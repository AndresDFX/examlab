
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS max_exam_attempts integer NOT NULL DEFAULT 1;

ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS max_attempts integer;

-- Backfill: si por algún motivo quedan en NULL los cursos previos, normaliza a 1
UPDATE public.courses SET max_exam_attempts = 1 WHERE max_exam_attempts IS NULL;
