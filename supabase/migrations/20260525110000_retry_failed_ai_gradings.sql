-- ──────────────────────────────────────────────────────────────────────
-- Reintento automático de AI gradings fallidos (rate limit 429, errores
-- transitorios). Caso típico: examen calificado en hora pico → Gemini
-- responde 429 → algunas preguntas quedan con `ai_error` en el
-- breakdown. Sin esta tarea, el docente debe entrar a cada submission
-- y recalificar manualmente.
--
-- Arquitectura:
--   1) RPC `list_failed_ai_gradings(_cooldown_minutes, _limit)` que
--      busca submissions con `ai_error` en su breakdown y que no se
--      reintentaron en el cooldown reciente.
--   2) SQL function `trigger_retry_failed_ai_gradings()` que invoca el
--      edge `retry-failed-ai-gradings` vía net.http_post + shared secret.
--   3) pg_cron job (configurado en supabase/cron/setup.sql) que llama
--      a la SQL function cada 30 minutos.
--
-- El edge function actualiza `answers.__last_retry_at` ANTES de
-- recalificar, así si el edge falla o se cuelga el cooldown sigue
-- activo en el siguiente tick.
-- ──────────────────────────────────────────────────────────────────────

-- ─────────────── RPC: listar gradings fallidos pendientes
CREATE OR REPLACE FUNCTION public.list_failed_ai_gradings(
  _cooldown_minutes INTEGER DEFAULT 30,
  _limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  exam_id UUID,
  user_id UUID,
  last_retry_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.id,
    s.exam_id,
    s.user_id,
    NULLIF(s.answers->>'__last_retry_at', '')::timestamptz AS last_retry_at
  FROM public.submissions s
  WHERE
    -- Algún item del breakdown tiene ai_error → grading parcialmente fallido.
    -- `jsonb_path_exists` recorre el array completo.
    jsonb_path_exists(s.answers, '$."__breakdown"[*]."ai_error"')
    -- Cooldown: NULL (nunca reintentado) o suficientemente antiguo.
    AND (
      s.answers->>'__last_retry_at' IS NULL
      OR s.answers->>'__last_retry_at' = ''
      OR NULLIF(s.answers->>'__last_retry_at', '')::timestamptz
         < now() - (_cooldown_minutes || ' minutes')::interval
    )
    -- Solo submissions entregadas (no las que aún están en progreso).
    AND s.submitted_at IS NOT NULL
  -- Las más viejas primero — si una lleva más rato esperando, se
  -- reintenta antes que una recién fallada.
  ORDER BY s.submitted_at ASC
  LIMIT GREATEST(1, LEAST(_limit, 100));
END
$$;

REVOKE ALL ON FUNCTION public.list_failed_ai_gradings(INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_failed_ai_gradings(INTEGER, INTEGER) TO service_role;

-- ─────────────── SQL trigger function que invoca el edge function
-- Mismo patrón que `notify_send_push`: usa current_setting() para
-- recuperar URL + secret. Los seteamos con ALTER DATABASE en setup.sql.
CREATE OR REPLACE FUNCTION public.trigger_retry_failed_ai_gradings()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    text := current_setting('app.settings.retry_grading_url', true);
  v_secret text := current_setting('app.settings.retry_grading_secret', true);
BEGIN
  IF v_url IS NULL OR v_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RAISE NOTICE 'retry_grading_url/secret no configurados — skip';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Content-Type',     'application/json',
      'X-Trigger-Secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
END
$$;

REVOKE ALL ON FUNCTION public.trigger_retry_failed_ai_gradings() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.trigger_retry_failed_ai_gradings() TO service_role;

NOTIFY pgrst, 'reload schema';
