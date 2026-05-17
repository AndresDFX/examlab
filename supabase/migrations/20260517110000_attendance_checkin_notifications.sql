-- ──────────────────────────────────────────────────────────────────────
-- Notificar a los estudiantes cuando se abre el check-in de asistencia.
--
-- Canales:
--   - In-app: INSERT en `notifications` (la app los muestra realtime).
--   - Push:   el trigger existente sobre `notifications` envía push si el
--             usuario está suscrito.
--   - Email:  agregamos `attendance` al predicado `_notification_kind_emails`
--             para que `notify_send_email` se dispare.
--
-- Trigger en `attendance_sessions` AFTER UPDATE OF check_in_open:
--   fires solo cuando OLD.check_in_open=false → NEW.check_in_open=true.
--   Evita disparar al volver a abrirlo (idempotente) o al cerrarlo.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Extender el predicado de email para incluir 'attendance' ──

CREATE OR REPLACE FUNCTION public._notification_kind_emails(
  _kind TEXT,
  _link TEXT
) RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'attendance')
    OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%');
$$;

-- ── 2) Trigger function: notificar al abrir check-in ──

CREATE OR REPLACE FUNCTION public._notify_attendance_check_in_open()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _course_name TEXT;
BEGIN
  -- Solo cuando transiciona false → true
  IF NOT (NEW.check_in_open IS TRUE AND OLD.check_in_open IS NOT TRUE) THEN
    RETURN NEW;
  END IF;

  SELECT c.name INTO _course_name
    FROM public.courses c WHERE c.id = NEW.course_id;

  -- notify_course_students hace INSERT en notifications para todos los
  -- matriculados del curso. El trigger de notifications dispara push
  -- y, por el predicado actualizado arriba, también dispara email.
  PERFORM public.notify_course_students(
    NEW.course_id,
    'Check-in de asistencia abierto',
    'Tu docente abrió el check-in para "' ||
      COALESCE(NEW.title, to_char(NEW.session_date, 'DD/MM')) ||
      '" en el curso "' || COALESCE(_course_name, 'sin curso') ||
      '". Escanea el QR o ingresa el código antes de que cierre.',
    'attendance',
    '/app/student/attendance'
  );

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_notify_attendance_check_in_open
  ON public.attendance_sessions;

CREATE TRIGGER trg_notify_attendance_check_in_open
  AFTER UPDATE OF check_in_open ON public.attendance_sessions
  FOR EACH ROW
  WHEN (NEW.check_in_open IS TRUE AND OLD.check_in_open IS NOT TRUE)
  EXECUTE FUNCTION public._notify_attendance_check_in_open();

NOTIFY pgrst, 'reload schema';
