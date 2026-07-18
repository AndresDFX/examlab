-- ══════════════════════════════════════════════════════════════════════
-- Bucket `help-videos` (videos de ayuda/demostración de la plataforma):
-- permitir que el SuperAdmin SUBA y ACTUALICE los videos. Hasta ahora el bucket
-- era público de SOLO LECTURA (sin política de INSERT/UPDATE → solo el
-- service_role podía escribir, vía dashboard). La lectura pública se mantiene.
--
-- Los videos de ayuda son un recurso GLOBAL de plataforma → su gestión
-- corresponde al SuperAdmin. Patrón espejo de tenant_logos_insert / gc_write.
-- ══════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  IF to_regclass('storage.objects') IS NOT NULL THEN
    -- SELECT para authenticated (igual que tenant_logos_select): el bucket es
    -- público (las lecturas van por la URL pública), pero el INSERT de
    -- storage-api usa RETURNING → la RLS exige TAMBIÉN una policy de SELECT
    -- sobre la fila nueva, o el upload falla 403 "new row violates row-level
    -- security policy" AUNQUE la policy de INSERT pase (verificado en prod:
    -- el INSERT directo a storage.objects pasaba y el upload HTTP no).
    DROP POLICY IF EXISTS help_videos_select ON storage.objects;
    CREATE POLICY help_videos_select
      ON storage.objects
      FOR SELECT
      TO authenticated
      USING (bucket_id = 'help-videos');

    DROP POLICY IF EXISTS help_videos_insert_superadmin ON storage.objects;
    CREATE POLICY help_videos_insert_superadmin
      ON storage.objects
      FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'help-videos' AND public.is_super_admin());

    DROP POLICY IF EXISTS help_videos_update_superadmin ON storage.objects;
    CREATE POLICY help_videos_update_superadmin
      ON storage.objects
      FOR UPDATE
      TO authenticated
      USING (bucket_id = 'help-videos' AND public.is_super_admin())
      WITH CHECK (bucket_id = 'help-videos' AND public.is_super_admin());
  END IF;
END $$;
