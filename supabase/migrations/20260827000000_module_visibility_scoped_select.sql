-- ──────────────────────────────────────────────────────────────────────
-- Fix: `module_visibility` SELECT solo retorna global + tenant del caller.
--
-- Bug reportado: un SuperAdmin cross-tenant (`/app/admin/settings →
-- Módulos` con banner "Configuración global de la plataforma") apaga
-- "Certificaciones" para la columna SuperAdmin → guarda → recarga →
-- el ítem "Certificaciones" SIGUE apareciendo en su sidebar.
--
-- Causa raíz: la policy SELECT vigente (`module_visibility_read_all`,
-- mig 20260601100000) tiene `USING (true)` — todo `authenticated` ve
-- TODAS las filas de la tabla. Cuando el cliente carga el mapa de
-- visibilidad (`fetchVisibilityMap` en use-module-visibility.ts), el
-- merge tenant-sobre-global pisa el global si CUALQUIER tenant escribió
-- una fila `(certificates, SuperAdmin, true)` históricamente. El SA
-- cross-tenant no tiene `current_tenant_id()`, así que NO debería ver
-- overrides de ningún tenant — solo los globales.
--
-- Fix: la SELECT acota a `tenant_id IS NULL OR tenant_id =
-- current_tenant_id()`. Cada caller ve solo los globales + los
-- overrides de SU tenant (Admin de Alpha ve globales + Alpha; SA puro
-- ve solo globales; SA "Ver como Beta" ve globales + Beta).
--
-- Las policies INSERT/UPDATE/DELETE no cambian — siguen permitiendo a
-- la SA tocar cualquier tenant + global, y al Admin solo su tenant.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Drop la SELECT abierta + la FOR ALL anterior. Ambas dejaban pasar
--    SELECT desde el SuperAdmin para CUALQUIER tenant — RLS combina
--    policies con OR, así que la más laxa gana. Sin dropearlas, la
--    nueva SELECT scoped se queda corta.
DROP POLICY IF EXISTS "module_visibility_read_all" ON public.module_visibility;
DROP POLICY IF EXISTS "module_visibility_admin_write_own_tenant"
  ON public.module_visibility;

-- 2) SELECT: scoped al tenant del caller (o globales). SuperAdmin
--    cross-tenant (sin override) tiene current_tenant_id() = NULL,
--    así que solo ve filas con `tenant_id IS NULL` (globales). Cuando
--    entra a "Ver como X", current_tenant_id() devuelve X y ve también
--    los overrides de X. Admin/Docente/Estudiante solo ven globales +
--    su propio tenant. Nadie ve overrides de OTROS tenants.
DROP POLICY IF EXISTS "module_visibility_select_scoped" ON public.module_visibility;
CREATE POLICY "module_visibility_select_scoped"
  ON public.module_visibility FOR SELECT TO authenticated
  USING (
    tenant_id IS NULL OR tenant_id = public.current_tenant_id()
  );

-- 3) INSERT: SuperAdmin puede escribir cualquier fila (global o tenant);
--    Admin solo filas de su tenant.
DROP POLICY IF EXISTS "module_visibility_insert" ON public.module_visibility;
CREATE POLICY "module_visibility_insert"
  ON public.module_visibility FOR INSERT TO authenticated
  WITH CHECK (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  );

-- 4) UPDATE: idem INSERT (USING + WITH CHECK).
DROP POLICY IF EXISTS "module_visibility_update" ON public.module_visibility;
CREATE POLICY "module_visibility_update"
  ON public.module_visibility FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  )
  WITH CHECK (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  );

-- 5) DELETE: idem.
DROP POLICY IF EXISTS "module_visibility_delete" ON public.module_visibility;
CREATE POLICY "module_visibility_delete"
  ON public.module_visibility FOR DELETE TO authenticated
  USING (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  );

NOTIFY pgrst, 'reload schema';
