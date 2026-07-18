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
