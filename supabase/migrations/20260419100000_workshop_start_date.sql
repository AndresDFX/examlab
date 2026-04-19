-- Add start_date to workshops for visibility control
ALTER TABLE public.workshops ADD COLUMN IF NOT EXISTS start_date TIMESTAMPTZ;
