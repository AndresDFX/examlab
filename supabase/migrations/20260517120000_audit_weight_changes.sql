-- ──────────────────────────────────────────────────────────────────────
-- Auditoría automática de cambios en pesos de calificación.
--
-- Tablas observadas:
--   - grade_cuts: weight, workshop_weight, exam_weight, project_weight,
--                 attendance_weight
--   - exams:      weight
--   - workshops:  weight
--   - projects:   weight
--   - project_courses: weight (peso del proyecto por curso)
--
-- Por qué triggers DB y no client-side:
--   - Cubre cualquier ruta de update (form UI, RPC, edge function, futuro
--     import masivo). Hoy cada lugar tiene logEvent genérico que no
--     captura el delta de pesos específicamente.
--   - Compara OLD vs NEW directamente, sin fetch previo en el cliente.
-- ──────────────────────────────────────────────────────────────────────

-- ── Helper: insert audit log con actor de session si está disponible ──

CREATE OR REPLACE FUNCTION public._log_weight_change(
  _action      TEXT,
  _entity_type TEXT,
  _entity_id   TEXT,
  _entity_name TEXT,
  _course_id   UUID,
  _previous    JSONB,
  _new_values  JSONB
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _course_name TEXT;
  _actor_email TEXT;
BEGIN
  IF _course_id IS NOT NULL THEN
    SELECT name INTO _course_name FROM public.courses WHERE id = _course_id;
  END IF;

  -- Si auth.uid() devuelve algo (request del usuario), obtenemos su email.
  -- Si es un cron job o SECURITY DEFINER sin sesión, actor_id = NULL.
  IF auth.uid() IS NOT NULL THEN
    SELECT email INTO _actor_email FROM auth.users WHERE id = auth.uid();
  END IF;

  INSERT INTO public.audit_logs (
    actor_id, actor_email, action, category, severity,
    entity_type, entity_id, entity_name,
    course_id, course_name, metadata
  ) VALUES (
    auth.uid(), _actor_email,
    _action, 'grading', 'warning',
    _entity_type, _entity_id, _entity_name,
    _course_id, _course_name,
    jsonb_build_object('previous', _previous, 'new', _new_values)
  );
END
$$;

-- ── 1) grade_cuts: detectar cambios en weight + bucket weights ──

CREATE OR REPLACE FUNCTION public._audit_grade_cuts_weight_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (
    NEW.weight            IS DISTINCT FROM OLD.weight OR
    NEW.workshop_weight   IS DISTINCT FROM OLD.workshop_weight OR
    NEW.exam_weight       IS DISTINCT FROM OLD.exam_weight OR
    NEW.project_weight    IS DISTINCT FROM OLD.project_weight OR
    NEW.attendance_weight IS DISTINCT FROM OLD.attendance_weight
  ) THEN
    PERFORM public._log_weight_change(
      'grading.cut_weight_changed',
      'grade_cut',
      NEW.id::text,
      NEW.name,
      NEW.course_id,
      jsonb_build_object(
        'weight',            OLD.weight,
        'workshop_weight',   OLD.workshop_weight,
        'exam_weight',       OLD.exam_weight,
        'project_weight',    OLD.project_weight,
        'attendance_weight', OLD.attendance_weight
      ),
      jsonb_build_object(
        'weight',            NEW.weight,
        'workshop_weight',   NEW.workshop_weight,
        'exam_weight',       NEW.exam_weight,
        'project_weight',    NEW.project_weight,
        'attendance_weight', NEW.attendance_weight
      )
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_grade_cuts_weight ON public.grade_cuts;
CREATE TRIGGER trg_audit_grade_cuts_weight
  AFTER UPDATE ON public.grade_cuts
  FOR EACH ROW EXECUTE FUNCTION public._audit_grade_cuts_weight_change();

-- ── 2) exams.weight ──

CREATE OR REPLACE FUNCTION public._audit_exams_weight_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.weight IS DISTINCT FROM OLD.weight THEN
    PERFORM public._log_weight_change(
      'grading.exam_weight_changed',
      'exam',
      NEW.id::text,
      NEW.title,
      NEW.course_id,
      jsonb_build_object('weight', OLD.weight),
      jsonb_build_object('weight', NEW.weight)
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_exams_weight ON public.exams;
CREATE TRIGGER trg_audit_exams_weight
  AFTER UPDATE OF weight ON public.exams
  FOR EACH ROW EXECUTE FUNCTION public._audit_exams_weight_change();

-- ── 3) workshops.weight ──

CREATE OR REPLACE FUNCTION public._audit_workshops_weight_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.weight IS DISTINCT FROM OLD.weight THEN
    PERFORM public._log_weight_change(
      'grading.workshop_weight_changed',
      'workshop',
      NEW.id::text,
      NEW.title,
      NEW.course_id,
      jsonb_build_object('weight', OLD.weight),
      jsonb_build_object('weight', NEW.weight)
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_workshops_weight ON public.workshops;
CREATE TRIGGER trg_audit_workshops_weight
  AFTER UPDATE OF weight ON public.workshops
  FOR EACH ROW EXECUTE FUNCTION public._audit_workshops_weight_change();

-- ── 4) projects.weight ──

CREATE OR REPLACE FUNCTION public._audit_projects_weight_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.weight IS DISTINCT FROM OLD.weight THEN
    PERFORM public._log_weight_change(
      'grading.project_weight_changed',
      'project',
      NEW.id::text,
      NEW.title,
      NEW.course_id,
      jsonb_build_object('weight', OLD.weight),
      jsonb_build_object('weight', NEW.weight)
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_projects_weight ON public.projects;
CREATE TRIGGER trg_audit_projects_weight
  AFTER UPDATE OF weight ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public._audit_projects_weight_change();

-- ── 5) project_courses.weight (peso del proyecto por curso) ──

CREATE OR REPLACE FUNCTION public._audit_project_courses_weight_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _project_title TEXT;
BEGIN
  IF NEW.weight IS DISTINCT FROM OLD.weight THEN
    SELECT title INTO _project_title FROM public.projects WHERE id = NEW.project_id;
    PERFORM public._log_weight_change(
      'grading.project_course_weight_changed',
      'project_course',
      NEW.project_id::text || '|' || NEW.course_id::text,
      _project_title,
      NEW.course_id,
      jsonb_build_object('weight', OLD.weight, 'cut_id', OLD.cut_id),
      jsonb_build_object('weight', NEW.weight, 'cut_id', NEW.cut_id)
    );
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_project_courses_weight ON public.project_courses;
CREATE TRIGGER trg_audit_project_courses_weight
  AFTER UPDATE ON public.project_courses
  FOR EACH ROW EXECUTE FUNCTION public._audit_project_courses_weight_change();

NOTIFY pgrst, 'reload schema';
