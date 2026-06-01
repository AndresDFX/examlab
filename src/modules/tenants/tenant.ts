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
  /** Override del color de letra sobre superficies con branding (sidebar,
   *  botones primarios). Si es NULL, TenantThemeProvider lo deriva por
   *  luminancia (blanco si el primario es oscuro, negro si es claro).
   *  Útil cuando la marca tiene un color de texto específico (ej. crema,
   *  azul oscuro) que no surge naturalmente del primario. */
  text_color: string | null;
  /** Override del color de los íconos del sidebar nav. Si NULL, los
   *  íconos heredan `text_color` (que a su vez puede ser auto-derivado).
   *  Útil cuando la marca quiere íconos en color contrastante con el
   *  texto (ej. íconos amarillos sobre texto blanco). */
  icon_color: string | null;
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
      const { data } = supabaseClient.storage.from("tenant-logos").getPublicUrl(tenant.logo_path);
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
 * Slugifica el nombre de un tenant para usarlo como NOMBRE DE ARCHIVO
 * (no como slug de URL — eso lo hace el campo `tenants.slug` en DB).
 *
 * Por qué: los logos de institución se guardan en el bucket
 * `tenant-logos` con path `${tenant_id}/<filename>`. El folder DEBE ser
 * el UUID (lo exige la RLS via `(storage.foldername(name))[1]`), pero
 * el filename es libre — así que usamos el nombre de la institución
 * para que cuando alguien inspeccione el storage o descargue el archivo
 * directamente, sea claro qué institución es:
 *   `Universidad Antonio Jose Camacho` → `universidad-antonio-jose-camacho`
 *
 * Reglas:
 *   - lowercase
 *   - quita acentos (NFD + remove combining marks)
 *   - reemplaza cualquier no-alfanumérico por guión
 *   - colapsa guiones consecutivos
 *   - trim de guiones al inicio/fin
 *   - fallback a `"institution"` si queda vacío (tenant name todo símbolos)
 *   - cap a 60 chars para no generar paths gigantes
 */
export function slugifyTenantName(name: string | null | undefined): string {
  if (!name) return "institution";
  const normalized = name
    .normalize("NFD")
    // Combining marks (acentos, tildes, diéresis) — quedan como código
    // separado después del NFD. U+0300..U+036F es el rango
    // "Combining Diacritical Marks" de Unicode.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return normalized || "institution";
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

export function decideTenantUrlAction(pathname: string, isSuperAdmin: boolean): TenantUrlAction {
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
