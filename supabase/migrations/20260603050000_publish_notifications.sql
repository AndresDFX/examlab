-- ──────────────────────────────────────────────────────────────────────
-- Notificaciones automáticas al publicar / actualizar contenido
--
-- Disparadores por cada entidad (workshops, exams, projects, polls,
-- generated_contents). Dos escenarios cubiertos:
--
--   1. PUBLICACIÓN: el ítem transiciona a estado "publicado"
--      (status='published' o is_published=true). Cada alumno
--      matriculado en el/los curso(s) asociado(s) recibe una
--      notificación in-app + correo (gated por _notification_kind_emails
--      y email_settings.enabled_kinds).
--
--   2. EDICIÓN POST-PUBLICACIÓN: el ítem ya está publicado y cambia
--      un campo significativo (título, instrucciones, fechas clave).
--      Notificamos para que el alumno sepa que algo cambió.
--      Excluimos cambios irrelevantes (updated_at, ai_*, contadores)
--      vía comparación explícita de campos.
--
-- Para multi-curso (polls): el fan-out usa poll_courses; un alumno
-- matriculado en >1 curso recibe UNA sola notificación (DISTINCT en
-- el helper).
--
-- Email: el predicado `_notification_kind_emails` se extiende para
-- aceptar 'poll' y 'content'. Esto es ortogonal al admin override:
-- el toggle de cada kind en `email_settings.enabled_kinds` sigue
-- gobernando si se manda correo en runtime.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Predicado de emails: agregar poll + content ───────────────
CREATE OR REPLACE FUNCTION public._notification_kind_emails(_kind text, _link text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'broadcast', 'poll', 'content')
    OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
    OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%');
$$;

-- ── 2) Helper para fan-out multi-curso (polls) ────────────────────
-- Notifica a TODOS los alumnos matriculados en los cursos linkeados
-- a una poll, sin duplicar si un alumno está en >1 de esos cursos.
-- Si los cursos están vacíos, no hace nada.
CREATE OR REPLACE FUNCTION public._notify_poll_students(
  _poll_id UUID,
  _title TEXT,
  _body TEXT,
  _kind TEXT,
  _link TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
  SELECT DISTINCT ce.user_id, _title, _body, _kind, _link, 'Docente'
    FROM public.poll_courses pc
    JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
   WHERE pc.poll_id = _poll_id
     AND ce.user_id IS NOT NULL;
END
$$;

-- ── 3) Triggers por entidad ──────────────────────────────────────

-- ---------- WORKSHOPS ----------
CREATE OR REPLACE FUNCTION public._tg_workshop_publish_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _is_publish_event BOOLEAN := false;
  _is_edit_published BOOLEAN := false;
  _title TEXT;
  _body TEXT;
BEGIN
  -- Caso publicación: INSERT con status='published' O UPDATE de
  -- !='published' a 'published'.
  IF TG_OP = 'INSERT' AND NEW.status = 'published' THEN
    _is_publish_event := true;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    _is_publish_event := true;
  END IF;

  -- Caso edición post-publicación: UPDATE sobre fila ya publicada con
  -- cambios en campos significativos.
  IF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status = 'published' THEN
    IF OLD.title IS DISTINCT FROM NEW.title
       OR OLD.instructions IS DISTINCT FROM NEW.instructions
       OR OLD.due_date IS DISTINCT FROM NEW.due_date
       OR OLD.start_date IS DISTINCT FROM NEW.start_date
       OR OLD.max_score IS DISTINCT FROM NEW.max_score
       OR OLD.max_attempts IS DISTINCT FROM NEW.max_attempts
    THEN
      _is_edit_published := true;
    END IF;
  END IF;

  IF NOT _is_publish_event AND NOT _is_edit_published THEN
    RETURN NULL;
  END IF;

  IF _is_publish_event THEN
    _title := 'Nuevo taller publicado';
    _body := COALESCE(NEW.title, 'Taller sin título') ||
             CASE WHEN NEW.due_date IS NOT NULL
                  THEN ' — entrega hasta ' || to_char(NEW.due_date, 'DD/MM/YYYY HH24:MI')
                  ELSE '' END;
  ELSE
    _title := 'Taller actualizado';
    _body := COALESCE(NEW.title, 'Taller') || ' fue modificado por el docente. Revisa los cambios.';
  END IF;

  PERFORM public.notify_course_students(
    NEW.course_id, _title, _body, 'workshop',
    '/app/student/workshops', 'Docente'
  );
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_workshop_publish_notify ON public.workshops;
CREATE TRIGGER trg_workshop_publish_notify
  AFTER INSERT OR UPDATE ON public.workshops
  FOR EACH ROW EXECUTE FUNCTION public._tg_workshop_publish_notify();

-- ---------- EXAMS ----------
CREATE OR REPLACE FUNCTION public._tg_exam_publish_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _is_publish_event BOOLEAN := false;
  _is_edit_published BOOLEAN := false;
  _title TEXT;
  _body TEXT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'published' THEN
    _is_publish_event := true;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    _is_publish_event := true;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status = 'published' THEN
    IF OLD.title IS DISTINCT FROM NEW.title
       OR OLD.description IS DISTINCT FROM NEW.description
       OR OLD.start_time IS DISTINCT FROM NEW.start_time
       OR OLD.end_time IS DISTINCT FROM NEW.end_time
       OR OLD.time_limit_minutes IS DISTINCT FROM NEW.time_limit_minutes
       OR OLD.max_attempts IS DISTINCT FROM NEW.max_attempts
    THEN
      _is_edit_published := true;
    END IF;
  END IF;

  IF NOT _is_publish_event AND NOT _is_edit_published THEN
    RETURN NULL;
  END IF;

  IF _is_publish_event THEN
    _title := 'Nuevo examen publicado';
    _body := COALESCE(NEW.title, 'Examen sin título') ||
             CASE WHEN NEW.start_time IS NOT NULL
                  THEN ' — disponible desde ' || to_char(NEW.start_time, 'DD/MM/YYYY HH24:MI')
                  ELSE '' END;
  ELSE
    _title := 'Examen actualizado';
    _body := COALESCE(NEW.title, 'Examen') || ' fue modificado por el docente. Revisa los cambios.';
  END IF;

  PERFORM public.notify_course_students(
    NEW.course_id, _title, _body, 'exam',
    '/app/student/exams', 'Docente'
  );
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_exam_publish_notify ON public.exams;
CREATE TRIGGER trg_exam_publish_notify
  AFTER INSERT OR UPDATE ON public.exams
  FOR EACH ROW EXECUTE FUNCTION public._tg_exam_publish_notify();

-- ---------- PROJECTS ----------
CREATE OR REPLACE FUNCTION public._tg_project_publish_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _is_publish_event BOOLEAN := false;
  _is_edit_published BOOLEAN := false;
  _title TEXT;
  _body TEXT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'published' THEN
    _is_publish_event := true;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    _is_publish_event := true;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status = 'published' THEN
    IF OLD.title IS DISTINCT FROM NEW.title
       OR OLD.instructions IS DISTINCT FROM NEW.instructions
       OR OLD.due_date IS DISTINCT FROM NEW.due_date
       OR OLD.start_date IS DISTINCT FROM NEW.start_date
       OR OLD.max_score IS DISTINCT FROM NEW.max_score
       OR OLD.max_attempts IS DISTINCT FROM NEW.max_attempts
    THEN
      _is_edit_published := true;
    END IF;
  END IF;

  IF NOT _is_publish_event AND NOT _is_edit_published THEN
    RETURN NULL;
  END IF;

  IF _is_publish_event THEN
    _title := 'Nuevo proyecto publicado';
    _body := COALESCE(NEW.title, 'Proyecto sin título') ||
             CASE WHEN NEW.due_date IS NOT NULL
                  THEN ' — entrega hasta ' || to_char(NEW.due_date, 'DD/MM/YYYY HH24:MI')
                  ELSE '' END;
  ELSE
    _title := 'Proyecto actualizado';
    _body := COALESCE(NEW.title, 'Proyecto') || ' fue modificado por el docente. Revisa los cambios.';
  END IF;

  PERFORM public.notify_course_students(
    NEW.course_id, _title, _body, 'project',
    '/app/student/projects', 'Docente'
  );
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_project_publish_notify ON public.projects;
CREATE TRIGGER trg_project_publish_notify
  AFTER INSERT OR UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public._tg_project_publish_notify();

-- ---------- POLLS ----------
-- Multi-curso: fan-out vía _notify_poll_students (DISTINCT user_id).
CREATE OR REPLACE FUNCTION public._tg_poll_publish_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _is_publish_event BOOLEAN := false;
  _is_edit_published BOOLEAN := false;
  _title TEXT;
  _body TEXT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.is_published THEN
    _is_publish_event := true;
  ELSIF TG_OP = 'UPDATE' AND NEW.is_published = true AND OLD.is_published IS DISTINCT FROM true THEN
    _is_publish_event := true;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.is_published = true AND OLD.is_published = true THEN
    IF OLD.title IS DISTINCT FROM NEW.title
       OR OLD.description IS DISTINCT FROM NEW.description
       OR OLD.closes_at IS DISTINCT FROM NEW.closes_at
       OR OLD.opens_at IS DISTINCT FROM NEW.opens_at
       OR OLD.poll_type IS DISTINCT FROM NEW.poll_type
    THEN
      _is_edit_published := true;
    END IF;
  END IF;

  IF NOT _is_publish_event AND NOT _is_edit_published THEN
    RETURN NULL;
  END IF;

  IF _is_publish_event THEN
    _title := 'Nueva encuesta publicada';
    _body := COALESCE(NEW.title, 'Encuesta sin título') ||
             CASE WHEN NEW.closes_at IS NOT NULL
                  THEN ' — cierra ' || to_char(NEW.closes_at, 'DD/MM/YYYY HH24:MI')
                  ELSE '' END;
  ELSE
    _title := 'Encuesta actualizada';
    _body := COALESCE(NEW.title, 'Encuesta') || ' fue modificada por el docente.';
  END IF;

  PERFORM public._notify_poll_students(
    NEW.id, _title, _body, 'poll', '/app/student/polls'
  );
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_poll_publish_notify ON public.polls;
CREATE TRIGGER trg_poll_publish_notify
  AFTER INSERT OR UPDATE ON public.polls
  FOR EACH ROW EXECUTE FUNCTION public._tg_poll_publish_notify();

-- ---------- GENERATED_CONTENTS ----------
-- Notificación de publicación de contenido al alumno. Le hace ruta a
-- /app/student/courses (donde verá el contenido vinculado a su curso).
-- Si course_id es NULL (raro pero posible — content general), no
-- notificamos a nadie en particular.
CREATE OR REPLACE FUNCTION public._tg_content_publish_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _is_publish_event BOOLEAN := false;
  _is_edit_published BOOLEAN := false;
  _title TEXT;
  _body TEXT;
BEGIN
  IF NEW.course_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.is_published THEN
    _is_publish_event := true;
  ELSIF TG_OP = 'UPDATE' AND NEW.is_published = true AND OLD.is_published IS DISTINCT FROM true THEN
    _is_publish_event := true;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.is_published = true AND OLD.is_published = true THEN
    IF OLD.display_name IS DISTINCT FROM NEW.display_name
       OR OLD.topic IS DISTINCT FROM NEW.topic
       OR OLD.instructions IS DISTINCT FROM NEW.instructions
       OR OLD.modality IS DISTINCT FROM NEW.modality
       OR OLD.duration_minutes IS DISTINCT FROM NEW.duration_minutes
       OR OLD.files IS DISTINCT FROM NEW.files
    THEN
      _is_edit_published := true;
    END IF;
  END IF;

  IF NOT _is_publish_event AND NOT _is_edit_published THEN
    RETURN NULL;
  END IF;

  IF _is_publish_event THEN
    _title := 'Nuevo contenido disponible';
    _body := COALESCE(NEW.display_name, NEW.topic, 'Material de clase') ||
             ' fue publicado en tu curso.';
  ELSE
    _title := 'Contenido actualizado';
    _body := COALESCE(NEW.display_name, NEW.topic, 'Material') ||
             ' fue modificado por el docente.';
  END IF;

  PERFORM public.notify_course_students(
    NEW.course_id, _title, _body, 'content',
    '/app/student/courses', 'Docente'
  );
  RETURN NULL;
END
$$;

DROP TRIGGER IF EXISTS trg_content_publish_notify ON public.generated_contents;
CREATE TRIGGER trg_content_publish_notify
  AFTER INSERT OR UPDATE ON public.generated_contents
  FOR EACH ROW EXECUTE FUNCTION public._tg_content_publish_notify();

NOTIFY pgrst, 'reload schema';
