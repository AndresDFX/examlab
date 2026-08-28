-- ══════════════════════════════════════════════════════════════════════════
-- El docente no puede FABRICAR un estudiante para ganar acceso a su perfil.
--
-- ── La cadena, verificada leyendo las tres piezas ─────────────────────────
-- 1. `enrollments_docente_manage` (mig 20261180000000) quedó acotada solo por
--    `_teaches_course(course_id)`: dice DÓNDE puede matricular el docente, pero
--    nada sobre A QUIÉN. Así que podía insertar por REST la fila
--    (un_curso_que_dicta, el_user_id_de_un_Admin).
-- 2. Hecho eso, `_is_my_student(id)` (mig 20261890000000) devuelve true para esa
--    cuenta: la función solo pregunta si hay matrícula en un curso vivo que el
--    docente dicta.
-- 3. Y entonces `profiles_docente_manage_own_students` le habilita el UPDATE de
--    ese perfil. El trigger `trg_guard_profile_self_escalation` (mig
--    20261035000000) frena `is_active`, `deactivated_at`, `deactivated_by`,
--    `estado` y `tenant_id` — pero NO frena `institutional_email` ni
--    `full_name`. O sea que el docente podía cambiarle el correo institucional a
--    un Admin, que es su identidad de acceso.
--
-- Esto refuta el COMMENT que la propia 20261890000000 le puso a la función
-- ("Alcance del Docente sobre estudiantes; NO incluye colegas ni Admins"): no
-- los incluía por sí sola, pero el docente podía hacerlos entrar. La afirmación
-- era correcta sobre el estado de los datos y falsa sobre lo que el docente
-- podía provocar, que es lo que importa en una frontera de permisos.
--
-- Además del escalamiento, la fabricación es un problema de datos por sí sola:
-- un Admin matriculado aparece en el listado del curso, en el gradebook, en la
-- asistencia y en los correos del curso.
--
-- ── Se cierra en los DOS extremos, a propósito ────────────────────────────
-- * `_is_my_student` deja de considerar cuentas con rol de staff. Es la defensa
--   en el punto de USO: aunque una matrícula así ya exista (por este agujero, o
--   porque un Admin la creó a mano), el docente no gana el UPDATE del perfil.
-- * `enrollments_docente_manage` deja de aceptar esas filas en su WITH CHECK. Es
--   la defensa en el punto de ENTRADA: la fila no llega a existir.
-- Con una sola capa quedaría o el dato sucio (solo la primera) o las filas ya
-- existentes explotables (solo la segunda).
--
-- La restricción va SOLO en el WITH CHECK y no en el USING: el USING gobierna
-- qué filas ve para UPDATE y DELETE, y un docente tiene que poder BORRAR una
-- matrícula equivocada de su curso, incluida una de estas.
--
-- No rompe ningún flujo: el único write de `course_enrollments` desde el cliente
-- es el diálogo del Admin (`app.admin.users.tsx`), que pasa por la rama de Admin,
-- y el alta de estudiantes del docente va por el edge `bulk-import-users` con
-- `service_role` (la RLS no aplica). Verificado por grep antes de escribir esto.
-- ══════════════════════════════════════════════════════════════════════════

/**
 * true si la cuenta tiene algún rol de staff. Se usa para excluirla del alcance
 * "mi estudiante": un Admin, un SuperAdmin o un colega docente no son alumnos de
 * nadie, aunque exista una fila de matrícula que diga lo contrario.
 *
 * Ojo con el multi-rol: alguien con Docente + Estudiante SÍ cuenta como staff acá
 * y por lo tanto queda fuera del alcance de otro docente. Es la lectura
 * conservadora a propósito — el costo es que un docente que además cursa una
 * materia tenga que pedirle al Admin que le corrija el perfil, y el beneficio es
 * que ningún docente pueda editar a un colega. Entre las dos, la que no se puede
 * deshacer es la segunda.
 */
CREATE OR REPLACE FUNCTION public._has_staff_role(_user_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = _user_id
       AND ur.role IN ('Admin'::public.app_role,
                       'SuperAdmin'::public.app_role,
                       'Docente'::public.app_role)
  );
$fn$;

REVOKE ALL ON FUNCTION public._has_staff_role(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._has_staff_role(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public._has_staff_role(uuid) TO authenticated;

COMMENT ON FUNCTION public._has_staff_role(uuid) IS
  'true si _user_id tiene rol Admin, SuperAdmin o Docente. Usada para excluir al staff del alcance "mi estudiante" del docente.';

-- ── Capa 1 · el punto de uso ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._is_my_student(_user_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
  SELECT
    -- Primero lo barato y lo que cierra el agujero: el staff nunca es "mi
    -- estudiante", exista o no la matrícula.
    NOT public._has_staff_role(_user_id)
    AND EXISTS (
      SELECT 1
        FROM public.course_enrollments ce
        JOIN public.course_teachers   ct ON ct.course_id = ce.course_id
        JOIN public.courses            c ON c.id         = ce.course_id
       WHERE ce.user_id = _user_id
         AND ct.user_id = auth.uid()
         -- Un curso en la papelera no habilita nada: regla universal del proyecto.
         AND c.deleted_at IS NULL
    );
$fn$;

COMMENT ON FUNCTION public._is_my_student(uuid) IS
  'true si _user_id esta matriculado en algun curso VIVO que dicta auth.uid() Y no tiene rol de staff. Alcance del Docente sobre estudiantes: excluye Admins, SuperAdmins y colegas docentes AUNQUE exista una fila de matricula para ellos (mig 20261920000000).';

-- ── Capa 2 · el punto de entrada ──────────────────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.course_enrollments') IS NULL THEN
    RAISE NOTICE 'Sin course_enrollments: nada que acotar.';
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'course_enrollments'
       AND policyname = 'enrollments_docente_manage'
  ) THEN
    RAISE NOTICE 'La policy enrollments_docente_manage no existe en este entorno: se omite.';
    RETURN;
  END IF;

  -- Solo el WITH CHECK. El USING queda igual para que el docente pueda borrar una
  -- matrícula equivocada de su curso (ver la cabecera).
  ALTER POLICY enrollments_docente_manage ON public.course_enrollments
    WITH CHECK (
      public._teaches_course(course_id)
      AND public.has_role(auth.uid(), 'Docente'::public.app_role)
      AND NOT public._has_staff_role(user_id)
    );
END $mig$;

NOTIFY pgrst, 'reload schema';
