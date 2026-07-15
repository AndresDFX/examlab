-- Bienvenida al PUBLICAR el curso (borrador → en_curso), no al matricular en borrador.
--
-- Contexto: al matricular estudiantes en un curso en BORRADOR (aún no publicado)
-- NO se les debe mandar la bienvenida — el curso todavía no está disponible para
-- ellos y recibirían el correo antes de tiempo. La bienvenida debe salir cuando
-- el docente/admin PUBLICA el curso (lo pasa a en_curso).
--
-- Esta migración:
--   1) endurece el trigger de matrícula (20261110000000) para que SALTE los
--      cursos en borrador; y
--   2) agrega un trigger de PUBLICACIÓN que, al pasar borrador → en_curso, da la
--      bienvenida a los estudiantes que ya estaban matriculados.
--
-- El trigger de matrícula sigue cubriendo el caso de matricular DIRECTO en un
-- curso ya publicado (status distinto de borrador): ese alumno recibe la
-- bienvenida al instante, como hasta ahora.

DO $$
BEGIN
  IF to_regclass('public.courses') IS NULL
     OR to_regclass('public.course_enrollments') IS NULL
     OR to_regclass('public.notifications') IS NULL THEN
    RAISE NOTICE 'course_welcome_on_publish: tablas base ausentes, se omite';
    RETURN;
  END IF;

  -- 1) Enroll trigger: NO dar bienvenida al matricular en un curso en BORRADOR.
  CREATE OR REPLACE FUNCTION public.notify_course_enrollment_welcome()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
  AS $fn$
  DECLARE
    v_course_name text;
    v_deleted     timestamptz;
    v_status      text;
  BEGIN
    -- Defensivo: NADA acá debe abortar la inscripción. Si algo falla, la matrícula
    -- queda intacta y solo se pierde el correo de bienvenida.
    BEGIN
      SELECT name, deleted_at, status
        INTO v_course_name, v_deleted, v_status
        FROM public.courses WHERE id = NEW.course_id;

      -- Curso inexistente o en papelera → no dar bienvenida (no se debe notificar
      -- a un alumno sobre un curso soft-deleted; ver regla universal de Papelera).
      IF v_course_name IS NULL OR v_deleted IS NOT NULL THEN
        RETURN NEW;
      END IF;

      -- Curso en BORRADOR → todavía no publicado; la bienvenida saldrá al publicar
      -- (trg_course_published_welcome). Matricular en borrador NO debe emailar.
      IF v_status = 'borrador' THEN
        RETURN NEW;
      END IF;

      INSERT INTO public.notifications (user_id, title, body, kind, link)
      VALUES (
        NEW.user_id,
        '🎓 Bienvenido a ' || v_course_name,
        'Fuiste inscrito en el curso "' || v_course_name ||
          '". Ya puedes ver su contenido, clases, talleres y evaluaciones desde Mis cursos.',
        'course_welcome',
        '/app/student/courses'
      );
    EXCEPTION WHEN OTHERS THEN
      -- Swallow: la inscripción es más importante que el correo de bienvenida.
      NULL;
    END;
    RETURN NEW;
  END;
  $fn$;

  -- 2) Publish trigger: al pasar borrador → en_curso, bienvenida a los YA matriculados.
  CREATE OR REPLACE FUNCTION public.notify_course_published_welcome()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path TO 'public'
  AS $fn$
  BEGIN
    -- Solo la transición de publicación: borrador → en_curso, curso no en papelera.
    IF NEW.status = 'en_curso'
       AND OLD.status = 'borrador'
       AND NEW.deleted_at IS NULL THEN
      BEGIN
        -- Una bienvenida por cada estudiante ya matriculado. El pipeline de email
        -- (notifications_send_email) se encarga del correo por cada notificación.
        INSERT INTO public.notifications (user_id, title, body, kind, link)
        SELECT
          ce.user_id,
          '🎓 Bienvenido a ' || NEW.name,
          'El curso "' || NEW.name ||
            '" ya está disponible. Ya puedes ver su contenido, clases, talleres y evaluaciones desde Mis cursos.',
          'course_welcome',
          '/app/student/courses'
        FROM public.course_enrollments ce
        WHERE ce.course_id = NEW.id;
      EXCEPTION WHEN OTHERS THEN
        -- Swallow: publicar el curso es más importante que el correo de bienvenida.
        NULL;
      END;
    END IF;
    RETURN NEW;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS trg_course_published_welcome ON public.courses;
  CREATE TRIGGER trg_course_published_welcome
    AFTER UPDATE OF status ON public.courses
    FOR EACH ROW
    WHEN (NEW.status = 'en_curso' AND OLD.status = 'borrador')
    EXECUTE FUNCTION public.notify_course_published_welcome();
END $$;
