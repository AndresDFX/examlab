-- ═══════════════════════════════════════════════════════════════════════
-- Evitar jobs DUPLICADOS en ai_grading_queue (mismo target + kind).
--
-- Problema: enqueue_ai_grading hacía INSERT directo sin deduplicar, y la
-- tabla no tenía constraint. Un re-envío de taller/proyecto (que NO cancela
-- el job previo) o una re-calificación manual encolaban OTRO job para la
-- MISMA entrega+tipo → la cola mostraba el mismo (taller/proyecto, estudiante)
-- varias veces (reportado en el tenant Camacho: workshop_full ×3, project_full
-- ×3, project_codigo_zip ×2 pendientes para la misma entrega).
--
-- NOTA: project_full y project_codigo_zip son kinds DISTINTOS de la misma
-- entrega → NO son duplicados entre sí (la dedup es por target+kind).
--
-- Fix (3 capas):
--  1. Limpieza: cancelar los duplicados existentes (deja el más reciente por
--     grupo (target_table, target_row_id, kind) entre los pending/processing).
--  2. Índice único PARCIAL sobre (target_table, target_row_id, kind) WHERE
--     status IN ('pending','processing') → backstop atómico a nivel DB.
--     Permite re-grade tras done/cancelled/rejected (esos estados no cuentan).
--  3. enqueue_ai_grading IDEMPOTENTE: si ya hay un job activo para el mismo
--     target+kind, reusa su id en vez de insertar (con handler de carrera).
--  4. requeue_ai_grading_job: guard amable si ya hay un job activo (en vez de
--     un error 23505 críptico del índice).
-- ═══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('public.ai_grading_queue') IS NULL THEN
    RETURN;
  END IF;

  -- 1) Limpieza de duplicados existentes (conserva el más reciente por grupo).
  WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY target_table, target_row_id, kind
             ORDER BY created_at DESC, id DESC
           ) AS rn
      FROM public.ai_grading_queue
     WHERE status IN ('pending', 'processing')
  )
  UPDATE public.ai_grading_queue q
     SET status = 'cancelled',
         completed_at = now(),
         last_error = 'Cancelado: job duplicado (ya había uno encolado para esta entrega y tipo).'
    FROM ranked r
   WHERE q.id = r.id AND r.rn > 1;

  -- 2) Índice único parcial (backstop). Tras la limpieza no hay colisiones.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_grading_queue_active_dedup
    ON public.ai_grading_queue (target_table, target_row_id, kind)
    WHERE status IN ('pending', 'processing');
END $$;

-- 3) enqueue_ai_grading idempotente.
CREATE OR REPLACE FUNCTION public.enqueue_ai_grading(
  _kind TEXT,
  _invoke_target TEXT,
  _body JSONB,
  _target_table TEXT,
  _target_row_id UUID,
  _field_grade TEXT DEFAULT 'ai_grade',
  _field_feedback TEXT DEFAULT 'ai_feedback',
  _field_likelihood TEXT DEFAULT NULL,
  _field_reasons TEXT DEFAULT NULL,
  _course_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _new_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- Dedup: si ya hay un job ACTIVO (pending/processing) para este mismo
  -- target + kind, reusarlo en vez de crear un duplicado. Un re-grade tras
  -- done/cancelled/rejected SÍ encola (esos estados no entran en el filtro).
  SELECT id INTO _new_id
    FROM public.ai_grading_queue
   WHERE target_table = _target_table
     AND target_row_id = _target_row_id
     AND kind = _kind
     AND status IN ('pending', 'processing')
   ORDER BY created_at ASC
   LIMIT 1;
  IF _new_id IS NOT NULL THEN
    RETURN _new_id;
  END IF;

  BEGIN
    INSERT INTO public.ai_grading_queue (
      kind, invoke_target, body,
      target_table, target_row_id,
      field_grade, field_feedback, field_likelihood, field_reasons,
      course_id, created_by, status
    ) VALUES (
      _kind, _invoke_target, _body,
      _target_table, _target_row_id,
      _field_grade, _field_feedback, _field_likelihood, _field_reasons,
      _course_id, auth.uid(), 'pending'
    ) RETURNING id INTO _new_id;
  EXCEPTION WHEN unique_violation THEN
    -- Carrera: otro encoló el mismo target+kind entre el SELECT y el INSERT.
    -- Devolvemos el job ganador en vez de fallar.
    SELECT id INTO _new_id
      FROM public.ai_grading_queue
     WHERE target_table = _target_table
       AND target_row_id = _target_row_id
       AND kind = _kind
       AND status IN ('pending', 'processing')
     ORDER BY created_at ASC
     LIMIT 1;
  END;

  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.enqueue_ai_grading(TEXT, TEXT, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_ai_grading(TEXT, TEXT, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, UUID) TO authenticated;

-- 4) requeue_ai_grading_job: rechazar con mensaje claro si ya hay un job
-- activo para el mismo target+kind (en vez del 23505 del índice).
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

  IF _job.status NOT IN ('failed', 'cancelled') THEN
    RAISE EXCEPTION 'Solo se pueden re-encolar jobs en estado failed o cancelled (estado actual: %)', _job.status;
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

-- 5) cancel_ai_grading_job: autorizar también al SuperAdmin (gestiona la cola
-- cross-tenant para soporte — antes solo Admin/creador/docente del curso, por
-- eso el SA no podía limpiar jobs de un tenant ajeno).
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

REVOKE ALL ON FUNCTION public.cancel_ai_grading_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_ai_grading_job(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
