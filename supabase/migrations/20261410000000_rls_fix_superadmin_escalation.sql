-- ════════════════════════════════════════════════════════════════════════
-- CRÍTICO — cierre de escalada de privilegio Admin → SuperAdmin.
--
-- Vulnerabilidad (verificada empíricamente contra prod): un Admin de CUALQUIER
-- institución podía hacer un POST REST directo a /rest/v1/user_roles con
-- {user_id: <su_propio_id>, role: 'SuperAdmin'} y quedar SuperAdmin. La policy
-- user_roles_admin_manage_same_tenant (cmd=ALL) valida el TENANT del user_id
-- pero NO el VALOR de role, y el único trigger (trg_user_roles_quota_check,
-- BEFORE INSERT) hace RETURN NEW para role='SuperAdmin'. is_super_admin() lee
-- EXISTS(user_roles WHERE user_id=auth.uid() AND role='SuperAdmin'), así que esa
-- sola fila convierte al Admin en SuperAdmin → bypassa TODA la RLS (cada policy
-- empieza con is_super_admin() OR ...) → lectura/escritura de TODAS las
-- instituciones (profiles, cursos, entregas, notas, API keys de IA, etc.).
--
-- La regla "SuperAdmin solo lo asigna un SuperAdmin" vivía SOLO en la edge
-- bulk-import-users y en el front — un POST REST directo la saltaba. Este guard
-- la mueve a la DB (única capa que el REST directo no puede evitar).
--
-- Contexto service_role / SQL interno (auth.uid() IS NULL): EXENTO — la edge
-- bulk-import-users ya validó callerIsSuperAdmin antes de insertar como
-- service_role; un atacante no puede falsificar auth.uid() NULL (requiere la
-- service key). Solo se bloquea a un usuario autenticado real no-SuperAdmin.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_guard_user_roles_no_self_superadmin()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.role = 'SuperAdmin'::public.app_role
     AND auth.uid() IS NOT NULL              -- contexto de usuario (no service_role/interno)
     AND NOT public.is_super_admin() THEN    -- el caller NO es ya SuperAdmin
    RAISE EXCEPTION 'Solo un SuperAdmin puede otorgar el rol SuperAdmin.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF to_regclass('public.user_roles') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tg_guard_user_roles_no_self_superadmin ON public.user_roles;
    CREATE TRIGGER tg_guard_user_roles_no_self_superadmin
      BEFORE INSERT OR UPDATE ON public.user_roles
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_user_roles_no_self_superadmin();
  END IF;
END $$;

-- Defensa en profundidad: la rama Admin de la policy ALL tampoco debe ACEPTAR
-- SuperAdmin como valor (aunque el trigger ya lo bloquea). Se re-crea la policy
-- agregando "role <> 'SuperAdmin'" a la rama del Admin; la rama is_super_admin()
-- sigue sin restricción (un SA sí puede).
DO $$
BEGIN
  IF to_regclass('public.user_roles') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
                  AND tablename='user_roles' AND policyname='user_roles_admin_manage_same_tenant') THEN
    DROP POLICY user_roles_admin_manage_same_tenant ON public.user_roles;
    CREATE POLICY user_roles_admin_manage_same_tenant ON public.user_roles
      FOR ALL TO authenticated
      USING (
        public.is_super_admin()
        OR (
          public.has_role(auth.uid(), 'Admin'::public.app_role)
          AND EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.id = user_roles.user_id AND p.tenant_id = public.current_tenant_id())
        )
      )
      WITH CHECK (
        public.is_super_admin()
        OR (
          public.has_role(auth.uid(), 'Admin'::public.app_role)
          AND user_roles.role <> 'SuperAdmin'::public.app_role
          AND EXISTS (SELECT 1 FROM public.profiles p
                       WHERE p.id = user_roles.user_id AND p.tenant_id = public.current_tenant_id())
        )
      );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
