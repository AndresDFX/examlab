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
--
-- ── Nota de historia (leer antes de "arreglar" esto otra vez) ──────────
-- Esta migración YA SE APLICÓ en producción, y en el modelo de despliegue del
-- proyecto una migración aplicada es inmutable: editarla NO la vuelve a correr.
-- El paso 3 se editó DESPUÉS de aplicarse, y es a propósito: sirve para que un
-- entorno NUEVO no reproduzca la caída que sí ocurrió en producción (ver el
-- comentario del paso 3). **Producción se corrigió a mano**, poniendo la fila
-- platform-default de vuelta en Gemini, y se verificó con una llamada real a la
-- IA — no por esta edición. Si estás leyendo esto en un entorno ya migrado, el
-- estado correcto de la fila `tenant_id IS NULL` es el proveedor cuya key esté
-- efectivamente cargada, y eso se cambia desde Configuración → Modelo IA.
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
-- base sobre la que se mezcla la fila de cada institución. No existía: las
-- instituciones tenían su propia fila y no había default global, así que un
-- tenant sin fila caía al `DEFAULT_MODEL` hardcoded (Gemini).
--
-- ⚠ SE CREA CON **GEMINI**, NO CON BEDROCK, Y ESO ES DELIBERADO.
--
-- `ai_mode` default es 'shared', y en ese modo `getActiveAiModel` hace
-- `{...shared}`: el **provider sale de ESTA fila** para TODAS las instituciones.
-- Si acá se pone un proveedor cuya key todavía no está cargada, la cadena de
-- candidatos queda vacía y `runKeyFailover` LANZA ("lista de keys vacía") →
-- se cae la IA de toda la plataforma: tutor, calificación y generación.
--
-- No es hipotético: se creó con 'bedrock' y tumbó la IA de las 5 instituciones
-- (todas en 'shared', todas con key propia de Gemini que quedó ignorada porque
-- el provider activo pasó a ser Bedrock). Una migración NO puede saber si el
-- secret `AWS_BEARER_TOKEN_BEDROCK` está cargado en el entorno, así que no debe
-- apostar a que lo esté.
--
-- Activar Bedrock es entonces una acción DELIBERADA y en este orden:
--   1. cargar el secret (o la key propia de la institución en el panel);
--   2. recién ahí cambiar el proveedor desde Configuración → Modelo IA.
-- Todo lo que Bedrock necesita —columnas, failover de keys, UI y región— queda
-- listo por esta migración; lo único que no se hace es activarlo a ciegas.
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
    -- `bedrock_region` se siembra igual: no activa nada por sí sola y evita
    -- tener que recordarla cuando se active Bedrock.
    INSERT INTO public.ai_model_settings
      (tenant_id, provider, model, bedrock_region, is_active, processing_mode)
    VALUES
      (NULL, 'gemini', 'gemini-2.5-flash', 'us-east-1', TRUE, 'sync');
    RAISE NOTICE 'Fila platform-default creada con Gemini (Bedrock queda disponible, sin activar).';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
