-- =====================================================================
-- Projects module (extensión) — slots de archivo + entrega texto-por-caja
-- =====================================================================
-- La tabla `projects` y `project_submissions` ya existen en una migración
-- previa basada en ZIP. Aquí añadimos:
--   - `project_files`            (un slot/caja por archivo esperado)
--   - `project_assignments`
--   - `project_submission_files` (respuesta texto del estudiante por slot)
--
-- También vinculamos cortes a proyectos vía FK (`grade_cut_items.project_id`)
-- y suavizamos el CHECK del esquema de cortes para aceptar tanto el FK como
-- el `project_title` libre original.
--
-- El campo `max_files` de `projects` se reusa como "número de archivos
-- esperados" — lo escribe la generación con IA y lo edita el docente.
-- =====================================================================

-- ============ PROJECT FILES (slots) ============
CREATE TABLE IF NOT EXISTS public.project_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  description TEXT,
  expected_rubric TEXT,
  language TEXT,
  points NUMERIC NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_files_project ON public.project_files(project_id);
ALTER TABLE public.project_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_files_view_all_authenticated" ON public.project_files;
CREATE POLICY "project_files_view_all_authenticated"
  ON public.project_files FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "project_files_manage_teachers_admins" ON public.project_files;
CREATE POLICY "project_files_manage_teachers_admins"
  ON public.project_files FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));


-- ============ PROJECT ASSIGNMENTS ============
CREATE TABLE IF NOT EXISTS public.project_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);
ALTER TABLE public.project_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_assignments_owner_or_staff" ON public.project_assignments;
CREATE POLICY "project_assignments_owner_or_staff"
  ON public.project_assignments FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Docente')
    OR public.has_role(auth.uid(), 'Admin')
  );

DROP POLICY IF EXISTS "project_assignments_manage_staff" ON public.project_assignments;
CREATE POLICY "project_assignments_manage_staff"
  ON public.project_assignments FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));


-- ============ PROJECT SUBMISSION FILES (respuesta texto por slot) ============
CREATE TABLE IF NOT EXISTS public.project_submission_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id UUID NOT NULL REFERENCES public.project_submissions(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES public.project_files(id) ON DELETE CASCADE,
  content TEXT,
  ai_grade NUMERIC,
  ai_feedback TEXT,
  ai_likelihood NUMERIC,
  ai_reasons TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(submission_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_project_sub_files_sub ON public.project_submission_files(submission_id);
CREATE INDEX IF NOT EXISTS idx_project_sub_files_file ON public.project_submission_files(file_id);
ALTER TABLE public.project_submission_files ENABLE ROW LEVEL SECURITY;
DROP TRIGGER IF EXISTS project_sub_files_updated ON public.project_submission_files;
CREATE TRIGGER project_sub_files_updated BEFORE UPDATE ON public.project_submission_files
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP POLICY IF EXISTS "project_sub_files_owner_or_staff_select" ON public.project_submission_files;
CREATE POLICY "project_sub_files_owner_or_staff_select"
  ON public.project_submission_files FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_submissions ps
      WHERE ps.id = submission_id
        AND (ps.user_id = auth.uid()
             OR public.has_role(auth.uid(), 'Docente')
             OR public.has_role(auth.uid(), 'Admin'))
    )
  );

DROP POLICY IF EXISTS "project_sub_files_owner_or_staff_insert" ON public.project_submission_files;
CREATE POLICY "project_sub_files_owner_or_staff_insert"
  ON public.project_submission_files FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.project_submissions ps
      WHERE ps.id = submission_id AND ps.user_id = auth.uid()
    )
    OR public.has_role(auth.uid(), 'Docente')
    OR public.has_role(auth.uid(), 'Admin')
  );

DROP POLICY IF EXISTS "project_sub_files_owner_or_staff_update" ON public.project_submission_files;
CREATE POLICY "project_sub_files_owner_or_staff_update"
  ON public.project_submission_files FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.project_submissions ps
      WHERE ps.id = submission_id
        AND (ps.user_id = auth.uid()
             OR public.has_role(auth.uid(), 'Docente')
             OR public.has_role(auth.uid(), 'Admin'))
    )
  );

DROP POLICY IF EXISTS "project_sub_files_staff_delete" ON public.project_submission_files;
CREATE POLICY "project_sub_files_staff_delete"
  ON public.project_submission_files FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));


-- ============ Realtime ============
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.project_submissions;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.project_submission_files;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;


-- ============ grade_cut_items: enlazar project_id real ============
ALTER TABLE public.grade_cut_items
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;

ALTER TABLE public.grade_cut_items
  DROP CONSTRAINT IF EXISTS grade_cut_items_shape;
ALTER TABLE public.grade_cut_items
  ADD CONSTRAINT grade_cut_items_shape CHECK (
    (item_type = 'exam'     AND exam_id IS NOT NULL     AND workshop_id IS NULL AND project_id IS NULL AND project_title IS NULL) OR
    (item_type = 'workshop' AND workshop_id IS NOT NULL AND exam_id IS NULL     AND project_id IS NULL AND project_title IS NULL) OR
    (item_type = 'project'  AND exam_id IS NULL AND workshop_id IS NULL
                            AND (project_id IS NOT NULL OR project_title IS NOT NULL))
  );
