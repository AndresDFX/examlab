-- ──────────────────────────────────────────────────────────────────────
-- feedback_attachments + bucket `feedback-attachments`
--
-- Permite que cada `feedback_comments` lleve uno o varios archivos
-- adjuntos (capturas, PDFs, ejemplos de código, etc.). El estudiante o
-- el docente pueden adjuntar — la visibilidad la heredan del comment,
-- que a su vez la hereda del thread (RLS por curso/entrega).
--
-- Layout del bucket: `<user_id>/<comment_id>/<filename>`.
-- - `<user_id>` como primer segmento permite la policy de INSERT clásica
--   ("solo subo en MI carpeta") sin necesidad de JOINs.
-- - `<comment_id>` como segundo segmento facilita borrado por comment
--   (al borrar el comment, borramos `<user_id>/<comment_id>/*`).
-- - El filename se sanea en el cliente (caracteres no seguros → _).
--
-- Límite: 25MB por archivo (cap del bucket). La UI valida MIME antes de
-- subir para evitar pérdida de tiempo en archivos demasiado grandes.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Tabla de metadata --------------------------------------------------
CREATE TABLE IF NOT EXISTS public.feedback_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id UUID NOT NULL REFERENCES public.feedback_comments(id) ON DELETE CASCADE,
  -- path completo dentro del bucket (incluye <user_id>/<comment_id>/<filename>)
  path TEXT NOT NULL,
  -- nombre original que verá el usuario al descargar
  name TEXT NOT NULL,
  -- MIME type reportado por el navegador al subir (image/png, application/pdf, …).
  -- NO se usa para autorización; solo para mostrar el ícono correcto.
  mime_type TEXT,
  size_bytes BIGINT,
  uploaded_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feedback_attachments_comment_id_idx
  ON public.feedback_attachments(comment_id);

-- 2) RLS de la tabla ----------------------------------------------------
ALTER TABLE public.feedback_attachments ENABLE ROW LEVEL SECURITY;

-- SELECT: cualquiera que pueda ver el comment ve sus adjuntos. Reutiliza
-- las helpers `is_submission_owner` / `is_question_course_teacher` vía
-- los joins thread → comment.
DROP POLICY IF EXISTS "feedback_attachments select" ON public.feedback_attachments;
CREATE POLICY "feedback_attachments select"
ON public.feedback_attachments FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.feedback_comments c
    JOIN public.feedback_threads t ON t.id = c.thread_id
    WHERE c.id = comment_id
      AND (
        public.is_submission_owner(t.parent_kind, t.submission_id, auth.uid())
        OR public.is_question_course_teacher(t.parent_kind, t.question_id, auth.uid())
      )
  )
);

-- INSERT: el autor del comment puede agregar adjuntos a SU comment.
-- No exigimos que el thread esté abierto porque la app sube los archivos
-- DESPUÉS del insert del comment (mismo flujo atómico desde el cliente);
-- si la app trata de subir post-cierre, igual el INSERT del comment ya
-- habría fallado por la policy de feedback_comments.
DROP POLICY IF EXISTS "feedback_attachments insert own" ON public.feedback_attachments;
CREATE POLICY "feedback_attachments insert own"
ON public.feedback_attachments FOR INSERT TO authenticated
WITH CHECK (
  uploaded_by = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.feedback_comments c
    WHERE c.id = comment_id
      AND c.user_id = auth.uid()
  )
);

-- DELETE: solo el autor del comment original puede borrar sus adjuntos.
-- ON DELETE CASCADE del FK encima se encarga del caso "borraron el
-- comment completo" — esto cubre el caso "quito UN adjunto".
DROP POLICY IF EXISTS "feedback_attachments delete own" ON public.feedback_attachments;
CREATE POLICY "feedback_attachments delete own"
ON public.feedback_attachments FOR DELETE TO authenticated
USING (uploaded_by = auth.uid());

-- 3) Bucket de Storage --------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'feedback-attachments',
  'feedback-attachments',
  false,
  26214400, -- 25 MB
  NULL      -- aceptamos cualquier MIME; la UI hace whitelist amigable
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit;

-- 4) RLS sobre storage.objects para este bucket -------------------------
-- INSERT/UPDATE/DELETE: solo en mi propia carpeta (<auth.uid()>/...).
DROP POLICY IF EXISTS "feedback_attachments storage insert own folder" ON storage.objects;
CREATE POLICY "feedback_attachments storage insert own folder"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'feedback-attachments'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

DROP POLICY IF EXISTS "feedback_attachments storage delete own folder" ON storage.objects;
CREATE POLICY "feedback_attachments storage delete own folder"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'feedback-attachments'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- SELECT: el dueño del archivo (siempre), O cualquiera con acceso al
-- thread vía la metadata en `feedback_attachments`. Usamos EXISTS para
-- amarrar el path al row y hacer el chequeo via RLS heredado.
DROP POLICY IF EXISTS "feedback_attachments storage select" ON storage.objects;
CREATE POLICY "feedback_attachments storage select"
ON storage.objects FOR SELECT TO authenticated
USING (
  bucket_id = 'feedback-attachments'
  AND (
    auth.uid()::text = (storage.foldername(name))[1]
    OR EXISTS (
      SELECT 1
      FROM public.feedback_attachments fa
      JOIN public.feedback_comments fc ON fc.id = fa.comment_id
      JOIN public.feedback_threads ft ON ft.id = fc.thread_id
      WHERE fa.path = storage.objects.name
        AND (
          public.is_submission_owner(ft.parent_kind, ft.submission_id, auth.uid())
          OR public.is_question_course_teacher(ft.parent_kind, ft.question_id, auth.uid())
        )
    )
  )
);

NOTIFY pgrst, 'reload schema';
