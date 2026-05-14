-- ──────────────────────────────────────────────────────────────────────
-- 1) Recordatorios de talleres y proyectos próximos a vencer.
-- 2) RPC de diagnóstico para listar pg_cron jobs.
--
-- Patrón de los recordatorios: idéntico al de exámenes
-- (`notify_students_exam_starting_soon`). Idempotencia por usuario+
-- titulo en una ventana de 6h (más holgada que el examen porque la
-- granularidad de "vence en N horas" es de un día, no de 1h).
--
-- IMPORTANTE — extensión de CRITICAL_KINDS: para que estos avisos
-- disparen correo, agregamos 'workshop' y 'project' a la lista del
-- predicado `_notification_kind_emails`. Hoy no hay notificaciones en
-- el sistema que usen esos kinds (el grading usa kind='grade', las
-- asignaciones de exam usan 'exam'); así que es un cambio aditivo
-- seguro.
-- ──────────────────────────────────────────────────────────────────────

-- 1a) ─────────────────── Ampliar el filtro de kinds que mandan correo

CREATE OR REPLACE FUNCTION public._notification_kind_emails(
  _kind TEXT,
  _link TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project')
    OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%');
$$;

-- 1b) ─────────────────── Recordatorio para talleres

CREATE OR REPLACE FUNCTION public.notify_students_workshop_due_soon(
  _hours INTEGER DEFAULT 24
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count INTEGER;
BEGIN
  IF _hours IS NULL OR _hours < 1 OR _hours > 168 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT
    wa.user_id,
    'Tu taller "' || w.title || '" vence pronto',
    'El taller del curso "' || COALESCE(c.name, 'sin curso') ||
      '" vence en menos de ' || _hours || ' hora(s). Entrega antes del cierre.',
    'workshop',
    '/app/student/workshops'
  FROM public.workshops w
  LEFT JOIN public.courses c ON c.id = w.course_id
  JOIN public.workshop_assignments wa ON wa.workshop_id = w.id
  WHERE w.due_date IS NOT NULL
    AND w.due_date > NOW()
    AND w.due_date <= NOW() + make_interval(hours => _hours)
    AND w.status = 'published'
    -- Exclusión 1: ya entregaron
    AND NOT EXISTS (
      SELECT 1 FROM public.workshop_submissions s
       WHERE s.workshop_id = w.id
         AND s.user_id = wa.user_id
         AND s.status IN ('entregado', 'calificado', 'ai_revisado')
    )
    -- Exclusión 2: ya se notificó en las últimas 6h
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.user_id = wa.user_id
         AND n.title = 'Tu taller "' || w.title || '" vence pronto'
         AND n.created_at > NOW() - INTERVAL '6 hours'
    );

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END
$$;

REVOKE ALL ON FUNCTION public.notify_students_workshop_due_soon(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_students_workshop_due_soon(INTEGER) TO service_role;

-- 1c) ─────────────────── Recordatorio para proyectos
-- Los proyectos tienen DOS vías de asignación al estudiante:
--   - project_assignments (explícito por usuario)
--   - project_courses → course_enrollments (todos los matriculados al curso)
-- Hacemos UNION DISTINCT para no duplicar si el alumno está en ambas.

CREATE OR REPLACE FUNCTION public.notify_students_project_due_soon(
  _hours INTEGER DEFAULT 24
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count INTEGER;
BEGIN
  IF _hours IS NULL OR _hours < 1 OR _hours > 168 THEN
    RETURN 0;
  END IF;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  SELECT DISTINCT
    target.user_id,
    'Tu proyecto "' || p.title || '" vence pronto',
    'El proyecto vence en menos de ' || _hours || ' hora(s). Entrega antes del cierre.',
    'project',
    '/app/student/projects'
  FROM public.projects p
  CROSS JOIN LATERAL (
    SELECT pa.user_id
      FROM public.project_assignments pa
     WHERE pa.project_id = p.id
    UNION
    SELECT ce.user_id
      FROM public.project_courses pc
      JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
     WHERE pc.project_id = p.id
  ) target
  WHERE p.due_date IS NOT NULL
    AND p.due_date > NOW()
    AND p.due_date <= NOW() + make_interval(hours => _hours)
    AND p.status = 'published'
    AND NOT EXISTS (
      SELECT 1 FROM public.project_submissions s
       WHERE s.project_id = p.id
         AND s.user_id = target.user_id
         AND s.status IN ('entregado', 'calificado', 'ai_revisado')
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.user_id = target.user_id
         AND n.title = 'Tu proyecto "' || p.title || '" vence pronto'
         AND n.created_at > NOW() - INTERVAL '6 hours'
    );

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END
$$;

REVOKE ALL ON FUNCTION public.notify_students_project_due_soon(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_students_project_due_soon(INTEGER) TO service_role;

-- 2) ─────────────────────────────────── RPC system_cron_jobs

CREATE OR REPLACE FUNCTION public.system_cron_jobs()
RETURNS TABLE(
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
  -- Defensa: si pg_cron no está habilitado en este Supabase, retornamos
  -- empty sin error. El panel pinta "Sin cron jobs" o equivalente.
  SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') INTO v_cron_exists;
  IF NOT v_cron_exists THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    j.jobname::text,
    j.schedule::text,
    j.command::text,
    j.active::boolean,
    -- Última ejecución: LATERAL subselect por jobid. La tabla
    -- job_run_details crece — el ORDER BY DESC LIMIT 1 pega un índice
    -- sobre jobid.
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

REVOKE ALL ON FUNCTION public.system_cron_jobs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.system_cron_jobs() TO service_role;

NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────── Programación recordada
-- Después de aplicar esta migración, registrá los nuevos cron jobs:
--
--   SELECT cron.schedule(
--     'workshop-due-24h',
--     '0 */2 * * *',  -- cada 2 horas
--     $$ SELECT public.notify_students_workshop_due_soon(24); $$
--   );
--
--   SELECT cron.schedule(
--     'project-due-24h',
--     '0 */2 * * *',
--     $$ SELECT public.notify_students_project_due_soon(24); $$
--   );
--
-- Cada 2h es más laxo que el examen (cada 10 min) porque los talleres
-- y proyectos tienen vencimientos de días, no minutos. La idempotencia
-- de 6h cubre los reintentos sin duplicar al alumno.
