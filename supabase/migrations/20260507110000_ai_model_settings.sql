-- ============================================================
-- ai_model_settings: configuración global del modelo de IA activo.
--
-- V1 alcance:
--   - Una única fila activa a la vez (UNIQUE PARTIAL idx).
--   - Solo Admin escribe; SELECT abierto a authenticated (la edge
--     function lo necesita; RLS lo protegería igual desde service_role
--     pero mantenemos paridad con ai_prompts).
--   - API keys NO se guardan aquí — viven como env vars en Lovable
--     secrets (LOVABLE_API_KEY, OPENAI_API_KEY). La tabla solo
--     selecciona qué provider/modelo usar.
--
-- V1 providers soportados: lovable | openai (ambos chat-completions).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ai_model_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('lovable', 'openai')),
  model text NOT NULL,
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Solo una fila puede ser is_active = true.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_model_one_active
  ON public.ai_model_settings(is_active)
  WHERE is_active = true;

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_ai_model_settings_updated_at ON public.ai_model_settings;
CREATE TRIGGER trg_ai_model_settings_updated_at
  BEFORE UPDATE ON public.ai_model_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.ai_model_settings ENABLE ROW LEVEL SECURITY;

-- ───── RLS ─────
DROP POLICY IF EXISTS "ai_model_settings_read" ON public.ai_model_settings;
CREATE POLICY "ai_model_settings_read"
  ON public.ai_model_settings FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "ai_model_settings_admin_write" ON public.ai_model_settings;
CREATE POLICY "ai_model_settings_admin_write"
  ON public.ai_model_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- ───── Seed: default = Lovable + Gemini 2.5 flash ─────
-- Solo si no hay ya alguna config activa.
INSERT INTO public.ai_model_settings (provider, model, is_active)
SELECT 'lovable', 'google/gemini-2.5-flash', true
WHERE NOT EXISTS (SELECT 1 FROM public.ai_model_settings WHERE is_active = true);
