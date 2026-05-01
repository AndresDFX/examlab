ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS retry_mode text NOT NULL DEFAULT 'last'
  CHECK (retry_mode IN ('last','average','highest'));