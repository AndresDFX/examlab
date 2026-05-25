-- ──────────────────────────────────────────────────────────────────────
-- Tenant scoping de profiles + user_roles.
--
-- Hasta ahora `profiles` tenia RLS abierta a authenticated (cualquier
-- logueado ve cualquier profile) y `user_roles` permite a Admin
-- gestionar TODOS los roles cross-tenant. Con multi-tenant esto rompe
-- el aislamiento: Admin de Universidad A podia ver/editar usuarios de
-- Universidad B.
--
-- Cambios:
--   1. profiles.SELECT: mi propio profile + profiles de MI tenant +
--      SuperAdmin ve todos.
--   2. profiles.UPDATE: yo edito el mio; Admin edita los de su tenant;
--      SuperAdmin todos.
--   3. profiles.INSERT: handle_new_user() lo hace via SECURITY DEFINER
--      (bypassa RLS) — no necesita policy explicita. Quitamos la FOR ALL
--      que era demasiado amplia.
--   4. user_roles: Admin gestiona roles solo de usuarios de SU tenant.
--      SuperAdmin global. Usuario sigue viendo sus propios roles.
--
-- Retrocompat: con un solo tenant 'default', el comportamiento es
-- equivalente al actual — todos los profiles tienen tenant_id='default'
-- y se ven entre si.
--
-- Politica explicita para SuperAdmin: `is_super_admin()` ya es bypass
-- en otras tablas (Fases 1-5); aqui sumamos en cada policy via OR.
-- ──────────────────────────────────────────────────────────────────────

-- ─── PROFILES ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Profiles viewable by all authenticated" ON public.profiles;
DROP POLICY IF EXISTS "Users update own profile" ON public.profiles;
DROP POLICY IF EXISTS "Admins manage profiles" ON public.profiles;

-- SELECT: mi propio profile + profiles del mismo tenant + SuperAdmin.
-- El "mismo tenant" es necesario para listas (cursos, grupos, mensajeria
-- de contactos, etc.) que muestran nombres de otros usuarios. Sin esto,
-- un estudiante no podria ver los nombres de sus companeros del curso.
CREATE POLICY "profiles_select_same_tenant"
  ON public.profiles FOR SELECT TO authenticated
  USING (
    id = auth.uid()
    OR (tenant_id IS NOT NULL AND tenant_id = public.current_tenant_id())
    OR public.is_super_admin()
  );

-- UPDATE: usuario edita SU propio profile; Admin edita profiles de SU
-- tenant; SuperAdmin todos. INSERT lo maneja handle_new_user() trigger
-- (SECURITY DEFINER, bypassa RLS).
CREATE POLICY "profiles_update_self"
  ON public.profiles FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_admin_manage_same_tenant"
  ON public.profiles FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (
      public.has_role(auth.uid(), 'Admin'::public.app_role)
      AND tenant_id IS NOT NULL
      AND tenant_id = public.current_tenant_id()
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR (
      public.has_role(auth.uid(), 'Admin'::public.app_role)
      AND tenant_id IS NOT NULL
      AND tenant_id = public.current_tenant_id()
    )
  );

CREATE POLICY "profiles_admin_delete_same_tenant"
  ON public.profiles FOR DELETE TO authenticated
  USING (
    public.is_super_admin()
    OR (
      public.has_role(auth.uid(), 'Admin'::public.app_role)
      AND tenant_id IS NOT NULL
      AND tenant_id = public.current_tenant_id()
    )
  );

-- ─── USER_ROLES ──────────────────────────────────────────────────────

DROP POLICY IF EXISTS "Users see own roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins see all roles" ON public.user_roles;
DROP POLICY IF EXISTS "Admins manage roles" ON public.user_roles;

-- SELECT: yo veo mis roles. Admin/SuperAdmin ve los roles de usuarios
-- de SU tenant (resuelto via JOIN a profiles).
CREATE POLICY "user_roles_select_self_or_admin"
  ON public.user_roles FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.is_super_admin()
    OR (
      public.has_role(auth.uid(), 'Admin'::public.app_role)
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = user_roles.user_id
          AND p.tenant_id = public.current_tenant_id()
      )
    )
  );

-- INSERT/UPDATE/DELETE: Admin gestiona roles de usuarios de SU tenant.
-- SuperAdmin cross-tenant. Multiples Admins por tenant: soportado
-- naturalmente — la policy no limita por user_id; cualquier user con
-- rol Admin en un tenant puede asignar Admin a otro user del mismo
-- tenant. No hay restriccion de "un solo Admin por tenant".
CREATE POLICY "user_roles_admin_manage_same_tenant"
  ON public.user_roles FOR ALL TO authenticated
  USING (
    public.is_super_admin()
    OR (
      public.has_role(auth.uid(), 'Admin'::public.app_role)
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = user_roles.user_id
          AND p.tenant_id = public.current_tenant_id()
      )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR (
      public.has_role(auth.uid(), 'Admin'::public.app_role)
      AND EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.id = user_roles.user_id
          AND p.tenant_id = public.current_tenant_id()
      )
    )
  );

NOTIFY pgrst, 'reload schema';
