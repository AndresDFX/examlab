-- ──────────────────────────────────────────────────────────────────────
-- Agrega 'aws_lambda' a los providers válidos en code_execution_settings.
-- Es el runner self-hosted que vive en AWS Lambda — ver aws/code-runner/.
--
-- Postgres no permite ALTER CHECK directo → drop + recreate idempotente.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.code_execution_settings
  DROP CONSTRAINT IF EXISTS code_execution_settings_provider_check;

ALTER TABLE public.code_execution_settings
  ADD CONSTRAINT code_execution_settings_provider_check
  CHECK (provider IN ('onlinecompiler', 'jdoodle', 'cheerp', 'aws_lambda'));

COMMENT ON COLUMN public.code_execution_settings.provider IS
  'Motor de ejecución de código: onlinecompiler (API externa), jdoodle (fallback), cheerp (browser WebAssembly), aws_lambda (runner self-hosted en AWS — ver aws/code-runner/).';

NOTIFY pgrst, 'reload schema';
