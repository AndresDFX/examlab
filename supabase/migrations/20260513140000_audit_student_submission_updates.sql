-- ──────────────────────────────────────────────────────────────────────
-- Audit: trazar cuándo un estudiante actualiza una entrega ANTES de
-- entregarla (status='pendiente'). Aplica a workshop_submissions y
-- project_submissions; NO a exams (autosave continuo del examen
-- generaría miles de filas por intento, sin valor para auditoría).
--
-- Eventos nuevos:
--   - submission.workshop.updated_in_progress
--   - submission.project.updated_in_progress
--
-- Metadata incluye `within_deadline` (bool) — true si la edición ocurre
-- antes de workshops/projects.due_date. Permite filtrar "actualizaciones
-- después de la fecha límite" desde la UI de auditoría.
--
-- Para evitar ruido (UI puede guardar borrador en cada keystroke), el
-- trigger solo registra cuando pasó >= 60 segundos desde el último
-- audit log de esta entrega. Eso agrupa sesiones de edición activa.
-- ──────────────────────────────────────────────────────────────────────

-- ── Workshop submissions ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._trg_audit_workshop_submission_updates()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_workshop_title text;
  v_course_id      uuid;
  v_course_name    text;
  v_due_date       timestamptz;
  v_within         boolean;
  v_last_log_at    timestamptz;
  v_student_email  text;
BEGIN
  -- Solo entregas en estado 'pendiente' (en construcción). Una vez que
  -- el estudiante entrega (status='entregado') o se califica, no audita
  -- ediciones — esas tendrían otro significado (re-submit, override).
  IF NEW.status IS DISTINCT FROM 'pendiente' THEN
    RETURN NEW;
  END IF;

  -- Solo si cambió contenido editable. Cambios a ai_*, teacher_feedback
  -- etc. no son del estudiante editando.
  IF OLD.content IS NOT DISTINCT FROM NEW.content
     AND OLD.external_link IS NOT DISTINCT FROM NEW.external_link
     AND OLD.file_url IS NOT DISTINCT FROM NEW.file_url THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT w.title, w.course_id, w.due_date
      INTO v_workshop_title, v_course_id, v_due_date
      FROM public.workshops w WHERE w.id = NEW.workshop_id;

    SELECT c.name INTO v_course_name FROM public.courses c WHERE c.id = v_course_id;
    SELECT au.email INTO v_student_email FROM auth.users au WHERE au.id = NEW.user_id;

    v_within := (v_due_date IS NULL OR now() <= v_due_date);

    -- Debounce: si ya hay un log de updated_in_progress para esta
    -- submission hace < 60 seg, no registramos otro. Las sesiones de
    -- edición activa quedan agrupadas en una sola entrada de auditoría.
    SELECT MAX(created_at) INTO v_last_log_at
      FROM public.audit_logs
      WHERE entity_type = 'workshop_submission'
        AND entity_id = NEW.id::text
        AND action = 'submission.workshop.updated_in_progress'
        AND created_at >= now() - interval '60 seconds';

    IF v_last_log_at IS NOT NULL THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.audit_logs (
      actor_id, actor_email, actor_role,
      action, category, severity,
      entity_type, entity_id, entity_name,
      course_id, course_name, metadata
    ) VALUES (
      NEW.user_id, v_student_email, 'Estudiante',
      'submission.workshop.updated_in_progress', 'workshop',
      CASE WHEN v_within THEN 'info' ELSE 'warning' END,
      'workshop_submission', NEW.id::text, v_workshop_title,
      v_course_id, v_course_name,
      jsonb_build_object(
        'workshop_id', NEW.workshop_id,
        'student_id', NEW.user_id,
        'within_deadline', v_within,
        'due_date', v_due_date,
        'has_content', NEW.content IS NOT NULL AND length(NEW.content) > 0,
        'has_file', NEW.file_url IS NOT NULL,
        'has_link', NEW.external_link IS NOT NULL
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_workshop_submission_updates ON public.workshop_submissions;
CREATE TRIGGER trg_audit_workshop_submission_updates
  AFTER UPDATE ON public.workshop_submissions
  FOR EACH ROW EXECUTE FUNCTION public._trg_audit_workshop_submission_updates();

-- ── Project submissions ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._trg_audit_project_submission_updates()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_project_title  text;
  v_course_id      uuid;
  v_course_name    text;
  v_due_date       timestamptz;
  v_within         boolean;
  v_last_log_at    timestamptz;
  v_student_email  text;
BEGIN
  IF NEW.status IS DISTINCT FROM 'pendiente' THEN
    RETURN NEW;
  END IF;

  -- Para projects los campos editables del estudiante son repository_url
  -- + (a través de project_submission_files que es otra tabla). Acá
  -- solo capturamos cambios en la fila parent — los archivos suben/
  -- borran en project_submission_files, los cubre otro trigger si se
  -- necesita.
  IF OLD.repository_url IS NOT DISTINCT FROM NEW.repository_url THEN
    RETURN NEW;
  END IF;

  BEGIN
    SELECT p.title, p.course_id, p.due_date
      INTO v_project_title, v_course_id, v_due_date
      FROM public.projects p WHERE p.id = NEW.project_id;

    SELECT c.name INTO v_course_name FROM public.courses c WHERE c.id = v_course_id;
    SELECT au.email INTO v_student_email FROM auth.users au WHERE au.id = NEW.user_id;

    v_within := (v_due_date IS NULL OR now() <= v_due_date);

    SELECT MAX(created_at) INTO v_last_log_at
      FROM public.audit_logs
      WHERE entity_type = 'project_submission'
        AND entity_id = NEW.id::text
        AND action = 'submission.project.updated_in_progress'
        AND created_at >= now() - interval '60 seconds';

    IF v_last_log_at IS NOT NULL THEN
      RETURN NEW;
    END IF;

    INSERT INTO public.audit_logs (
      actor_id, actor_email, actor_role,
      action, category, severity,
      entity_type, entity_id, entity_name,
      course_id, course_name, metadata
    ) VALUES (
      NEW.user_id, v_student_email, 'Estudiante',
      'submission.project.updated_in_progress', 'project',
      CASE WHEN v_within THEN 'info' ELSE 'warning' END,
      'project_submission', NEW.id::text, v_project_title,
      v_course_id, v_course_name,
      jsonb_build_object(
        'project_id', NEW.project_id,
        'student_id', NEW.user_id,
        'within_deadline', v_within,
        'due_date', v_due_date,
        'has_repo', NEW.repository_url IS NOT NULL
      )
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_project_submission_updates ON public.project_submissions;
CREATE TRIGGER trg_audit_project_submission_updates
  AFTER UPDATE ON public.project_submissions
  FOR EACH ROW EXECUTE FUNCTION public._trg_audit_project_submission_updates();
