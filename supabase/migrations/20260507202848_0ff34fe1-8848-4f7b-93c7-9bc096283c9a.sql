-- Workshop groups
ALTER TABLE public.workshops
  ADD COLUMN IF NOT EXISTS group_mode TEXT NOT NULL DEFAULT 'individual'
    CHECK (group_mode IN ('individual', 'teacher_assigned', 'self_signup')),
  ADD COLUMN IF NOT EXISTS group_size_min INT NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS group_size_max INT NOT NULL DEFAULT 5;

CREATE TABLE IF NOT EXISTS public.workshop_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workshop_id uuid NOT NULL REFERENCES public.workshops(id) ON DELETE CASCADE,
  name text NOT NULL,
  signup_code text NOT NULL DEFAULT substr(md5(random()::text), 1, 6),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workshop_id, name)
);

CREATE INDEX IF NOT EXISTS idx_workshop_groups_workshop
  ON public.workshop_groups(workshop_id);

CREATE TABLE IF NOT EXISTS public.workshop_group_members (
  group_id uuid NOT NULL REFERENCES public.workshop_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workshop_group_members_user
  ON public.workshop_group_members(user_id);

CREATE OR REPLACE FUNCTION public.assert_one_workshop_group_per_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_workshop_id uuid;
BEGIN
  SELECT workshop_id INTO v_workshop_id FROM public.workshop_groups WHERE id = NEW.group_id;
  IF EXISTS (
    SELECT 1
    FROM public.workshop_group_members m
    JOIN public.workshop_groups g ON g.id = m.group_id
    WHERE g.workshop_id = v_workshop_id
      AND m.user_id = NEW.user_id
      AND m.group_id <> NEW.group_id
  ) THEN
    RAISE EXCEPTION 'El estudiante ya está en otro grupo de este taller';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_one_workshop_group_per_user ON public.workshop_group_members;
CREATE TRIGGER trg_one_workshop_group_per_user
  BEFORE INSERT OR UPDATE ON public.workshop_group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.assert_one_workshop_group_per_user();

ALTER TABLE public.workshop_submissions
  ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES public.workshop_groups(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workshop_submissions_group
  ON public.workshop_submissions(group_id);

ALTER TABLE public.workshop_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workshop_group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workshop_groups_read" ON public.workshop_groups;
CREATE POLICY "workshop_groups_read"
  ON public.workshop_groups FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "workshop_groups_teacher_admin_write" ON public.workshop_groups;
CREATE POLICY "workshop_groups_teacher_admin_write"
  ON public.workshop_groups FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "workshop_group_members_read" ON public.workshop_group_members;
CREATE POLICY "workshop_group_members_read"
  ON public.workshop_group_members FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "workshop_group_members_teacher_admin_write" ON public.workshop_group_members;
CREATE POLICY "workshop_group_members_teacher_admin_write"
  ON public.workshop_group_members FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "Users see own workshop submissions" ON public.workshop_submissions;
DROP POLICY IF EXISTS "workshop_submissions_select" ON public.workshop_submissions;
CREATE POLICY "workshop_submissions_select"
  ON public.workshop_submissions FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Docente')
    OR public.has_role(auth.uid(), 'Admin')
    OR (group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.workshop_group_members m
      WHERE m.group_id = workshop_submissions.group_id AND m.user_id = auth.uid()
    ))
  );

DROP POLICY IF EXISTS "Users insert own workshop submissions" ON public.workshop_submissions;
DROP POLICY IF EXISTS "workshop_submissions_insert" ON public.workshop_submissions;
CREATE POLICY "workshop_submissions_insert"
  ON public.workshop_submissions FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Docente')
    OR public.has_role(auth.uid(), 'Admin')
    OR (group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.workshop_group_members m
      WHERE m.group_id = workshop_submissions.group_id AND m.user_id = auth.uid()
    ))
  );

DROP POLICY IF EXISTS "Users update own workshop submissions" ON public.workshop_submissions;
DROP POLICY IF EXISTS "workshop_submissions_update" ON public.workshop_submissions;
CREATE POLICY "workshop_submissions_update"
  ON public.workshop_submissions FOR UPDATE TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Docente')
    OR public.has_role(auth.uid(), 'Admin')
    OR (group_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.workshop_group_members m
      WHERE m.group_id = workshop_submissions.group_id AND m.user_id = auth.uid()
    ))
  );

-- Project ZIP uploads
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('project-files','project-files',false,104857600,
  ARRAY['application/zip','application/x-zip-compressed','application/octet-stream'])
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "project_files_student_upload" ON storage.objects;
CREATE POLICY "project_files_student_upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'project-files' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "project_files_student_update" ON storage.objects;
CREATE POLICY "project_files_student_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'project-files' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "project_files_student_read_own" ON storage.objects;
CREATE POLICY "project_files_student_read_own"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'project-files' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "project_files_student_delete" ON storage.objects;
CREATE POLICY "project_files_student_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'project-files' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "project_files_teacher_read_all" ON storage.objects;
CREATE POLICY "project_files_teacher_read_all"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'project-files'
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin')));

ALTER TABLE public.project_files DROP CONSTRAINT IF EXISTS project_files_type_check;
ALTER TABLE public.project_files
  ADD CONSTRAINT project_files_type_check
  CHECK (type IN ('abierta','cerrada','codigo','diagrama','java_gui','codigo_zip'));

ALTER TABLE public.project_submission_files
  ADD COLUMN IF NOT EXISTS zip_path TEXT;

-- Project defense + repo
ALTER TABLE public.project_submissions
  ADD COLUMN IF NOT EXISTS submission_grade NUMERIC,
  ADD COLUMN IF NOT EXISTS defense_factor NUMERIC
    CHECK (defense_factor IS NULL OR (defense_factor >= 0 AND defense_factor <= 1)),
  ADD COLUMN IF NOT EXISTS defense_notes TEXT,
  ADD COLUMN IF NOT EXISTS defense_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS repository_url TEXT;

UPDATE public.project_submissions
SET submission_grade = final_grade, defense_factor = 1
WHERE final_grade IS NOT NULL AND submission_grade IS NULL;