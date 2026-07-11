-- ──────────────────────────────────────────────────────────────────────
-- Auditoría de INTEGRIDAD / anti-fraude de acciones sensibles del docente.
--
-- Objetivo: para prevenir fraude, registrar cada vez que un HUMANO staff
-- (docente/admin) cambia manualmente una NOTA o dato sensible de una entrega
-- —NO las notas que pone la IA— capturando: quién (actor + rol), cuándo,
-- IP, el CAMPO, el VALOR ANTERIOR y el VALOR NUEVO.
--
-- Distinción humano vs IA/sistema (clave del pedido):
--   - IA / worker / edge escriben con service_role → auth.uid() IS NULL → NO se audita.
--   - El propio estudiante (submit / autocalificación client-side) → auth.uid() = user_id → NO se audita.
--   - Docente/Admin del curso (override manual) → auth.uid() = staff ≠ alumno → SÍ se audita.
--
-- Campos sensibles por tabla:
--   submissions (examen):     final_override_grade, teacher_feedback
--   workshop_submissions:     final_grade, teacher_feedback
--   project_submissions:      final_grade, submission_grade, defense_factor, defense_notes, teacher_feedback
--
-- Eventos: category='integrity', severity='warning'.
--   integrity.grade_changed    (campos numéricos de nota / factor)
--   integrity.feedback_changed (retroalimentación / notas de sustentación)
-- metadata: { field, old_value, new_value, ip, student_id, student_email, changed_by_role }.
--
-- Convive con los triggers `_trg_audit_*` existentes (timeline general): estos
-- añaden el rastro forense con anterior→nuevo + IP. La auditoría NUNCA rompe el
-- UPDATE (EXCEPTION → RETURN NEW). Defensiva por tabla (to_regclass).
-- ──────────────────────────────────────────────────────────────────────

-- IP del cliente desde los headers de la request (GUC de PostgREST). Toma la
-- primera de x-forwarded-for (cadena de proxies) o fallbacks. NULL si no hay
-- headers (ej. cambios por service_role, que igual no llegan acá).
CREATE OR REPLACE FUNCTION public._audit_client_ip()
RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  h text;
  j json;
BEGIN
  h := current_setting('request.headers', true);
  IF h IS NULL OR h = '' THEN RETURN NULL; END IF;
  BEGIN
    j := h::json;
  EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
  END;
  RETURN NULLIF(
    trim(split_part(
      COALESCE(
        j ->> 'x-forwarded-for',
        j ->> 'cf-connecting-ip',
        j ->> 'x-real-ip',
        ''
      ), ',', 1
    )),
    ''
  );
END;
$$;

-- Inserta UN evento de integridad por campo cambiado. Resuelve email + rol del actor.
CREATE OR REPLACE FUNCTION public._audit_integrity_field(
  _actor_id uuid, _action text, _entity_type text, _entity_id text, _entity_name text,
  _course_id uuid, _course_name text, _field text, _old text, _new text,
  _student_id uuid, _student_email text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_email text;
  v_role  text;
BEGIN
  SELECT email INTO v_email FROM auth.users WHERE id = _actor_id;
  SELECT role::text INTO v_role
    FROM public.user_roles
    WHERE user_id = _actor_id
    ORDER BY CASE role::text
               WHEN 'SuperAdmin' THEN 0 WHEN 'Admin' THEN 1 WHEN 'Docente' THEN 2 ELSE 3
             END
    LIMIT 1;
  v_role := COALESCE(v_role, 'Docente');

  INSERT INTO public.audit_logs (
    actor_id, actor_email, actor_role,
    action, category, severity,
    entity_type, entity_id, entity_name,
    course_id, course_name, metadata
  ) VALUES (
    _actor_id, v_email, v_role,
    _action, 'integrity', 'warning',
    _entity_type, _entity_id, _entity_name,
    _course_id, _course_name,
    jsonb_build_object(
      'field', _field,
      'old_value', _old,
      'new_value', _new,
      'ip', public._audit_client_ip(),
      'student_id', _student_id,
      'student_email', _student_email,
      'changed_by_role', v_role
    )
  );
END;
$$;

-- ── EXAMEN ──
CREATE OR REPLACE FUNCTION public._trg_integrity_exam_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_staff boolean;
  v_title text; v_course_id uuid; v_course_name text; v_student_email text;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;        -- IA / service_role
  IF v_uid = NEW.user_id THEN RETURN NEW; END IF;  -- el propio estudiante
  IF NEW.final_override_grade IS NOT DISTINCT FROM OLD.final_override_grade
     AND NEW.teacher_feedback IS NOT DISTINCT FROM OLD.teacher_feedback THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.exams e JOIN public.course_teachers ct ON ct.course_id = e.course_id
    WHERE e.id = NEW.exam_id AND ct.user_id = v_uid
  ) OR EXISTS (
    SELECT 1 FROM public.exams e WHERE e.id = NEW.exam_id AND public.is_admin_of_course_tenant(e.course_id)
  ) INTO v_is_staff;
  IF NOT v_is_staff THEN RETURN NEW; END IF;

  SELECT e.title, e.course_id INTO v_title, v_course_id FROM public.exams e WHERE e.id = NEW.exam_id;
  SELECT name INTO v_course_name FROM public.courses WHERE id = v_course_id;
  SELECT email INTO v_student_email FROM auth.users WHERE id = NEW.user_id;

  IF NEW.final_override_grade IS DISTINCT FROM OLD.final_override_grade THEN
    PERFORM public._audit_integrity_field(v_uid, 'integrity.grade_changed', 'exam_submission', NEW.id::text, v_title,
      v_course_id, v_course_name, 'final_override_grade', OLD.final_override_grade::text, NEW.final_override_grade::text, NEW.user_id, v_student_email);
  END IF;
  IF NEW.teacher_feedback IS DISTINCT FROM OLD.teacher_feedback THEN
    PERFORM public._audit_integrity_field(v_uid, 'integrity.feedback_changed', 'exam_submission', NEW.id::text, v_title,
      v_course_id, v_course_name, 'teacher_feedback', left(COALESCE(OLD.teacher_feedback,''),500), left(COALESCE(NEW.teacher_feedback,''),500), NEW.user_id, v_student_email);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW; -- la auditoría nunca rompe el UPDATE
END;
$$;

-- ── TALLER ──
CREATE OR REPLACE FUNCTION public._trg_integrity_workshop_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_staff boolean;
  v_title text; v_course_id uuid; v_course_name text; v_student_email text;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  IF v_uid = NEW.user_id THEN RETURN NEW; END IF;
  IF NEW.final_grade IS NOT DISTINCT FROM OLD.final_grade
     AND NEW.teacher_feedback IS NOT DISTINCT FROM OLD.teacher_feedback THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.workshops w JOIN public.course_teachers ct ON ct.course_id = w.course_id
    WHERE w.id = NEW.workshop_id AND ct.user_id = v_uid
  ) OR EXISTS (
    SELECT 1 FROM public.workshops w WHERE w.id = NEW.workshop_id AND public.is_admin_of_course_tenant(w.course_id)
  ) INTO v_is_staff;
  IF NOT v_is_staff THEN RETURN NEW; END IF;

  SELECT w.title, w.course_id INTO v_title, v_course_id FROM public.workshops w WHERE w.id = NEW.workshop_id;
  SELECT name INTO v_course_name FROM public.courses WHERE id = v_course_id;
  SELECT email INTO v_student_email FROM auth.users WHERE id = NEW.user_id;

  IF NEW.final_grade IS DISTINCT FROM OLD.final_grade THEN
    PERFORM public._audit_integrity_field(v_uid, 'integrity.grade_changed', 'workshop_submission', NEW.id::text, v_title,
      v_course_id, v_course_name, 'final_grade', OLD.final_grade::text, NEW.final_grade::text, NEW.user_id, v_student_email);
  END IF;
  IF NEW.teacher_feedback IS DISTINCT FROM OLD.teacher_feedback THEN
    PERFORM public._audit_integrity_field(v_uid, 'integrity.feedback_changed', 'workshop_submission', NEW.id::text, v_title,
      v_course_id, v_course_name, 'teacher_feedback', left(COALESCE(OLD.teacher_feedback,''),500), left(COALESCE(NEW.teacher_feedback,''),500), NEW.user_id, v_student_email);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- ── PROYECTO ──
CREATE OR REPLACE FUNCTION public._trg_integrity_project_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_staff boolean;
  v_title text; v_course_id uuid; v_course_name text; v_student_email text;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  IF v_uid = NEW.user_id THEN RETURN NEW; END IF;
  IF NEW.final_grade IS NOT DISTINCT FROM OLD.final_grade
     AND NEW.submission_grade IS NOT DISTINCT FROM OLD.submission_grade
     AND NEW.defense_factor IS NOT DISTINCT FROM OLD.defense_factor
     AND NEW.defense_notes IS NOT DISTINCT FROM OLD.defense_notes
     AND NEW.teacher_feedback IS NOT DISTINCT FROM OLD.teacher_feedback THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.projects p JOIN public.course_teachers ct ON ct.course_id = p.course_id
    WHERE p.id = NEW.project_id AND ct.user_id = v_uid
  ) OR EXISTS (
    SELECT 1 FROM public.projects p WHERE p.id = NEW.project_id AND public.is_admin_of_course_tenant(p.course_id)
  ) INTO v_is_staff;
  IF NOT v_is_staff THEN RETURN NEW; END IF;

  SELECT p.title, p.course_id INTO v_title, v_course_id FROM public.projects p WHERE p.id = NEW.project_id;
  SELECT name INTO v_course_name FROM public.courses WHERE id = v_course_id;
  SELECT email INTO v_student_email FROM auth.users WHERE id = NEW.user_id;

  IF NEW.final_grade IS DISTINCT FROM OLD.final_grade THEN
    PERFORM public._audit_integrity_field(v_uid, 'integrity.grade_changed', 'project_submission', NEW.id::text, v_title,
      v_course_id, v_course_name, 'final_grade', OLD.final_grade::text, NEW.final_grade::text, NEW.user_id, v_student_email);
  END IF;
  IF NEW.submission_grade IS DISTINCT FROM OLD.submission_grade THEN
    PERFORM public._audit_integrity_field(v_uid, 'integrity.grade_changed', 'project_submission', NEW.id::text, v_title,
      v_course_id, v_course_name, 'submission_grade', OLD.submission_grade::text, NEW.submission_grade::text, NEW.user_id, v_student_email);
  END IF;
  IF NEW.defense_factor IS DISTINCT FROM OLD.defense_factor THEN
    PERFORM public._audit_integrity_field(v_uid, 'integrity.grade_changed', 'project_submission', NEW.id::text, v_title,
      v_course_id, v_course_name, 'defense_factor', OLD.defense_factor::text, NEW.defense_factor::text, NEW.user_id, v_student_email);
  END IF;
  IF NEW.defense_notes IS DISTINCT FROM OLD.defense_notes THEN
    PERFORM public._audit_integrity_field(v_uid, 'integrity.feedback_changed', 'project_submission', NEW.id::text, v_title,
      v_course_id, v_course_name, 'defense_notes', left(COALESCE(OLD.defense_notes,''),500), left(COALESCE(NEW.defense_notes,''),500), NEW.user_id, v_student_email);
  END IF;
  IF NEW.teacher_feedback IS DISTINCT FROM OLD.teacher_feedback THEN
    PERFORM public._audit_integrity_field(v_uid, 'integrity.feedback_changed', 'project_submission', NEW.id::text, v_title,
      v_course_id, v_course_name, 'teacher_feedback', left(COALESCE(OLD.teacher_feedback,''),500), left(COALESCE(NEW.teacher_feedback,''),500), NEW.user_id, v_student_email);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- ── Triggers (AFTER UPDATE) ──
DO $$
BEGIN
  IF to_regclass('public.submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_integrity_exam_submission ON public.submissions;
    CREATE TRIGGER trg_integrity_exam_submission
      AFTER UPDATE ON public.submissions
      FOR EACH ROW EXECUTE FUNCTION public._trg_integrity_exam_submission();
  END IF;
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_integrity_workshop_submission ON public.workshop_submissions;
    CREATE TRIGGER trg_integrity_workshop_submission
      AFTER UPDATE ON public.workshop_submissions
      FOR EACH ROW EXECUTE FUNCTION public._trg_integrity_workshop_submission();
  END IF;
  IF to_regclass('public.project_submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_integrity_project_submission ON public.project_submissions;
    CREATE TRIGGER trg_integrity_project_submission
      AFTER UPDATE ON public.project_submissions
      FOR EACH ROW EXECUTE FUNCTION public._trg_integrity_project_submission();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
