/**
 * Helpers para el routing multi-tenant URL-driven.
 *
 * Idea central: el slug del tenant vive en el path como `/t/<slug>/...`
 * y TanStack Router se configura con `basepath: "/t/<slug>"` al
 * inicializar — así el router internamente "ve" `/app/...` y matchea las
 * rutas existentes sin necesidad de renombrar 80+ archivos. Cuando el
 * usuario cambia de tenant (login, "Ver como X"), hacemos un hard
 * navigate (`window.location.href = ...`) que dispara reload completo y
 * re-inicializa el router con el nuevo basepath.
 *
 * Esto reemplaza el sistema viejo basado en `localStorage["examlab_tenant_override"]`:
 *   - El URL es ahora la ÚNICA fuente de verdad para "qué tenant estás viendo".
 *   - Compartir un link `/t/<slug>/app/exam/123` lleva al destinatario al
 *     contexto correcto sin más configuración.
 *   - El SuperAdmin "Ver como X" se traduce a una URL real, no a un
 *     estado oculto en storage.
 */
import { isValidTenantSlug } from "./tenant";

// Match `/t/<slug>` al inicio del path. El slug sigue las reglas del SQL
// CHECK (3-50 chars, lowercase alfanumérico + guión, no termina en guión).
const TENANT_PREFIX_RE = /^\/t\/([a-z0-9][a-z0-9-]{1,48}[a-z0-9])(?=\/|$)/;

/**
 * Extrae el slug del tenant del pathname actual (o uno dado).
 * Retorna null si no hay prefijo válido. SSR-safe.
 */
export function getTenantSlugFromUrl(pathname?: string): string | null {
  const p = pathname ?? (typeof window !== "undefined" ? window.location.pathname : "");
  if (!p) return null;
  const m = p.match(TENANT_PREFIX_RE);
  if (!m) return null;
  return isValidTenantSlug(m[1]) ? m[1] : null;
}

/**
 * Computa el basepath para TanStack Router según el URL inicial.
 * Llamado UNA SOLA VEZ en `router.tsx` al boot. Para cambiar de tenant
 * a runtime, usar `hardNavigateToTenant` (full reload).
 *
 * - `/t/fesna/app/admin/users` → basepath `/t/fesna`, router ve `/app/admin/users`.
 * - `/auth` → basepath `""`, router ve `/auth`.
 * - `/` → basepath `""`, router ve `/`.
 */
export function computeRouterBasepath(): string {
  const slug = getTenantSlugFromUrl();
  return slug ? `/t/${slug}` : "";
}

/**
 * Construye un URL absoluto con prefijo de tenant. Si `slug` es null
 * (SuperAdmin cross-tenant o landing), retorna el path sin prefijo.
 */
export function buildTenantUrl(slug: string | null, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (!slug) return clean;
  if (!isValidTenantSlug(slug)) return clean;
  return `/t/${slug}${clean}`;
}

/**
 * Hard-navega a otro tenant (o limpia el prefijo). Trigger:
 *   - Post-login: redirige a `/t/<userTenant>/app`.
 *   - SuperAdmin "Ver como X": salta a `/t/<X>/app`.
 *   - SuperAdmin "Salir del modo institución": limpia prefijo → `/app`.
 *   - Logout: `/auth` sin prefijo.
 *
 * Hace `window.location.href = ...` que dispara reload completo. Esto es
 * INTENCIONAL: el `basepath` del router se computa al boot, así que
 * cambiar de prefijo requiere re-init. Costo: una recarga de página
 * (~300ms con SW + chunks cacheados). Eventos de cambio de tenant son
 * raros (login, ver como, logout), no de navegación normal.
 */
export function hardNavigateToTenant(slug: string | null, path: string): void {
  if (typeof window === "undefined") return;
  window.location.href = buildTenantUrl(slug, path);
}

/**
 * Limpia el localStorage del override legacy si existe (rollover desde
 * el sistema viejo de override a URL-based). Llamar UNA VEZ en boot.
 *
 * El override viejo dejaba un slug en `localStorage["examlab_tenant_override"]`
 * que el `useTenant()` priorizaba. Como ahora la fuente de verdad es la
 * URL, dejar el localStorage podría confundir si quedaron pestañas
 * abiertas con valor viejo. Eliminarlo es seguro — la nueva lógica lo
 * ignora completamente.
 */
export function clearLegacyOverrideStorage(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem("examlab_tenant_override");
  } catch {
    // SecurityError en sandboxes / quotaError — ignorar.
  }
}
