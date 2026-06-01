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
import type { LocationRewrite } from "@tanstack/router-core";
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
 *
 * **DEPRECATED:** TanStack Start hace `router.update({ basepath:
 * process.env.TSS_ROUTER_BASEPATH })` durante la hidratación del
 * cliente, lo que sobrescribe el basepath dinámico que pasemos en
 * `createRouter`. Usar `createTenantRewrite()` en su lugar — los
 * `rewrite` SÍ persisten a través de `router.update` porque se
 * mantienen en `router.options.rewrite` y se recomponen automáticamente
 * cada vez que basepath cambia (ver `router-core/router.js` línea 122).
 *
 * Se mantiene exportada por compat con el test `url.test.ts`.
 */
export function computeRouterBasepath(): string {
  const slug = getTenantSlugFromUrl();
  return slug ? `/t/${slug}` : "";
}

/**
 * Crea el par de rewrites (input/output) que TanStack Router usa para
 * traducir entre URL pública (`/t/<slug>/app/...`) y URL interna del
 * router (`/app/...`).
 *
 *   - INPUT (URL pública → interna): regex-strip de `/t/<slug>` al
 *     inicio. Stateless: aplica a CUALQUIER URL con prefix válido. Corre
 *     tanto en server (SSR) como en cliente.
 *   - OUTPUT (URL interna → pública): prefija con el slug capturado al
 *     boot del cliente. En server, `window` no existe → slug=null → no-op
 *     (server renderiza hrefs "pelados"). En cliente, slug del URL
 *     actual.
 *
 * **Por qué la diferencia entre input y output:** el input es regex puro
 * porque la URL trae el slug explícito; el output necesita un slug
 * implícito "del contexto" porque el caller pasa solo el destino
 * (`/app/admin/users` sin saber el tenant actual). Closure al boot
 * captura el slug del URL en la pestaña del usuario.
 *
 * **Hydration mismatch:** server renderiza hrefs sin prefix, cliente los
 * regenera con prefix → mismatch breve en `<a href>`. React lo resuelve
 * adoptando el valor del cliente; no rompe la app. Aceptable porque las
 * navigaciones reales pasan por `pushState` (que SÍ tiene prefix).
 */
export function createTenantRewrite(): LocationRewrite {
  const initialSlug = typeof window !== "undefined" ? getTenantSlugFromUrl() : null;
  const prefix = initialSlug ? `/t/${initialSlug}` : "";

  return {
    input: ({ url }) => {
      // Strippea `/t/<slug>` regex-stateless. Funciona en server (SSR) y
      // cliente. Tolera slugs distintos al `initialSlug` por si el user
      // pega un link de otro tenant — la routing match es la misma.
      const m = url.pathname.match(TENANT_PREFIX_RE);
      if (m) {
        url.pathname = url.pathname.replace(TENANT_PREFIX_RE, "") || "/";
      }
      return url;
    },
    output: ({ url }) => {
      if (!prefix) return url;
      // No re-prefijar si ya tiene prefix (caller paso URL absoluta).
      if (url.pathname.startsWith(`${prefix}/`) || url.pathname === prefix) return url;
      // Auth y landing NO deben llevar prefix — son rutas globales del
      // sistema. Si el caller navega a /auth o /, dejamos pelado.
      if (url.pathname === "/" || url.pathname.startsWith("/auth")) return url;
      url.pathname = `${prefix}${url.pathname}`;
      return url;
    },
  };
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
  const target = buildTenantUrl(slug, path);
  // Anti-loop: si el target es exactamente el URL actual (mismo path
  // sin querystring/hash), no hacemos nada — un reload a la misma URL
  // ejecuta los mismos effects, que podrían re-disparar el navigate y
  // generar un loop. Esto puede pasar si dos efectos cargan estado en
  // distinto orden y uno termina pidiendo el redirect "al mismo lugar".
  if (window.location.pathname === target) return;
  window.location.href = target;
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
