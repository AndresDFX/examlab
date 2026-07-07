-- ══════════════════════════════════════════════════════════════════════
-- RLS course_enrollments / course_teachers: cualquier autenticado del tenant leía
-- TODO el roster (course_enrollments) y todas las asignaciones de docentes
-- (course_teachers) — las policies SELECT eran `USING (course_in_my_tenant(course_id))`,
-- sin acotar al acceso del usuario. Un estudiante veía las 195 matrículas del tenant
-- (quién está en qué curso) y las 4 asignaciones docente-curso, sin estar en esos cursos.
--
-- FIX:
--   course_enrollments SELECT → propias (user_id=auth.uid()) + Admin(tenant) + docente del
--     curso (_teaches_course) + SuperAdmin. (Los clientes de estudiante ya leen SOLO
--     `.eq(user_id, me)`; el trabajo en grupo usa *_group_members, no el roster.)
--   course_teachers SELECT → Admin(tenant) + cualquier Docente del tenant (colaboran; dato de
--     baja sensibilidad) + estudiante MATRICULADO en el curso (_is_enrolled_in_course, para ver
--     al docente de SU curso) + SuperAdmin.
--
-- Helpers SECURITY DEFINER para el cross-check (evitan recursión RLS mutua entre las 2 tablas).
-- Idempotente + guards.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._teaches_course(_course_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.course_teachers ct
    WHERE ct.course_id = _course_id AND ct.user_id = auth.uid()
  );
$fn$;

CREATE OR REPLACE FUNCTION public._is_enrolled_in_course(_course_id uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM public.course_enrollments ce
    WHERE ce.course_id = _course_id AND ce.user_id = auth.uid()
  );
$fn$;

REVOKE ALL ON FUNCTION public._teaches_course(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._teaches_course(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public._is_enrolled_in_course(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._is_enrolled_in_course(uuid) TO authenticated;

DO $$
BEGIN
  IF to_regclass('public.course_enrollments') IS NOT NULL THEN
    DROP POLICY IF EXISTS enrollments_select_in_tenant ON public.course_enrollments;
    CREATE POLICY enrollments_select_in_tenant ON public.course_enrollments
      FOR SELECT USING (
        (user_id = auth.uid())
        OR public.is_super_admin()
        OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
        OR public._teaches_course(course_id)
      );
  END IF;

  IF to_regclass('public.course_teachers') IS NOT NULL THEN
    DROP POLICY IF EXISTS course_teachers_select_in_tenant ON public.course_teachers;
    CREATE POLICY course_teachers_select_in_tenant ON public.course_teachers
      FOR SELECT USING (
        public.is_super_admin()
        OR (
          public.course_in_my_tenant(course_id) AND (
            public.has_role(auth.uid(), 'Admin')
            OR public.has_role(auth.uid(), 'Docente')
          )
        )
        OR public._is_enrolled_in_course(course_id)
      );
  END IF;
END $$;
