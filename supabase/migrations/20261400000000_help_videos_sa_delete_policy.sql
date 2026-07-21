-- ════════════════════════════════════════════════════════════════════════
-- help-videos: permitir DELETE al SuperAdmin.
--
-- El bucket público `help-videos` tenía policies de SELECT (público),
-- INSERT y UPDATE (SuperAdmin) pero NO de DELETE. El pipeline de demos
-- necesita poder BORRAR videos obsoletos (p.ej. series con nomenclatura
-- vieja reemplazadas por las `serie-*-completa.mp4`). Sin esta policy el
-- borrado por Storage API devolvía 403 "Access denied", y el borrado
-- directo en storage.objects está bloqueado por el trigger protect_delete.
--
-- Mismo patrón que help_videos_update_superadmin (bucket + is_super_admin()).
-- ════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage'
      AND tablename = 'objects'
      AND policyname = 'help_videos_delete_superadmin'
  ) THEN
    CREATE POLICY help_videos_delete_superadmin ON storage.objects
      FOR DELETE TO authenticated
      USING (bucket_id = 'help-videos' AND public.is_super_admin());
  END IF;
END $$;
