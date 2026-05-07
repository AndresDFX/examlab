-- ============================================================
-- Tipo de archivo `codigo_zip` para proyectos.
--
-- El docente declara un slot tipo `codigo_zip` en `project_files` y el
-- estudiante sube un archivo .zip con todo el código fuente. El edge
-- function `ai-grade-submission` descomprime, filtra archivos por
-- extensión (whitelist de lenguajes de programación) y los pasa
-- concatenados a la IA para calificación.
--
-- Diagramas y documentos siguen entregándose como tipos existentes
-- (diagrama, abierta, etc) en preguntas puntuales del proyecto — el
-- ZIP es solo para código fuente.
-- ============================================================

-- ── 1) Bucket de Storage para los ZIPs de código ──
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'project-files',
  'project-files',
  false,
  104857600, -- 100MB
  ARRAY[
    'application/zip',
    'application/x-zip-compressed',
    'application/octet-stream'
  ]
) ON CONFLICT (id) DO NOTHING;

-- RLS para storage: estudiante sube/lee/borra los suyos, docente/admin
-- leen todos.
DROP POLICY IF EXISTS "project_files_student_upload" ON storage.objects;
CREATE POLICY "project_files_student_upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'project-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "project_files_student_update" ON storage.objects;
CREATE POLICY "project_files_student_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "project_files_student_read_own" ON storage.objects;
CREATE POLICY "project_files_student_read_own"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "project_files_student_delete" ON storage.objects;
CREATE POLICY "project_files_student_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "project_files_teacher_read_all" ON storage.objects;
CREATE POLICY "project_files_teacher_read_all"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'project-files'
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ── 2) Permitir 'codigo_zip' en el CHECK de project_files.type ──
ALTER TABLE public.project_files
  DROP CONSTRAINT IF EXISTS project_files_type_check;
ALTER TABLE public.project_files
  ADD CONSTRAINT project_files_type_check
  CHECK (type IN ('abierta','cerrada','codigo','diagrama','java_gui','codigo_zip'));

-- ── 3) Columna zip_path en project_submission_files ──
-- Cuando el slot es 'codigo_zip', el estudiante sube un .zip y persistimos
-- la ruta del objeto en Storage (formato: <user_id>/<submission_id>/<file_id>.zip).
ALTER TABLE public.project_submission_files
  ADD COLUMN IF NOT EXISTS zip_path TEXT;
