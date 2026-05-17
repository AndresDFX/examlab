-- ──────────────────────────────────────────────────────────────────────
-- Mejoras al módulo de Contenidos:
--   1) Notificación al estudiante cuando se asigna contenido a su sesión
--      (in-app + push; email NO — kind='content' no se incluye en el
--      predicado de emails para no saturar).
--   2) Notificación al docente cuando una generación falla (in-app).
--   3) Columna `release_after_session_date` para que el docente pueda
--      ocultar el contenido al estudiante hasta el día de la sesión.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Trigger: notificar estudiantes al asignar contenido a sesión ──

CREATE OR REPLACE FUNCTION public._notify_content_assigned_to_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _course_name TEXT;
BEGIN
  -- Solo cuando se ASIGNA (NULL → valor) o cambia entre contenidos.
  -- No disparamos al desasignar (NEW.content_id IS NULL).
  IF NEW.content_id IS NULL OR NEW.content_id IS NOT DISTINCT FROM OLD.content_id THEN
    RETURN NEW;
  END IF;

  SELECT name INTO _course_name FROM public.courses WHERE id = NEW.course_id;

  PERFORM public.notify_course_students(
    NEW.course_id,
    'Nuevo material disponible',
    'Tu docente asignó material para "' ||
      COALESCE(NEW.title, to_char(NEW.session_date, 'DD/MM')) ||
      '" en el curso "' || COALESCE(_course_name, 'sin curso') || '".',
    'content',
    '/app/student/attendance'
  );

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_notify_content_assigned ON public.attendance_sessions;
CREATE TRIGGER trg_notify_content_assigned
  AFTER INSERT OR UPDATE OF content_id ON public.attendance_sessions
  FOR EACH ROW EXECUTE FUNCTION public._notify_content_assigned_to_session();

-- ── 2) Trigger: notificar al docente cuando falla la generación ──

CREATE OR REPLACE FUNCTION public._notify_content_generation_failed()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Solo cuando status transiciona a 'failed'
  IF NEW.status <> 'failed' OR (OLD.status IS NOT DISTINCT FROM NEW.status) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  VALUES (
    NEW.teacher_id,
    'Fallo al generar contenido',
    'La generación de "' || NEW.topic || '" falló' ||
      CASE WHEN NEW.error IS NOT NULL
           THEN ': ' || left(NEW.error, 200)
           ELSE '.'
      END ||
      ' Puedes reintentar desde la lista de contenidos.',
    'system',
    '/app/teacher/contents'
  );

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_notify_content_generation_failed
  ON public.generated_contents;
CREATE TRIGGER trg_notify_content_generation_failed
  AFTER UPDATE OF status ON public.generated_contents
  FOR EACH ROW EXECUTE FUNCTION public._notify_content_generation_failed();

-- ── 3) Visibilidad temporal: release_after_session_date ──
-- Si TRUE, el estudiante solo ve el contenido cuando la sesión asignada
-- llegó (now() >= session_date). Si FALSE (default), siempre visible al
-- estar asignado.

ALTER TABLE public.generated_contents
  ADD COLUMN IF NOT EXISTS release_after_session_date BOOLEAN
    NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.generated_contents.release_after_session_date IS
  'Si TRUE, el estudiante solo accede al contenido a partir de la fecha de la sesión asignada. Default FALSE (visible inmediatamente).';

NOTIFY pgrst, 'reload schema';
