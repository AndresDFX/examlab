-- ══════════════════════════════════════════════════════════════════════
-- RLS attendance_sessions: un estudiante NO matriculado veía sesiones (y su
-- pizarra) de cursos ajenos de su tenant.
--
-- CAUSA: attendance_sessions_select_in_tenant otorgaba
--   course_in_my_tenant(course_id) AND (
--     (deleted_at IS NULL AND NOT en_papelera)  -- ← rama SIN chequeo de matrícula
--     OR has_role('Docente') OR has_role('Admin') OR is_super_admin())
-- Para un estudiante (sin rol staff) la condición se reducía a
-- "course_in_my_tenant AND (no borrada)" → leía TODAS las sesiones no borradas de
-- CUALQUIER curso de su tenant, sin importar si está matriculado. La pizarra de
-- sesión COMPARTIDA vive en attendance_sessions.whiteboard_scene → un estudiante
-- no matriculado veía la pizarra del curso (bug reportado). También exponía
-- meeting_url / recording_url / notes_url / títulos / fechas de todo el tenant.
--
-- Reproducido contra prod (tx rolled-back): un estudiante puro matriculado solo en
-- el curso A veía las 3 sesiones del curso B (no matriculado) → ANTES=3; tras el
-- fix ve 0 de B, sigue viendo las 9 de A (matriculado), y un estudiante sin
-- ninguna matrícula ve 0 en todo. El Docente sigue viendo tenant-wide (sin regresión).
--
-- FIX: la rama de estudiante exige matrícula (course_enrollments). El staff
-- (Docente/Admin/SuperAdmin) conserva su acceso tenant-wide sin cambios (blast
-- radius mínimo). Idempotente + guard to_regclass.
-- Complementa 20261061000000 (tabla whiteboards, otro vector del mismo reporte).
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NOT NULL THEN
    DROP POLICY IF EXISTS attendance_sessions_select_in_tenant ON public.attendance_sessions;
    CREATE POLICY attendance_sessions_select_in_tenant ON public.attendance_sessions
      FOR SELECT USING (
        public.course_in_my_tenant(course_id) AND (
          public.has_role(auth.uid(), 'Docente')
          OR public.has_role(auth.uid(), 'Admin')
          OR public.is_super_admin()
          OR (
            (deleted_at IS NULL)
            AND (NOT public._course_in_papelera(course_id))
            AND EXISTS (
              SELECT 1 FROM public.course_enrollments ce
              WHERE ce.course_id = attendance_sessions.course_id
                AND ce.user_id = auth.uid()
            )
          )
        )
      );
  END IF;
END $$;
