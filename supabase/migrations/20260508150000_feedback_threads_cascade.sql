-- ============================================================
-- Cascade polimórfico para feedback_threads.
--
-- Problema: feedback_threads.question_id y .submission_id apuntan a
-- 3 tablas distintas según parent_kind (questions/workshop_questions/
-- project_files y submissions/workshop_submissions/project_submissions).
-- Como no hay FK declarada (es polimórfico), borrar un examen/taller/
-- proyecto deja threads huérfanos que siguen apareciendo en el modal
-- "Conversaciones abiertas" del dashboard del docente.
--
-- Solución: trigger AFTER DELETE en cada tabla padre que limpia las
-- threads matching (parent_kind, question_id) o (parent_kind,
-- submission_id). Los comments caen por CASCADE de feedback_comments.
--
-- Adicional: cleanup one-shot al final para purgar los huérfanos que
-- ya quedaron en la BD antes de este fix.
-- ============================================================

-- ───────── Triggers por question/file ─────────

CREATE OR REPLACE FUNCTION public.cleanup_feedback_threads_for_exam_question()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM public.feedback_threads
   WHERE parent_kind = 'exam' AND question_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_questions_cleanup_threads ON public.questions;
CREATE TRIGGER trg_questions_cleanup_threads
  BEFORE DELETE ON public.questions
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_feedback_threads_for_exam_question();

CREATE OR REPLACE FUNCTION public.cleanup_feedback_threads_for_workshop_question()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM public.feedback_threads
   WHERE parent_kind = 'workshop' AND question_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_workshop_questions_cleanup_threads ON public.workshop_questions;
CREATE TRIGGER trg_workshop_questions_cleanup_threads
  BEFORE DELETE ON public.workshop_questions
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_feedback_threads_for_workshop_question();

CREATE OR REPLACE FUNCTION public.cleanup_feedback_threads_for_project_file()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM public.feedback_threads
   WHERE parent_kind = 'project' AND question_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_files_cleanup_threads ON public.project_files;
CREATE TRIGGER trg_project_files_cleanup_threads
  BEFORE DELETE ON public.project_files
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_feedback_threads_for_project_file();

-- ───────── Triggers por submission ─────────

CREATE OR REPLACE FUNCTION public.cleanup_feedback_threads_for_exam_submission()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM public.feedback_threads
   WHERE parent_kind = 'exam' AND submission_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_submissions_cleanup_threads ON public.submissions;
CREATE TRIGGER trg_submissions_cleanup_threads
  BEFORE DELETE ON public.submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_feedback_threads_for_exam_submission();

CREATE OR REPLACE FUNCTION public.cleanup_feedback_threads_for_workshop_submission()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM public.feedback_threads
   WHERE parent_kind = 'workshop' AND submission_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_workshop_submissions_cleanup_threads ON public.workshop_submissions;
CREATE TRIGGER trg_workshop_submissions_cleanup_threads
  BEFORE DELETE ON public.workshop_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_feedback_threads_for_workshop_submission();

CREATE OR REPLACE FUNCTION public.cleanup_feedback_threads_for_project_submission()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  DELETE FROM public.feedback_threads
   WHERE parent_kind = 'project' AND submission_id = OLD.id;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_submissions_cleanup_threads ON public.project_submissions;
CREATE TRIGGER trg_project_submissions_cleanup_threads
  BEFORE DELETE ON public.project_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.cleanup_feedback_threads_for_project_submission();

-- ───────── Cleanup one-shot de huérfanos pre-existentes ─────────
-- Borra threads cuyo question_id o submission_id ya no existe en la
-- tabla padre correspondiente. Los comments caen por CASCADE.

DELETE FROM public.feedback_threads ft
 WHERE ft.parent_kind = 'exam'
   AND (
     NOT EXISTS (SELECT 1 FROM public.questions q WHERE q.id = ft.question_id)
     OR NOT EXISTS (SELECT 1 FROM public.submissions s WHERE s.id = ft.submission_id)
   );

DELETE FROM public.feedback_threads ft
 WHERE ft.parent_kind = 'workshop'
   AND (
     NOT EXISTS (SELECT 1 FROM public.workshop_questions q WHERE q.id = ft.question_id)
     OR NOT EXISTS (SELECT 1 FROM public.workshop_submissions s WHERE s.id = ft.submission_id)
   );

DELETE FROM public.feedback_threads ft
 WHERE ft.parent_kind = 'project'
   AND (
     NOT EXISTS (SELECT 1 FROM public.project_files f WHERE f.id = ft.question_id)
     OR NOT EXISTS (SELECT 1 FROM public.project_submissions s WHERE s.id = ft.submission_id)
   );
