-- =============================================================
-- Audit logs: arreglar visibilidad para Docentes.
--
-- Síntoma: el docente no veía NINGÚN evento en /app/teacher/audit-logs.
--
-- Causas:
--   1) Logs antiguos donde `course_id` quedó NULL (trigger no pudo
--      resolver el curso del entity, o INSERT directo desde frontend
--      sin pasarlo). La RLS del docente exige `course_id IN (sus
--      cursos) OR actor_id = él` — sin course_id y sin ser actor,
--      el log se le escondía.
--   2) Logs derivados de submissions de proyectos/talleres con
--      `is_external` u otros casos donde el join a `exams`/`workshops`/
--      `projects` falla por RLS o por columna missing.
--   3) Triggers usan `EXCEPTION WHEN OTHERS THEN NULL`, así que si
--      alguno fallaba al resolver el curso, ni siquiera se insertaba
--      el log y no había forma de detectarlo.
--
-- Fix:
--   A) Política de SELECT del docente más permisiva: además del match
--      directo por `course_id`, permite ver el log si su `entity_id`
--      apunta a una submission de un examen/taller/proyecto cuyo curso
--      está en `course_teachers` del docente.
--   B) Backfill `course_id` en logs huérfanos derivando del entity.
--   C) Reemplazar `EXCEPTION WHEN OTHERS THEN NULL` por `RAISE WARNING`
--      en los triggers para que los fallos queden visibles en logs.
-- =============================================================

-- A) ---------------------------------------------------- RLS DOCENTE
DROP POLICY IF EXISTS "audit_logs_teacher_select" ON public.audit_logs;

CREATE POLICY "audit_logs_teacher_select" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Docente')
    AND (
      -- Match directo: el log tiene course_id de un curso del docente.
      course_id IN (
        SELECT course_id FROM public.course_teachers WHERE user_id = auth.uid()
      )
      -- El docente fue el actor.
      OR actor_id = auth.uid()
      -- Match indirecto vía entity: el log es sobre una submission de
      -- examen / taller / proyecto cuyo curso es del docente. Cubre
      -- los casos donde course_id quedó NULL pero el evento sí
      -- corresponde a un curso del docente.
      OR (
        entity_type = 'exam_submission'
        AND entity_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM public.submissions s
            JOIN public.exams e ON e.id = s.exam_id
            JOIN public.course_teachers ct
              ON ct.course_id = e.course_id AND ct.user_id = auth.uid()
           WHERE s.id::text = entity_id
        )
      )
      OR (
        entity_type = 'workshop_submission'
        AND entity_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM public.workshop_submissions ws
            JOIN public.workshops w ON w.id = ws.workshop_id
            JOIN public.course_teachers ct
              ON ct.course_id = w.course_id AND ct.user_id = auth.uid()
           WHERE ws.id::text = entity_id
        )
      )
      OR (
        entity_type = 'project_submission'
        AND entity_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM public.project_submissions ps
            JOIN public.projects p ON p.id = ps.project_id
            JOIN public.course_teachers ct
              ON ct.course_id = p.course_id AND ct.user_id = auth.uid()
           WHERE ps.id::text = entity_id
        )
      )
    )
  );

-- B) ----------------------------------------------- BACKFILL course_id
-- Para logs históricos donde el course_id quedó NULL, lo derivamos del
-- entity referenciado. Si el entity ya no existe (fue borrado), el log
-- queda con course_id NULL y solo lo verá el actor o un Admin.
UPDATE public.audit_logs al
   SET course_id = e.course_id,
       course_name = COALESCE(al.course_name, c.name)
  FROM public.submissions s
  JOIN public.exams e ON e.id = s.exam_id
  LEFT JOIN public.courses c ON c.id = e.course_id
 WHERE al.entity_type = 'exam_submission'
   AND al.course_id IS NULL
   AND s.id::text = al.entity_id;

UPDATE public.audit_logs al
   SET course_id = w.course_id,
       course_name = COALESCE(al.course_name, c.name)
  FROM public.workshop_submissions ws
  JOIN public.workshops w ON w.id = ws.workshop_id
  LEFT JOIN public.courses c ON c.id = w.course_id
 WHERE al.entity_type = 'workshop_submission'
   AND al.course_id IS NULL
   AND ws.id::text = al.entity_id;

UPDATE public.audit_logs al
   SET course_id = p.course_id,
       course_name = COALESCE(al.course_name, c.name)
  FROM public.project_submissions ps
  JOIN public.projects p ON p.id = ps.project_id
  LEFT JOIN public.courses c ON c.id = p.course_id
 WHERE al.entity_type = 'project_submission'
   AND al.course_id IS NULL
   AND ps.id::text = al.entity_id;

-- C) -------------------------- TRIGGERS: reemplazar swallow por WARNING
-- Recreamos los 3 triggers cambiando `EXCEPTION WHEN OTHERS THEN NULL`
-- por `RAISE WARNING` para que cualquier fallo quede en logs (Lovable
-- los expone) y no haga que el log se pierda silenciosamente.

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
            IF OLD.final_override_grade IS NOT DISTINCT FROM NEW.final_override_grade THEN
              RETURN NEW;
            END IF;
            v_action := NULL;
        END CASE;
      END IF;

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
    -- Antes: NULL (silencioso). Ahora levantamos warning para que el
    -- mensaje quede en logs. NO re-raise: si el INSERT del audit
    -- fallara, NO queremos que la submission del estudiante falle.
    RAISE WARNING '[audit] exam_submission trigger failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

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
    RAISE WARNING '[audit] workshop_submission trigger failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

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
    RAISE WARNING '[audit] project_submission trigger failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;
