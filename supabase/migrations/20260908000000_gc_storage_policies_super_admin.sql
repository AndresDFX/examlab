-- ──────────────────────────────────────────────────────────────────────
-- Storage RLS del bucket `generated-contents`: incluir SuperAdmin.
--
-- Bug reportado: el docente subiendo contenido externo
-- (UploadExternalContentDialog) recibía 403 "new row violates row-level
-- security policy" al hacer `upload(path, file)` sobre el bucket
-- `generated-contents`. Path armado correctamente como
-- `<user.id>/<content_id>/<filename>` que debería matchear la condición
-- `(storage.foldername(name))[1] = auth.uid()::text`.
--
-- Causa raíz observada en producción: las 4 policies del bucket
-- (`gc_read`, `gc_write`, `gc_update`, `gc_delete` — mig 20260509190000)
-- aceptan SOLO:
--   1. Dueño-por-path (primer folder = auth.uid()).
--   2. Rol = 'Admin'.
--
-- Faltantes:
--   - **SuperAdmin**: gestionando contenido cross-tenant (revisar,
--     auditar, borrar material publicado en otro tenant) recibe 403.
--   - Posiblemente flujos donde `user.id` NO matchea el primer folder
--     por convenciones legacy del path. Pero ese es bug de path; el
--     fix de SuperAdmin es estrictamente necesario.
--
-- Fix: recreamos las 4 policies extendiendo a SuperAdmin con
-- `public.is_super_admin()` (mismo patrón aplicado en mig 20260903100000
-- para db_backups). El comportamiento del Docente NO cambia — sigue
-- accediendo solo a su prefijo.
-- ──────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS gc_read ON storage.objects;
CREATE POLICY gc_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'generated-contents' AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
      OR public.is_super_admin()
    )
  );

DROP POLICY IF EXISTS gc_write ON storage.objects;
CREATE POLICY gc_write ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'generated-contents' AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
      OR public.is_super_admin()
    )
  );

DROP POLICY IF EXISTS gc_update ON storage.objects;
CREATE POLICY gc_update ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'generated-contents' AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
      OR public.is_super_admin()
    )
  );

DROP POLICY IF EXISTS gc_delete ON storage.objects;
CREATE POLICY gc_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'generated-contents' AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'Admin')
      OR public.is_super_admin()
    )
  );
