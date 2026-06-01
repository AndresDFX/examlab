-- ───────────────────────────────────────────────────────────────────────
-- list_active_tenants_public()
--
-- Necesitamos que el login muestre un selector de instituciones ANTES
-- de autenticar — el usuario tiene que poder elegir su tenant. La RLS
-- de `tenants` exige `authenticated` para SELECT, así que un caller
-- `anon` no ve nada (todo bien — no queremos exponer la lista interna
-- de tenants a cualquiera que llegue al login sin credenciales).
--
-- Esta función SECURITY DEFINER deja al login leer solo lo necesario:
-- id, slug, name, branding mínimo (logo, color primario). Excluye
-- campos sensibles (cuotas, email_domain, is_active=false). Filtra a
-- `is_active = true` para no listar instituciones pausadas.
--
-- Riesgo de exposición: bajo. El nombre y slug del tenant son visibles
-- en URLs públicas (`/t/<slug>/...`) y en branding renderizado. No hay
-- info adicional que un atacante no pudiera adivinar/iterar.
-- ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.list_active_tenants_public()
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  logo_url text,
  logo_path text,
  primary_color text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT t.id, t.slug, t.name, t.logo_url, t.logo_path, t.primary_color
  FROM public.tenants AS t
  WHERE t.is_active = true
  ORDER BY t.name ASC;
$$;

REVOKE ALL ON FUNCTION public.list_active_tenants_public() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_active_tenants_public() TO anon, authenticated;

COMMENT ON FUNCTION public.list_active_tenants_public() IS
  'Lista pública (anon-readable) de tenants activos para el selector del login. Expone solo campos no sensibles.';
