-- ══════════════════════════════════════════════════════════════════════════
-- Activar Amazon Bedrock como proveedor de IA de la plataforma.
--
-- ── Qué cambia y a quién ──────────────────────────────────────────────────
-- Solo la fila PLATFORM-DEFAULT (`tenant_id IS NULL`). Con las 6 instituciones
-- en `ai_mode='shared'` —el default—, el PROVEEDOR y el MODELO de esa fila
-- gobiernan a todas: `getActiveAiModel` compone el resultado con `{...shared}`.
-- Las filas de cada institución quedan como están (dicen `gemini`, que en modo
-- compartido no se usa): tocarlas sería churn sin efecto, y si alguna pasa a
-- `ai_mode='own'` su configuración es decisión suya.
--
-- ── El orden importa, y acá ya se cumplió ─────────────────────────────────
-- La regla dura del proyecto: **nunca activar un proveedor cuya key no esté
-- cargada**. Si la cadena de candidatos queda vacía, `aiChatCompletionFailover`
-- corta con «Falta la API key de Bedrock» y se cae la IA de TODA la plataforma
-- —tutor, calificación y generación—, con un mensaje que además señala a las
-- instituciones, que no pusieron nada mal y no pueden arreglarlo. Pasó el
-- 2026-08-19 al sembrar esta misma fila con `bedrock` antes de cargar el secret.
--
-- Antes de esta migración se hizo, en este orden:
--   1. `AWS_BEARER_TOKEN_BEDROCK` agregado a `.github/workflows/deploy-secrets.yml`
--      (faltaba: el secret se podía cargar en GitHub y NUNCA llegaba a las edges).
--   2. La key cargada como repository secret y desplegada a las edge functions
--      (`deploy-secrets.yml`, dry-run primero: tocó solo ese secret y APP_PUBLIC_URL).
--   3. Verificada contra el endpoint REAL que arma `bedrockChatUrl`: HTTP 200 en
--      `openai.gpt-oss-120b-1:0` y en `-20b-1:0`, y el `tool_choice` forzado que
--      usan los 7 edges de IA responde `finish_reason: "tool_calls"`.
--   4. Desplegado el recorte del bloque `<reasoning>` que esos modelos devuelven
--      DENTRO de `message.content` (`_shared/ai-content.ts`): sin eso, el
--      razonamiento interno del modelo se le mostraba al estudiante en el tutor y
--      se insertaba en el SQL y los documentos generados.
--
-- ── Por qué el modelo cambia en el MISMO movimiento ───────────────────────
-- Dejar `model='gemini-2.5-flash'` con `provider='bedrock'` manda un modelo que
-- Bedrock no sirve: la llamada falla para las 6 instituciones. El modelo y el
-- proveedor son un solo cambio, no dos.
--
-- `openai.gpt-oss-*` es la familia que sirve el endpoint compatible con OpenAI de
-- Bedrock; los modelos de Anthropic responden 404 ahí (viven en la API nativa
-- `/converse`, que no habla chat-completions) — medido y documentado en
-- `_shared/ai-model.ts`.
--
-- ── Cómo volver a Gemini ──────────────────────────────────────────────────
-- Desde Configuración → Modelo IA (SuperAdmin), sin migración: es un cambio de
-- configuración, no de esquema.
-- ══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE
  v_antes  text;
  v_modelo text;
BEGIN
  IF to_regclass('public.ai_model_settings') IS NULL THEN
    RAISE NOTICE 'Sin ai_model_settings: nada que activar.';
    RETURN;
  END IF;

  SELECT provider, model
    INTO v_antes, v_modelo
    FROM public.ai_model_settings
   WHERE tenant_id IS NULL AND is_active
   LIMIT 1;

  IF NOT FOUND THEN
    -- No se crea la fila acá: la siembra `tg_provision_tenant_defaults` / la
    -- migración que introdujo el proveedor. Crear una a ciegas podría duplicar
    -- el índice único parcial sobre `is_active`.
    RAISE NOTICE 'No hay fila platform-default activa: nada que activar.';
    RETURN;
  END IF;

  UPDATE public.ai_model_settings
     SET provider       = 'bedrock',
         model          = 'openai.gpt-oss-120b-1:0',
         -- La región solo la usa Bedrock; si ya estaba, se respeta.
         bedrock_region = COALESCE(bedrock_region, 'us-east-1'),
         updated_at     = now()
   WHERE tenant_id IS NULL AND is_active;

  RAISE NOTICE 'IA de plataforma: % (%) -> bedrock (openai.gpt-oss-120b-1:0)', v_antes, v_modelo;
END $mig$;

NOTIFY pgrst, 'reload schema';
