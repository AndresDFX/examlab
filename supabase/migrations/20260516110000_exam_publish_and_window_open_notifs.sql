-- ──────────────────────────────────────────────────────────────────────
-- Recordatorios de examen complementarios al de "1h antes" que ya existe:
--   A) Al asignar/publicar:  trigger on INSERT exam_assignments → notif
--                            "Te asignaron el examen X" (push + email).
--   B) Al abrir la ventana:  RPC notify_students_exam_window_opens()
--                            llamada por pg_cron cuando start_time pasa.
--
-- Idempotencia: usamos el patrón de la migración 20260523000006 — buscamos
-- una notificación previa con el mismo título en una ventana de tiempo.
-- ──────────────────────────────────────────────────────────────────────

-- A) ─────────────────── Trigger al asignar un examen
-- Disparamos una sola vez por (exam_id, user_id) la primera vez que
-- aparece la fila en exam_assignments. Si el docente desasigna y
-- vuelve a asignar, generamos otra notificación (es decisión correcta:
-- es un evento real del estudiante que debe ver).

CREATE OR REPLACE FUNCTION public._notify_exam_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _exam_title TEXT;
  _course_name TEXT;
BEGIN
  SELECT e.title, COALESCE(c.name, 'sin curso')
    INTO _exam_title, _course_name
    FROM public.exams e
    LEFT JOIN public.courses c ON c.id = e.course_id
   WHERE e.id = NEW.exam_id;

  IF _exam_title IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  VALUES (
    NEW.user_id,
    'Te asignaron el examen "' || _exam_title || '"',
    'Curso: ' || _course_name || '. Revisa la fecha de inicio en tu lista de exámenes.',
    'exam',
    '/app/student/exams'
  );

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_notify_exam_assigned ON public.exam_assignments;
CREATE TRIGGER trg_notify_exam_assigned
  AFTER INSERT ON public.exam_assignments
  FOR EACH ROW
  EXECUTE FUNCTION public._notify_exam_assigned();

-- B) ─────────────────── RPC: examen abrió su ventana (start_time pasó)
-- Detecta exámenes cuyo start_time cayó en la última ventana de búsqueda
-- (default 30 min — debe ser ≥ frecuencia del cron para no perder casos)
-- y aún no han notificado el evento "ya disponible" en las últimas 12h.

CREATE OR REPLACE FUNCTION public.notify_students_exam_window_opens(
  _lookback_minutes INTEGER DEFAULT 30
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    -- Exclusión: ya entregó (no necesita ver el aviso de "ya disponible")
    AND NOT EXISTS (
      SELECT 1 FROM public.submissions s
       WHERE s.exam_id = e.id
         AND s.user_id = ea.user_id
         AND s.status IN ('completado', 'sospechoso')
    )
    -- Idempotencia: no duplicar si ya se notificó en las últimas 12h.
    -- Ventana grande porque este evento solo ocurre una vez por examen.
    AND NOT EXISTS (
      SELECT 1 FROM public.notifications n
       WHERE n.user_id = ea.user_id
         AND n.title = 'Tu examen "' || e.title || '" ya está disponible'
         AND n.created_at > NOW() - INTERVAL '12 hours'
    );

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END
$$;

REVOKE ALL ON FUNCTION public.notify_students_exam_window_opens(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.notify_students_exam_window_opens(INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ─────────────────────────────────────────────── Programación recordada
-- Después de aplicar esta migración, registrá el cron:
--
--   SELECT cron.schedule(
--     'exam-window-opens',
--     '*/15 * * * *',  -- cada 15 minutos
--     $$ SELECT public.notify_students_exam_window_opens(30); $$
--   );
--
-- Y verifica que el cron 'exam-reminders-1h' (de la migración
-- 20260523000006_exam_starting_soon_notif.sql) también esté activo:
--   SELECT * FROM public.system_cron_jobs();
