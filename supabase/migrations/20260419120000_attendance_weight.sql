-- Add attendance_weight to courses
ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS attendance_weight NUMERIC NOT NULL DEFAULT 0;
