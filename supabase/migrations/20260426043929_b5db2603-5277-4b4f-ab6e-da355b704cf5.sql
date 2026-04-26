-- 1) Peso de proyecto en cursos
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS project_weight numeric NOT NULL DEFAULT 0;

-- 2) Sub-pesos por componente dentro de cada corte
ALTER TABLE public.grade_cuts
  ADD COLUMN IF NOT EXISTS exam_weight numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS workshop_weight numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attendance_weight numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS project_weight numeric NOT NULL DEFAULT 0;

-- 3) Tabla projects
CREATE TABLE IF NOT EXISTS public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL,
  cut_id uuid NULL,
  created_by uuid NOT NULL,
  title text NOT NULL,
  description text,
  instructions text,
  project_type text NOT NULL DEFAULT 'escrito',
  max_files integer NOT NULL DEFAULT 10,
  max_score numeric NOT NULL DEFAULT 100,
  start_date timestamptz,
  due_date timestamptz,
  status text NOT NULL DEFAULT 'draft',
  ai_generated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_course ON public.projects(course_id);
CREATE INDEX IF NOT EXISTS idx_projects_cut ON public.projects(cut_id);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated view projects" ON public.projects;
CREATE POLICY "Authenticated view projects"
  ON public.projects FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Docentes/Admins manage projects" ON public.projects;
CREATE POLICY "Docentes/Admins manage projects"
  ON public.projects FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));

CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4) Tabla project_submissions
CREATE TABLE IF NOT EXISTS public.project_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  zip_url text,
  status text NOT NULL DEFAULT 'pendiente',
  ai_grade numeric,
  ai_feedback text,
  ai_detected boolean NOT NULL DEFAULT false,
  ai_detected_score numeric,
  ai_detected_reasons text,
  final_grade numeric,
  teacher_feedback text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_submissions_project ON public.project_submissions(project_id);
CREATE INDEX IF NOT EXISTS idx_project_submissions_user ON public.project_submissions(user_id);

ALTER TABLE public.project_submissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own project submissions" ON public.project_submissions;
CREATE POLICY "Users see own project submissions"
  ON public.project_submissions FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));

DROP POLICY IF EXISTS "Users insert own project submissions" ON public.project_submissions;
CREATE POLICY "Users insert own project submissions"
  ON public.project_submissions FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users update own project submissions" ON public.project_submissions;
CREATE POLICY "Users update own project submissions"
  ON public.project_submissions FOR UPDATE TO authenticated
  USING (auth.uid() = user_id OR has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));

DROP POLICY IF EXISTS "Docentes/Admins delete project submissions" ON public.project_submissions;
CREATE POLICY "Docentes/Admins delete project submissions"
  ON public.project_submissions FOR DELETE TO authenticated
  USING (has_role(auth.uid(), 'Docente'::app_role) OR has_role(auth.uid(), 'Admin'::app_role));

CREATE TRIGGER update_project_submissions_updated_at
  BEFORE UPDATE ON public.project_submissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5) AI detection columns en otros módulos
ALTER TABLE public.workshop_submissions
  ADD COLUMN IF NOT EXISTS ai_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_detected_score numeric,
  ADD COLUMN IF NOT EXISTS ai_detected_reasons text;

ALTER TABLE public.workshop_submission_answers
  ADD COLUMN IF NOT EXISTS ai_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_detected_score numeric,
  ADD COLUMN IF NOT EXISTS ai_detected_reasons text;

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS ai_detected boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_detected_score numeric,
  ADD COLUMN IF NOT EXISTS ai_detected_reasons text;

-- 6) Storage policies para subir ZIP de proyectos en bucket workshop-files (carpeta projects/{project_id}/{user_id}/...)
DROP POLICY IF EXISTS "Project owner can upload zip" ON storage.objects;
CREATE POLICY "Project owner can upload zip"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'workshop-files'
    AND (storage.foldername(name))[1] = 'projects'
    AND (storage.foldername(name))[3] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Project owner or teacher can read zip" ON storage.objects;
CREATE POLICY "Project owner or teacher can read zip"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'workshop-files'
    AND (
      (storage.foldername(name))[1] <> 'projects'
      OR (storage.foldername(name))[3] = auth.uid()::text
      OR has_role(auth.uid(), 'Docente'::app_role)
      OR has_role(auth.uid(), 'Admin'::app_role)
    )
  );

DROP POLICY IF EXISTS "Project owner can update zip" ON storage.objects;
CREATE POLICY "Project owner can update zip"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'workshop-files'
    AND (storage.foldername(name))[1] = 'projects'
    AND (storage.foldername(name))[3] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Project owner or teacher can delete zip" ON storage.objects;
CREATE POLICY "Project owner or teacher can delete zip"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'workshop-files'
    AND (storage.foldername(name))[1] = 'projects'
    AND (
      (storage.foldername(name))[3] = auth.uid()::text
      OR has_role(auth.uid(), 'Docente'::app_role)
      OR has_role(auth.uid(), 'Admin'::app_role)
    )
  );