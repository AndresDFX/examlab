-- ──────────────────────────────────────────────────────────────────────
-- Agrega `java_gui_provider` a code_execution_settings para parametrizar
-- el motor que ejecuta preguntas tipo `java_gui` (Swing/AWT/JavaFX).
--
-- Independiente del `provider` general (que aplica a preguntas `codigo`):
--   provider          → motor para preguntas `codigo` (Lambda, OnlineCompiler, etc.)
--   java_gui_provider → motor para preguntas `java_gui`:
--                       - 'cheerp'         (default): CheerpJ en el navegador (interactivo)
--                       - 'aws_screenshot': AWS Lambda + Xvfb + captura PNG (no interactivo)
--
-- Ver docs/JAVA-GUI-OPTIONS.md para el análisis completo y trade-offs.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.code_execution_settings
  ADD COLUMN IF NOT EXISTS java_gui_provider text NOT NULL DEFAULT 'cheerp';

ALTER TABLE public.code_execution_settings
  DROP CONSTRAINT IF EXISTS code_execution_settings_java_gui_provider_check;

ALTER TABLE public.code_execution_settings
  ADD CONSTRAINT code_execution_settings_java_gui_provider_check
  CHECK (java_gui_provider IN ('cheerp', 'aws_screenshot'));

COMMENT ON COLUMN public.code_execution_settings.java_gui_provider IS
  'Motor para preguntas tipo java_gui. cheerp = CheerpJ en navegador (interactivo). aws_screenshot = AWS Lambda + Xvfb + ImageMagick (captura PNG estática, no interactivo).';

NOTIFY pgrst, 'reload schema';
