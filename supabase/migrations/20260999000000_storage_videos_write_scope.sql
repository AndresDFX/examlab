-- ============================================================================
-- Storage RLS round 7 — videos: scope del WRITE al tenant del uploader.
--
-- El bucket `videos` es public=true → la LECTURA es pública por diseño (los
-- videos se ven embebidos sin auth), NO es leak. Pero las policies de WRITE
-- (insert/update/delete) eran `has_role(Docente) OR has_role(Admin)` GLOBAL →
-- un staff de cualquier tenant podía SUBIR/BORRAR/MODIFICAR archivos de video de
-- otro tenant (tamper/borrado cross-tenant, no fuga de datos pero sí integridad).
--
-- Path: `<uploaderUserId>/<file>.mp4` (foldername[1] = uid del uploader,
-- verificado). Se exige que el uploader (foldername[1]) sea del MISMO tenant que
-- el caller (reusa el helper SECURITY DEFINER storage_owner_in_my_tenant de la
-- mig 20260998). SA conserva acceso cross-tenant. La policy de SELECT (lectura
-- pública) NO se toca.
-- ============================================================================

DO $POL$
DECLARE
  _pred text := $$bucket_id = 'videos' AND (
    ((public.has_role(auth.uid(),'Docente') OR public.has_role(auth.uid(),'Admin'))
       AND public.storage_owner_in_my_tenant((storage.foldername(name))[1]))
    OR public.is_super_admin()
  )$$;
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "videos_storage_write_staff" ON storage.objects';
  EXECUTE 'CREATE POLICY "videos_storage_write_staff" ON storage.objects FOR INSERT TO authenticated WITH CHECK ('||_pred||')';
  EXECUTE 'DROP POLICY IF EXISTS "videos_storage_update_staff" ON storage.objects';
  EXECUTE 'CREATE POLICY "videos_storage_update_staff" ON storage.objects FOR UPDATE TO authenticated USING ('||_pred||') WITH CHECK ('||_pred||')';
  EXECUTE 'DROP POLICY IF EXISTS "videos_storage_delete_staff" ON storage.objects';
  EXECUTE 'CREATE POLICY "videos_storage_delete_staff" ON storage.objects FOR DELETE TO authenticated USING ('||_pred||')';
END $POL$;
