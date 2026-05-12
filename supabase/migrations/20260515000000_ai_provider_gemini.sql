-- Agrega 'gemini' como provider valido en ai_model_settings.
--
-- Por que: el codigo original soportaba solo 'lovable' (Lovable AI
-- Gateway, key sk_lovable_...) y 'openai' (api.openai.com, key sk-...).
-- Para usar tu propia key de Google Gemini directamente, agregamos un
-- tercer provider que llama al endpoint compatible-OpenAI de Google:
--   https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
--
-- El cambio aqui es solo del CHECK constraint. El secret GEMINI_API_KEY
-- se configura en Edge Function Secrets (no en la DB), y el provider se
-- elige desde la UI de Admin (app.admin.ai-prompts.tsx tab "Modelo").

ALTER TABLE public.ai_model_settings
  DROP CONSTRAINT IF EXISTS ai_model_settings_provider_check;

ALTER TABLE public.ai_model_settings
  ADD CONSTRAINT ai_model_settings_provider_check
    CHECK (provider IN ('lovable', 'openai', 'gemini'));

NOTIFY pgrst, 'reload schema';
