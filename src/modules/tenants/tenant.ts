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
  /** Path dentro del bucket `tenant-logos`. Si está seteado, el cliente
   *  resuelve la URL pública con `supabase.storage.from('tenant-logos').getPublicUrl(logo_path)`. */
  logo_path: string | null;
  primary_color: string | null;
  /** Color secundario (acento) hex. Se aplica como `--brand-secondary`
   *  en el theme. */
  secondary_color: string | null;
  email_domain: string | null;
  is_active: boolean;
  /** Cuotas de usuarios por rol. NULL = ilimitado. SuperAdmin las define
   *  desde el panel /app/superadmin/tenants. SuperAdmin no consume cuota
   *  (cross-tenant). El trigger tg_check_tenant_user_quota rechaza
   *  INSERT en user_roles cuando se excede. */
  max_admins: number | null;
  max_teachers: number | null;
  max_students: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Helper: resuelve la URL renderizable del logo del tenant.
 *   1. Si tiene logo_path → URL publica del bucket Storage.
 *   2. Si tiene logo_url externa (legacy) → la usa directa.
 *   3. Si nada → null (el caller pinta fallback con iniciales o "ExamLab" plano).
 *
 * Necesita el cliente de Supabase para resolver la URL del bucket.
 */
export function resolveTenantLogoUrl(
  tenant: Pick<Tenant, "logo_path" | "logo_url"> | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabaseClient: any,
): string | null {
  if (!tenant) return null;
  if (tenant.logo_path) {
    try {
      const { data } = supabaseClient.storage
        .from("tenant-logos")
        .getPublicUrl(tenant.logo_path);
      return (data?.publicUrl as string | undefined) ?? null;
    } catch {
      return null;
    }
  }
  return tenant.logo_url ?? null;
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

/**
 * Resultado de la decisión del URL-guard al inspeccionar un pathname.
 *   - `strippedPath`: el pathname normalizado sin prefijo `/t/<slug>` (o
 *     null si no había prefijo que strip — caller no hace replaceState).
 *   - `overrideSlug`: slug del tenant a setear como override en
 *     localStorage. Solo se setea si el caller es SuperAdmin Y había
 *     prefijo válido. Null = no setear.
 *
 * La lógica es pura — no toca window/localStorage. El componente
 * `TenantUrlGuard` aplica los efectos secundarios.
 */
export interface TenantUrlAction {
  strippedPath: string | null;
  overrideSlug: string | null;
}

export function decideTenantUrlAction(
  pathname: string,
  isSuperAdmin: boolean,
): TenantUrlAction {
  const slug = extractTenantSlugFromPath(pathname);
  if (!slug) {
    return { strippedPath: null, overrideSlug: null };
  }
  // Strip el prefijo. Si el path era exactamente `/t/<slug>`, queda "/".
  const stripped = pathname.replace(/^\/t\/[^/]+/, "") || "/";
  return {
    strippedPath: stripped,
    overrideSlug: isSuperAdmin ? slug : null,
  };
}
