-- ──────────────────────────────────────────────────────────────────────
-- Permitir cancelar jobs en estado `processing`.
--
-- La migración 20260603103300 limitó `cancel_ai_grading_job` a
-- pending/failed. La razón documentada era que cancelar mid-fetch
-- dejaba a la edge function en estado inconsistente y al target_table
-- con un resultado fantasma. En la práctica:
--   - La llamada a Gemini ya está en vuelo y el costo no se recupera.
--   - Pero SI podemos evitar persistir el resultado al target_table.
--   - Y SI podemos preservar `status='cancelled'` para auditoría.
--
-- Cambios:
--   1) `cancel_ai_grading_job` ahora acepta `processing` además de
--      `pending`/`failed`. `done`/`cancelled` siguen rechazados.
--   2) `complete_ai_grading` se vuelve idempotente respecto a cancel:
--      si el job ya está `cancelled` cuando el worker termina, NO lo
--      promociona a `done`/`failed` — se queda como cancelado.
--
-- El worker hace re-check del status antes de UPDATE target_table; la
-- guardia acá es la última defensa (race en que el cancel llega entre
-- la re-lectura del worker y el complete_ai_grading).
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cancel_ai_grading_job(_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job RECORD;
  _caller UUID := auth.uid();
  _authorized BOOLEAN := false;
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT id, status, course_id, created_by
    INTO _job
    FROM public.ai_grading_queue
   WHERE id = _job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job no encontrado';
  END IF;

  IF public.has_role(_caller, 'Admin') THEN
    _authorized := true;
  ELSIF _job.created_by = _caller THEN
    _authorized := true;
  ELSIF _job.course_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.course_teachers ct
    WHERE ct.course_id = _job.course_id AND ct.user_id = _caller
  ) THEN
    _authorized := true;
  END IF;

  IF NOT _authorized THEN
    RAISE EXCEPTION 'No tienes permiso para cancelar este job';
  END IF;

  IF _job.status NOT IN ('pending', 'failed', 'processing') THEN
    RAISE EXCEPTION 'Solo se pueden cancelar jobs en estado pending, failed o processing (estado actual: %)', _job.status;
  END IF;

  UPDATE public.ai_grading_queue
     SET status = 'cancelled',
         completed_at = COALESCE(completed_at, now())
   WHERE id = _job_id;
END
$$;

-- complete_ai_grading: respeta cancel preexistente. La cláusula
-- `WHERE status <> 'cancelled'` evita la transición cancelled→done/failed
-- cuando el worker termina y llama complete después de que el user ya
-- canceló. Sin esto el job aparece como done/failed en el grid y se
-- pierde la traza de la cancelación.
CREATE OR REPLACE FUNCTION public.complete_ai_grading(
  _job_id UUID,
  _ok BOOLEAN,
  _error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.ai_grading_queue
     SET status = CASE WHEN _ok THEN 'done' ELSE 'failed' END,
         last_error = _error,
         completed_at = now()
   WHERE id = _job_id
     AND status <> 'cancelled';
END
$$;

NOTIFY pgrst, 'reload schema';
