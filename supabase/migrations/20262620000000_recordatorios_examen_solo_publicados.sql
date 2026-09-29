-- Recordatorios de examen al estudiante: SOLO para exámenes publicados.
--
-- `notify_students_exam_starting_soon` («inicia pronto», cron `exam-reminders-1h`) y
-- `notify_students_exam_window_opens` («ya está disponible», cron `exam-window-opens`)
-- elegían por fecha + asignación, sin mirar `exams.status`. Un borrador con
-- estudiantes asignados —medido el 2026-09-29: 6, dos con inicio ese mismo día—
-- les habría avisado de un examen que no pueden ver, con un enlace a la toma.
-- Hoy no sale nada porque la categoría `exam` está apagada en el panel de
-- correos; este arreglo es para que encenderla no dispare avisos de borradores.
-- También se excluyen los externos: no tienen pantalla de toma.
-- Mismo cuerpo que 20260962000000 más los dos filtros. Idempotente.
DO $$
BEGIN
  IF to_regclass('public.exams') IS NULL OR to_regclass('public.exam_assignments') IS NULL
     OR to_regclass('public.notifications') IS NULL THEN
    RAISE NOTICE 'skip recordatorios de examen: tabla(s) ausente(s)';
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
      'exam',
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

CREATE OR REPLACE FUNCTION public.notify_students_exam_window_opens(
    _lookback_minutes INTEGER DEFAULT 30
  )
  RETURNS INTEGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  DECLARE
    _count INTEGER;
  BEGIN
    IF _lookback_minutes IS NULL OR _lookback_minutes < 1 OR _lookback_minutes > 360 THEN
      RETURN 0;
    END IF;

    INSERT INTO public.notifications (user_id, title, body, kind, link)
    SELECT
      ea.user_id,
      'Tu examen "' || e.title || '" ya está disponible',
      'La ventana de presentación se abrió. Tienes hasta ' ||
        to_char(e.end_time AT TIME ZONE 'America/Bogota', 'DD/MM HH24:MI') ||
        ' para presentarlo.',
      'exam',
      '/app/student/take/' || e.id::text
    FROM public.exams e
    JOIN public.exam_assignments ea ON ea.exam_id = e.id
    WHERE e.start_time <= NOW()
      AND e.start_time > NOW() - make_interval(mins => _lookback_minutes)
      AND e.end_time > NOW()
      -- Papelera: un examen soft-deleted no debe notificar "ya disponible"
      -- ni dar deep-link a /app/student/take/<exam_id>.
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
           AND n.title = 'Tu examen "' || e.title || '" ya está disponible'
           AND n.created_at > NOW() - INTERVAL '12 hours'
      );

    GET DIAGNOSTICS _count = ROW_COUNT;
    RETURN _count;
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.notify_students_exam_starting_soon(INTEGER) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.notify_students_exam_starting_soon(INTEGER) TO service_role;
  REVOKE ALL ON FUNCTION public.notify_students_exam_window_opens(INTEGER) FROM PUBLIC, anon, authenticated;
  GRANT EXECUTE ON FUNCTION public.notify_students_exam_window_opens(INTEGER) TO service_role;
END
$$;
