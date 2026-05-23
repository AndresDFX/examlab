-- ──────────────────────────────────────────────────────────────────────
-- Limpieza automática de `ai_grading_queue` cuando se borra el target.
--
-- La cola es polimórfica: `(target_table, target_row_id)` apunta a una
-- fila de tres tablas distintas (`submissions`, `workshop_submission_answers`,
-- `project_submission_files`). Como no hay FK real, eliminar el padre
-- (exam, workshop, project) cascadeaba a la fila destino pero dejaba
-- jobs huérfanos en la cola — el worker los procesaba, fallaba al
-- UPDATE de un row inexistente, marcaba `failed` y dejaba ruido.
--
-- Solución: AFTER DELETE triggers en las tres tablas leaf. La cadena
-- CASCADE de FK ya las dispara cuando se borra el padre, así que con
-- esto cubrimos todos los caminos:
--
--   Borra exam     → CASCADE submissions                  → trigger limpia jobs
--   Borra workshop → CASCADE workshop_submissions
--                  → CASCADE workshop_submission_answers  → trigger limpia jobs
--   Borra project  → CASCADE project_submissions
--                  → CASCADE project_submission_files     → trigger limpia jobs
--
-- Bonus: si el docente fuerza recalificación (que típicamente borra +
-- re-inserta el answer row), los jobs viejos también se limpian — no
-- quedan apuntando a IDs reciclados de la pasada anterior.
-- ──────────────────────────────────────────────────────────────────────

-- Helper genérico: borra de la cola las filas que apuntan a OLD.id.
-- El target_table se determina por el TG_ARGV (lo pasa cada trigger).
CREATE OR REPLACE FUNCTION public.tg_delete_ai_grading_queue_for_target()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _target_table TEXT := TG_ARGV[0];
BEGIN
  DELETE FROM public.ai_grading_queue
   WHERE target_table = _target_table
     AND target_row_id = OLD.id;
  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION public.tg_delete_ai_grading_queue_for_target() FROM PUBLIC;

-- ─── Trigger sobre submissions (exámenes) ────────────────────────────
DROP TRIGGER IF EXISTS trg_submissions_cleanup_ai_queue ON public.submissions;
CREATE TRIGGER trg_submissions_cleanup_ai_queue
  AFTER DELETE ON public.submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_delete_ai_grading_queue_for_target('submissions');

-- ─── Trigger sobre workshop_submission_answers ───────────────────────
DROP TRIGGER IF EXISTS trg_workshop_answers_cleanup_ai_queue ON public.workshop_submission_answers;
CREATE TRIGGER trg_workshop_answers_cleanup_ai_queue
  AFTER DELETE ON public.workshop_submission_answers
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_delete_ai_grading_queue_for_target('workshop_submission_answers');

-- ─── Trigger sobre project_submission_files ──────────────────────────
DROP TRIGGER IF EXISTS trg_project_files_cleanup_ai_queue ON public.project_submission_files;
CREATE TRIGGER trg_project_files_cleanup_ai_queue
  AFTER DELETE ON public.project_submission_files
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_delete_ai_grading_queue_for_target('project_submission_files');

-- Cleanup retroactivo: borra los jobs huérfanos que quedaron de
-- borrados previos (antes de existir estos triggers). Hacemos esto
-- inline en la migración para que la cola quede limpia desde ya.
DELETE FROM public.ai_grading_queue q
 WHERE q.target_table = 'submissions'
   AND NOT EXISTS (SELECT 1 FROM public.submissions s WHERE s.id = q.target_row_id);

DELETE FROM public.ai_grading_queue q
 WHERE q.target_table = 'workshop_submission_answers'
   AND NOT EXISTS (
     SELECT 1 FROM public.workshop_submission_answers a WHERE a.id = q.target_row_id
   );

DELETE FROM public.ai_grading_queue q
 WHERE q.target_table = 'project_submission_files'
   AND NOT EXISTS (
     SELECT 1 FROM public.project_submission_files f WHERE f.id = q.target_row_id
   );

NOTIFY pgrst, 'reload schema';
