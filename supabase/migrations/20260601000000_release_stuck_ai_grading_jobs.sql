-- ──────────────────────────────────────────────────────────────────────
-- Rescate de jobs IA colgados en `processing`.
--
-- Problema: si el edge function `ai-grading-worker` crashea o excede el
-- timeout del runtime de Supabase (típicamente ~150s) mientras procesa
-- un job, el job queda con `status='processing'` y `started_at` viejo.
-- Nadie más lo levanta (la RPC `claim_pending_ai_grading` solo toma
-- `pending`), nadie lo retoma. El alumno ve "Por calificar" para siempre,
-- el panel Cola lo cuenta en "En proceso" sin movimiento, y el docente
-- tiene que cancelar + reencolar manualmente.
--
-- Esta migración:
--   1. RPC `release_stuck_processing_jobs(_threshold_minutes, _max_attempts)`:
--      identifica jobs colgados y los devuelve a `pending` (para que el
--      próximo tick del worker los retome) o los marca `failed` si ya
--      excedieron el cap de attempts (evita bucle infinito sobre algo
--      genuinamente irrecuperable).
--   2. pg_cron: ejecuta la RPC cada 10 min con defaults 30 min / 3 attempts.
--   3. cron_job_descriptions: entrada legible para el panel Cron.
--
-- Decisiones:
--   - 30 min como threshold: lo suficientemente largo para que jobs
--     legítimos (project_full con código ZIP grande + Gemini Pro) terminen,
--     pero suficientemente corto para que un alumno espere a lo sumo
--     una ventana de 10-40 min entre rescate y reproceso.
--   - 3 attempts: alineado con el patrón típico de retry. Después de 3
--     liberaciones, asumimos que el job es problemático per se (body
--     inválido, target_row_id que no existe, etc.).
--   - `started_at = NULL` al volver a pending: importante para distinguir
--     "nunca se intentó" de "fue rescatado". Si dejamos started_at viejo,
--     la próxima ejecución del rescate vería el mismo job como stuck (porque
--     vuelve a pasar el threshold sin que el worker lo haya tomado todavía).
--   - SECURITY DEFINER + GRANT solo a service_role: este es trabajo de
--     infraestructura, no UI. Si un Admin quiere disparar manualmente,
--     puede hacerlo desde SQL Editor o desde el panel Cron (que ejecuta
--     RPCs como service_role).
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.release_stuck_processing_jobs(
  _threshold_minutes INT DEFAULT 30,
  _max_attempts INT DEFAULT 3
)
RETURNS TABLE (
  released_to_pending INT,
  released_to_failed  INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _to_pending INT := 0;
  _to_failed  INT := 0;
  _stuck      RECORD;
BEGIN
  -- FOR UPDATE SKIP LOCKED por si una corrida concurrente (paranoia —
  -- pg_cron no debería superponerse, pero el RPC también podría
  -- invocarse manualmente desde otro lugar).
  --
  -- `started_at IS NULL` es defensa por si un bug futuro deja un job
  -- en processing sin started_at — esos también se rescatan.
  FOR _stuck IN
    SELECT id, attempts
    FROM public.ai_grading_queue
    WHERE status = 'processing'
      AND (
        started_at IS NULL
        OR started_at < now() - (_threshold_minutes || ' minutes')::interval
      )
    FOR UPDATE SKIP LOCKED
  LOOP
    IF _stuck.attempts >= _max_attempts THEN
      UPDATE public.ai_grading_queue
         SET status = 'failed',
             last_error = format(
               'Job colgado en processing por >%s min después de %s intentos. Liberado por cleanup automático.',
               _threshold_minutes, _max_attempts
             ),
             completed_at = now()
       WHERE id = _stuck.id;
      _to_failed := _to_failed + 1;
    ELSE
      -- started_at = NULL es CRÍTICO: distingue "nunca intentado" de
      -- "rescatado". Si dejáramos started_at viejo, la próxima corrida
      -- del cleanup vería el job todavía vencido y lo "rescataría" de
      -- nuevo en bucle.
      UPDATE public.ai_grading_queue
         SET status = 'pending',
             started_at = NULL,
             last_error = format(
               'Liberado de processing colgado tras %s min (intento %s). El worker lo reintenta en el siguiente tick.',
               _threshold_minutes, _stuck.attempts
             )
       WHERE id = _stuck.id;
      _to_pending := _to_pending + 1;
    END IF;
  END LOOP;

  -- Audit log fire-and-forget. Solo loguea si hubo trabajo para no
  -- spammear cuando el rescate corre y no encuentra nada (caso típico).
  IF _to_pending + _to_failed > 0 THEN
    BEGIN
      PERFORM public.log_audit_event(
        p_action      := 'ai_grading.stuck_jobs_released',
        p_category    := 'grading',
        p_severity    := 'warning',
        p_entity_type := 'ai_grading_queue',
        p_entity_id   := NULL,
        p_entity_name := 'cleanup_automatico',
        p_metadata    := jsonb_build_object(
          'released_to_pending', _to_pending,
          'released_to_failed',  _to_failed,
          'threshold_minutes',   _threshold_minutes,
          'max_attempts',        _max_attempts
        )
      );
    EXCEPTION WHEN OTHERS THEN
      -- log_audit_event ya tiene EXCEPTION WHEN OTHERS interno, pero
      -- defensivo por si la firma cambia y deja de matchear.
      NULL;
    END;
  END IF;

  RETURN QUERY SELECT _to_pending, _to_failed;
END;
$$;

REVOKE ALL ON FUNCTION public.release_stuck_processing_jobs(INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.release_stuck_processing_jobs(INT, INT) TO service_role;

COMMENT ON FUNCTION public.release_stuck_processing_jobs(INT, INT) IS
  'Rescata jobs IA colgados en status=processing más allá del threshold. Devuelve cuántos se mandaron de vuelta a pending vs cuántos se marcaron failed por exceder attempts. Llamado por pg_cron cada 10 min.';

-- ─── pg_cron schedule ─────────────────────────────────────────────────
-- Cada 10 min. La función es idempotente y no compite con el worker
-- porque solo toca status=processing (el worker SKIP LOCKED-ea
-- pending). Si por alguna razón ya hay un schedule con este nombre,
-- cron.schedule lanza error — usamos un unschedule defensivo previo.
DO $cleanup$
BEGIN
  PERFORM cron.unschedule('release-stuck-ai-grading-jobs');
EXCEPTION WHEN OTHERS THEN
  -- No existía. Ignorar.
  NULL;
END;
$cleanup$;

SELECT cron.schedule(
  'release-stuck-ai-grading-jobs',
  '*/10 * * * *',
  $$SELECT public.release_stuck_processing_jobs(30, 3);$$
);

-- ─── Descripción para el panel Cron (admin) ───────────────────────────
-- La tabla cron_job_descriptions la mantiene el admin via UI; insertamos
-- la descripción inicial para que el job nuevo aparezca con contexto en
-- vez de "sin descripción".
INSERT INTO public.cron_job_descriptions (jobname, description)
VALUES (
  'release-stuck-ai-grading-jobs',
  'Rescata jobs de calificación IA colgados en estado "procesando" por más de 30 minutos. Los devuelve a la cola pendiente para que el worker los reintente, o los marca como fallados si ya excedieron 3 intentos. Corre cada 10 minutos.'
)
ON CONFLICT (jobname) DO UPDATE
  SET description = EXCLUDED.description,
      updated_at  = now();

NOTIFY pgrst, 'reload schema';
