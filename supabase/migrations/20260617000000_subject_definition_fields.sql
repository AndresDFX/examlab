-- ============================================================
-- Enriquecer `academic_subjects` con campos de DEFINICIÓN (lo que se
-- debe dictar). Refuerza la distinción asignatura (template) vs curso
-- (instancia por periodo):
--
--   - objetivos       → propósito general que el plan de estudios fija
--                       para esta materia
--   - contenidos      → temáticas / módulos a cubrir
--   - sistema_evaluacion → pesos default por tipo (examen / taller /
--                          proyecto / asistencia). El docente puede
--                          ajustarlos en el curso instanciado.
--   - bibliografia    → referencias sugeridas
--   - intensidad_horaria → horas semanales (opcional)
--
-- Todos opcionales — no rompen asignaturas existentes ni la creación
-- mínima (solo `name` + opcionalmente `program_id`).
-- ============================================================

ALTER TABLE public.academic_subjects
  ADD COLUMN IF NOT EXISTS objetivos TEXT,
  ADD COLUMN IF NOT EXISTS contenidos TEXT,
  -- sistema_evaluacion: { exam_weight, workshop_weight, project_weight, attendance_weight }
  -- Sum should be 100. Validamos en cliente, no en DB (los pesos pueden
  -- variar por institución; un CHECK estricto sería frágil).
  ADD COLUMN IF NOT EXISTS sistema_evaluacion JSONB,
  ADD COLUMN IF NOT EXISTS bibliografia TEXT,
  ADD COLUMN IF NOT EXISTS intensidad_horaria SMALLINT;

ALTER TABLE public.academic_subjects
  DROP CONSTRAINT IF EXISTS chk_academic_subjects_intensidad;
ALTER TABLE public.academic_subjects
  ADD CONSTRAINT chk_academic_subjects_intensidad
  CHECK (intensidad_horaria IS NULL OR (intensidad_horaria >= 0 AND intensidad_horaria <= 60));

NOTIFY pgrst, 'reload schema';
