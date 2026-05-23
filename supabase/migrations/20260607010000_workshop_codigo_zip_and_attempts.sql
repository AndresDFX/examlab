-- ──────────────────────────────────────────────────────────────────────
-- Talleres: soporte para preguntas tipo `codigo_zip` (paridad con
-- proyectos) + enforcement de max_attempts.
--
-- Refleja lo que ya existe en proyectos:
--   - migración 20260507160000_project_code_zip.sql       (tipo + ZIP path)
--   - migración 20260603150000_project_files_zip_single.sql (flag scaffolding)
--   - migración 20260603100300_project_code_files.sql     (multi-file paths)
--   - migración 20260607000000_project_attempt_count.sql  (contador intentos)
--
-- Decisiones:
--   - Reusamos el bucket existente `workshop-files` (ya tiene ZIP en la
--     whitelist MIME). Actualizamos sus políticas RLS para soportar
--     entregas grupales — mismo patrón que `project_files_rls_fix`.
--   - El edge function `ai-grade-submission` aceptará un body con
--     `workshopCodeZipGrading: true` que reusa el pipeline de proyectos
--     pero apunta al bucket `workshop-files`.
-- ──────────────────────────────────────────────────────────────────────

-- ─── 1) Permitir 'codigo_zip' en workshop_questions.type ─────────────
ALTER TABLE public.workshop_questions
  DROP CONSTRAINT IF EXISTS workshop_questions_type_check;
ALTER TABLE public.workshop_questions
  ADD CONSTRAINT workshop_questions_type_check
  CHECK (type IN ('abierta','cerrada','cerrada_multi','codigo','diagrama','java_gui','codigo_zip'));

-- ─── 2) Flag scaffolding `zip_single` (un único ZIP vs N archivos) ───
ALTER TABLE public.workshop_questions
  ADD COLUMN IF NOT EXISTS zip_single BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.workshop_questions.zip_single IS
  'Scaffolding del slot codigo_zip: si TRUE, el estudiante sube UN .zip que el backend descomprime y pasa entero a la IA (sin minify, sin truncar per-file). Si FALSE, el estudiante sube N archivos individuales filtrados por extensión.';

-- ─── 3) Columnas para el upload en workshop_submission_answers ───────
-- `zip_path`: path único cuando zip_single=TRUE (legacy también).
-- `code_paths`: array de paths cuando zip_single=FALSE (multi-file).
ALTER TABLE public.workshop_submission_answers
  ADD COLUMN IF NOT EXISTS zip_path TEXT;
ALTER TABLE public.workshop_submission_answers
  ADD COLUMN IF NOT EXISTS code_paths TEXT[];
ALTER TABLE public.workshop_submission_answers
  ADD COLUMN IF NOT EXISTS ai_likelihood NUMERIC;
ALTER TABLE public.workshop_submission_answers
  ADD COLUMN IF NOT EXISTS ai_reasons TEXT;
ALTER TABLE public.workshop_submission_answers
  ADD COLUMN IF NOT EXISTS zip_truncated BOOLEAN;
ALTER TABLE public.workshop_submission_answers
  ADD COLUMN IF NOT EXISTS zip_chars_used INT;

-- ─── 4) attempt_count en workshop_submissions ────────────────────────
-- Mismo razonamiento que `project_submissions.attempt_count`: la
-- migración 20260602300000 agregó `workshops.max_attempts` pero el
-- enforcement nunca se cableó. Una sola fila por estudiante/grupo que se
-- UPDATEa, así que necesitamos un contador explícito para gating.
ALTER TABLE public.workshop_submissions
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0);

COMMENT ON COLUMN public.workshop_submissions.attempt_count IS
  'Número de veces que el estudiante/grupo entregó este taller. Se incrementa en cada submit. El frontend bloquea nuevos submits cuando attempt_count >= workshops.max_attempts (o el default global).';

-- Backfill: filas con status "real" cuentan como 1 intento consumido.
UPDATE public.workshop_submissions
   SET attempt_count = 1
 WHERE attempt_count = 0
   AND status IN ('entregado', 'calificado', 'sospechoso', 'ai_revisado', 'pendiente_revision');

-- ─── 5) Re-políticas RLS de Storage para workshop-files ──────────────
-- Las políticas originales (20260419070000) eran user-folder only —
-- bloqueaban entregas grupales y la calificación del docente al edge.
-- Actualizamos al patrón group-aware (mismo que project_files).
-- Path layout esperado por el cliente:
--   <user_id>/<submission_id>/<question_id>/<filename>       (individual)
--   <group_id>/<submission_id>/<question_id>/<filename>      (grupal)
--   <user_id>/<submission_id>/<question_id>.zip              (zip_single individual)
--   <group_id>/<submission_id>/<question_id>.zip             (zip_single grupal)

-- Limpia políticas previas — algunas pueden coexistir y un OR permisivo
-- accidental abriría el bucket.
DROP POLICY IF EXISTS "Students upload own workshop files" ON storage.objects;
DROP POLICY IF EXISTS "Students update own workshop files" ON storage.objects;
DROP POLICY IF EXISTS "Students read own workshop files" ON storage.objects;
DROP POLICY IF EXISTS "Students delete own workshop files" ON storage.objects;
DROP POLICY IF EXISTS "Teachers read all workshop files" ON storage.objects;
DROP POLICY IF EXISTS "workshop_files_upload" ON storage.objects;
DROP POLICY IF EXISTS "workshop_files_update" ON storage.objects;
DROP POLICY IF EXISTS "workshop_files_select" ON storage.objects;
DROP POLICY IF EXISTS "workshop_files_delete" ON storage.objects;

-- ── INSERT ──
CREATE POLICY "workshop_files_upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'workshop-files'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.workshop_group_members m
        WHERE m.group_id::text = (storage.foldername(name))[1]
          AND m.user_id = auth.uid()
      )
      OR public.has_role(auth.uid(), 'Docente')
      OR public.has_role(auth.uid(), 'Admin')
    )
  );

-- ── UPDATE ──
CREATE POLICY "workshop_files_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'workshop-files'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.workshop_group_members m
        WHERE m.group_id::text = (storage.foldername(name))[1]
          AND m.user_id = auth.uid()
      )
      OR public.has_role(auth.uid(), 'Docente')
      OR public.has_role(auth.uid(), 'Admin')
    )
  );

-- ── SELECT ──
CREATE POLICY "workshop_files_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'workshop-files'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.workshop_group_members m
        WHERE m.group_id::text = (storage.foldername(name))[1]
          AND m.user_id = auth.uid()
      )
      OR public.has_role(auth.uid(), 'Docente')
      OR public.has_role(auth.uid(), 'Admin')
    )
  );

-- ── DELETE ──
CREATE POLICY "workshop_files_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'workshop-files'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.workshop_group_members m
        WHERE m.group_id::text = (storage.foldername(name))[1]
          AND m.user_id = auth.uid()
      )
      OR public.has_role(auth.uid(), 'Docente')
      OR public.has_role(auth.uid(), 'Admin')
    )
  );

NOTIFY pgrst, 'reload schema';
