-- ============================================================
-- Permite al ESTUDIANTE eliminar su propia entrega de taller o
-- proyecto SIEMPRE QUE el plazo esté abierto. Las políticas previas
-- de Docente/Admin siguen vigentes — RLS aplica OR entre policies
-- de la misma operación.
--
-- "Plazo abierto" = status='published' AND due_date IS NULL OR
-- due_date > now() AND start_date IS NULL OR start_date <= now().
--
-- Adicional: agrega FK CASCADE para workshop_submission_answers ->
-- workshop_submissions, que estaba definida sin FK (las respuestas
-- quedaban huérfanas al borrar la entrega). Lo mismo con
-- attendance_records / project_submission_files que ya tenían
-- CASCADE en sus migraciones originales.
-- ============================================================

-- ───────── workshop_submission_answers FK CASCADE ─────────
-- Solo agregamos si no existe ya — algunos entornos pueden tenerla.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workshop_submission_answers_submission_id_fkey'
  ) THEN
    -- Defensivo: borra huérfanos previos (submission_id sin entrega)
    DELETE FROM public.workshop_submission_answers wsa
    WHERE NOT EXISTS (
      SELECT 1 FROM public.workshop_submissions ws WHERE ws.id = wsa.submission_id
    );
    ALTER TABLE public.workshop_submission_answers
      ADD CONSTRAINT workshop_submission_answers_submission_id_fkey
      FOREIGN KEY (submission_id)
      REFERENCES public.workshop_submissions(id)
      ON DELETE CASCADE;
  END IF;
END $$;

-- ───────── RLS workshop_submissions: estudiante puede borrar su entrega ─────────
DROP POLICY IF EXISTS "Students delete own workshop submissions in window"
  ON public.workshop_submissions;
CREATE POLICY "Students delete own workshop submissions in window"
  ON public.workshop_submissions FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.workshops w
      WHERE w.id = workshop_submissions.workshop_id
        AND w.status = 'published'
        AND (w.due_date IS NULL OR w.due_date > now())
        AND (w.start_date IS NULL OR w.start_date <= now())
    )
  );

-- ───────── RLS project_submissions: estudiante puede borrar su entrega ─────────
DROP POLICY IF EXISTS "Students delete own project submissions in window"
  ON public.project_submissions;
CREATE POLICY "Students delete own project submissions in window"
  ON public.project_submissions FOR DELETE TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_submissions.project_id
        AND p.status = 'published'
        AND (p.due_date IS NULL OR p.due_date > now())
        AND (p.start_date IS NULL OR p.start_date <= now())
    )
  );
