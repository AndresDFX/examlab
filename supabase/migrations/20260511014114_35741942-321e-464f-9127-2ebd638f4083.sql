ALTER TABLE public.teacher_google_tokens
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'google',
  ADD COLUMN IF NOT EXISTS provider_email text;

UPDATE public.teacher_google_tokens
SET provider_email = google_email
WHERE provider_email IS NULL AND google_email IS NOT NULL;

ALTER TABLE public.teacher_google_tokens
  DROP CONSTRAINT IF EXISTS teacher_google_tokens_provider_check;
ALTER TABLE public.teacher_google_tokens
  ADD CONSTRAINT teacher_google_tokens_provider_check
  CHECK (provider IN ('google', 'microsoft'));

COMMENT ON COLUMN public.teacher_google_tokens.provider IS
  'Proveedor del calendario conectado: google o microsoft. Default google por la migración inicial. La columna google_email queda histórica; usar provider_email en código nuevo.';

NOTIFY pgrst, 'reload schema';