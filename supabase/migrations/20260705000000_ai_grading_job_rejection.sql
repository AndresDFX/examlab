-- ──────────────────────────────────────────────────────────────────────
-- Rechazo con razón de jobs de calificación IA + reconocimiento por
-- parte del docente que disparó la calificación.
--
-- Flujo nuevo:
--   1. Admin/SuperAdmin abre el panel Cron, ve un job pending/failed,
--      decide rechazarlo (ej. porque consume cuota cara o cae fuera
--      del scope académico). Antes solo había "cancelar" — ahora puede
--      "rechazar con razón" via RPC reject_ai_grading_job.
--   2. El job pasa a status='rejected' con rejection_reason + rejected_by.
--      Se crea una notification para el created_by del job (el docente
--      que lo encolo).
--   3. El docente ve el job en SU panel Cron marcado como Rechazado
--      con la razón. NO desaparece — queda visible hasta que él haga
--      ack (acknowledge_rejected_ai_grading_job).
--   4. Tras ack, el job se mueve al historial (con ambos flags poblados).
--
-- Historial = vista de jobs done/cancelled + rejected reconocidos.
-- ──────────────────────────────────────────────────────────────────────

-- ─── Columnas nuevas en ai_grading_queue ────────────────────────────
ALTER TABLE public.ai_grading_queue
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  -- acknowledged_at: cuando el docente (created_by) marcó "visto" el
  -- rechazo. Permite que un job rechazado siga apareciendo hasta que
  -- el docente lo cierre — como una conversación.
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

-- ─── Extender CHECK status para aceptar 'rejected' ──────────────────
-- El CHECK original (mig 20260603100700) era IN (pending, processing,
-- failed, done, cancelled). Agregamos rejected.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name LIKE '%ai_grading_queue_status%'
  ) THEN
    BEGIN
      ALTER TABLE public.ai_grading_queue
        DROP CONSTRAINT IF EXISTS ai_grading_queue_status_check;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END IF;
END
$$;
ALTER TABLE public.ai_grading_queue
  ADD CONSTRAINT ai_grading_queue_status_check
  CHECK (status IN ('pending', 'processing', 'failed', 'done', 'cancelled', 'rejected'));

-- ─── RPC reject_ai_grading_job ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_ai_grading_job(
  _job_id UUID,
  _reason TEXT
)
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
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;

  IF _reason IS NULL OR length(trim(_reason)) < 5 THEN
    RAISE EXCEPTION 'La razón del rechazo es obligatoria (mínimo 5 caracteres)'
      USING ERRCODE = 'P0001';
  END IF;

  SELECT id, status, course_id, created_by
    INTO _job
    FROM public.ai_grading_queue
   WHERE id = _job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job no encontrado' USING ERRCODE = 'P0001';
  END IF;

  -- Solo Admin/SuperAdmin rechazan jobs. Cualquier docente solo puede
  -- cancelar SU propio job (eso ya lo hace cancel_ai_grading_job).
  -- Rechazar implica un mensaje al docente — solo el operador de la
  -- plataforma tiene autoridad para hacerlo.
  IF public.has_role(_caller, 'Admin'::public.app_role)
     OR EXISTS (
       SELECT 1 FROM public.user_roles
        WHERE user_id = _caller AND role::text = 'SuperAdmin'
     ) THEN
    _authorized := true;
  END IF;

  IF NOT _authorized THEN
    RAISE EXCEPTION 'Solo Admin/SuperAdmin pueden rechazar jobs'
      USING ERRCODE = '42501';
  END IF;

  IF _job.status NOT IN ('pending', 'failed') THEN
    RAISE EXCEPTION 'Solo se pueden rechazar jobs pending o failed (estado actual: %)',
      _job.status USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.ai_grading_queue
     SET status = 'rejected',
         rejection_reason = trim(_reason),
         rejected_by = _caller,
         rejected_at = now(),
         completed_at = now()
   WHERE id = _job_id;

  -- Notificación al docente que encolo el job.
  IF _job.created_by IS NOT NULL THEN
    BEGIN
      INSERT INTO public.notifications (user_id, title, body, kind, link)
      VALUES (
        _job.created_by,
        'Trabajo IA rechazado por el administrador',
        format('Razón: %s. Revisa el panel Cola para cerrar la conversación.', trim(_reason)),
        'system',
        '/app/teacher/ai-cron'
      );
    EXCEPTION WHEN OTHERS THEN
      -- Si la notif falla (RLS, schema), no abortamos el reject.
      NULL;
    END;
  END IF;

  -- Audit log.
  BEGIN
    INSERT INTO public.audit_logs (
      actor_id, action, category, severity,
      entity_type, entity_id, entity_name, metadata
    ) VALUES (
      _caller,
      'ai_grading.job_rejected',
      'system',
      'warning',
      'ai_grading_queue',
      _job_id::text,
      'Job IA rechazado',
      jsonb_build_object(
        'reason', trim(_reason),
        'job_status_before', _job.status,
        'course_id', _job.course_id,
        'docente_id', _job.created_by
      )
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
END
$$;

REVOKE ALL ON FUNCTION public.reject_ai_grading_job(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reject_ai_grading_job(UUID, TEXT) TO authenticated;

-- ─── RPC acknowledge_rejected_ai_grading_job ───────────────────────
-- El docente cierra la "conversación" (acepta el rechazo). Solo el
-- created_by del job puede acusar recibo.
CREATE OR REPLACE FUNCTION public.acknowledge_rejected_ai_grading_job(_job_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _job RECORD;
  _caller UUID := auth.uid();
BEGIN
  IF _caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;

  SELECT id, status, created_by, acknowledged_at
    INTO _job
    FROM public.ai_grading_queue
   WHERE id = _job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Job no encontrado' USING ERRCODE = 'P0001';
  END IF;

  -- Solo el docente que encolo el job puede cerrarlo. Admin/SuperAdmin
  -- también, por si necesitan limpiar como soporte.
  IF _job.created_by <> _caller
     AND NOT public.has_role(_caller, 'Admin'::public.app_role)
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles
        WHERE user_id = _caller AND role::text = 'SuperAdmin'
     ) THEN
    RAISE EXCEPTION 'Solo el docente del job (o Admin) puede cerrar el rechazo'
      USING ERRCODE = '42501';
  END IF;

  IF _job.status <> 'rejected' THEN
    RAISE EXCEPTION 'Solo se acusan rechazos (estado actual: %)', _job.status
      USING ERRCODE = 'P0001';
  END IF;

  IF _job.acknowledged_at IS NOT NULL THEN
    -- Ya estaba acusado; idempotente.
    RETURN;
  END IF;

  UPDATE public.ai_grading_queue
     SET acknowledged_at = now()
   WHERE id = _job_id;
END
$$;

REVOKE ALL ON FUNCTION public.acknowledge_rejected_ai_grading_job(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acknowledge_rejected_ai_grading_job(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';
