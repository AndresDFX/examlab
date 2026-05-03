ALTER TABLE public.project_files
  ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'abierta',
  ADD COLUMN IF NOT EXISTS options jsonb,
  ADD COLUMN IF NOT EXISTS starter_code text,
  ADD COLUMN IF NOT EXISTS content text;

ALTER TABLE public.project_files
  DROP CONSTRAINT IF EXISTS project_files_type_check;
ALTER TABLE public.project_files
  ADD CONSTRAINT project_files_type_check
  CHECK (type IN ('abierta','cerrada','codigo','diagrama','java_gui'));

ALTER TABLE public.project_submission_files
  ADD COLUMN IF NOT EXISTS selected_option text;