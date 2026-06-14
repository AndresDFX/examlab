-- ═══════════════════════════════════════════════════════════════════════
-- Asociar (opcionalmente) un examen / taller / proyecto a una SESIÓN de clase.
--
-- Igual que `polls.attendance_session_id`: cuando la actividad está asociada a
-- una sesión, aparece en el TABLERO bajo esa sesión (docente y estudiante);
-- si no, aparece en la sección "General" del curso. Así el estudiante ve todo
-- desde el tablero.
--
-- FK ON DELETE SET NULL: si la sesión se borra, la actividad cae a "General"
-- (no se borra la actividad). Defensivo con to_regclass por si la tabla no
-- existe en el entorno (patrón del repo).
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.exams') IS NOT NULL
     AND to_regclass('public.attendance_sessions') IS NOT NULL THEN
    ALTER TABLE public.exams
      ADD COLUMN IF NOT EXISTS attendance_session_id UUID
      REFERENCES public.attendance_sessions(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_exams_attendance_session
      ON public.exams(attendance_session_id) WHERE attendance_session_id IS NOT NULL;
  END IF;

  IF to_regclass('public.workshops') IS NOT NULL
     AND to_regclass('public.attendance_sessions') IS NOT NULL THEN
    ALTER TABLE public.workshops
      ADD COLUMN IF NOT EXISTS attendance_session_id UUID
      REFERENCES public.attendance_sessions(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_workshops_attendance_session
      ON public.workshops(attendance_session_id) WHERE attendance_session_id IS NOT NULL;
  END IF;

  IF to_regclass('public.projects') IS NOT NULL
     AND to_regclass('public.attendance_sessions') IS NOT NULL THEN
    ALTER TABLE public.projects
      ADD COLUMN IF NOT EXISTS attendance_session_id UUID
      REFERENCES public.attendance_sessions(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_attendance_session
      ON public.projects(attendance_session_id) WHERE attendance_session_id IS NOT NULL;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
