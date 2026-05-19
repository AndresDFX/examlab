-- ──────────────────────────────────────────────────────────────────────
-- Upload directo de archivos de video a Storage.
--
-- V1 de la biblioteca solo aceptaba URLs externas (YouTube/Vimeo/MP4
-- hospedado fuera). Esta migración agrega:
--
--   1) Bucket `videos` PÚBLICO en Storage. Es público porque los videos
--      son contenido de plataforma (subido por Docente/Admin) y se
--      reproducen embedded en la UI con autenticación previa para llegar
--      a la URL. El nombre del objeto incluye un UUID así que la URL no
--      es enumerable. Si en el futuro se requiere control granular por
--      curso/rol, se migra a privado + signed URLs.
--   2) RLS de storage.objects: solo Docente/Admin pueden INSERT/UPDATE/
--      DELETE en este bucket. Lectura abierta (deriva de bucket público).
--   3) Columna `storage_path` en videos. Cuando se subió un archivo, este
--      campo guarda la ruta `<uuid>.<ext>` para poder borrar el objeto
--      cuando el video se elimina. Si es URL externa, queda null.
--
-- Tipos MIME aceptados: mp4, webm, quicktime (mov). Tope 500MB —
-- balance entre suficiente para una clase grabada y no saturar Storage.
-- ──────────────────────────────────────────────────────────────────────

-- Bucket público con límites razonables.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'videos',
  'videos',
  true,
  524288000, -- 500MB
  ARRAY[
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-m4v'
  ]
) ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Solo Docente/Admin pueden escribir. La lectura es abierta a cualquier
-- autenticado (no anon — aún siendo bucket público requerimos login en
-- la app; las URLs no se exponen fuera).
DROP POLICY IF EXISTS "videos_storage_write_staff" ON storage.objects;
CREATE POLICY "videos_storage_write_staff"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'videos'
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

DROP POLICY IF EXISTS "videos_storage_update_staff" ON storage.objects;
CREATE POLICY "videos_storage_update_staff"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'videos'
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

DROP POLICY IF EXISTS "videos_storage_delete_staff" ON storage.objects;
CREATE POLICY "videos_storage_delete_staff"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'videos'
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

DROP POLICY IF EXISTS "videos_storage_read_authenticated" ON storage.objects;
CREATE POLICY "videos_storage_read_authenticated"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'videos');

-- Path del objeto en Storage para los videos subidos. NULL para URLs
-- externas (YouTube/Vimeo/CDN).
ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS storage_path TEXT;

COMMENT ON COLUMN public.videos.storage_path IS
  'Ruta del objeto en el bucket `videos` cuando el video fue subido directo (no URL externa). Permite borrar el objeto al eliminar el registro.';

NOTIFY pgrst, 'reload schema';
