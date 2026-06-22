-- ============================================================================
-- Storage RLS — scoping cross-tenant (round 6). El barrido de tablas (rounds
-- 1-5) NO cubría storage.objects, que tiene su propia RLS por bucket. La
-- verificación empírica reveló leaks SEVEROS (un Docente/Admin de un tenant veía
-- archivos de OTROS tenants):
--   - db-backups   🔴🔴 CRÍTICO: un Admin de cualquier tenant leía/borraba el
--                  backup COMPLETO de la base (TODOS los tenants). Es platform-
--                  level → debe ser SOLO SuperAdmin.
--   - project-files / workshop-files: rama `has_role(Docente/Admin)` GLOBAL →
--                  cualquier staff leía/escribía las entregas (ZIPs de código,
--                  archivos) de cualquier tenant.
--   - generated-contents: rama `EXISTS(user_roles role=Admin)` GLOBAL → cualquier
--                  Admin leía/escribía el material del curso de cualquier tenant.
--
-- Fix: helpers SECURITY DEFINER que derivan el tenant del archivo desde el path
-- (bypassan RLS → robustos, sin doble-gating) y se exige que coincida con el
-- tenant del caller. SA conserva acceso cross-tenant vía is_super_admin().
--   - generated-contents: path `<ownerUserId>/<contentId>/...` → tenant del OWNER.
--   - project-files/workshop-files: path `<owner|groupId>/<submissionId>/...`
--     → tenant del curso de la ENTREGA (segmento [2], confiable en ambos modos).
--   - db-backups: SA-only (sin derivación; es global).
--
-- videos NO se toca: la lectura es pública por diseño (bucket public); el write
-- bare-staff queda anotado como mejora aparte (tamper, no fuga de datos).
-- ============================================================================

-- ── Helpers SECURITY DEFINER (bypassan RLS de las tablas referenciadas) ──
CREATE OR REPLACE FUNCTION public.storage_owner_in_my_tenant(_owner text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
     WHERE p.id::text = _owner AND p.tenant_id = public.current_tenant_id()
  );
$$;
REVOKE ALL ON FUNCTION public.storage_owner_in_my_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.storage_owner_in_my_tenant(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.storage_project_sub_in_my_tenant(_sub text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_submissions ps
      JOIN public.projects pr ON pr.id = ps.project_id
      JOIN public.courses co ON co.id = pr.course_id
     WHERE ps.id::text = _sub AND co.tenant_id = public.current_tenant_id()
  );
$$;
REVOKE ALL ON FUNCTION public.storage_project_sub_in_my_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.storage_project_sub_in_my_tenant(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.storage_workshop_sub_in_my_tenant(_sub text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.workshop_submissions ws
      JOIN public.workshops w ON w.id = ws.workshop_id
      JOIN public.courses co ON co.id = w.course_id
     WHERE ws.id::text = _sub AND co.tenant_id = public.current_tenant_id()
  );
$$;
REVOKE ALL ON FUNCTION public.storage_workshop_sub_in_my_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.storage_workshop_sub_in_my_tenant(text) TO authenticated;

-- ── db-backups → SOLO SuperAdmin (es un dump platform-level de toda la DB) ──
DROP POLICY IF EXISTS "db_backups_storage_read_admin" ON storage.objects;
CREATE POLICY "db_backups_storage_read_admin" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'db-backups' AND public.is_super_admin());
DROP POLICY IF EXISTS "db_backups_storage_delete_admin" ON storage.objects;
CREATE POLICY "db_backups_storage_delete_admin" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'db-backups' AND public.is_super_admin());

-- ── generated-contents → owner OR (Admin del tenant del owner) OR SA ──
DROP POLICY IF EXISTS "gc_read" ON storage.objects;
CREATE POLICY "gc_read" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'generated-contents' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR (public.has_role(auth.uid(), 'Admin') AND public.storage_owner_in_my_tenant((storage.foldername(name))[1]))
    OR public.is_super_admin()
  ));
DROP POLICY IF EXISTS "gc_write" ON storage.objects;
CREATE POLICY "gc_write" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'generated-contents' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR (public.has_role(auth.uid(), 'Admin') AND public.storage_owner_in_my_tenant((storage.foldername(name))[1]))
    OR public.is_super_admin()
  ));
DROP POLICY IF EXISTS "gc_update" ON storage.objects;
CREATE POLICY "gc_update" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'generated-contents' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR (public.has_role(auth.uid(), 'Admin') AND public.storage_owner_in_my_tenant((storage.foldername(name))[1]))
    OR public.is_super_admin()
  ))
  WITH CHECK (bucket_id = 'generated-contents' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR (public.has_role(auth.uid(), 'Admin') AND public.storage_owner_in_my_tenant((storage.foldername(name))[1]))
    OR public.is_super_admin()
  ));
DROP POLICY IF EXISTS "gc_delete" ON storage.objects;
CREATE POLICY "gc_delete" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'generated-contents' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR (public.has_role(auth.uid(), 'Admin') AND public.storage_owner_in_my_tenant((storage.foldername(name))[1]))
    OR public.is_super_admin()
  ));

-- ── project-files → owner OR miembro-de-grupo OR (staff del tenant de la entrega) OR SA ──
DO $POL$
DECLARE
  _pred text := $$bucket_id = 'project-files' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR EXISTS (SELECT 1 FROM public.project_group_members m
                WHERE m.group_id::text = (storage.foldername(name))[1] AND m.user_id = auth.uid())
    OR ((public.has_role(auth.uid(),'Docente') OR public.has_role(auth.uid(),'Admin'))
         AND public.storage_project_sub_in_my_tenant((storage.foldername(name))[2]))
    OR public.is_super_admin()
  )$$;
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "project_files_select" ON storage.objects';
  EXECUTE 'CREATE POLICY "project_files_select" ON storage.objects FOR SELECT TO authenticated USING ('||_pred||')';
  EXECUTE 'DROP POLICY IF EXISTS "project_files_upload" ON storage.objects';
  EXECUTE 'CREATE POLICY "project_files_upload" ON storage.objects FOR INSERT TO authenticated WITH CHECK ('||_pred||')';
  EXECUTE 'DROP POLICY IF EXISTS "project_files_update" ON storage.objects';
  EXECUTE 'CREATE POLICY "project_files_update" ON storage.objects FOR UPDATE TO authenticated USING ('||_pred||') WITH CHECK ('||_pred||')';
  EXECUTE 'DROP POLICY IF EXISTS "project_files_delete" ON storage.objects';
  EXECUTE 'CREATE POLICY "project_files_delete" ON storage.objects FOR DELETE TO authenticated USING ('||_pred||')';
END $POL$;

-- ── workshop-files → owner OR miembro-de-grupo OR (staff del tenant de la entrega) OR SA ──
DO $POL$
DECLARE
  _pred text := $$bucket_id = 'workshop-files' AND (
    (storage.foldername(name))[1] = auth.uid()::text
    OR EXISTS (SELECT 1 FROM public.workshop_group_members m
                WHERE m.group_id::text = (storage.foldername(name))[1] AND m.user_id = auth.uid())
    OR ((public.has_role(auth.uid(),'Docente') OR public.has_role(auth.uid(),'Admin'))
         AND public.storage_workshop_sub_in_my_tenant((storage.foldername(name))[2]))
    OR public.is_super_admin()
  )$$;
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "workshop_files_select" ON storage.objects';
  EXECUTE 'CREATE POLICY "workshop_files_select" ON storage.objects FOR SELECT TO authenticated USING ('||_pred||')';
  EXECUTE 'DROP POLICY IF EXISTS "workshop_files_upload" ON storage.objects';
  EXECUTE 'CREATE POLICY "workshop_files_upload" ON storage.objects FOR INSERT TO authenticated WITH CHECK ('||_pred||')';
  EXECUTE 'DROP POLICY IF EXISTS "workshop_files_update" ON storage.objects';
  EXECUTE 'CREATE POLICY "workshop_files_update" ON storage.objects FOR UPDATE TO authenticated USING ('||_pred||') WITH CHECK ('||_pred||')';
  EXECUTE 'DROP POLICY IF EXISTS "workshop_files_delete" ON storage.objects';
  EXECUTE 'CREATE POLICY "workshop_files_delete" ON storage.objects FOR DELETE TO authenticated USING ('||_pred||')';
END $POL$;
