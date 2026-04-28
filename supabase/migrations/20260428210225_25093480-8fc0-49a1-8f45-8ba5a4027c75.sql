
CREATE TABLE IF NOT EXISTS public.project_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, course_id)
);

CREATE INDEX IF NOT EXISTS idx_project_courses_project ON public.project_courses(project_id);
CREATE INDEX IF NOT EXISTS idx_project_courses_course ON public.project_courses(course_id);

ALTER TABLE public.project_courses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_courses_view_all_authenticated"
  ON public.project_courses FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "project_courses_manage_teachers_admins"
  ON public.project_courses FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));

-- Backfill: link each project to its primary course
INSERT INTO public.project_courses (project_id, course_id)
SELECT id, course_id FROM public.projects
ON CONFLICT (project_id, course_id) DO NOTHING;
