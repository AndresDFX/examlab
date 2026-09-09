-- ══════════════════════════════════════════════════════════════════════════
-- Una cuenta ELIMINADA o DESACTIVADA no se puede matricular ni asignar como
-- docente de un curso.
--
-- ── Lo que se reportó ─────────────────────────────────────────────────────
-- «Aun cuando elimine o desactive un estudiante desde el panel de
-- administración se sigue viendo como opción para matricular en un curso.»
-- Medido el 2026-09-09: el diálogo de matrícula cargaba `profiles` sin ningún
-- filtro, y NINGUNA de las ~65 consultas a `profiles` del cliente filtraba por
-- estado de cuenta. El filtro del cliente ya se agregó (`profile-scope.ts`);
-- esta migración es la mitad que lo hace CIERTO.
--
-- ── Por qué hace falta el guard además del filtro del cliente ─────────────
-- Tres caminos llegan a `course_enrollments` sin pasar por ese filtro:
--   1. La edge `bulk-import-users` inserta con `service_role`, así que no la
--      alcanza ninguna policy. Y empareja por CORREO contra
--      `auth.admin.listUsers()`, donde la fila de una cuenta eliminada SIGUE
--      VIVA (el borrado la BANEA, no la elimina) — o sea que una importación
--      masiva vuelve a matricular al fantasma.
--   2. Un cliente viejo ya desplegado en el navegador de alguien.
--   3. Un PATCH/POST directo a PostgREST.
-- El filtro del cliente es la experiencia; esto es la garantía.
--
-- ── Y por qué NO se cierra en la RLS de `profiles` ────────────────────────
-- Porque un perfil eliminado tiene que seguir siendo LEGIBLE: la entrega de un
-- estudiante que se retiró después de entregar necesita mostrar su nombre en el
-- monitor, en el gradebook y en el acta. Cortar la lectura dejaría notas sin
-- dueño. La base no puede distinguir «ofrecer» de «resolver un nombre», así que
-- lo que se cierra es la ESCRITURA que crea el vínculo.
--
-- ── Alcance deliberado: solo el INSERT ────────────────────────────────────
-- El guard NO corre en UPDATE ni en DELETE, y eso es a propósito:
--   · Las matrículas que YA existen no se tocan. Si a alguien lo eliminan
--     después de entregar, su nota, su asistencia y su acta siguen en pie —
--     borrarle el vínculo sería destruir historia académica.
--   · Desmatricular a una cuenta eliminada tiene que seguir funcionando.
--   · `vocero_marcado_at` y los demás UPDATE sobre una fila vieja siguen
--     pasando.
--
-- ── El nulo es ACTIVO ─────────────────────────────────────────────────────
-- `is_active` es NULLABLE y en producción 325 de 566 perfiles lo tienen en NULL
-- (filas anteriores a la migración que agregó la columna). Por eso el predicado
-- es `COALESCE(is_active, true)` y no `is_active = true`: con la comparación
-- directa, este trigger rechazaría más de la mitad de las matrículas de la
-- plataforma.
--
-- `estado` (activo/retirado/aplazado/graduado) NO entra: es otro eje —la
-- situación académica, que el Admin escribe a mano y tiene su propio
-- enforcement en `is_student_blocked`— y ni eliminar ni desactivar lo tocan.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_check_membership_account_active()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_deleted timestamptz;
  v_active boolean;
  v_nombre text;
BEGIN
  SELECT p.deleted_at, COALESCE(p.is_active, true), p.full_name
    INTO v_deleted, v_active, v_nombre
    FROM public.profiles p
   WHERE p.id = NEW.user_id;

  -- Sin fila en `profiles` no se opina: hay altas donde el perfil lo crea un
  -- trigger sobre auth.users y el orden no está garantizado. Ese caso ya lo
  -- cubre la FK de user_id.
  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_deleted IS NOT NULL THEN
    RAISE EXCEPTION
      'La cuenta de % está eliminada: no se puede vincular a un curso. Restaurala primero desde el panel de usuarios.',
      COALESCE(v_nombre, 'esa persona')
      USING ERRCODE = 'P0001';
  END IF;

  -- `IF NOT v_active` y NO `IF v_active IS NOT TRUE`. Se ve igual y no lo es:
  -- con la logica de tres valores de plpgsql, `NOT NULL` da NULL y el IF no
  -- dispara, o sea que el nulo pasa como ACTIVO. `IS NOT TRUE` en cambio SI
  -- dispara con el nulo y rechazaria a los 325 de 566 perfiles que lo tienen
  -- asi. Verificado contra un PostgreSQL real: mutando esta linea a
  -- `IS NOT TRUE`, el arnes falla con "La cuenta de X esta desactivada" sobre
  -- una cuenta que nunca se desactivo.
  IF NOT v_active THEN
    RAISE EXCEPTION
      'La cuenta de % está desactivada: no se puede vincular a un curso. Activala primero desde el panel de usuarios.',
      COALESCE(v_nombre, 'esa persona')
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- ── Matrícula de estudiantes ──
DO $$
BEGIN
  IF to_regclass('public.course_enrollments') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_course_enrollments_account_active ON public.course_enrollments;
    CREATE TRIGGER trg_course_enrollments_account_active
      BEFORE INSERT ON public.course_enrollments
      FOR EACH ROW EXECUTE FUNCTION public.tg_check_membership_account_active();
  END IF;
END $$;

-- ── Asignación de docentes ──
-- Mismo problema por el mismo camino: el diálogo de docentes del curso también
-- listaba las cuentas eliminadas (filtraba por rol Docente y nada más).
DO $$
BEGIN
  IF to_regclass('public.course_teachers') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_course_teachers_account_active ON public.course_teachers;
    CREATE TRIGGER trg_course_teachers_account_active
      BEFORE INSERT ON public.course_teachers
      FOR EACH ROW EXECUTE FUNCTION public.tg_check_membership_account_active();
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.tg_check_membership_account_active() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tg_check_membership_account_active() FROM anon;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════════
-- El selector de destinatario de mensajes tampoco ofrece cuentas eliminadas.
--
-- `list_messageable_users` es SECURITY DEFINER y su rama de Admin devuelve
-- TODOS los perfiles ("Si soy admin, todos los perfiles"), sin mirar el estado
-- de la cuenta. O sea que se podía abrir una conversación con alguien que ya no
-- puede entrar: los mensajes quedan escritos y nadie los lee nunca.
--
-- El filtro va en el JOIN final y no en cada rama de `candidates`: así cubre
-- las tres de una (Admin ve todos, compañeros de curso, y todos los Admin) y no
-- hay forma de agregar una cuarta rama y olvidarse.
--
-- El cuerpo se copia TEXTUAL de 20260518000000 y lo único que cambia es ese
-- JOIN, que pasa de LEFT a INNER con la condición de estado. LEFT ya no tiene
-- sentido: un candidato sin fila en `profiles` salía con nombre y correo en
-- NULL, o sea una opción vacía en el selector.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.list_messageable_users()
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  email TEXT,
  role_label TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH me AS (SELECT auth.uid() AS uid),
  am_admin AS (
    SELECT public.has_role((SELECT uid FROM me), 'Admin'::public.app_role) AS is_admin
  ),
  my_courses AS (
    SELECT course_id FROM public.course_teachers WHERE user_id = (SELECT uid FROM me)
    UNION
    SELECT course_id FROM public.course_enrollments WHERE user_id = (SELECT uid FROM me)
  ),
  candidates AS (
    -- Si soy admin, todos los perfiles
    SELECT p.id AS uid
    FROM public.profiles p
    WHERE (SELECT is_admin FROM am_admin) = TRUE
      AND p.id <> (SELECT uid FROM me)
    UNION
    -- Compañeros de curso (cualquier rol)
    SELECT u.user_id AS uid
    FROM (
      SELECT user_id FROM public.course_teachers
      WHERE course_id IN (SELECT course_id FROM my_courses)
      UNION
      SELECT user_id FROM public.course_enrollments
      WHERE course_id IN (SELECT course_id FROM my_courses)
    ) u
    WHERE u.user_id <> (SELECT uid FROM me)
    UNION
    -- Todos los admins (cualquier usuario puede mensajearles)
    SELECT ur.user_id AS uid
    FROM public.user_roles ur
    WHERE ur.role = 'Admin'::public.app_role
      AND ur.user_id <> (SELECT uid FROM me)
  )
  SELECT DISTINCT
    c.uid,
    p.full_name,
    p.institutional_email AS email,
    CASE
      WHEN public.has_role(c.uid, 'Admin'::public.app_role) THEN 'Admin'
      WHEN public.has_role(c.uid, 'Docente'::public.app_role) THEN 'Docente'
      WHEN public.has_role(c.uid, 'Estudiante'::public.app_role) THEN 'Estudiante'
      ELSE 'Usuario'
    END AS role_label
  FROM candidates c
  JOIN public.profiles p
    ON p.id = c.uid
   AND p.deleted_at IS NULL
   AND COALESCE(p.is_active, true);
$fn$;

NOTIFY pgrst, 'reload schema';
