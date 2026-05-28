-- ──────────────────────────────────────────────────────────────────────
-- admin_list_push_subscriptions — listar TODAS las suscripciones de Web
-- Push de la plataforma (scopeadas por rol).
--
-- `push_subscriptions` tiene RLS `USING (user_id = auth.uid())` — el dueño
-- solo ve las suyas. El panel "Web Push (PWA)" de System Diagnostics
-- mostraba SOLO las suscripciones del admin que estaba mirando, no
-- daba visibilidad operativa real ("¿quién tiene la PWA instalada y le
-- llegan pushes?"). Esta RPC SECURITY DEFINER abre esa vista a Admin
-- (acotado a su tenant) y SuperAdmin (cross-tenant).
--
-- Retorna info mínima del usuario (email + nombre completo) para que el
-- admin pueda mapear el device a la persona. NO retorna endpoint
-- completo (es un secret operativo del browser — la URL única por
-- device); el `user_agent` alcanza para identificar el dispositivo.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_list_push_subscriptions()
RETURNS TABLE (
  id UUID,
  user_id UUID,
  user_email TEXT,
  user_full_name TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  tenant_id UUID,
  tenant_name TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_super  BOOLEAN := public.is_super_admin();
  v_is_admin  BOOLEAN := public.has_role(auth.uid(), 'Admin');
  v_my_tenant UUID    := public.current_tenant_id();
BEGIN
  IF NOT v_is_super AND NOT v_is_admin THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    ps.id,
    ps.user_id,
    p.institutional_email AS user_email,
    p.full_name           AS user_full_name,
    ps.user_agent,
    ps.created_at,
    ps.updated_at,
    p.tenant_id,
    t.name AS tenant_name
  FROM public.push_subscriptions ps
  LEFT JOIN public.profiles p ON p.id = ps.user_id
  LEFT JOIN public.tenants  t ON t.id = p.tenant_id
  WHERE v_is_super OR (v_is_admin AND p.tenant_id = v_my_tenant)
  ORDER BY ps.updated_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_push_subscriptions() TO authenticated;

NOTIFY pgrst, 'reload schema';
