-- ──────────────────────────────────────────────────────────────────────
-- API keys per-tenant en ai_model_settings.
--
-- Hoy la columna `gemini_api_key` ya existe (migración 20260524110000).
-- Agregamos `openai_api_key` y `lovable_api_key` para que cada
-- institución gestione sus propias keys (y sus propios costos de IA).
--
-- Fallback chain en las edge functions:
--   1. row.<provider>_api_key  (per-tenant, configurado por el Admin)
--   2. Deno.env.get("<PROVIDER>_API_KEY") (legacy, en Lovable Secrets)
--   3. Si ninguno, la edge devuelve error accionable.
--
-- Storage:
--   - Las keys quedan en DB. RLS las protege (solo Admin del tenant +
--     SuperAdmin pueden leer/escribir la fila — politica de Fase 5).
--   - NO se exponen al cliente como texto plano salvo para edit. La
--     UI muestra masked (••••XXXX) cuando hay valor y el Admin
--     reescribe el campo completo para rotar.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.ai_model_settings
  ADD COLUMN IF NOT EXISTS openai_api_key TEXT,
  ADD COLUMN IF NOT EXISTS lovable_api_key TEXT;

COMMENT ON COLUMN public.ai_model_settings.openai_api_key IS
  'API key de OpenAI para este tenant. NULL → fallback al env OPENAI_API_KEY.';
COMMENT ON COLUMN public.ai_model_settings.lovable_api_key IS
  'API key de Lovable Gateway para este tenant. NULL → fallback al env LOVABLE_API_KEY.';
COMMENT ON COLUMN public.ai_model_settings.gemini_api_key IS
  'API key de Gemini directa para este tenant. NULL → fallback al env GEMINI_API_KEY.';

NOTIFY pgrst, 'reload schema';
