-- ──────────────────────────────────────────────────────────────────────
-- Lista de API keys con failover + endurecimiento del leak de keys.
--
-- OBJETIVO (feature):
--   Hoy cada tenant configura UNA sola key por provider (`gemini_api_key`
--   / `openai_api_key`). Si esa key se queda sin cuota (429) o se invalida
--   (401/403), toda la IA del tenant cae. Agregamos una LISTA ORDENADA de
--   keys de respaldo por provider: el edge intenta la principal y, si falla,
--   rota a las secundarias para asegurar disponibilidad en el momento.
--     - `gemini_fallback_keys text[]`  → secundarias de Gemini (orden = prioridad).
--     - `openai_fallback_keys text[]`  → secundarias de OpenAI (estructura lista
--       para cuando se pruebe OpenAI; el failover en el edge ya las contempla).
--   La key PRINCIPAL sigue en `gemini_api_key` / `openai_api_key` (compat).
--   Cadena efectiva de candidatos = [principal, ...secundarias, env legacy].
--
-- SEGURIDAD (leak preexistente que esta feature agrava si no se corrige):
--   `ai_model_settings` guarda secretos (las API keys) en columnas de la fila.
--   Las policies de SELECT vigentes dejaban leer la fila a:
--     (a) cualquier miembro del tenant  → `tenant_id = current_tenant_id()`
--     (b) cualquier authenticated        → `ai_model_settings_select_platform_default
--                                            USING (tenant_id IS NULL)`
--   => un Docente/Estudiante podía leer por REST la API key de su institución
--      (a) y la del platform-default del SuperAdmin (b). Agregar MÁS keys
--      (las de respaldo) ampliaría ese leak. Lo cerramos: SELECT de la fila
--      SOLO para Admin del tenant + SuperAdmin. Las edges leen por
--      service_role (bypassa RLS) → no se ven afectadas.
--   El ÚNICO campo no-secreto que el cliente no-admin necesita
--   (`processing_mode`, para decidir sync vs encolar en la generación del
--   docente) se sirve por un RPC SECURITY DEFINER dedicado.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.ai_model_settings') IS NULL THEN
    RAISE NOTICE 'ai_model_settings no existe; se omite la migración de failover de keys.';
    RETURN;
  END IF;

  -- 1) Columnas de keys de respaldo (orden = prioridad de failover).
  ALTER TABLE public.ai_model_settings
    ADD COLUMN IF NOT EXISTS gemini_fallback_keys TEXT[],
    ADD COLUMN IF NOT EXISTS openai_fallback_keys TEXT[];

  COMMENT ON COLUMN public.ai_model_settings.gemini_fallback_keys IS
    'Keys de respaldo de Gemini (orden = prioridad). El edge intenta la principal '
    '(gemini_api_key) y, si falla con 429/401/402/403/5xx, rota a estas.';
  COMMENT ON COLUMN public.ai_model_settings.openai_fallback_keys IS
    'Keys de respaldo de OpenAI (orden = prioridad). Misma semántica que '
    'gemini_fallback_keys; estructura lista para activar OpenAI.';

  -- 2) Endurecer SELECT: SOLO Admin del tenant + SuperAdmin pueden leer la
  --    fila (que contiene secretos). Se eliminan las policies permisivas.
  DROP POLICY IF EXISTS ai_model_settings_read ON public.ai_model_settings;            -- legacy V1
  DROP POLICY IF EXISTS ai_model_settings_select ON public.ai_model_settings;          -- tenant-wide
  DROP POLICY IF EXISTS ai_model_settings_select_platform_default ON public.ai_model_settings; -- world-readable NULL tenant

  CREATE POLICY ai_model_settings_select
    ON public.ai_model_settings FOR SELECT TO authenticated
    USING (
      public.is_super_admin()
      OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
    );
END $$;

-- 3) RPC para que el cliente NO-admin resuelva el processing_mode sin leer la
--    fila (y sin exponerle las keys). Resuelve el modo del propio tenant y,
--    si no hay, el platform-default; default conservador 'async'.
CREATE OR REPLACE FUNCTION public.get_active_processing_mode()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _tenant uuid := public.current_tenant_id();
  _mode text;
BEGIN
  IF _tenant IS NOT NULL THEN
    SELECT processing_mode INTO _mode
      FROM public.ai_model_settings
     WHERE is_active = true AND tenant_id = _tenant
     LIMIT 1;
  END IF;

  IF _mode IS NULL THEN
    SELECT processing_mode INTO _mode
      FROM public.ai_model_settings
     WHERE is_active = true AND tenant_id IS NULL
     LIMIT 1;
  END IF;

  RETURN CASE WHEN _mode = 'sync' THEN 'sync' ELSE 'async' END;
END;
$$;

REVOKE ALL ON FUNCTION public.get_active_processing_mode() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_active_processing_mode() TO authenticated;

COMMENT ON FUNCTION public.get_active_processing_mode() IS
  'Devuelve sync|async para el tenant del caller (fallback platform-default → async). '
  'Permite a clientes no-admin conocer el modo sin SELECT directo a ai_model_settings '
  '(que ahora es Admin/SA-only porque guarda las API keys).';

NOTIFY pgrst, 'reload schema';
