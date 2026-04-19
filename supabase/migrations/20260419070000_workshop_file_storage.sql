-- ============================================================
-- MIGRATION: Workshop file uploads via Supabase Storage
-- ============================================================

-- Create the storage bucket for workshop submissions
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'workshop-files',
  'workshop-files',
  false,
  52428800, -- 50MB limit
  ARRAY[
    'application/pdf',
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',
    'application/x-7z-compressed',
    'application/gzip',
    'application/x-tar',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
    'text/html',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'application/json',
    'application/xml',
    'application/java-archive',
    'application/octet-stream'
  ]
) ON CONFLICT (id) DO NOTHING;

-- RLS: Students can upload to their own folder
CREATE POLICY "Students upload own workshop files"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'workshop-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- RLS: Students can update (overwrite) their own files
CREATE POLICY "Students update own workshop files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'workshop-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- RLS: Students can read their own files
CREATE POLICY "Students read own workshop files"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'workshop-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- RLS: Students can delete their own files
CREATE POLICY "Students delete own workshop files"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'workshop-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- RLS: Teachers and Admins can read ALL workshop files (for grading)
CREATE POLICY "Teachers read all workshop files"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'workshop-files'
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );
