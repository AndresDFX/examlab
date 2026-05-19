-- ──────────────────────────────────────────────────────────────────────
-- RPC: cancel_ai_grading_job
--
-- Marca un job de `ai_grading_queue` como `cancelled` para que:
--   - El worker hourly NO lo levante (filtra status='pending').
--   - Quede en audit (row preservada con status='cancelled', NO se borra).
--   - El widget lo deje de mostrar (filtramos pending/processing/failed).
--
-- Solo se puede cancelar un job en estado pending o failed. Procesando
-- y done NO se cancelan:
--   - processing: el worker ya lo tomó; cancelar a mitad de fetch a
--     Gemini deja a la edge function en estado inconsistente. Mejor
--     esperar a que termine y revisar el resultado.
--   - done: el resultado ya está aplicado; cancelar no deshace nada.
--
-- Permisos en cascada (igual que requeue_ai_grading_job):
--   - Admin                            → siempre.
--   - Owner del job (created_by = uid) → docente que disparó la calif.
--   - Docente del curso del job        → si course_id está poblado.
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

  IF _job.status NOT IN ('pending', 'failed') THEN
    RAISE EXCEPTION 'Solo se pueden cancelar jobs en estado pending o failed (estado actual: %)', _job.status;
  END IF;

  UPDATE public.ai_grading_queue
     SET status = 'cancelled',
         completed_at = COALESCE(completed_at, now())
   WHERE id = _job_id;
END
$$;

REVOKE ALL ON FUNCTION public.cancel_ai_grading_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_ai_grading_job(UUID) TO authenticated;

-- ─── Variante de claim para procesamiento individual ─────────────────
-- El worker actual usa claim_pending_ai_grading(limit) para reclamar
-- el batch oldest-first. Necesitamos también claim de UN job específico
-- por ID — útil cuando un docente clickea "Procesar este" en el widget
-- en vez de esperar al cron. Atómico (FOR UPDATE) para que dos clicks
-- simultáneos no procesen el mismo job dos veces.
CREATE OR REPLACE FUNCTION public.claim_one_ai_grading(_job_id UUID)
RETURNS TABLE (
  id UUID,
  kind TEXT,
  invoke_target TEXT,
  body JSONB,
  target_table TEXT,
  target_row_id UUID,
  field_grade TEXT,
  field_feedback TEXT,
  field_likelihood TEXT,
  field_reasons TEXT,
  attempts INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT q.id
    FROM public.ai_grading_queue q
    WHERE q.id = _job_id AND q.status = 'pending'
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ai_grading_queue q
     SET status = 'processing',
         started_at = now(),
         attempts = q.attempts + 1
   WHERE q.id IN (SELECT id FROM picked)
   RETURNING q.id, q.kind, q.invoke_target, q.body, q.target_table, q.target_row_id,
             q.field_grade, q.field_feedback, q.field_likelihood, q.field_reasons,
             q.attempts;
END
$$;

REVOKE ALL ON FUNCTION public.claim_one_ai_grading(UUID) FROM PUBLIC;
-- service_role para que el worker lo llame; authenticated NO necesita
-- llamarlo directo (el flow es: widget → invoke ai-grading-worker → claim).
GRANT EXECUTE ON FUNCTION public.claim_one_ai_grading(UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
