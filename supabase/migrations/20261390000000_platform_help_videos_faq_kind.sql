-- ════════════════════════════════════════════════════════════════════════
-- FAQ videos: clips CORTOS y puntuales por rol, distintos de los tours de
-- módulo (largos) que ya viven en platform_help_videos.
--
-- Se agrega:
--   - kind ('module' | 'faq'): 'module' = tour completo del módulo (lo actual);
--     'faq' = clip corto que responde UNA pregunta puntual.
--   - question: la pregunta que responde el clip (para que el asistente lo
--     matchee mejor y lo muestre con su enlace público en el chat).
--
-- Sigue siendo CROSS-TENANT (RLS phv_select = true → disponible para TODOS los
-- tenants) y SA-only para escritura (phv_write = is_super_admin). El asistente
-- de plataforma ya inyecta estos videos con su link público de help-videos.
-- ════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.platform_help_videos') IS NOT NULL THEN
    ALTER TABLE public.platform_help_videos
      ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'module'
        CHECK (kind IN ('module','faq'));
    ALTER TABLE public.platform_help_videos
      ADD COLUMN IF NOT EXISTS question TEXT;
    -- Lo ya cargado son tours de módulo → kind='module' (el default ya lo cubre;
    -- explícito por claridad ante re-aplicación de la migración).
    UPDATE public.platform_help_videos SET kind = 'module' WHERE kind IS NULL;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
