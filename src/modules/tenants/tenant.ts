/**
 * Multi-tenancy: tipos y helpers compartidos.
 *
 * El resto del cliente —que asume single-tenant— sigue funcionando
 * porque la migración Fase 1 backfilea a TODOS los usuarios al tenant
 * "default". Este módulo expone el contrato para cuando las fases
 * siguientes empiecen a leer/escribir tenant_id en otras tablas.
 *
 * Resolución de tenant del usuario activo (Fase 6 lo conecta a un hook
 * `useTenant()` con cache de sesión):
 *   1. Cliente al cargar la app → SELECT id, slug, name, logo_url, primary_color
 *      FROM tenants WHERE id = (SELECT tenant_id FROM profiles WHERE id = auth.uid())
 *   2. Branding (logo + color) se inyecta en PageHeader / login.
 *   3. SuperAdmin: puede cambiar de tenant vía un dropdown (Fase 6).
 *
 * Routing (Fase 7):
 *   - URL canónica: `/t/<slug>/app/...`
 *   - Si el URL trae slug, el cliente verifica que coincida con el
 *     tenant del usuario logueado (o que sea SuperAdmin). Si no, redirect
 *     a `/t/<mySlug>/app/...`.
 */

/** Fila de la tabla `tenants` tal como la devuelve PostgREST. */
export interface Tenant {
  id: string;
  slug: string;
  name: string;
  logo_url: string | null;
  primary_color: string | null;
  email_domain: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Validación de slug — debe coincidir con el CHECK en SQL. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export function isValidTenantSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

/**
 * Extrae el slug de tenant de un pathname. Soporta:
 *   - `/t/<slug>/app/...`
 *   - `/t/<slug>` (sin trailing path)
 *
 * Devuelve null si la URL no tiene prefijo `/t/<slug>` válido. Útil para
 * el guard del router (Fase 7).
 */
export function extractTenantSlugFromPath(pathname: string): string | null {
  const m = pathname.match(/^\/t\/([^/]+)(?:\/|$)/);
  if (!m) return null;
  const slug = m[1];
  return isValidTenantSlug(slug) ? slug : null;
}

/**
 * Construye una URL canónica con prefijo de tenant. Si el path ya tiene
 * prefijo `/t/...` lo reemplaza; si no, lo añade adelante.
 */
export function withTenantPrefix(slug: string, path: string): string {
  if (!isValidTenantSlug(slug)) return path;
  // Normaliza: garantiza que path arranque con "/"
  const clean = path.startsWith("/") ? path : `/${path}`;
  // Si ya trae prefijo de tenant, reemplazamos el slug.
  const stripped = clean.replace(/^\/t\/[^/]+/, "");
  const tail = stripped.startsWith("/") ? stripped : `/${stripped}`;
  return `/t/${slug}${tail}`;
}
