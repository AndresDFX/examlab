-- ──────────────────────────────────────────────────────────────────────
-- RPC: admin_update_my_tenant
--
-- Permite al Admin editar campos branding/identidad de SU PROPIA
-- institución desde el panel Configuración → Institución → "Mi
-- institución" (componente AdminMyTenantPanel).
--
-- Por qué una RPC y no UPDATE directo con RLS más permisiva:
--   - La policy de UPDATE en `tenants` (mig 20260621) es estricta:
--     solo SuperAdmin. Razón: gestionar TODAS las instituciones es
--     responsabilidad cross-tenant, no del Admin individual.
--   - El Admin sí debe poder editar SU tenant — pero solo campos
--     visibles (branding), NO `slug` (URL canónica, immutable) ni
--     `is_active` (apagar tu propia institución te dejaría fuera).
--   - Una RPC SECURITY DEFINER nos permite expresar exactamente esa
--     política sin abrir UPDATE completo en RLS.
--
-- Validaciones server-side:
--   - El caller debe tener rol Admin O SuperAdmin.
--   - El tenant_id afectado es SIEMPRE current_tenant_id() del caller.
--     No se puede pasar otro tenant via parámetro.
--   - `name` no puede ser vacío.
--
-- Audit: registramos el evento en audit_logs.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_update_my_tenant(
  _name          TEXT,
  _logo_url      TEXT DEFAULT NULL,
  _primary_color TEXT DEFAULT NULL,
  _email_domain  TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_tenant  UUID;
  v_is_adm  BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;

  -- El caller debe ser Admin o SuperAdmin. (Docente/Estudiante NO pueden
  -- editar branding de la institución.)
  SELECT
    public.has_role(v_uid, 'Admin'::public.app_role)
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_uid AND role::text = 'SuperAdmin'
    )
  INTO v_is_adm;

  IF NOT v_is_adm THEN
    RAISE EXCEPTION 'Permiso denegado: requiere rol Admin' USING ERRCODE = '42501';
  END IF;

  -- Tenant del caller (su propia institución).
  SELECT public.current_tenant_id() INTO v_tenant;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tu usuario no tiene institución asignada' USING ERRCODE = 'P0001';
  END IF;

  -- Validación: name no vacío.
  IF _name IS NULL OR length(trim(_name)) = 0 THEN
    RAISE EXCEPTION 'El nombre de la institución no puede estar vacío'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.tenants
     SET name          = trim(_name),
         logo_url      = NULLIF(trim(COALESCE(_logo_url, '')), ''),
         primary_color = NULLIF(trim(COALESCE(_primary_color, '')), ''),
         email_domain  = LOWER(NULLIF(trim(COALESCE(_email_domain, '')), '')),
         updated_at    = now()
   WHERE id = v_tenant;

  -- Audit log (best-effort — no abortamos si falla).
  BEGIN
    INSERT INTO public.audit_logs (
      actor_id, action, category, severity, entity_type, entity_id, entity_name
    )
    VALUES (
      v_uid,
      'tenant.updated',
      'tenants',
      'info',
      'tenant',
      v_tenant::text,
      trim(_name)
    );
  EXCEPTION WHEN OTHERS THEN
    -- silencioso
    NULL;
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_update_my_tenant(TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION public.admin_update_my_tenant(TEXT, TEXT, TEXT, TEXT) IS
  'Permite al Admin (o SuperAdmin) editar branding (name/logo/color/email_domain) de SU PROPIA institución. Slug e is_active solo los gestiona SuperAdmin desde el panel global.';

NOTIFY pgrst, 'reload schema';
