-- ══════════════════════════════════════════════════════════════════════
-- Sesiones autónomas: notificación al inicio + "asistió si revisó el material".
--
-- 1) Kind emailable nuevo 'session_start' (predicado _notification_kind_emails).
-- 2) notify_autonomous_sessions_starting(): cron cada minuto que, al llegar la
--    fecha/hora de inicio de una sesión AUTÓNOMA, notifica a los alumnos
--    matriculados para que revisen el material. Idempotente (notified_start_at).
-- 3) student_review_autonomous_session(): el alumno "asiste" a una sesión
--    autónoma marcando el material como revisado → attendance_record 'presente'.
--    (Decisión de negocio: la autónoma cuenta como asistió si el alumno revisa.)
-- 4) Toggle email_settings.enabled_kinds.session_start (default ON).
--
-- INVARIANTE de 3 lados del predicado kind→email: este SQL agrega 'session_start'
-- a public._notification_kind_emails; hay que sincronizar
-- supabase/functions/send-email/index.ts (CRITICAL_KINDS) y
-- src/modules/notifications/notification-email.ts (CRITICAL_KINDS).
-- ══════════════════════════════════════════════════════════════════════

-- 1) Predicado central "este kind emaila" + 'session_start'. CREATE OR REPLACE
--    con misma firma; se replica el cuerpo vigente (mig 20261110000000).
DO $$
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public._notification_kind_emails(_kind text, _link text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $fn$
        SELECT
          _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'attendance', 'broadcast', 'course_welcome', 'session_start')
          OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%')
          OR (
            _kind = 'support'
            AND COALESCE(
              (SELECT ps.support_emails_enabled FROM public.platform_settings ps WHERE ps.id = 1),
              true
            )
          );
      $fn$;
  ELSE
    CREATE OR REPLACE FUNCTION public._notification_kind_emails(_kind text, _link text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $fn$
        SELECT
          _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'attendance', 'broadcast', 'course_welcome', 'session_start')
          OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%');
      $fn$;
  END IF;
END $$;

-- 2) Función que notifica el inicio de las sesiones autónomas due.
DO $mig$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL
     OR to_regclass('public.courses') IS NULL
     OR to_regclass('public.course_enrollments') IS NULL THEN
    RAISE NOTICE 'skip notify_autonomous_sessions: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.notify_autonomous_sessions_starting()
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    rec     RECORD;
    v_count INTEGER := 0;
    v_batch INTEGER;
    v_start TIMESTAMPTZ;
  BEGIN
    FOR rec IN
      SELECT s.id, s.course_id, s.title, c.name AS course_name
        FROM public.attendance_sessions s
        JOIN public.courses c ON c.id = s.course_id
       WHERE s.session_type = 'autonoma'
         AND s.notified_start_at IS NULL
         AND s.deleted_at IS NULL
         AND c.deleted_at IS NULL
         -- "due": el inicio (fecha + hora, interpretadas como hora de Bogotá) ya
         -- llegó. start_time NULL → 09:00. La ventana de 2h evita el spam
         -- retroactivo del primer deploy (precedente scheduled_messages_no_retroactive).
         AND (s.session_date + COALESCE(s.start_time, '09:00'::time))
               AT TIME ZONE 'America/Bogota' <= now()
         AND (s.session_date + COALESCE(s.start_time, '09:00'::time))
               AT TIME ZONE 'America/Bogota' > now() - INTERVAL '2 hours'
       -- OF s: solo lockeamos la fila de attendance_sessions (no la de courses
       -- del JOIN) para no saltear una sesión por contención en courses.
       FOR UPDATE OF s SKIP LOCKED
    LOOP
      -- Una notif por alumno matriculado (kind emailable → correo + campana + push).
      INSERT INTO public.notifications (user_id, title, body, kind, link)
      SELECT ce.user_id,
             'Sesión autónoma disponible',
             format('La sesión «%s» de %s ya está disponible. Revisa el material cuando puedas y márcalo como revisado.',
                    COALESCE(NULLIF(rec.title, ''), 'de hoy'), rec.course_name),
             'session_start',
             '/app/student/courses'
        FROM public.course_enrollments ce
       WHERE ce.course_id = rec.course_id;

      GET DIAGNOSTICS v_batch = ROW_COUNT;

      -- Marcar como notificada SIEMPRE (aunque el curso no tenga alumnos) para
      -- no re-evaluarla cada minuto.
      UPDATE public.attendance_sessions SET notified_start_at = now() WHERE id = rec.id;

      v_count := v_count + v_batch;
    END LOOP;

    RETURN v_count;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.notify_autonomous_sessions_starting() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.notify_autonomous_sessions_starting() TO service_role;
END
$mig$;

-- 3) RPC: el alumno marca el material de una sesión autónoma como revisado →
--    queda 'presente'. Valida matrícula + tipo autónomo + no papelera.
DROP FUNCTION IF EXISTS public.student_review_autonomous_session(UUID);
CREATE OR REPLACE FUNCTION public.student_review_autonomous_session(_session_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid       UUID := auth.uid();
  v_course_id UUID;
  v_type      TEXT;
  v_deleted   TIMESTAMPTZ;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = 'P0001';
  END IF;

  SELECT course_id, session_type, deleted_at
    INTO v_course_id, v_type, v_deleted
    FROM public.attendance_sessions
   WHERE id = _session_id;

  IF v_course_id IS NULL OR v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'Sesión no encontrada' USING ERRCODE = 'P0001';
  END IF;

  IF v_type <> 'autonoma' THEN
    RAISE EXCEPTION 'Solo las sesiones autónomas se marcan como revisadas' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.course_enrollments ce
     WHERE ce.course_id = v_course_id AND ce.user_id = v_uid
  ) THEN
    RAISE EXCEPTION 'No estás matriculado en este curso' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.attendance_records (session_id, user_id, status)
  VALUES (_session_id, v_uid, 'presente')
  ON CONFLICT (session_id, user_id) DO UPDATE SET status = 'presente';
END;
$$;

GRANT EXECUTE ON FUNCTION public.student_review_autonomous_session(UUID) TO authenticated;

-- 4) Cron cada minuto (precisión de la hora de inicio). Patrón cron.schedule bare.
DO $cron$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    RAISE NOTICE 'pg_cron no instalado, salida limpia.';
    RETURN;
  END IF;
  -- OJO: cron.schedule (schema cron), NUNCA extensions.cron.schedule.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notify-autonomous-sessions') THEN
    PERFORM cron.schedule(
      'notify-autonomous-sessions',
      '* * * * *',
      $job$ SELECT public.notify_autonomous_sessions_starting(); $job$
    );
  END IF;
END
$cron$;

-- 5) Descripción humana (módulo Cron del Admin).
DO $desc$
BEGIN
  IF to_regclass('public.cron_job_descriptions') IS NOT NULL THEN
    INSERT INTO public.cron_job_descriptions (jobname, description)
    VALUES (
      'notify-autonomous-sessions',
      'Cada minuto: cuando llega la fecha/hora de inicio de una sesión AUTÓNOMA, notifica (campana + correo + push) a los alumnos matriculados para que revisen el material. Idempotente por notified_start_at.'
    )
    ON CONFLICT (jobname) DO UPDATE SET description = EXCLUDED.description, updated_at = now();
  END IF;
END
$desc$;

-- 6) Toggle del correo (default ON) para que aparezca el switch en el panel admin.
DO $$
BEGIN
  IF to_regclass('public.email_settings') IS NOT NULL THEN
    UPDATE public.email_settings
      SET enabled_kinds = COALESCE(enabled_kinds, '{}'::jsonb)
        || jsonb_build_object('session_start', true)
      WHERE id = 1 AND NOT (COALESCE(enabled_kinds, '{}'::jsonb) ? 'session_start');
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
