-- «Tu examen inicia pronto» pasa a su PROPIA categoría y queda como el único
-- recordatorio automático de examen al estudiante.
--
-- Pedido del dueño (2026-09-29): dejar solo el recordatorio del mismo día y
-- encenderlo. Mientras compartía el kind `exam`, encenderlo obligaba a prender
-- también «nuevo examen publicado», el aviso al asignar y «ya está disponible»,
-- porque el panel de correos gobierna por categoría (mig 20262300000000).
--
--  1. notify_students_exam_starting_soon inserta kind `exam_reminder`.
--  2. `exam_reminder` es emailable (_notification_kind_emails; espejo TS en
--     notification-email.ts y send-email/index.ts, CRITICAL_KINDS).
--  3. Se desagenda el cron `exam-window-opens` («ya está disponible»). La
--     función queda por si se quiere volver: `cron.schedule` de nuevo.
--  4. Se enciende `enabled_kinds.exam_reminder`. El resto de `exam` sigue apagado.

DO $mig$
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public._notification_kind_emails(_kind text, _link text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $fn$
        SELECT
          _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'attendance', 'broadcast', 'course_welcome', 'session_start', 'report_signature', 'exam_reminder')
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
          _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'attendance', 'broadcast', 'course_welcome', 'session_start', 'report_signature', 'exam_reminder')
          OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%');
      $fn$;
  END IF;
END $mig$;

DO $$
BEGIN
  IF to_regclass('public.exams') IS NULL OR to_regclass('public.exam_assignments') IS NULL
     OR to_regclass('public.notifications') IS NULL THEN
    RAISE NOTICE 'skip exam_reminder: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.notify_students_exam_starting_soon(
    _hours INTEGER DEFAULT 1
  )
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    _count INTEGER;
  BEGIN
    IF _hours IS NULL OR _hours < 1 OR _hours > 24 THEN
      RETURN 0;
    END IF;

    INSERT INTO public.notifications (user_id, title, body, kind, link)
    SELECT
      ea.user_id,
      'Tu examen "' || e.title || '" inicia pronto',
      'El examen del curso "' || COALESCE(c.name, 'sin curso') ||
        '" inicia en menos de ' || _hours || ' hora(s). Prepárate.',
      'exam_reminder',
      '/app/student/exams'
    FROM public.exams e
    LEFT JOIN public.courses c ON c.id = e.course_id
    JOIN public.exam_assignments ea ON ea.exam_id = e.id
    WHERE e.start_time > NOW()
      AND e.start_time <= NOW() + make_interval(hours => _hours)
      -- Papelera: un examen soft-deleted no debe recordar "inicia pronto".
      AND e.deleted_at IS NULL
      -- Solo exámenes PUBLICADOS: un borrador puede tener estudiantes asignados
      -- y no debe avisarles de un examen que todavía no existe para ellos.
      AND e.status = 'published'
      AND COALESCE(e.is_external, false) = false
      AND NOT EXISTS (
        SELECT 1 FROM public.submissions s
         WHERE s.exam_id = e.id
           AND s.user_id = ea.user_id
           AND s.status IN ('completado', 'sospechoso')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.notifications n
         WHERE n.user_id = ea.user_id
           AND n.title = 'Tu examen "' || e.title || '" inicia pronto'
           AND n.created_at > NOW() - INTERVAL '2 hours'
      );

    GET DIAGNOSTICS _count = ROW_COUNT;
    RETURN _count;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.notify_students_exam_starting_soon(INTEGER) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.notify_students_exam_starting_soon(INTEGER) TO service_role;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron')
     AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'exam-window-opens') THEN
    PERFORM cron.unschedule('exam-window-opens');
  END IF;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.email_settings') IS NOT NULL THEN
    UPDATE public.email_settings
       SET enabled_kinds = COALESCE(enabled_kinds, '{}'::jsonb) || '{"exam_reminder": true}'::jsonb,
           updated_at = now();
  END IF;
END
$$;
