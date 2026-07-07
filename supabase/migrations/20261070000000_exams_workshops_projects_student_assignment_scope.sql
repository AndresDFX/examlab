-- ══════════════════════════════════════════════════════════════════════
-- RLS exams / workshops / projects: un estudiante veía TODOS los del tenant sin
-- estar asignado (mismo anti-patrón que attendance_sessions, mig 20261065).
--
-- CAUSA: {exams,workshops,projects}_select_in_tenant otorgaban
--   is_super_admin() OR (course_in_my_tenant(course_id) AND (
--     (deleted_at IS NULL AND NOT en_papelera)   -- ← rama estudiante SIN chequeo de acceso
--     OR has_role('Docente') OR has_role('Admin')))
-- Para un estudiante (sin rol staff) → "course_in_my_tenant AND no-borrada" → leía TODOS
-- los exámenes/talleres/proyectos no borrados de CUALQUIER curso de su tenant (títulos,
-- instrucciones, fechas, enlaces), sin importar si le fueron asignados. Verificado: un
-- estudiante con 0 workshop_assignments veía 6 talleres del tenant.
--
-- FIX: el acceso del estudiante a estas entidades es por ASIGNACIÓN POR-USUARIO
-- ({exam,workshop,project}_assignments.user_id) — es como el cliente las consulta. La rama
-- de estudiante ahora exige EXISTS en la tabla de asignación. Staff (Docente/Admin) y
-- SuperAdmin sin cambios (blast radius mínimo). Idempotente + guards.
-- ══════════════════════════════════════════════════════════════════════

-- ── Exámenes ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.exams') IS NOT NULL AND to_regclass('public.exam_assignments') IS NOT NULL THEN
    DROP POLICY IF EXISTS exams_select_in_tenant ON public.exams;
    CREATE POLICY exams_select_in_tenant ON public.exams
      FOR SELECT USING (
        public.is_super_admin()
        OR (
          public.course_in_my_tenant(course_id) AND (
            public.has_role(auth.uid(), 'Docente')
            OR public.has_role(auth.uid(), 'Admin')
            OR (
              (deleted_at IS NULL) AND (NOT public._course_in_papelera(course_id))
              AND EXISTS (
                SELECT 1 FROM public.exam_assignments ea
                WHERE ea.exam_id = exams.id AND ea.user_id = auth.uid()
              )
            )
          )
        )
      );
  END IF;
END $$;

-- ── Talleres ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.workshops') IS NOT NULL AND to_regclass('public.workshop_assignments') IS NOT NULL THEN
    DROP POLICY IF EXISTS workshops_select_in_tenant ON public.workshops;
    CREATE POLICY workshops_select_in_tenant ON public.workshops
      FOR SELECT USING (
        public.is_super_admin()
        OR (
          public.course_in_my_tenant(course_id) AND (
            public.has_role(auth.uid(), 'Docente')
            OR public.has_role(auth.uid(), 'Admin')
            OR (
              (deleted_at IS NULL) AND (NOT public._course_in_papelera(course_id))
              AND EXISTS (
                SELECT 1 FROM public.workshop_assignments wa
                WHERE wa.workshop_id = workshops.id AND wa.user_id = auth.uid()
              )
            )
          )
        )
      );
  END IF;
END $$;

-- ── Proyectos ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.projects') IS NOT NULL AND to_regclass('public.project_assignments') IS NOT NULL THEN
    DROP POLICY IF EXISTS projects_select_in_tenant ON public.projects;
    CREATE POLICY projects_select_in_tenant ON public.projects
      FOR SELECT USING (
        public.is_super_admin()
        OR (
          public.course_in_my_tenant(course_id) AND (
            public.has_role(auth.uid(), 'Docente')
            OR public.has_role(auth.uid(), 'Admin')
            OR (
              (deleted_at IS NULL) AND (NOT public._course_in_papelera(course_id))
              AND EXISTS (
                SELECT 1 FROM public.project_assignments pa
                WHERE pa.project_id = projects.id AND pa.user_id = auth.uid()
              )
            )
          )
        )
      );
  END IF;
END $$;
