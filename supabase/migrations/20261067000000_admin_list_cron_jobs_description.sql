-- ══════════════════════════════════════════════════════════════════════
-- admin_list_cron_jobs() se recreó (en alguna migración posterior) SIN la
-- columna `description` ni el LEFT JOIN a cron_job_descriptions → el panel
-- SuperAdmin (SupabaseCronPanel) lee `job.description` pero el RPC nunca la
-- devuelve → las descripciones humanas de los jobs NUNCA se muestran.
--
-- FIX: recrear el RPC agregando `description text` al RETURNS TABLE + LEFT JOIN
-- a public.cron_job_descriptions por jobname. Cambia el row type → hace falta
-- DROP FUNCTION antes de CREATE (Postgres no permite cambiar el RETURNS con
-- OR REPLACE). Se re-GRANTa (el DROP quita los grants). SECURITY DEFINER +
-- check has_role('SuperAdmin') interno (infra cross-tenant) sin cambios.
-- ══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.admin_list_cron_jobs();

CREATE FUNCTION public.admin_list_cron_jobs()
  RETURNS TABLE(
    jobid bigint,
    jobname text,
    schedule text,
    command text,
    active boolean,
    last_run_at timestamptz,
    last_status text,
    last_message text,
    description text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public', 'cron'
AS $fn$
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
    last_run.return_message::text AS last_message,
    d.description::text
  FROM cron.job j
  LEFT JOIN public.cron_job_descriptions d ON d.jobname = j.jobname
  LEFT JOIN LATERAL (
    SELECT r.start_time, r.status, r.return_message
      FROM cron.job_run_details r
     WHERE r.jobid = j.jobid
     ORDER BY r.start_time DESC
     LIMIT 1
  ) last_run ON TRUE
  ORDER BY j.jobname;
END
$fn$;

REVOKE ALL ON FUNCTION public.admin_list_cron_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_cron_jobs() TO authenticated;
