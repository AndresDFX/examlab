/**
 * Helpers de URL para el tenant.
 *
 * **Historia:** se intentó exponer el slug en la URL como
 * `/t/<slug>/app/...` via un `rewrite` custom de TanStack Router.
 * NO funcionó en Lovable: el SSR emite 307 redirects cuando el
 * INPUT/OUTPUT rewrite es asimétrico (server no captura el slug porque
 * `window` es undefined). Volvimos al modelo localStorage para el
 * override del SuperAdmin (`examlab_tenant_override`).
 *
 * Este archivo conserva solo el helper que sigue siendo útil:
 * `getTenantSlugFromUrl()` — extrae el slug del URL si está presente.
 * Útil para shareable links históricos (`/t/<slug>/auth`) que pueden
 * llegar como deep-link aunque la URL ya no se mantenga así.
 */
import { isValidTenantSlug } from "./tenant";

// Match `/t/<slug>` al inicio del path.
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
