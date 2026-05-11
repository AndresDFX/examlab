-- ──────────────────────────────────────────────────────────────────────
-- Unicidad de títulos dentro de un curso — case-insensitive.
--
-- Hoy un docente puede crear dos exámenes con el mismo título dentro
-- del mismo curso (idem talleres / proyectos / cortes), lo cual genera
-- confusión en grids, gradebook, links de notificación, etc. Esta
-- migración agrega UNIQUE INDEXES sobre `(course_id, LOWER(title))` o
-- `(course_id, LOWER(name))` según corresponda.
--
-- Por qué LOWER:
--   "Examen Final" y "examen final" son el mismo título para el
--   docente — diferenciarlos por capitalización es una trampa.
--
-- Idempotente con `IF NOT EXISTS`. Si en tu DB ya hay duplicados al
-- correr esta migración, el CREATE INDEX FALLA. En ese caso el admin
-- debe renombrar los duplicados existentes ANTES de re-correr la
-- migración. Consulta de detección:
--   SELECT course_id, LOWER(title), count(*) FROM public.exams
--   GROUP BY 1, 2 HAVING count(*) > 1;
-- ──────────────────────────────────────────────────────────────────────

-- exams.title por curso
CREATE UNIQUE INDEX IF NOT EXISTS exams_course_title_lower_uidx
  ON public.exams (course_id, LOWER(title));

-- workshops.title por curso
CREATE UNIQUE INDEX IF NOT EXISTS workshops_course_title_lower_uidx
  ON public.workshops (course_id, LOWER(title));

-- projects.title por curso
CREATE UNIQUE INDEX IF NOT EXISTS projects_course_title_lower_uidx
  ON public.projects (course_id, LOWER(title));

-- grade_cuts.name por curso (cortes/parciales).
CREATE UNIQUE INDEX IF NOT EXISTS grade_cuts_course_name_lower_uidx
  ON public.grade_cuts (course_id, LOWER(name));

NOTIFY pgrst, 'reload schema';
