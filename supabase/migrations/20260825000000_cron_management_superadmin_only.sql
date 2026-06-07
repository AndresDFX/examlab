-- ──────────────────────────────────────────────────────────────────────
-- Cron management RPCs: Admin → SuperAdmin-only.
--
-- Las 4 RPCs creadas en 20260603104000 + 20260603104200 chequeaban
-- `has_role(auth.uid(), 'Admin')`. Pero `pg_cron` es infraestructura
-- CROSS-TENANT — un Admin de tenant NO debería poder pausar / reagendar
-- jobs que afectan a TODAS las instituciones de la plataforma.
--
-- Síntoma reportado: el SuperAdmin entra a `/app/admin/ai-cron` →
-- tab "Tareas programadas" y ve "Solo Admin puede listar cron jobs",
-- porque la cuenta es SuperAdmin pura (sin Admin role asignado), y
-- el guard rechaza.
--
-- Fix:
--   1. Cambiar `has_role(...,'Admin')` → `has_role(...,'SuperAdmin')`
--      en las 4 RPCs.
--   2. Actualizar los mensajes de error para reflejar el nuevo gate.
--   3. La UI ya gatea la tab por `roles.includes("SuperAdmin")` en
--      `app.admin.ai-cron.tsx`, así que un Admin normal nunca llega a
--      llamar estas RPCs.
-- ──────────────────────────────────────────────────────────────────────

-- 1) admin_list_cron_jobs — solo SuperAdmin lista.
CREATE OR REPLACE FUNCTION public.admin_list_cron_jobs()
RETURNS TABLE(
  jobid        BIGINT,
  jobname      TEXT,
  schedule     TEXT,
  command      TEXT,
  active       BOOLEAN,
  last_run_at  TIMESTAMPTZ,
  last_status  TEXT,
  last_message TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
DECLARE
  v_cron_exists boolean;
BEGIN
  IF NOT public.has_role(auth.uid(), 'SuperAdmin') THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede listar cron jobs (infra cross-tenant)';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') INTO v_cron_exists;
  IF NOT v_cron_exists THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    j.jobid::bigint,
    j.jobname::text,
    j.schedule::text,
    j.command::text,
    j.active::boolean,
    last_run.start_time AS last_run_at,
    last_run.status::text AS last_status,
    last_run.return_message::text AS last_message
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT r.start_time, r.status, r.return_message
      FROM cron.job_run_details r
     WHERE r.jobid = j.jobid
     ORDER BY r.start_time DESC
     LIMIT 1
  ) last_run ON TRUE
  ORDER BY j.jobname;
END
$$;

-- 2) admin_set_cron_job_active — solo SuperAdmin pausa/reanuda.
CREATE OR REPLACE FUNCTION public.admin_set_cron_job_active(
  _jobid  BIGINT,
  _active BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
DECLARE
  v_cron_exists BOOLEAN;
  v_jobname     TEXT;
BEGIN
  IF NOT public.has_role(auth.uid(), 'SuperAdmin') THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede modificar cron jobs (infra cross-tenant)';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') INTO v_cron_exists;
  IF NOT v_cron_exists THEN
    RAISE EXCEPTION 'pg_cron no está instalado en este proyecto';
  END IF;

  SELECT jobname INTO v_jobname FROM cron.job WHERE jobid = _jobid;
  IF v_jobname IS NULL THEN
    RAISE EXCEPTION 'No existe el cron job con jobid=%', _jobid;
  END IF;

  PERFORM cron.alter_job(job_id := _jobid, active := _active);

  PERFORM public.log_audit_event(
    p_action      => CASE WHEN _active THEN 'cron.activated' ELSE 'cron.deactivated' END,
    p_category    => 'system',
    p_severity    => 'info',
    p_entity_type => 'cron_job',
    p_entity_id   => _jobid::text,
    p_entity_name => v_jobname,
    p_metadata    => jsonb_build_object('active', _active)
  );

  RETURN TRUE;
END
$$;

-- 3) admin_update_cron_job_schedule — solo SuperAdmin reagenda.
CREATE OR REPLACE FUNCTION public.admin_update_cron_job_schedule(
  _jobid    BIGINT,
  _schedule TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, cron
AS $$
DECLARE
  v_cron_exists BOOLEAN;
  v_jobname     TEXT;
  v_old         TEXT;
  v_tokens      INTEGER;
BEGIN
  IF NOT public.has_role(auth.uid(), 'SuperAdmin') THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede modificar cron jobs (infra cross-tenant)';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') INTO v_cron_exists;
  IF NOT v_cron_exists THEN
    RAISE EXCEPTION 'pg_cron no está instalado en este proyecto';
  END IF;

  IF _schedule IS NULL OR length(trim(_schedule)) = 0 THEN
    RAISE EXCEPTION 'La expresión cron no puede estar vacía';
  END IF;

  v_tokens := array_length(string_to_array(trim(regexp_replace(_schedule, '\s+', ' ', 'g')), ' '), 1);
  IF NOT (
    v_tokens IN (5, 6)
    OR _schedule ~ '^@(hourly|daily|weekly|monthly|yearly|annually|reboot)$'
  ) THEN
    RAISE EXCEPTION 'Expresión cron inválida: "%". Esperaba 5 campos ("m h dom mon dow") o un alias @hourly/@daily/...', _schedule;
  END IF;

  SELECT jobname, schedule INTO v_jobname, v_old FROM cron.job WHERE jobid = _jobid;
  IF v_jobname IS NULL THEN
    RAISE EXCEPTION 'No existe el cron job con jobid=%', _jobid;
  END IF;

  PERFORM cron.alter_job(job_id := _jobid, schedule := _schedule);

  PERFORM public.log_audit_event(
    p_action      => 'cron.schedule_updated',
    p_category    => 'system',
    p_severity    => 'info',
    p_entity_type => 'cron_job',
    p_entity_id   => _jobid::text,
    p_entity_name => v_jobname,
    p_metadata    => jsonb_build_object('old_schedule', v_old, 'new_schedule', _schedule)
  );

  RETURN TRUE;
END
$$;

-- 4) admin_set_cron_job_description — solo SuperAdmin edita descripción.
CREATE OR REPLACE FUNCTION public.admin_set_cron_job_description(
  _jobname     TEXT,
  _description TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), 'SuperAdmin') THEN
    RAISE EXCEPTION 'Solo SuperAdmin puede editar descripciones de cron jobs (infra cross-tenant)';
  END IF;

  IF _jobname IS NULL OR length(trim(_jobname)) = 0 THEN
    RAISE EXCEPTION 'jobname requerido';
  END IF;

  INSERT INTO public.cron_job_descriptions (jobname, description, updated_by)
  VALUES (_jobname, COALESCE(_description, ''), auth.uid())
  ON CONFLICT (jobname) DO UPDATE
    SET description = EXCLUDED.description,
        updated_by  = EXCLUDED.updated_by,
        updated_at  = now();

  PERFORM public.log_audit_event(
    p_action      => 'cron.description_updated',
    p_category    => 'system',
    p_severity    => 'info',
    p_entity_type => 'cron_job',
    p_entity_name => _jobname
  );

  RETURN TRUE;
END
$$;

NOTIFY pgrst, 'reload schema';
