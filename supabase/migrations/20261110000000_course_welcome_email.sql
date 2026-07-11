-- ══════════════════════════════════════════════════════════════════════
-- Correo de BIENVENIDA al CURSO.
--
-- Objetivo: cuando un estudiante se inscribe a un curso por CUALQUIER flujo
-- (alta individual en Usuarios, importación masiva CSV, gestión de estudiantes
-- del curso, RPC o SQL manual), reciba un correo de bienvenida al curso.
--
-- Estrategia: en vez de parchear cada call-site (frágil — un flujo nuevo se
-- olvida), un trigger AFTER INSERT en `course_enrollments` crea una notification
-- kind='course_welcome'. El pipeline existente (trigger notifications_send_email
-- → edge send-email) la convierte en correo. Cubrir desde el INSERT de la tabla
-- garantiza "cualquier flujo" POR CONSTRUCCIÓN.
--
-- Idempotencia: AFTER INSERT solo dispara para filas realmente insertadas. Los
-- re-enroll vía UPSERT con ON CONFLICT DO NOTHING (patrón usado en admin.courses
-- / admin.users / bulk-import) NO insertan → no re-envían. Un alumno removido y
-- vuelto a agregar SÍ es una inscripción nueva → nueva bienvenida (correcto).
--
-- Invariante de 3 lados del predicado kind→email: este SQL agrega 'course_welcome'
-- a public._notification_kind_emails; hay que sincronizar
-- supabase/functions/send-email/index.ts (CRITICAL_KINDS) y
-- src/modules/notifications/notification-email.ts (CRITICAL_KINDS).
-- ══════════════════════════════════════════════════════════════════════

-- 1) Habilitar 'course_welcome' en el predicado central "este kind emaila".
--    CREATE OR REPLACE con MISMA firma/RETURNS (sin DROP). Se replica el cuerpo
--    vigente (mig 20261066, con la rama 'support' gated por platform_settings)
--    y se agrega 'course_welcome' a la lista incondicional.
DO $$
BEGIN
  IF to_regclass('public.platform_settings') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public._notification_kind_emails(_kind text, _link text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $fn$
        SELECT
          _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'attendance', 'broadcast', 'course_welcome')
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
    -- Entorno sin platform_settings (mig 20260907 no aplicada): versión sin support.
    CREATE OR REPLACE FUNCTION public._notification_kind_emails(_kind text, _link text)
      RETURNS boolean LANGUAGE sql STABLE
      AS $fn$
        SELECT
          _kind IN ('grade', 'exam', 'feedback', 'workshop', 'project', 'attendance', 'broadcast', 'course_welcome')
          OR (_kind = 'info' AND _link IS NOT NULL AND _link LIKE '/app/messages%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/app/admin/system%')
          OR (_kind = 'system' AND _link IS NOT NULL AND _link LIKE '/auth/reset-password%');
      $fn$;
  END IF;
END $$;

-- 2) Trigger function: crea la notification de bienvenida al curso.
--    SECURITY DEFINER → bypassa la RLS de notifications (mismo patrón que los
--    demás triggers que insertan notifications). tenant_id y source_role los
--    rellenan los triggers BEFORE INSERT existentes de notifications
--    (tg_notifications_set_tenant deriva del perfil del alumno; el alumno vive
--    en el mismo tenant que el curso).
CREATE OR REPLACE FUNCTION public.notify_course_enrollment_welcome()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course_name text;
  v_deleted     timestamptz;
BEGIN
  -- Defensivo: NADA acá debe abortar la inscripción. Si algo falla, la matrícula
  -- queda intacta y solo se pierde el correo de bienvenida.
  BEGIN
    SELECT name, deleted_at INTO v_course_name, v_deleted
      FROM public.courses WHERE id = NEW.course_id;

    -- Curso inexistente o en papelera → no dar bienvenida (no se debe notificar
    -- a un alumno sobre un curso soft-deleted; ver regla universal de Papelera).
    IF v_course_name IS NULL OR v_deleted IS NOT NULL THEN
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
$$;

DROP TRIGGER IF EXISTS trg_course_enrollment_welcome ON public.course_enrollments;
CREATE TRIGGER trg_course_enrollment_welcome
  AFTER INSERT ON public.course_enrollments
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_course_enrollment_welcome();

-- 3) Registrar el toggle en email_settings.enabled_kinds (default ON). Un kind
--    ausente ya se trata como ON en la edge; lo sembramos para que el panel de
--    admin muestre el switch con el estado correcto.
DO $$
BEGIN
  IF to_regclass('public.email_settings') IS NOT NULL THEN
    UPDATE public.email_settings
      SET enabled_kinds = COALESCE(enabled_kinds, '{}'::jsonb)
        || jsonb_build_object('course_welcome', true)
      WHERE id = 1 AND NOT (COALESCE(enabled_kinds, '{}'::jsonb) ? 'course_welcome');
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
