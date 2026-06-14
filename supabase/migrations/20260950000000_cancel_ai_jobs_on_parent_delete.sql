-- ═══════════════════════════════════════════════════════════════════════
-- Cancelar jobs de la cola de IA cuando se ELIMINA el contenido original.
--
-- Si se borra (a Papelera = soft-delete, o físico = hard-delete) un examen,
-- taller, proyecto o un contenido generado, los eventos asociados en las
-- colas de IA deben quitarse — ya no tiene sentido calificar/generar sobre
-- algo que ya no existe (gastaría cupo IA y dejaría jobs huérfanos).
--
-- Cubre AMBAS colas:
--   - ai_grading_queue   → jobs de las ENTREGAS del padre (+ sus answers/files).
--   - ai_generation_queue→ jobs cuyo (source_table, source_id) = el padre
--     (generación de preguntas de examen/taller, archivos de proyecto, o
--     contenido didáctico).
--
-- Implementado con UN trigger por tabla padre, `BEFORE UPDATE OF deleted_at
-- OR DELETE`:
--   - UPDATE: solo actúa en la transición soft-delete (deleted_at null→no-null);
--     restaurar o editar NO cancela.
--   - DELETE (BEFORE): corre ANTES de que las cascadas borren las entregas
--     hijas, así los subqueries todavía las ven.
-- SECURITY DEFINER: limpia las colas saltando su RLS (el caller ya tiene
-- permiso para borrar el padre vía RLS de su tabla).
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._cancel_ai_jobs_for_deleted_parent()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _kind TEXT := TG_ARGV[0];  -- 'exam' | 'workshop' | 'project' | 'content'
  _msg  TEXT;
BEGIN
  -- En UPDATE solo seguimos si es la transición a soft-deleted.
  IF TG_OP = 'UPDATE' AND NOT (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  _msg := CASE _kind
    WHEN 'exam'     THEN 'Cancelado: el examen fue eliminado.'
    WHEN 'workshop' THEN 'Cancelado: el taller fue eliminado.'
    WHEN 'project'  THEN 'Cancelado: el proyecto fue eliminado.'
    WHEN 'content'  THEN 'Cancelado: el contenido fue eliminado.'
    ELSE 'Cancelado: el contenido original fue eliminado.'
  END;

  -- ── Cola de CALIFICACIÓN (no aplica a 'content') ────────────────────
  IF _kind = 'exam' THEN
    UPDATE public.ai_grading_queue
       SET status = 'cancelled', completed_at = now(), last_error = _msg
     WHERE status IN ('pending', 'processing')
       AND target_table = 'submissions'
       AND target_row_id IN (SELECT id FROM public.submissions WHERE exam_id = OLD.id);

  ELSIF _kind = 'workshop' THEN
    UPDATE public.ai_grading_queue
       SET status = 'cancelled', completed_at = now(), last_error = _msg
     WHERE status IN ('pending', 'processing')
       AND (
         (target_table = 'workshop_submissions'
          AND target_row_id IN (SELECT id FROM public.workshop_submissions WHERE workshop_id = OLD.id))
         OR (target_table = 'workshop_submission_answers'
             AND target_row_id IN (
               SELECT a.id FROM public.workshop_submission_answers a
                 JOIN public.workshop_submissions ws ON ws.id = a.submission_id
                WHERE ws.workshop_id = OLD.id))
       );

  ELSIF _kind = 'project' THEN
    UPDATE public.ai_grading_queue
       SET status = 'cancelled', completed_at = now(), last_error = _msg
     WHERE status IN ('pending', 'processing')
       AND (
         (target_table = 'project_submissions'
          AND target_row_id IN (SELECT id FROM public.project_submissions WHERE project_id = OLD.id))
         OR (target_table = 'project_submission_files'
             AND target_row_id IN (
               SELECT f.id FROM public.project_submission_files f
                 JOIN public.project_submissions ps ON ps.id = f.submission_id
                WHERE ps.project_id = OLD.id))
       );
  END IF;

  -- ── Cola de GENERACIÓN (source = el padre) ──────────────────────────
  IF to_regclass('public.ai_generation_queue') IS NOT NULL THEN
    UPDATE public.ai_generation_queue
       SET status = 'cancelled', completed_at = now(), last_error = _msg
     WHERE status IN ('pending', 'processing')
       AND source_id = OLD.id
       AND source_table = CASE _kind
         WHEN 'exam'     THEN 'exams'
         WHEN 'workshop' THEN 'workshops'
         WHEN 'project'  THEN 'projects'
         WHEN 'content'  THEN 'generated_contents'
       END;
  END IF;

  RETURN COALESCE(NEW, OLD);
END
$$;

-- Triggers por tabla padre (idempotentes). Guard `to_regclass` por si la
-- tabla no existe en el entorno donde Lovable aplica la migración.
DO $$
BEGIN
  IF to_regclass('public.exams') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tg_cancel_ai_jobs_on_exam_delete ON public.exams;
    CREATE TRIGGER tg_cancel_ai_jobs_on_exam_delete
      BEFORE UPDATE OF deleted_at OR DELETE ON public.exams
      FOR EACH ROW EXECUTE FUNCTION public._cancel_ai_jobs_for_deleted_parent('exam');
  END IF;

  IF to_regclass('public.workshops') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tg_cancel_ai_jobs_on_workshop_delete ON public.workshops;
    CREATE TRIGGER tg_cancel_ai_jobs_on_workshop_delete
      BEFORE UPDATE OF deleted_at OR DELETE ON public.workshops
      FOR EACH ROW EXECUTE FUNCTION public._cancel_ai_jobs_for_deleted_parent('workshop');
  END IF;

  IF to_regclass('public.projects') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tg_cancel_ai_jobs_on_project_delete ON public.projects;
    CREATE TRIGGER tg_cancel_ai_jobs_on_project_delete
      BEFORE UPDATE OF deleted_at OR DELETE ON public.projects
      FOR EACH ROW EXECUTE FUNCTION public._cancel_ai_jobs_for_deleted_parent('project');
  END IF;

  IF to_regclass('public.generated_contents') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tg_cancel_ai_jobs_on_content_delete ON public.generated_contents;
    CREATE TRIGGER tg_cancel_ai_jobs_on_content_delete
      BEFORE UPDATE OF deleted_at OR DELETE ON public.generated_contents
      FOR EACH ROW EXECUTE FUNCTION public._cancel_ai_jobs_for_deleted_parent('content');
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
