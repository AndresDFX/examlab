-- =====================================================================
-- Project module — file uploads per slot
-- =====================================================================
-- Replaces the single `content TEXT` column on `project_submission_files`
-- with a 1:N relation to `project_submission_attachments`. Each attachment
-- is a real binary stored in the `project-files` Supabase Storage bucket.
--
-- The `content` column on `project_submission_files` is kept for backwards
-- compatibility (legacy text submissions still render) but new submissions
-- use attachments. The frontend concatenates attachments into the same
-- field before grading so the edge function `ai-grade-submission` doesn't
-- need to change.
-- =====================================================================

-- Attachments table: many files per project_submission_files row.
CREATE TABLE IF NOT EXISTS public.project_submission_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_submission_file_id UUID NOT NULL
    REFERENCES public.project_submission_files(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  mime_type TEXT,
  size_bytes BIGINT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_psa_psf
  ON public.project_submission_attachments(project_submission_file_id);

ALTER TABLE public.project_submission_attachments ENABLE ROW LEVEL SECURITY;

-- SELECT: own submission's attachments or staff (Docente/Admin).
DROP POLICY IF EXISTS "psa_select_owner_or_staff" ON public.project_submission_attachments;
CREATE POLICY "psa_select_owner_or_staff"
  ON public.project_submission_attachments FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.project_submission_files psf
      JOIN public.project_submissions ps ON ps.id = psf.submission_id
      WHERE psf.id = project_submission_file_id
        AND (ps.user_id = auth.uid()
             OR public.has_role(auth.uid(), 'Docente')
             OR public.has_role(auth.uid(), 'Admin'))
    )
  );

-- INSERT: only the submission owner (or staff) can attach files to a slot.
DROP POLICY IF EXISTS "psa_insert_owner_or_staff" ON public.project_submission_attachments;
CREATE POLICY "psa_insert_owner_or_staff"
  ON public.project_submission_attachments FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.project_submission_files psf
      JOIN public.project_submissions ps ON ps.id = psf.submission_id
      WHERE psf.id = project_submission_file_id
        AND (ps.user_id = auth.uid()
             OR public.has_role(auth.uid(), 'Docente')
             OR public.has_role(auth.uid(), 'Admin'))
    )
  );

-- DELETE: same as insert.
DROP POLICY IF EXISTS "psa_delete_owner_or_staff" ON public.project_submission_attachments;
CREATE POLICY "psa_delete_owner_or_staff"
  ON public.project_submission_attachments FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.project_submission_files psf
      JOIN public.project_submissions ps ON ps.id = psf.submission_id
      WHERE psf.id = project_submission_file_id
        AND (ps.user_id = auth.uid()
             OR public.has_role(auth.uid(), 'Docente')
             OR public.has_role(auth.uid(), 'Admin'))
    )
  );


-- =====================================================================
-- Storage bucket: project-files
-- =====================================================================
-- Private bucket. 10MB per file. MIME filter empty so the front can keep
-- a flexible whitelist by slot type (.md for diagrams, .java for code, etc).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'project-files',
  'project-files',
  false,
  10485760, -- 10 MB
  NULL
) ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;


-- RLS for the bucket: students touch only `<userId>/...` paths;
-- teachers/admins can read everything.
DROP POLICY IF EXISTS "Students upload own project files"
  ON storage.objects;
CREATE POLICY "Students upload own project files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'project-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Students update own project files"
  ON storage.objects;
CREATE POLICY "Students update own project files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Students read own project files"
  ON storage.objects;
CREATE POLICY "Students read own project files"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Students delete own project files"
  ON storage.objects;
CREATE POLICY "Students delete own project files"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "Teachers read all project files"
  ON storage.objects;
CREATE POLICY "Teachers read all project files"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );


-- =====================================================================
-- Realtime
-- =====================================================================
DO $$
BEGIN
  BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.project_submission_attachments;
  EXCEPTION WHEN duplicate_object THEN NULL;
  END;
END $$;
