-- =============================================================
-- MODULO DE AUDITORIA -- audit_logs
-- Registra eventos importantes del sistema para Admin y Docente.
-- Estrategia dual:
--   - Triggers automaticos en tablas de submissions (INSERT + cambios
--     de estado/nota).
--   - Funcion RPC log_audit_event para que el frontend registre
--     operaciones CRUD de examenes, talleres, proyectos, cursos y
--     usuarios. (El frontend tambien puede insertar via INSERT policy
--     directamente; ambos caminos estan abiertos.)
--
-- Schemas reales:
--   public.submissions (examenes)
--     status: en_progreso | completado | sospechoso
--     grade:  final_override_grade
--     warns:  focus_warnings
--   public.workshop_submissions
--     status: pendiente | entregado | calificado
--     grade:  final_grade
--   public.project_submissions
--     status: pendiente | ... | calificado
--     grade:  final_grade
-- =============================================================

-- 1) ----------------------------------------------------------------- TABLE

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),

  actor_id    uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email text,
  actor_role  text,

  action      text        NOT NULL,
  category    text        NOT NULL,
  severity    text        NOT NULL DEFAULT 'info',

  entity_type text,
  entity_id   text,
  entity_name text,

  course_id   uuid        REFERENCES public.courses(id) ON DELETE SET NULL,
  course_name text,

  metadata    jsonb       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_category   ON public.audit_logs(category);
CREATE INDEX IF NOT EXISTS idx_audit_logs_course_id  ON public.audit_logs(course_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id   ON public.audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity   ON public.audit_logs(severity);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

-- 2) --------------------------------------------------------------- RLS

DROP POLICY IF EXISTS "audit_logs_admin_select"   ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_teacher_select" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_insert"         ON public.audit_logs;

CREATE POLICY "audit_logs_admin_select" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'));

CREATE POLICY "audit_logs_teacher_select" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Docente')
    AND (
      course_id IN (
        SELECT course_id FROM public.course_teachers WHERE user_id = auth.uid()
      )
      OR actor_id = auth.uid()
    )
  );

-- INSERT abierto a usuarios autenticados (logEvent del frontend).
-- Sin UPDATE/DELETE policies => tabla append-only para todos.
CREATE POLICY "audit_logs_insert" ON public.audit_logs
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- 3) ------------------------------------------------------ HELPER FUNCTIONS

CREATE OR REPLACE FUNCTION public._audit_jwt_uid()
RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN (current_setting('request.jwt.claims', true)::json->>'sub')::uuid;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- 4) -------------------------------------------------------- RPC PUBLICA

CREATE OR REPLACE FUNCTION public.log_audit_event(
  p_action      text,
  p_category    text,
  p_severity    text    DEFAULT 'info',
  p_entity_type text    DEFAULT NULL,
  p_entity_id   text    DEFAULT NULL,
  p_entity_name text    DEFAULT NULL,
  p_course_id   uuid    DEFAULT NULL,
  p_course_name text    DEFAULT NULL,
  p_metadata    jsonb   DEFAULT '{}'
)
RETURNS void
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_email text;
  v_role  text;
BEGIN
  SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
  SELECT role::text INTO v_role FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1;

  INSERT INTO public.audit_logs (
    actor_id, actor_email, actor_role,
    action, category, severity,
    entity_type, entity_id, entity_name,
    course_id, course_name,
    metadata
  ) VALUES (
    auth.uid(), v_email, COALESCE(v_role, 'Estudiante'),
    p_action, p_category, p_severity,
    p_entity_type, p_entity_id, p_entity_name,
    p_course_id, p_course_name,
    COALESCE(p_metadata, '{}')
  );
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$$;

-- 5) ----------------------------------------- TRIGGERS: EXAM SUBMISSIONS
-- Tabla real: public.submissions
--   status: en_progreso | completado | sospechoso
--   grade:  final_override_grade

CREATE OR REPLACE FUNCTION public._trg_audit_exam_submission()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_exam_title    text;
  v_course_id     uuid;
  v_course_name   text;
  v_student_email text;
  v_actor_id      uuid;
  v_actor_email   text;
  v_actor_role    text;
  v_action        text;
  v_severity      text := 'info';
BEGIN
  BEGIN
    SELECT e.title, e.course_id
      INTO v_exam_title, v_course_id
      FROM public.exams e WHERE e.id = NEW.exam_id;

    SELECT c.name INTO v_course_name
      FROM public.courses c WHERE c.id = v_course_id;

    SELECT au.email INTO v_student_email
      FROM auth.users au WHERE au.id = NEW.user_id;

    IF TG_OP = 'INSERT' THEN
      v_action      := 'submission.exam.started';
      v_actor_id    := NEW.user_id;
      v_actor_email := v_student_email;
      v_actor_role  := 'Estudiante';

    ELSE
      -- Solo loggeamos si hubo cambio de status o de nota.
      IF OLD.status IS NOT DISTINCT FROM NEW.status
         AND OLD.final_override_grade IS NOT DISTINCT FROM NEW.final_override_grade THEN
        RETURN NEW;
      END IF;

      IF OLD.status IS DISTINCT FROM NEW.status THEN
        CASE NEW.status
          WHEN 'completado' THEN
            v_action      := 'submission.exam.submitted';
            v_actor_id    := NEW.user_id;
            v_actor_email := v_student_email;
            v_actor_role  := 'Estudiante';
          WHEN 'sospechoso' THEN
            v_action      := 'submission.exam.flagged_suspicious';
            v_severity    := 'warning';
            v_actor_id    := COALESCE(public._audit_jwt_uid(), NEW.user_id);
            SELECT au.email INTO v_actor_email FROM auth.users au WHERE au.id = v_actor_id;
            v_actor_role  := 'sistema';
          ELSE
            -- Cambios a otros estados (en_progreso, etc.) no se loggean aqui.
            IF OLD.final_override_grade IS NOT DISTINCT FROM NEW.final_override_grade THEN
              RETURN NEW;
            END IF;
            -- Cae al bloque de cambio de nota mas abajo.
            v_action := NULL;
        END CASE;
      END IF;

      -- Si no hubo cambio de status que loggear pero si cambio la nota:
      IF v_action IS NULL AND OLD.final_override_grade IS DISTINCT FROM NEW.final_override_grade THEN
        IF OLD.final_override_grade IS NULL AND NEW.final_override_grade IS NOT NULL THEN
          v_action := 'submission.exam.graded';
        ELSE
          v_action := 'submission.exam.grade_updated';
        END IF;
        v_actor_id    := COALESCE(public._audit_jwt_uid(), NEW.user_id);
        SELECT au.email INTO v_actor_email FROM auth.users au WHERE au.id = v_actor_id;
        SELECT ur.role::text INTO v_actor_role FROM public.user_roles ur
          WHERE ur.user_id = v_actor_id LIMIT 1;
        v_actor_role  := COALESCE(v_actor_role, 'sistema');
      END IF;

      IF v_action IS NULL THEN
        RETURN NEW;
      END IF;
    END IF;

    INSERT INTO public.audit_logs (
      actor_id, actor_email, actor_role,
      action, category, severity,
      entity_type, entity_id, entity_name,
      course_id, course_name, metadata
    ) VALUES (
      v_actor_id, v_actor_email, v_actor_role,
      v_action, 'exam', v_severity,
      'exam_submission', NEW.id::text, v_exam_title,
      v_course_id, v_course_name,
      jsonb_build_object(
        'exam_id', NEW.exam_id,
        'student_id', NEW.user_id,
        'student_email', v_student_email,
        'status', NEW.status,
        'final_override_grade', NEW.final_override_grade,
        'ai_grade', NEW.ai_grade,
        'focus_warnings', NEW.focus_warnings
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_exam_submission_insert ON public.submissions;
CREATE TRIGGER trg_audit_exam_submission_insert
  AFTER INSERT ON public.submissions
  FOR EACH ROW EXECUTE FUNCTION public._trg_audit_exam_submission();

DROP TRIGGER IF EXISTS trg_audit_exam_submission_update ON public.submissions;
CREATE TRIGGER trg_audit_exam_submission_update
  AFTER UPDATE ON public.submissions
  FOR EACH ROW EXECUTE FUNCTION public._trg_audit_exam_submission();

-- 6) --------------------------------------- TRIGGERS: WORKSHOP SUBMISSIONS

CREATE OR REPLACE FUNCTION public._trg_audit_workshop_submission()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ws_title      text;
  v_course_id     uuid;
  v_course_name   text;
  v_student_email text;
  v_actor_id      uuid;
  v_actor_email   text;
  v_actor_role    text;
  v_action        text;
BEGIN
  BEGIN
    SELECT w.title, w.course_id
      INTO v_ws_title, v_course_id
      FROM public.workshops w WHERE w.id = NEW.workshop_id;

    SELECT c.name INTO v_course_name
      FROM public.courses c WHERE c.id = v_course_id;

    SELECT au.email INTO v_student_email
      FROM auth.users au WHERE au.id = NEW.user_id;

    IF TG_OP = 'INSERT' THEN
      v_action      := 'submission.workshop.submitted';
      v_actor_id    := NEW.user_id;
      v_actor_email := v_student_email;
      v_actor_role  := 'Estudiante';

    ELSE
      IF OLD.final_grade IS NOT DISTINCT FROM NEW.final_grade OR NEW.final_grade IS NULL THEN
        RETURN NEW;
      END IF;

      v_action      := 'submission.workshop.graded';
      v_actor_id    := COALESCE(public._audit_jwt_uid(), NEW.user_id);
      SELECT au.email INTO v_actor_email FROM auth.users au WHERE au.id = v_actor_id;
      SELECT ur.role::text INTO v_actor_role FROM public.user_roles ur
        WHERE ur.user_id = v_actor_id LIMIT 1;
      v_actor_role  := COALESCE(v_actor_role, 'sistema');
    END IF;

    INSERT INTO public.audit_logs (
      actor_id, actor_email, actor_role,
      action, category, severity,
      entity_type, entity_id, entity_name,
      course_id, course_name, metadata
    ) VALUES (
      v_actor_id, v_actor_email, v_actor_role,
      v_action, 'workshop', 'info',
      'workshop_submission', NEW.id::text, v_ws_title,
      v_course_id, v_course_name,
      jsonb_build_object(
        'workshop_id', NEW.workshop_id,
        'student_id', NEW.user_id,
        'student_email', v_student_email,
        'status', NEW.status,
        'final_grade', NEW.final_grade
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_workshop_submission_insert ON public.workshop_submissions;
CREATE TRIGGER trg_audit_workshop_submission_insert
  AFTER INSERT ON public.workshop_submissions
  FOR EACH ROW EXECUTE FUNCTION public._trg_audit_workshop_submission();

DROP TRIGGER IF EXISTS trg_audit_workshop_submission_update ON public.workshop_submissions;
CREATE TRIGGER trg_audit_workshop_submission_update
  AFTER UPDATE ON public.workshop_submissions
  FOR EACH ROW EXECUTE FUNCTION public._trg_audit_workshop_submission();

-- 7) --------------------------------------- TRIGGERS: PROJECT SUBMISSIONS

CREATE OR REPLACE FUNCTION public._trg_audit_project_submission()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prj_title     text;
  v_course_id     uuid;
  v_course_name   text;
  v_student_email text;
  v_actor_id      uuid;
  v_actor_email   text;
  v_actor_role    text;
  v_action        text;
BEGIN
  BEGIN
    SELECT p.title, p.course_id
      INTO v_prj_title, v_course_id
      FROM public.projects p WHERE p.id = NEW.project_id;

    SELECT c.name INTO v_course_name
      FROM public.courses c WHERE c.id = v_course_id;

    SELECT au.email INTO v_student_email
      FROM auth.users au WHERE au.id = NEW.user_id;

    IF TG_OP = 'INSERT' THEN
      v_action      := 'submission.project.submitted';
      v_actor_id    := NEW.user_id;
      v_actor_email := v_student_email;
      v_actor_role  := 'Estudiante';

    ELSE
      IF OLD.final_grade IS NOT DISTINCT FROM NEW.final_grade OR NEW.final_grade IS NULL THEN
        RETURN NEW;
      END IF;

      v_action      := 'submission.project.graded';
      v_actor_id    := COALESCE(public._audit_jwt_uid(), NEW.user_id);
      SELECT au.email INTO v_actor_email FROM auth.users au WHERE au.id = v_actor_id;
      SELECT ur.role::text INTO v_actor_role FROM public.user_roles ur
        WHERE ur.user_id = v_actor_id LIMIT 1;
      v_actor_role  := COALESCE(v_actor_role, 'sistema');
    END IF;

    INSERT INTO public.audit_logs (
      actor_id, actor_email, actor_role,
      action, category, severity,
      entity_type, entity_id, entity_name,
      course_id, course_name, metadata
    ) VALUES (
      v_actor_id, v_actor_email, v_actor_role,
      v_action, 'project', 'info',
      'project_submission', NEW.id::text, v_prj_title,
      v_course_id, v_course_name,
      jsonb_build_object(
        'project_id', NEW.project_id,
        'student_id', NEW.user_id,
        'student_email', v_student_email,
        'status', NEW.status,
        'final_grade', NEW.final_grade
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_project_submission_insert ON public.project_submissions;
CREATE TRIGGER trg_audit_project_submission_insert
  AFTER INSERT ON public.project_submissions
  FOR EACH ROW EXECUTE FUNCTION public._trg_audit_project_submission();

DROP TRIGGER IF EXISTS trg_audit_project_submission_update ON public.project_submissions;
CREATE TRIGGER trg_audit_project_submission_update
  AFTER UPDATE ON public.project_submissions
  FOR EACH ROW EXECUTE FUNCTION public._trg_audit_project_submission();
