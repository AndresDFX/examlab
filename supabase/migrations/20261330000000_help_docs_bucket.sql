-- ══════════════════════════════════════════════════════════════════════
-- Bucket público `help-docs`: presentaciones/documentos comerciales de la
-- plataforma con LINK ESTABLE (mismo patrón que `help-videos` para los videos).
--
-- Objetivo: los correos/mensajes referencian las presentaciones por un link
-- público de Supabase con nombre SIN versión (ej. presentacion-comercial.pptx).
-- Si el archivo cambia, se re-sube al MISMO nombre (upsert) y el link se
-- mantiene — antes apuntaban a Google Drive/Slides (links que cambian).
--
-- Policies: lectura pública por URL + el trío para escribir del SuperAdmin.
-- IMPORTANTE (aprendido con help-videos): el INSERT de storage-api usa
-- RETURNING → sin una policy de SELECT que cubra la fila, el upload falla 403
-- aunque el INSERT pase. Siempre crear SELECT + INSERT + UPDATE juntos.
-- ══════════════════════════════════════════════════════════════════════

-- Bucket (idempotente). MIME: pptx/ppt/pdf/docx.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'help-docs', 'help-docs', true, 104857600,
  ARRAY[
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    DROP POLICY IF EXISTS help_docs_select ON storage.objects;
    CREATE POLICY help_docs_select
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (bucket_id = 'help-docs');

    DROP POLICY IF EXISTS help_docs_insert_superadmin ON storage.objects;
    CREATE POLICY help_docs_insert_superadmin
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'help-docs' AND public.is_super_admin());

    DROP POLICY IF EXISTS help_docs_update_superadmin ON storage.objects;
    CREATE POLICY help_docs_update_superadmin
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (bucket_id = 'help-docs' AND public.is_super_admin())
      WITH CHECK (bucket_id = 'help-docs' AND public.is_super_admin());
  END IF;
END $$;
