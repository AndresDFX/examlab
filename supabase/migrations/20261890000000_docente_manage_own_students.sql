-- ══════════════════════════════════════════════════════════════════════
-- El Docente gestiona a los estudiantes DE SUS CURSOS, con el alcance del Admin
-- pero acotado a lo que dicta.
--
-- Pedido: "al rol docente dale los mismos permisos sobre Gestión de Usuarios que
-- tiene el admin pero solo para los cursos de los que es docente; no debería ver
-- estudiantes de otros cursos que no tenga asignados".
--
-- ── Lo que ya estaba ──────────────────────────────────────────────────
-- Más de lo que parecía. El docente YA podía: ver a los matriculados de sus
-- cursos (la pantalla acota por `course_teachers`), iniciar sesión como ellos,
-- cambiarles la contraseña (el edge `bulk-set-passwords` trae el molde exacto:
-- Docente acotado a los estudiantes matriculados en SUS cursos) y matricular o
-- desmatricular (`enrollments_docente_manage` es FOR ALL con `_teaches_course`).
--
-- Faltaban dos cosas: CREAR usuarios (en el edge, aparte) y EDITAR el perfil,
-- que estaba reservado a `profiles_admin_manage_same_tenant`. Esta migración es
-- lo segundo.
--
-- ── Lo que NO se le da, y por qué ─────────────────────────────────────
-- **Borrar la cuenta.** No es prudencia difusa: "borrar, pero solo para mis
-- cursos" no significa nada. La cuenta NO pertenece a un curso — la misma
-- persona puede estar en cursos de otros docentes, con entregas, notas y actas
-- ahí. Un DELETE sobre `auth.users` cascadea a todo eso, así que un docente
-- borrando "a un alumno suyo" destruiría datos de cursos que no dicta, y ningún
-- scope de curso puede evitarlo. Lo que el docente realmente necesita —"este
-- alumno ya no está en mi curso"— es DESMATRICULAR, que sí es por curso y ya
-- podía hacer.
--
-- **Ver la contraseña temporal** (`admin_visible_passwords`, SELECT Admin/SA).
-- No hace falta: la clave temporal de un usuario nuevo es la fija `Temporal#123`
-- (ver el edge de import), así que el docente que crea la cuenta ya sabe qué
-- decirle al estudiante. Un privilegio que no se necesita no se otorga.
--
-- ── Lo que ya estaba protegido, y por eso acá no hay trigger nuevo ────
-- `profiles` tiene columnas que NO son "datos del estudiante": `tenant_id` (a
-- qué institución pertenece), `is_active`, `estado`, `deactivated_*`. Y la RLS de
-- Postgres es por FILA: una policy de UPDATE deja escribir CUALQUIER columna de
-- esa fila. Ese es exactamente el molde de la vulnerabilidad que este proyecto ya
-- tuvo dos veces (notas y `profiles`).
--
-- Acá NO hace falta un guard nuevo porque YA existe y ya cubre este caso:
-- `trg_guard_profile_self_escalation` (mig 20261035000000) es BEFORE UPDATE FOR
-- EACH ROW **sin `WHEN`**, así que dispara en TODO update —también en el de otra
-- fila— y para un caller que no sea Admin ni SuperAdmin RECHAZA cambiar
-- `is_active`, `deactivated_at/by`, `estado` y re-apuntar un `tenant_id` ya
-- asignado. Un docente cae en esa rama.
--
-- Se consideró agregar un segundo trigger que congelara `tenant_id` para el
-- docente y se DESCARTÓ: además de redundante, correría antes que el existente
-- (orden alfabético) y convertiría un error explícito en un cambio silenciosamente
-- ignorado. Un intento de mover a alguien de institución tiene que fallar
-- ruidosamente.
--
-- Lo que el docente SÍ puede editar queda entonces en el fast-path de ese guard:
-- `full_name`, `institutional_email`, `codigo`, `documento`, `cohorte`, avatar y
-- preferencias. Es la corrección de datos del estudiante, que es el pedido.
-- (`institutional_email` es la identidad de acceso: el Admin también puede
-- cambiarla, y el índice único sobre `LOWER(institutional_email)` evita choques.)
--
-- ── Por qué una policy y no una RPC ───────────────────────────────────
-- La edición del perfil ya se hace con un UPDATE directo desde el cliente —es lo
-- que `profiles_admin_manage_same_tenant` habilita para el Admin—. Agregar una
-- rama a esa misma superficie mantiene UN camino de escritura; una RPC crearía un
-- segundo, y los dos tendrían que mantenerse de acuerdo.
--
-- ── El alcance es "mi estudiante", no "mi institución" ────────────────
-- Si fuera lo segundo, el docente editaría al Admin y a sus colegas.
-- ══════════════════════════════════════════════════════════════════════

-- ─── Helper: ¿esta persona es estudiante de algún curso que dicto? ─────
-- SECURITY DEFINER para no re-entrar a la RLS de `course_enrollments` desde una
-- policy de `profiles` (recursión mutua entre tablas, que ya quemó al proyecto).
CREATE OR REPLACE FUNCTION public._is_my_student(_user_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
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

REVOKE ALL ON FUNCTION public._is_my_student(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public._is_my_student(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public._is_my_student(uuid) TO authenticated;

COMMENT ON FUNCTION public._is_my_student(uuid) IS
  'true si _user_id esta matriculado en algun curso VIVO que dicta auth.uid(). Alcance del Docente sobre estudiantes; NO incluye colegas ni Admins.';

-- ─── La policy ─────────────────────────────────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    DROP POLICY IF EXISTS profiles_docente_manage_own_students ON public.profiles;
    CREATE POLICY profiles_docente_manage_own_students
      ON public.profiles FOR UPDATE TO authenticated
      USING (
        public.has_role(auth.uid(), 'Docente'::public.app_role)
        AND public._is_my_student(id)
      )
      WITH CHECK (
        public.has_role(auth.uid(), 'Docente'::public.app_role)
        AND public._is_my_student(id)
      );
  END IF;
END $mig$;

COMMENT ON POLICY profiles_docente_manage_own_students ON public.profiles IS
  'El Docente edita el perfil de los estudiantes matriculados en cursos VIVOS que dicta. NO alcanza a colegas ni Admins. Las columnas sensibles (tenant_id, is_active, estado, deactivated_*) las sigue rechazando trg_guard_profile_self_escalation, que dispara en todo UPDATE y solo deja pasar a Admin/SuperAdmin.';

NOTIFY pgrst, 'reload schema';
