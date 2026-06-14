-- ═══════════════════════════════════════════════════════════════════════
-- Limpieza: cancelar jobs de calificación encolados para entregas de
-- TALLER/PROYECTO que YA están CALIFICADAS (job obsoleto).
--
-- Invariante: una entrega ya calificada NO debe tener un job pendiente en la
-- cola — salvo una regeneración, y la re-calificación de taller/proyecto es
-- SYNC (nunca se encola), así que un job encolado para una entrega ya
-- finalizada quedó obsoleto (se calificó por otra vía: manual, aprobar IA o
-- IA inmediata). Lo dejamos como 'cancelled' para que no lo procese el worker.
--
-- Exámenes EXCLUIDOS a propósito: su re-calificación con IA SÍ puede
-- encolarse (async) desde el monitor, así que un job sobre un examen con nota
-- previa puede ser un re-grade legítimo. No se tocan.
--
-- General (todos los tenants): cancelar un job para algo ya calificado es
-- siempre correcto en taller/proyecto. Esto limpia de paso el tenant Camacho
-- (uniaj), donde quedaron ~2 jobs de proyecto en este estado. El guard recién
-- añadido al worker (ai-grading-worker) evita que se vuelvan a acumular.
--
-- "Graded" = status='calificado' OR final_grade IS NOT NULL. Expande a los
-- jobs hijos (workshop_submission_answers / project_submission_files de esas
-- entregas).
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  _msg TEXT := 'Cancelado: la entrega ya estaba calificada (limpieza de job obsoleto).';
BEGIN
  IF to_regclass('public.ai_grading_queue') IS NULL THEN
    RETURN;
  END IF;

  -- ── Talleres: job sobre la entrega completa ──────────────────────────
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'workshop_submissions'
       AND EXISTS (
         SELECT 1 FROM public.workshop_submissions ws
          WHERE ws.id = q.target_row_id
            AND (ws.status = 'calificado' OR ws.final_grade IS NOT NULL)
       );

    -- Talleres: jobs por-pregunta de entregas ya calificadas.
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'workshop_submission_answers'
       AND EXISTS (
         SELECT 1
           FROM public.workshop_submission_answers a
           JOIN public.workshop_submissions ws ON ws.id = a.submission_id
          WHERE a.id = q.target_row_id
            AND (ws.status = 'calificado' OR ws.final_grade IS NOT NULL)
       );
  END IF;

  -- ── Proyectos: job sobre la entrega completa ─────────────────────────
  IF to_regclass('public.project_submissions') IS NOT NULL THEN
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'project_submissions'
       AND EXISTS (
         SELECT 1 FROM public.project_submissions ps
          WHERE ps.id = q.target_row_id
            AND (ps.status = 'calificado' OR ps.final_grade IS NOT NULL)
       );

    -- Proyectos: jobs por-archivo de entregas ya calificadas.
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'project_submission_files'
       AND EXISTS (
         SELECT 1
           FROM public.project_submission_files f
           JOIN public.project_submissions ps ON ps.id = f.submission_id
          WHERE f.id = q.target_row_id
            AND (ps.status = 'calificado' OR ps.final_grade IS NOT NULL)
       );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
