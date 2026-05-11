-- ──────────────────────────────────────────────────────────────────────
-- Extiende a las tablas legacy la misma protección case-insensitive
-- que aplicamos a profiles + exams/workshops/projects/grade_cuts:
--
-- - attendance_sessions: UNIQUE(course_id, session_date, title) → ahora
--   sobre LOWER(title). session_date es DATE (sin casing) y se mantiene
--   literal.
-- - workshop_groups: UNIQUE(workshop_id, name) → LOWER(name).
-- - project_groups: UNIQUE(project_id, name) → LOWER(name).
--
-- Drop de los constraints viejos + CREATE UNIQUE INDEX con expresión.
-- Idempotente — usa IF EXISTS / IF NOT EXISTS.
--
-- Si tu DB ya tiene duplicados de la forma "Grupo A" + "grupo a"
-- (case-insensitive) el CREATE INDEX fallará. Renombra uno antes de
-- re-publish.
-- ──────────────────────────────────────────────────────────────────────

-- attendance_sessions
ALTER TABLE public.attendance_sessions
  DROP CONSTRAINT IF EXISTS attendance_sessions_course_id_session_date_title_key;
CREATE UNIQUE INDEX IF NOT EXISTS attendance_sessions_course_date_title_lower_uidx
  ON public.attendance_sessions (course_id, session_date, LOWER(COALESCE(title, '')));

-- workshop_groups
ALTER TABLE public.workshop_groups
  DROP CONSTRAINT IF EXISTS workshop_groups_workshop_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS workshop_groups_workshop_name_lower_uidx
  ON public.workshop_groups (workshop_id, LOWER(name));

-- project_groups
ALTER TABLE public.project_groups
  DROP CONSTRAINT IF EXISTS project_groups_project_id_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS project_groups_project_name_lower_uidx
  ON public.project_groups (project_id, LOWER(name));

NOTIFY pgrst, 'reload schema';
