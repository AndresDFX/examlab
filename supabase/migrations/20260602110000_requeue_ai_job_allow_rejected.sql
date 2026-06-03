-- ──────────────────────────────────────────────────────────────────────
-- requeue_ai_grading_job: aceptar 'rejected' + limpiar metadata de rechazo.
--
-- Antes solo se podían reanudar jobs en estado 'failed' o 'cancelled'.
-- Si un Admin/SuperAdmin había rechazado un job con razón, el Docente
-- (que acusó recibo) no tenía cómo darle una segunda chance — su único
-- camino era encolar un job nuevo desde el flujo original.
--
-- Cambio:
--   1. Whitelist amplía a ('failed', 'cancelled', 'rejected').
--   2. Al re-encolar, limpiamos rejection_reason / rejected_by /
--      rejected_at / acknowledged_at — el job vuelve a empezar de cero
--      sin que la conversación vieja contamine la nueva pasada.
--   3. Misma autorización (Admin del tenant / creator / docente del
--      curso). Notar que un Docente PUEDE re-encolar un job que el
--      Admin rechazó — es intencional: el Docente acusó recibo, decidió
--      reintentar, asume el costo. Si el Admin quiere bloquear esto,
--      lo correcto es no encolar el job en lugar de rechazarlo.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.requeue_ai_grading_job(_job_id UUID)
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

  -- Permisos en cascada — primer match gana.
  IF public.has_role(_caller, 'Admin') THEN
    _authorized := true;
  ELSIF public.is_super_admin() THEN
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
    RAISE EXCEPTION 'No tienes permiso para re-encolar este job';
  END IF;

  -- Solo se reencolan jobs en estado terminal. Reintentar un job en
  -- 'pending' o 'processing' no tiene sentido y podría crear race
  -- conditions con el worker. 'done' tampoco — el resultado ya está
  -- aplicado a la entrega; re-calificar va por otro flujo.
  IF _job.status NOT IN ('failed', 'cancelled', 'rejected') THEN
    RAISE EXCEPTION 'Solo se pueden re-encolar jobs en estado failed, cancelled o rejected (estado actual: %)', _job.status;
  END IF;

  -- Reset a pending + limpiar metadata residual. Si venía de 'rejected',
  -- las columnas rejection_* y acknowledged_at se limpian para que el
  -- nuevo intento no muestre el banner naranja del rechazo viejo.
  UPDATE public.ai_grading_queue
     SET status = 'pending',
         attempts = 0,
         last_error = NULL,
         started_at = NULL,
         completed_at = NULL,
         rejection_reason = NULL,
         rejected_by = NULL,
         rejected_at = NULL,
         acknowledged_at = NULL
   WHERE id = _job_id;
END
$$;

REVOKE ALL ON FUNCTION public.requeue_ai_grading_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.requeue_ai_grading_job(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
