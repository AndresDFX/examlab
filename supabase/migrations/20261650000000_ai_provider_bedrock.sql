-- ──────────────────────────────────────────────────────────────────────
-- Amazon Bedrock como proveedor de IA, con key POR DEFECTO de plataforma.
--
-- Se suma a Gemini (default histórico) y OpenAI. Entra SIN traductor de payload
-- porque Bedrock expone un endpoint COMPATIBLE CON OPENAI:
--   https://bedrock-runtime.<region>.amazonaws.com/openai/v1/chat/completions
-- Verificado contra la cuenta real antes de escribir una línea de código:
--   · autentica con `Authorization: Bearer <API key de Bedrock>`;
--   · acepta `max_tokens` (lo que los edges ya mandan) y, lo que decidía la
--     viabilidad, `tools` + `tool_choice` — de eso dependen los edges de
--     generación para su salida estructurada, y devolvió `tool_calls` correcto.
--
-- LÍMITE REAL MEDIDO (no supuesto): ese endpoint sirve la familia
-- `openai.gpt-oss-*`. Los modelos de Anthropic en Bedrock responden 404 ahí
-- ("doesn't support this API"): viven en la API nativa `/converse`, que NO habla
-- chat-completions. Por eso los modelos ofrecidos son los `gpt-oss`.
--
-- ── Cómo se resuelve la key (dos niveles, sin secretos en esta migración) ──
--   1. `bedrock_api_key` + `bedrock_fallback_keys` de la fila → la key PROPIA de
--      la institución, editable desde Configuración → Modelo IA.
--   2. El secret `AWS_BEARER_TOKEN_BEDROCK` de Edge Functions → la key POR
--      DEFECTO de la plataforma, último candidato del failover.
-- Así una institución sin key propia funciona sin configurar nada, y la que
-- puso la suya la usa primero. Es el MISMO patrón que ya tienen Gemini y OpenAI
-- (`GEMINI_API_KEY` / `OPENAI_API_KEY`), así que no se inventa un mecanismo
-- nuevo. La key NO se guarda acá: las migraciones van al repo.
--
-- Defensiva: todo va dentro de `DO` con guard `to_regclass` — si la tabla no
-- existe en el entorno, se omite en vez de abortar el deploy completo.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.ai_model_settings') IS NULL THEN
    RAISE NOTICE 'ai_model_settings ausente — se omite el soporte de Bedrock';
    RETURN;
  END IF;

  -- ── 1) Columnas nuevas ────────────────────────────────────────────
  ALTER TABLE public.ai_model_settings
    ADD COLUMN IF NOT EXISTS bedrock_api_key TEXT,
    ADD COLUMN IF NOT EXISTS bedrock_fallback_keys TEXT[],
    ADD COLUMN IF NOT EXISTS bedrock_region TEXT;

  COMMENT ON COLUMN public.ai_model_settings.bedrock_api_key IS
    'API key de Amazon Bedrock (bearer). NULL → se usa el secret AWS_BEARER_TOKEN_BEDROCK de la plataforma.';
  COMMENT ON COLUMN public.ai_model_settings.bedrock_fallback_keys IS
    'Keys de respaldo de Bedrock, en orden. Mismo failover que gemini_fallback_keys.';
  COMMENT ON COLUMN public.ai_model_settings.bedrock_region IS
    'Región AWS del endpoint de Bedrock. NULL → us-east-1.';

  -- ── 2) El CHECK admite 'bedrock' ──────────────────────────────────
  -- El nombre del CHECK **no se puede asumir**: nació sin nombre en
  -- 20260507110000 (auto-nombrado `ai_model_settings_provider_check`) y
  -- 20260824000000 lo dropeó buscándolo DINÁMICAMENTE para deprecar
  -- 'lovable', recreándolo como `chk_ai_model_settings_provider`. Un
  -- `DROP CONSTRAINT IF EXISTS <nombre-viejo>` no encuentra nada, no falla,
  -- y deja vivo el CHECK real — que después rechaza el INSERT de más abajo
  -- (`violates check constraint "chk_ai_model_settings_provider"`).
  --
  -- Por eso se buscan TODOS los CHECK que restrinjan la columna `provider`
  -- y se dropean por nombre real, cualquiera sea. Se conserva el nombre
  -- vigente en producción para que futuras migraciones lo encuentren.
  DECLARE
    r RECORD;
    v_provider_attnum SMALLINT;
  BEGIN
    SELECT attnum INTO v_provider_attnum
      FROM pg_attribute
     WHERE attrelid = 'public.ai_model_settings'::regclass
       AND attname = 'provider'
       AND NOT attisdropped;

    FOR r IN
      SELECT con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
       WHERE con.conrelid = 'public.ai_model_settings'::regclass
         AND con.contype = 'c'
         AND v_provider_attnum = ANY (con.conkey)
    LOOP
      RAISE NOTICE 'Dropeando CHECK % → %', r.conname, r.def;
      EXECUTE format('ALTER TABLE public.ai_model_settings DROP CONSTRAINT %I', r.conname);
    END LOOP;

    ALTER TABLE public.ai_model_settings
      ADD CONSTRAINT chk_ai_model_settings_provider
      CHECK (provider IN ('openai', 'gemini', 'bedrock'));
  END;
END $$;

-- ── 3) Fila PLATFORM-DEFAULT (tenant_id IS NULL) ────────────────────
-- `getActiveAiModel()` la usa como modelo compartido de la plataforma y como
-- base sobre la que se mezcla la fila de cada institución. Hoy NO existía:
-- las 5 instituciones tenían su propia fila y no había default global, así que
-- un tenant nuevo sin fila caía al hardcoded del código. Se crea apuntando a
-- Bedrock, que es lo pedido para el cross-tenant.
--
-- Idempotente: si alguien ya la creó, NO se le pisa el provider — cambiar en
-- silencio el proveedor de una fila existente es justo lo que no debe hacer una
-- migración.
DO $$
DECLARE v_exists boolean;
BEGIN
  IF to_regclass('public.ai_model_settings') IS NULL THEN RETURN; END IF;

  SELECT EXISTS (SELECT 1 FROM public.ai_model_settings WHERE tenant_id IS NULL)
    INTO v_exists;

  IF v_exists THEN
    RAISE NOTICE 'La fila platform-default ya existe — no se toca su provider.';
  ELSE
    INSERT INTO public.ai_model_settings
      (tenant_id, provider, model, bedrock_region, is_active, processing_mode)
    VALUES
      (NULL, 'bedrock', 'openai.gpt-oss-120b-1:0', 'us-east-1', TRUE, 'sync');
    RAISE NOTICE 'Fila platform-default creada con Bedrock (openai.gpt-oss-120b-1:0).';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
