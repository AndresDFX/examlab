-- ──────────────────────────────────────────────────────────────────────
-- Auto-retry de jobs IA con errores transientes.
--
-- Problema: cuando un job falla con un error transiente (rate limit 429
-- de Gemini, timeout, 5xx, ECONNRESET), termina en `status='failed'`
-- hasta que un admin/docente entre al panel Cola y le dé "Reintentar"
-- manualmente. Si Gemini tiene 5 minutos malos, decenas de jobs caen y
-- alguien tiene que recogerlos a mano.
--
-- La edge `retry-failed-ai-gradings` cubre SOLO exam submissions
-- (V1) — workshops, project files, workshop_codigo_zip y demás kinds
-- de la cola async quedan fuera de ese rescate. Este fix los cubre.
--
-- Diseño: reemplaza la RPC `complete_ai_grading` para que cuando
-- `_ok=false` chequée:
--   1. ¿El job está realmente en `processing`? Si no (cancelado,
--      rejected, ya done), preservar estado (idempotencia).
--   2. ¿El _error matchea un patrón transiente?
--   3. ¿`attempts` todavía < cap (3)?
--
-- Si las 3 son sí → vuelve a `pending` con `started_at=NULL`, sin tocar
-- `attempts` (ya contó este fallo). El worker lo retoma en el próximo
-- tick automáticamente.
--
-- Si NO es transiente, o el cap se excedió → `failed` como antes.
--
-- El campo `last_error` documenta exactamente qué pasó para que el
-- admin pueda ver "intento 2/3" en el detalle del job.
--
-- Patrón de retry tradicional: NO decrementamos attempts; sumar fallos
-- es necesario para que el cap funcione. Quien quiera "reset total"
-- puede usar `requeue_ai_grading_job` desde el panel.
--
-- Convive bien con el cleanup de jobs colgados (mig 20260601000000):
-- ese cleanup pone started_at=NULL al volver a pending; este auto-retry
-- también. La regla es uniforme: "started_at=NULL en pending" = "no se
-- está procesando ahora". El claim del worker setea started_at=now().
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.complete_ai_grading(
  _job_id UUID,
  _ok BOOLEAN,
  _error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _max_attempts      CONSTANT INT := 3;
  _job_attempts      INT;
  _job_status        TEXT;
  _is_transient      BOOLEAN;
  -- Patrones que sabemos son retryable:
  --   - HTTP 429 (rate limit) y 5xx server errors
  --   - "rate limit" / "too many requests"
  --   - timeouts (incluye "timed out")
  --   - errores de red Node/Deno (ECONNRESET, ECONNREFUSED, ENETUNREACH)
  --   - "fetch failed" (genérico de undici/Deno)
  --   - "quota exceeded" (Gemini)
  --   - "service unavailable" / "gateway timeout" / "internal server error"
  -- Case insensitive — usamos `~*`.
  _retryable_pattern CONSTANT TEXT :=
    '(\y429\y|\y5\d\d\y|rate.?limit|too.many.requests|timeout|timed.?out|ECONN(RESET|REFUSED)|ENETUNREACH|fetch.failed|quota.exceeded|service.unavailable|gateway.timeout|internal.server.error)';
BEGIN
  -- ─── Re-check de estado (idempotencia) ───────────────────────────────
  -- Si el job ya NO está en processing (fue cancelado por el usuario
  -- mientras Gemini procesaba, o ya marcado como rejected/done por otro
  -- camino), respetamos el estado actual y salimos. Esto es lo que el
  -- worker ya espera — la versión anterior de complete_ai_grading también
  -- era idempotente ante cancelaciones.
  SELECT attempts, status INTO _job_attempts, _job_status
    FROM public.ai_grading_queue
   WHERE id = _job_id;

  IF NOT FOUND OR _job_status != 'processing' THEN
    RETURN;
  END IF;

  -- ─── Camino feliz: éxito → done ──────────────────────────────────────
  IF _ok THEN
    UPDATE public.ai_grading_queue
       SET status = 'done',
           last_error = NULL,
           completed_at = now()
     WHERE id = _job_id;
    RETURN;
  END IF;

  -- ─── Camino de fallo: decidir reintento vs failed ────────────────────
  -- COALESCE para tratar _error NULL como "no transiente" — un fallo sin
  -- mensaje no se reintenta automáticamente (probablemente algo serio).
  _is_transient := COALESCE(_error ~* _retryable_pattern, false);

  IF _is_transient AND _job_attempts < _max_attempts THEN
    -- Auto-retry: vuelve a pending.
    --   - started_at=NULL para que el cleanup de jobs colgados no lo
    --     confunda con un job que entró a processing y se quedó.
    --   - attempts se preserva (ya cuenta este fallo desde el claim).
    --   - last_error documenta el reintento con el mensaje original.
    --   - NO seteamos completed_at — el job sigue "en vuelo" en cola.
    UPDATE public.ai_grading_queue
       SET status = 'pending',
           started_at = NULL,
           last_error = format(
             'Reintento automático tras error transiente (intento %s/%s): %s',
             _job_attempts, _max_attempts, COALESCE(_error, '(sin mensaje)')
           )
     WHERE id = _job_id;
  ELSE
    -- Error no transiente, o cap excedido → failed final. Mismo
    -- comportamiento que antes. El admin puede reintentar manualmente
    -- vía `requeue_ai_grading_job` desde el panel.
    UPDATE public.ai_grading_queue
       SET status = 'failed',
           last_error = _error,
           completed_at = now()
     WHERE id = _job_id;
  END IF;
END
$$;

-- Preservar los grants — CREATE OR REPLACE los mantiene, pero re-aplicamos
-- por explicitud y para que la migración sea idempotente independiente
-- del estado de los grants previos.
REVOKE ALL ON FUNCTION public.complete_ai_grading(UUID, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_ai_grading(UUID, BOOLEAN, TEXT) TO service_role;

COMMENT ON FUNCTION public.complete_ai_grading(UUID, BOOLEAN, TEXT) IS
  'Cierra un job de la cola IA. Si _ok=true → done. Si _ok=false: detecta errores transientes (429, 5xx, timeouts, ECONNRESET, etc.) y re-encola automáticamente con attempts intacto hasta un cap de 3. Errores no transientes o cap excedido → failed.';

NOTIFY pgrst, 'reload schema';
