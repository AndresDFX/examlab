-- ═══════════════════════════════════════════════════════════════════════
-- Cola IA: "Volver a la cola" (re-encolar) vs "Eliminar" (borrar definitivo).
--
-- Contexto: el botón bulk "Cancelar" del panel marcaba los jobs como
-- 'cancelled' (salen de la vista de activos → el usuario lo percibe como un
-- borrado). Lo que se quiere para los jobs ATASCADOS en 'processing' es
-- DEVOLVERLOS a la cola ('pending') para que el worker los reintente, sin
-- perderlos. Y por separado, una acción que SÍ borre el registro.
--
-- Cambios:
--  1. requeue_ai_grading_job: ahora también acepta 'processing' (libera un job
--     atascado en proceso → 'pending'). Antes solo failed/cancelled, así que
--     un job colgado no se podía rescatar selectivamente (solo vía el release
--     global por umbral de tiempo). El guard de dedup se mantiene.
--  2. delete_ai_grading_job: NUEVO. Borra FÍSICAMENTE la fila de la cola.
--     Misma autorización que cancel (Admin/SA/creador/docente del curso).
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.ai_grading_queue') IS NULL THEN
    RETURN;
  END IF;
END $$;

-- 1) requeue_ai_grading_job — aceptar 'processing' además de failed/cancelled.
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

  SELECT id, status, course_id, created_by, target_table, target_row_id, kind
    INTO _job
    FROM public.ai_grading_queue
   WHERE id = _job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job no encontrado';
  END IF;

  IF public.has_role(_caller, 'Admin') OR public.is_super_admin() THEN
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

  -- 'processing' incluido: liberar un job atascado de vuelta a la cola.
  IF _job.status NOT IN ('failed', 'cancelled', 'processing') THEN
    RAISE EXCEPTION 'Solo se pueden re-encolar jobs en estado failed, cancelled o processing (estado actual: %)', _job.status;
  END IF;

  -- No re-encolar si ya hay OTRO job activo para la misma entrega+tipo
  -- (el índice único parcial lo rechazaría con un error críptico).
  IF EXISTS (
    SELECT 1 FROM public.ai_grading_queue q2
     WHERE q2.id <> _job_id
       AND q2.target_table = _job.target_table
       AND q2.target_row_id = _job.target_row_id
       AND q2.kind = _job.kind
       AND q2.status IN ('pending', 'processing')
  ) THEN
    RAISE EXCEPTION 'Ya hay un job activo para esta entrega; espera a que termine en vez de re-encolar.'
      USING ERRCODE = 'P0001';
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

-- 2) delete_ai_grading_job — borrado físico de la fila de la cola.
CREATE OR REPLACE FUNCTION public.delete_ai_grading_job(_job_id UUID)
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

  SELECT id, course_id, created_by
    INTO _job
    FROM public.ai_grading_queue
   WHERE id = _job_id;

  IF NOT FOUND THEN
    -- Idempotente: si ya no existe, no es un error (otra pestaña lo borró).
    RETURN;
  END IF;

  IF public.has_role(_caller, 'Admin') OR public.is_super_admin() THEN
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
    RAISE EXCEPTION 'No tienes permiso para eliminar este job';
  END IF;

  DELETE FROM public.ai_grading_queue WHERE id = _job_id;
END
$$;

REVOKE ALL ON FUNCTION public.delete_ai_grading_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_ai_grading_job(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
