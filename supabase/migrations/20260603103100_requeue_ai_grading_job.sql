-- ──────────────────────────────────────────────────────────────────────
-- RPC: requeue_ai_grading_job
--
-- Re-encola un job de `ai_grading_queue` que está en status='failed'
-- (o 'cancelled') para que el worker lo vuelva a procesar en su próxima
-- corrida. Reinicia el estado del job: status='pending', attempts=0,
-- limpia error y timestamps.
--
-- Antes el comentario del worker decía "el admin puede re-encolar con
-- UPDATE manual". Esto cierra ese loop con una RPC que cualquier rol
-- autorizado puede invocar desde el dashboard, sin acceso directo a SQL.
--
-- Autorización (mismo modelo que el SELECT policy del queue):
--   - Admin                            → siempre.
--   - Docente del curso del job        → si course_id está poblado y
--                                         enseña ese curso.
--   - Owner del job (created_by = uid) → docente que disparó la calif.
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

  -- Solo se reencolan jobs en estado terminal de error. Reintenter
  -- un job en 'pending' o 'processing' no tiene sentido y podría
  -- crear race conditions con el worker. 'done' tampoco — el resultado
  -- ya está aplicado.
  IF _job.status NOT IN ('failed', 'cancelled') THEN
    RAISE EXCEPTION 'Solo se pueden re-encolar jobs en estado failed o cancelled (estado actual: %)', _job.status;
  END IF;

  UPDATE public.ai_grading_queue
     SET status = 'pending',
         attempts = 0,
         last_error = NULL,
         started_at = NULL,
         completed_at = NULL
   WHERE id = _job_id;
END
$$;

REVOKE ALL ON FUNCTION public.requeue_ai_grading_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.requeue_ai_grading_job(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
