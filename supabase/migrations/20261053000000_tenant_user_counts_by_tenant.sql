-- ══════════════════════════════════════════════════════════════════════
-- tenant_user_counts(_tenant_id): sobrecarga para que TenantQuotaCard muestre el
-- conteo del tenant RESUELTO por useTenant (que respeta el override "Ver como X"),
-- no el de current_tenant_id(). El card sacaba el DENOMINADOR (max_*) del tenant X
-- pero el NUMERADOR del RPC parameterless (current_tenant_id() = NULL para el SA)
-- → mostraba "0 / 50". Autorización: el propio tenant (Admin) o SuperAdmin.
-- Coexiste con la versión sin argumentos (dashboards) — PostgREST resuelve por firma.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tenant_user_counts(_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (_tenant_id = public.current_tenant_id() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'No autorizado' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'admins',   COALESCE(public.tenant_role_count(_tenant_id, 'Admin'::public.app_role), 0),
    'teachers', COALESCE(public.tenant_role_count(_tenant_id, 'Docente'::public.app_role), 0),
    'students', COALESCE(public.tenant_role_count(_tenant_id, 'Estudiante'::public.app_role), 0)
  );
END
$function$;

REVOKE ALL ON FUNCTION public.tenant_user_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.tenant_user_counts(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
