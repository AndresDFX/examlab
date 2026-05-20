-- ──────────────────────────────────────────────────────────────────────
-- Gestión de pg_cron desde el panel Admin (módulo "Cron IA" → tab Supabase).
--
-- Expone TRES RPCs Admin-only para ver y modificar los cron jobs
-- registrados con `extensions.cron.schedule(...)`. La RPC de lectura ya
-- existía como `system_cron_jobs()` pero (a) estaba pensada para que el
-- edge function `health-check` la llamara con service_role, sin exponer
-- `jobid`, y (b) no había forma de mutarla desde la app. Eso quedaba
-- como tarea "ve al SQL editor de Supabase" cada vez que el admin
-- quería activar / desactivar / cambiar la frecuencia de un job.
--
-- Decisiones de diseño:
--
--   • Solo se permite modificar `schedule` y `active`. Editar `command`
--     (el SQL que ejecuta el job) es demasiado riesgoso para hacerlo
--     desde una UI — un typo deja un cron rota o, peor, ejecutando algo
--     no intencional cada minuto. Si el admin necesita cambiar el
--     comando, lo hace por migración como hasta ahora.
--
--   • No se permite crear ni borrar jobs desde la UI (igual razonamiento:
--     los jobs están versionados como migraciones SQL). El alcance es
--     "ya existe, lo quiero pausar o reagendar".
--
--   • Auditoría: cada cambio se persiste vía `log_audit_event` con
--     category='system' para que aparezca en /app/admin/audit-logs.
--
--   • Tolerancia a pg_cron ausente: la RPC de lectura devuelve set vacío
--     si la extensión no está instalada (entornos locales / dev). Las
--     RPCs de mutación lanzan error con mensaje claro si pg_cron no
--     está — no es un caso normal y queremos visibilidad.
-- ──────────────────────────────────────────────────────────────────────

-- 1) ─────────────────────────────────────────────── admin_list_cron_jobs
-- Variante de system_cron_jobs que (a) devuelve `jobid` (necesario para
-- mutar el job vía cron.alter_job) y (b) requiere rol Admin en lugar
-- de service_role. Reutiliza la misma forma del resto del cuerpo.
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
  IF NOT public.has_role(auth.uid(), 'Admin') THEN
    RAISE EXCEPTION 'Solo Admin puede listar cron jobs';
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

REVOKE ALL ON FUNCTION public.admin_list_cron_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_cron_jobs() TO authenticated;

-- 2) ─────────────────────────────── admin_set_cron_job_active(jobid, active)
-- Toggle on/off de un job. Internamente `cron.alter_job` recibe el
-- parámetro `active`. Cuando active=false el job sigue registrado pero
-- no se dispara más hasta que se vuelva a activar.
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
  IF NOT public.has_role(auth.uid(), 'Admin') THEN
    RAISE EXCEPTION 'Solo Admin puede modificar cron jobs';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') INTO v_cron_exists;
  IF NOT v_cron_exists THEN
    RAISE EXCEPTION 'pg_cron no está instalado en este proyecto';
  END IF;

  SELECT jobname INTO v_jobname FROM cron.job WHERE jobid = _jobid;
  IF v_jobname IS NULL THEN
    RAISE EXCEPTION 'No existe el cron job con jobid=%', _jobid;
  END IF;

  -- cron.alter_job no tiene un retorno útil (void), así que sólo
  -- propagamos errores. El client refresca después y verá active actual.
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

REVOKE ALL ON FUNCTION public.admin_set_cron_job_active(BIGINT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_cron_job_active(BIGINT, BOOLEAN) TO authenticated;

-- 3) ─────────────────────────── admin_update_cron_job_schedule(jobid, schedule)
-- Cambia la expresión cron de un job. Validamos que la expresión tenga
-- al menos 5 tokens separados por espacio (formato cron clásico
-- "m h dom mon dow"). Si la expresión es inválida, cron.alter_job
-- propaga el error real con detalle — no replicamos la lógica acá.
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
  IF NOT public.has_role(auth.uid(), 'Admin') THEN
    RAISE EXCEPTION 'Solo Admin puede modificar cron jobs';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') INTO v_cron_exists;
  IF NOT v_cron_exists THEN
    RAISE EXCEPTION 'pg_cron no está instalado en este proyecto';
  END IF;

  -- Validación liviana: 5 tokens o el formato "@hourly", "@daily", etc.
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

REVOKE ALL ON FUNCTION public.admin_update_cron_job_schedule(BIGINT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_cron_job_schedule(BIGINT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
