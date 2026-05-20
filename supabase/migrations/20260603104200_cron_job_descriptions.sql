-- ──────────────────────────────────────────────────────────────────────
-- Descripciones humanas para los pg_cron jobs.
--
-- Por qué: la tabla `extensions.cron.job` solo guarda jobname, schedule
-- y command (SQL crudo). En el panel admin del módulo "Cron" eso le
-- dice al admin QUÉ se ejecuta pero no PARA QUÉ — y los nombres son
-- siglas (`exam-window-opens`, `retry-failed-ai-gradings`) que no
-- explican el propósito ni qué pasa si los pausa.
--
-- Solución: tabla `public.cron_job_descriptions` con (jobname,
-- description). La RPC `admin_list_cron_jobs` ahora hace LEFT JOIN para
-- traer la descripción si existe. Jobs sin fila quedan con descripción
-- vacía — la UI muestra "(sin descripción)".
--
-- Seed inicial: descripciones de los jobs canónicos (los registrados
-- desde supabase/cron/setup.sql + el ai-grading-worker-hourly de la
-- migración 20260603100800).
--
-- Si en el futuro se agrega un cron nuevo, se debe sembrar la fila aquí
-- en una migración adicional o vía UI (TODO: editor de descripción).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.cron_job_descriptions (
  jobname     TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID REFERENCES auth.users(id)
);

COMMENT ON TABLE public.cron_job_descriptions IS
  'Descripciones legibles para los jobs registrados en extensions.cron.job. PK = jobname.';

-- RLS — read abierto a autenticados (la UI del módulo Cron las pinta);
-- write solo Admin (consistente con admin_set_cron_job_active / update_schedule).
ALTER TABLE public.cron_job_descriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cron_job_desc_read_all" ON public.cron_job_descriptions;
CREATE POLICY "cron_job_desc_read_all"
  ON public.cron_job_descriptions FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "cron_job_desc_admin_write" ON public.cron_job_descriptions;
CREATE POLICY "cron_job_desc_admin_write"
  ON public.cron_job_descriptions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- Seed: descripciones de los jobs conocidos. ON CONFLICT DO UPDATE para
-- que re-correr esta migración refresque el texto (idempotente).
INSERT INTO public.cron_job_descriptions (jobname, description) VALUES
  (
    'ai-grading-worker-hourly',
    'Cada hora invoca el edge function `ai-grading-worker`, que drena la cola `ai_grading_queue` (entregas marcadas para calificar con IA). Sin este job, las calificaciones IA quedan pendientes hasta que el admin pulse "Procesar ahora" desde el módulo Cron → tab IA.'
  ),
  (
    'exam-reminders-1h',
    'Cada 10 minutos avisa a los estudiantes cuando un examen al que están asignados arranca en la próxima hora. Pausarlo deja al estudiante sin el recordatorio (push + email) — sigue viendo el examen en el dashboard.'
  ),
  (
    'exam-window-opens',
    'Cada 15 minutos notifica a los estudiantes cuando se ABRE la ventana de un examen (llegó el `start_time`). Idempotencia interna de 12h evita avisos duplicados si el cron corre varias veces durante la ventana.'
  ),
  (
    'workshop-due-24h',
    'Cada 2 horas avisa a los estudiantes que tienen un taller que vence en las próximas 24h y todavía no han entregado. Estudiantes con entrega final no reciben el aviso.'
  ),
  (
    'project-due-24h',
    'Cada 2 horas avisa a los estudiantes que tienen un proyecto que vence en las próximas 24h y todavía no han entregado.'
  ),
  (
    'teacher-exam-prep-1h',
    'Cada 10 minutos avisa al docente si tiene un examen que arranca en la próxima hora y aún quedan notas de apoyo (chuletas) en estado `pendiente` por aprobar/rechazar.'
  ),
  (
    'teacher-daily-summary',
    'Diario a las 04:00 UTC (23:00 Colombia). Envía al docente un resumen del día: entregas nuevas, exámenes calificados, alertas de fraude detectadas, etc.'
  ),
  (
    'admin-storage-threshold',
    'Cada 6 horas chequea el uso de DB + Storage contra el umbral configurado en `system_settings`. Si supera el threshold, notifica a los admins. Idempotencia 1/día por admin evita spam si el almacenamiento queda alto varios días.'
  ),
  (
    'audit-logs-purge',
    'A las 03:00 UTC el día 1 de cada mes. Purga `audit_logs` según los días de retención por severidad configurados en `audit_retention_settings`. Default 0/0/0 = no purgar — el cron corre pero no borra nada hasta que el admin configure los días.'
  ),
  (
    'email-alert-threshold',
    'Cada 30 minutos revisa si los correos enviados en las últimas 24h exceden el umbral configurado en `app_settings.email_alert_threshold` (0 = desactivado). Notifica a los admins si lo excede para detectar bucles de envío o ataques de spam.'
  ),
  (
    'retry-failed-ai-gradings',
    'Cada 30 minutos busca submissions con `ai_error` en el breakdown (Gemini 429 o error transitorio) y las recalifica vía edge `retry-failed-ai-gradings`. Cooldown interno de 30 min evita reintentar la misma submission más de una vez por hora.'
  )
ON CONFLICT (jobname) DO UPDATE
  SET description = EXCLUDED.description,
      updated_at  = now();

-- Reemplaza admin_list_cron_jobs para incluir description en el SELECT.
-- El cambio es aditivo (nueva columna al final del RETURNS) — el cliente
-- viejo simplemente no la lee.
CREATE OR REPLACE FUNCTION public.admin_list_cron_jobs()
RETURNS TABLE(
  jobid        BIGINT,
  jobname      TEXT,
  schedule     TEXT,
  command      TEXT,
  active       BOOLEAN,
  last_run_at  TIMESTAMPTZ,
  last_status  TEXT,
  last_message TEXT,
  description  TEXT
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
    last_run.return_message::text AS last_message,
    d.description::text
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT r.start_time, r.status, r.return_message
      FROM cron.job_run_details r
     WHERE r.jobid = j.jobid
     ORDER BY r.start_time DESC
     LIMIT 1
  ) last_run ON TRUE
  LEFT JOIN public.cron_job_descriptions d ON d.jobname = j.jobname
  ORDER BY j.jobname;
END
$$;

REVOKE ALL ON FUNCTION public.admin_list_cron_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_list_cron_jobs() TO authenticated;

-- Nueva RPC para que el admin pueda EDITAR la descripción desde la UI
-- sin tener que tocar SQL. Upsert por jobname.
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
  IF NOT public.has_role(auth.uid(), 'Admin') THEN
    RAISE EXCEPTION 'Solo Admin puede editar descripciones de cron jobs';
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

REVOKE ALL ON FUNCTION public.admin_set_cron_job_description(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_set_cron_job_description(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
