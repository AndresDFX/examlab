-- Add grade scale and component weights to courses
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS grade_scale_min numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grade_scale_max numeric NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS exam_weight numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS workshop_weight numeric NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS passing_grade numeric NOT NULL DEFAULT 3;