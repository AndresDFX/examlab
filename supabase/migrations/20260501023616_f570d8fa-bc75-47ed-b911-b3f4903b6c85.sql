-- a) Re-escalar ai_grade y final_override_grade de submissions viejas
UPDATE public.submissions s
SET ai_grade = ROUND((s.ai_grade / 10.0) * c.grade_scale_max, 2)
FROM public.exams e
JOIN public.courses c ON c.id = e.course_id
WHERE s.exam_id = e.id
  AND s.ai_grade IS NOT NULL
  AND c.grade_scale_max < 10
  AND s.ai_grade > c.grade_scale_max;

UPDATE public.submissions s
SET final_override_grade = ROUND((s.final_override_grade / 10.0) * c.grade_scale_max, 2)
FROM public.exams e
JOIN public.courses c ON c.id = e.course_id
WHERE s.exam_id = e.id
  AND s.final_override_grade IS NOT NULL
  AND c.grade_scale_max < 10
  AND s.final_override_grade > c.grade_scale_max;

-- b) Nuevo tipo de programación de examen
ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS schedule_type text NOT NULL DEFAULT 'normal';

ALTER TABLE public.exams
  DROP CONSTRAINT IF EXISTS exams_schedule_type_check;

ALTER TABLE public.exams
  ADD CONSTRAINT exams_schedule_type_check
  CHECK (schedule_type IN ('normal','relativo'));