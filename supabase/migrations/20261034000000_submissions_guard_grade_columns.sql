-- ══════════════════════════════════════════════════════════════════════
-- CRÍTICO — Integridad de notas: impedir que un ESTUDIANTE auto-asigne su
-- calificación editando su propia entrega vía REST directo.
--
-- Hallazgo (validación rol-a-rol, ciclo 5, 2026-06-30 — CONFIRMADO empírica-
-- mente contra prod): la RLS de UPDATE de submissions / workshop_submissions /
-- project_submissions es `auth.uid() = user_id OR miembro-de-grupo OR staff`.
-- La RLS de Postgres es a nivel FILA, no columna, y `authenticated` tiene GRANT
-- de UPDATE en TODAS las columnas (incl. las de nota). No hay trigger que proteja
-- las columnas sensibles. Resultado: un estudiante, con su propio JWT, puede
--
--   PATCH /rest/v1/submissions?id=eq.<su_entrega>
--   { "final_override_grade": 5.0, "ai_grade": 5.0, "status": "calificado" }
--
-- y auto-asignarse la nota máxima (verificado: el UPDATE afecta 1 fila y la nota
-- queda en 5.0). Mismo vector en workshop_submissions.final_grade y
-- project_submissions.final_grade/submission_grade/defense_factor. El gradebook,
-- el acta, el boletín y la EMISIÓN DE CERTIFICADOS leen estas columnas → el
-- alumno se gradúa/certifica con nota falsa.
--
-- FIX: un trigger BEFORE UPDATE por tabla que, para un caller NO-staff (el
-- estudiante dueño / miembro del grupo), RECHAZA cualquier cambio a las columnas
-- de nota / IA / revisión / sustentación, y RECHAZA marcar/reabrir el estado
-- 'calificado'. Se PERMITE cuando:
--   • auth.uid() IS NULL  → service_role (edges de IA/cron) o SECURITY DEFINER
--     de sistema — la calificación con IA escribe ai_grade/submission_grade acá.
--   • el caller es DOCENTE del curso o Admin/SuperAdmin del tenant — la
--     calificación manual del docente (override) va por UPDATE de cliente con su
--     JWT (gradebook / monitor / dialog de taller), NO por service_role, así que
--     un REVOKE de GRANT por columna los rompería; el trigger los distingue por
--     rol. Fast-path: si el UPDATE no toca columnas sensibles ni el estado
--     'calificado' (autosave normal de answers/contenido), retorna sin consultar
--     roles.
--
-- Las columnas legítimas del estudiante (answers/contenido, focus_warnings,
-- submitted_at, repository_url, zip_path, status → entregado/completado/
-- sospechoso) NO se tocan. Defensa en profundidad sobre la RLS existente.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) submissions (exámenes) ──
CREATE OR REPLACE FUNCTION public.tg_guard_exam_submission_grade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_touch boolean;
  v_is_staff boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;  -- service_role / sistema

  v_touch :=
       NEW.final_override_grade IS DISTINCT FROM OLD.final_override_grade
    OR NEW.ai_grade             IS DISTINCT FROM OLD.ai_grade
    OR NEW.ai_detected          IS DISTINCT FROM OLD.ai_detected
    OR NEW.ai_detected_score    IS DISTINCT FROM OLD.ai_detected_score
    OR NEW.ai_detected_reasons  IS DISTINCT FROM OLD.ai_detected_reasons
    OR NEW.ai_review_at         IS DISTINCT FROM OLD.ai_review_at
    OR NEW.ai_review_by         IS DISTINCT FROM OLD.ai_review_by
    OR NEW.teacher_feedback     IS DISTINCT FROM OLD.teacher_feedback
    OR NEW.extra_seconds        IS DISTINCT FROM OLD.extra_seconds
    OR NEW.status = 'calificado'
    OR (OLD.status = 'calificado' AND NEW.status IS DISTINCT FROM OLD.status);

  IF NOT v_touch THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.exams e
    JOIN public.course_teachers ct ON ct.course_id = e.course_id
    WHERE e.id = NEW.exam_id AND ct.user_id = v_uid
  ) OR EXISTS (
    SELECT 1 FROM public.exams e
    WHERE e.id = NEW.exam_id AND public.is_admin_of_course_tenant(e.course_id)
  ) INTO v_is_staff;

  IF v_is_staff THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'No autorizado: solo el docente del curso o un administrador pueden modificar la calificación o los metadatos de revisión de una entrega';
END
$$;

-- ── 2) workshop_submissions (talleres) ──
CREATE OR REPLACE FUNCTION public.tg_guard_workshop_submission_grade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_touch boolean;
  v_is_staff boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;

  v_touch :=
       NEW.final_grade         IS DISTINCT FROM OLD.final_grade
    OR NEW.ai_grade            IS DISTINCT FROM OLD.ai_grade
    OR NEW.ai_feedback         IS DISTINCT FROM OLD.ai_feedback
    OR NEW.ai_detected         IS DISTINCT FROM OLD.ai_detected
    OR NEW.ai_detected_score   IS DISTINCT FROM OLD.ai_detected_score
    OR NEW.ai_detected_reasons IS DISTINCT FROM OLD.ai_detected_reasons
    OR NEW.ai_review_at        IS DISTINCT FROM OLD.ai_review_at
    OR NEW.ai_review_by        IS DISTINCT FROM OLD.ai_review_by
    OR NEW.teacher_feedback    IS DISTINCT FROM OLD.teacher_feedback
    OR NEW.status = 'calificado'
    OR (OLD.status = 'calificado' AND NEW.status IS DISTINCT FROM OLD.status);

  IF NOT v_touch THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.workshops w
    JOIN public.course_teachers ct ON ct.course_id = w.course_id
    WHERE w.id = NEW.workshop_id AND ct.user_id = v_uid
  ) OR EXISTS (
    SELECT 1 FROM public.workshops w
    WHERE w.id = NEW.workshop_id AND public.is_admin_of_course_tenant(w.course_id)
  ) INTO v_is_staff;

  IF v_is_staff THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'No autorizado: solo el docente del curso o un administrador pueden modificar la calificación o los metadatos de revisión de una entrega';
END
$$;

-- ── 3) project_submissions (proyectos) ──
CREATE OR REPLACE FUNCTION public.tg_guard_project_submission_grade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_touch boolean;
  v_is_staff boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;

  v_touch :=
       NEW.final_grade         IS DISTINCT FROM OLD.final_grade
    OR NEW.submission_grade    IS DISTINCT FROM OLD.submission_grade
    OR NEW.defense_factor      IS DISTINCT FROM OLD.defense_factor
    OR NEW.defense_notes       IS DISTINCT FROM OLD.defense_notes
    OR NEW.defense_at          IS DISTINCT FROM OLD.defense_at
    OR NEW.defense_video_url   IS DISTINCT FROM OLD.defense_video_url
    OR NEW.ai_grade            IS DISTINCT FROM OLD.ai_grade
    OR NEW.ai_feedback         IS DISTINCT FROM OLD.ai_feedback
    OR NEW.ai_detected         IS DISTINCT FROM OLD.ai_detected
    OR NEW.ai_detected_score   IS DISTINCT FROM OLD.ai_detected_score
    OR NEW.ai_detected_reasons IS DISTINCT FROM OLD.ai_detected_reasons
    OR NEW.ai_review_at        IS DISTINCT FROM OLD.ai_review_at
    OR NEW.ai_review_by        IS DISTINCT FROM OLD.ai_review_by
    OR NEW.teacher_feedback    IS DISTINCT FROM OLD.teacher_feedback
    OR NEW.status = 'calificado'
    OR (OLD.status = 'calificado' AND NEW.status IS DISTINCT FROM OLD.status);

  IF NOT v_touch THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.projects p
    JOIN public.course_teachers ct ON ct.course_id = p.course_id
    WHERE p.id = NEW.project_id AND ct.user_id = v_uid
  ) OR EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = NEW.project_id AND public.is_admin_of_course_tenant(p.course_id)
  ) INTO v_is_staff;

  IF v_is_staff THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'No autorizado: solo el docente del curso o un administrador pueden modificar la calificación, la sustentación o los metadatos de revisión de una entrega';
END
$$;

-- ── Triggers (idempotentes; guardados por to_regclass por si la tabla no
--    existe en un entorno Lovable a medio migrar) ──
DO $$ BEGIN
  IF to_regclass('public.submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_exam_submission_grade ON public.submissions;
    CREATE TRIGGER trg_guard_exam_submission_grade
      BEFORE UPDATE ON public.submissions
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_exam_submission_grade();
  END IF;
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_workshop_submission_grade ON public.workshop_submissions;
    CREATE TRIGGER trg_guard_workshop_submission_grade
      BEFORE UPDATE ON public.workshop_submissions
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_workshop_submission_grade();
  END IF;
  IF to_regclass('public.project_submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_project_submission_grade ON public.project_submissions;
    CREATE TRIGGER trg_guard_project_submission_grade
      BEFORE UPDATE ON public.project_submissions
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_project_submission_grade();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
