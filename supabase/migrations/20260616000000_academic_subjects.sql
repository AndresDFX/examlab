-- ============================================================
-- Sprint D — Asignaturas (plan de estudios).
--
-- Hasta ahora un `course` era simultáneamente:
--   - la asignatura abstracta ("Programación II"), y
--   - su instancia concreta (grupo 341-A, semestre 2026-1).
-- Resultado: dos grupos de la misma asignatura son cursos
-- desconectados. No hay forma de listar "todos los cursos de
-- Programación II históricamente" ni de mover el plan curricular
-- centralmente.
--
-- Esta migración separa el concepto: `academic_subjects` es la
-- asignatura abstracta (pertenece a un programa, vive en un
-- semestre del plan, tiene créditos). `courses` queda como
-- INSTANCIA — agrega `subject_id` opcional para asociarse.
--
-- Por ahora subject_id es nullable y los cursos existentes no se
-- backfillean automáticamente (la institución debe decidir qué
-- asignatura representa cada curso histórico — la heurística por
-- nombre es frágil). El admin lo asocia desde el form.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.academic_subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nombre canónico de la asignatura (ej. "Programación II").
  name text NOT NULL,
  -- Código corto (ej. "PRGII", "MAT-201"). Opcional.
  code text,
  -- Programa al que pertenece. NULL permitido para asignaturas
  -- transversales / electivas no atadas a un programa específico.
  program_id uuid NULL REFERENCES public.academic_programs(id) ON DELETE SET NULL,
  -- Semestre dentro del plan de estudios (1..12).
  semestre smallint,
  -- Créditos académicos. Opcional — no todas las instituciones manejan créditos.
  credits smallint,
  -- Descripción / syllabus corto (opcional).
  description text,
  -- Activa: si false, no aparece en dropdowns de creación de curso.
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Soft checks
  CONSTRAINT chk_academic_subjects_semestre
    CHECK (semestre IS NULL OR (semestre >= 1 AND semestre <= 12)),
  CONSTRAINT chk_academic_subjects_credits
    CHECK (credits IS NULL OR (credits >= 0 AND credits <= 20))
);

-- UNIQUE por programa: dos asignaturas con el mismo nombre dentro
-- del mismo programa son un error. Asignaturas transversales
-- (program_id NULL) pueden repetir nombre — pero pasar la barrera
-- de "no hay catch-all asignatura transversal" es decisión humana.
CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_subjects_name_program
  ON public.academic_subjects(LOWER(name), COALESCE(program_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_academic_subjects_program_id
  ON public.academic_subjects(program_id);

DROP TRIGGER IF EXISTS trg_academic_subjects_updated_at ON public.academic_subjects;
CREATE TRIGGER trg_academic_subjects_updated_at
  BEFORE UPDATE ON public.academic_subjects
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.academic_subjects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "academic_subjects_read" ON public.academic_subjects;
CREATE POLICY "academic_subjects_read"
  ON public.academic_subjects FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "academic_subjects_admin_write" ON public.academic_subjects;
CREATE POLICY "academic_subjects_admin_write"
  ON public.academic_subjects FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- ── FK desde courses ──
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS subject_id uuid NULL
  REFERENCES public.academic_subjects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_courses_subject_id
  ON public.courses(subject_id);

NOTIFY pgrst, 'reload schema';
