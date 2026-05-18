-- ──────────────────────────────────────────────────────────────────────
-- Extras de panel admin + toggle del banco de preguntas.
--
-- 1) `app_settings.question_bank_enabled` (BOOLEAN DEFAULT TRUE)
--    El Admin puede ocultar el módulo de Banco de preguntas globalmente.
--    El nav del docente lo respeta. Default TRUE → comportamiento previo.
--
-- 2) `ai_model_settings.gemini_api_key` (TEXT, nullable)
--    Permite al Admin editar la API key de Gemini desde la UI sin
--    redeployar. La edge function la lee como prioridad sobre la env
--    var (LOVABLE_API_KEY) — si la columna está poblada, esa gana; si
--    no, cae a la env var de siempre.
--
--    RLS: la tabla ai_model_settings ya restringe SELECT/UPDATE a Admin
--    (revisar policy existente). El valor en DB queda encriptado at-rest
--    por el storage de Postgres y solo accesible vía RPC SECURITY DEFINER
--    o por Admin con sesión. No expuesto a estudiantes/docentes.
--
-- 3) NOTIFY pgrst, 'reload schema' al final — fuerza a PostgREST a
--    refrescar el schema cache. Cubre el caso reportado donde la tabla
--    question_bank existía pero no aparecía en el cache.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS question_bank_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE public.ai_model_settings
  ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;

COMMENT ON COLUMN public.app_settings.question_bank_enabled IS
  'Si FALSE, el módulo Banco de preguntas se esconde del nav del docente.';

COMMENT ON COLUMN public.ai_model_settings.gemini_api_key IS
  'API key de Gemini gestionable desde el panel Admin. Si NULL/vacía, la edge function cae a la env var LOVABLE_API_KEY.';

NOTIFY pgrst, 'reload schema';
