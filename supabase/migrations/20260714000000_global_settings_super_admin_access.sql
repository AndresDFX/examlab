-- ──────────────────────────────────────────────────────────────────────
-- SuperAdmin access a la configuración GLOBAL de la plataforma
--
-- Hay 3 tablas que NO tienen `tenant_id` y guardan configuración única
-- para toda la plataforma:
--
--   - module_visibility        → visibilidad + orden de módulos del sidebar
--   - code_execution_settings  → proveedor del runner de código
--   - audit_retention_settings → política de retención de audit_logs
--
-- Sus policies originales son `has_role(uid, 'Admin')`, así que un usuario
-- con SOLO rol `SuperAdmin` (sin Admin) era rechazado al guardar. Pero la
-- configuración global es PRECISAMENTE responsabilidad del SuperAdmin (es
-- el dueño de la plataforma, no de un tenant). Agregamos `OR is_super_admin()`
-- a SELECT/ALL para destrabarlo.
--
-- Pareo con la UI: `/app/admin/settings` ahora habilita 3 tabs cuando el
-- SuperAdmin está en modo cross-tenant (sin "Ver como X") — Módulos /
-- Compilador / Auditoría. El resto siguen requiriendo entrar a una
-- institución porque son per-tenant (app_settings, certificate_settings,
-- ai_model_settings, ai_prompts).
-- ──────────────────────────────────────────────────────────────────────

-- module_visibility: el write policy era `has_role(Admin)`.
DROP POLICY IF EXISTS "module_visibility_admin_write" ON public.module_visibility;
CREATE POLICY "module_visibility_admin_write"
  ON public.module_visibility FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  WITH CHECK (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin());

-- code_execution_settings: read abierto a authenticated; write era Admin.
DROP POLICY IF EXISTS "Admin can manage code_execution_settings" ON public.code_execution_settings;
CREATE POLICY "Admin can manage code_execution_settings"
  ON public.code_execution_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  WITH CHECK (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin());

-- audit_retention_settings: SELECT y WRITE eran Admin.
DROP POLICY IF EXISTS "audit_retention_settings_select" ON public.audit_retention_settings;
CREATE POLICY "audit_retention_settings_select"
  ON public.audit_retention_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin());

DROP POLICY IF EXISTS "audit_retention_settings_write" ON public.audit_retention_settings;
CREATE POLICY "audit_retention_settings_write"
  ON public.audit_retention_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin())
  WITH CHECK (public.has_role(auth.uid(), 'Admin') OR public.is_super_admin());

NOTIFY pgrst, 'reload schema';
