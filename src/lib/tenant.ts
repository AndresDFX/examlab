/**
 * Resolución del tenant activo en el cliente.
 *
 * Estrategia (en orden de prioridad):
 *   1. Subdomain → `uni.examlab.com` → slug='uni'
 *      Si el host tiene un subdomain distinto a 'www', lo extraemos.
 *      Reservados (no son tenants): 'www', 'app', 'admin', 'api'.
 *   2. Query param `?tenant=slug` → util mientras no haya wildcard DNS.
 *      Se persiste en localStorage para sobrevivir navegación.
 *   3. localStorage `examlab.active_tenant_slug` → persistencia entre sesiones.
 *
 * Una vez resuelto el slug, llamamos al RPC público
 * `resolve_tenant_by_slug` para validar que el tenant existe y traer
 * el branding (logo + colores). Esto se hace UNA VEZ al boot de la app
 * para no recargar en cada navegación.
 *
 * Si NO se puede resolver ningún slug, retornamos null y el cliente
 * sigue funcionando "como antes" — `current_tenant_id_safe()` en DB
 * cae al profile.tenant_id, así que el aislamiento sigue activo.
 */
import { supabase } from "@/integrations/supabase/client";

export interface ResolvedTenant {
  id: string;
  slug: string;
  name: string;
  status: "active" | "trial" | "suspended" | string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
}

const STORAGE_KEY = "examlab.active_tenant_slug";

// Subdomains que NO son tenants (reservados para la app principal)
const RESERVED_SUBDOMAINS = new Set([
  "",
  "www",
  "app",
  "admin",
  "api",
  "auth",
  "preview",
  "localhost",
  "127",
]);

/**
 * Detecta el slug del tenant en el orden documentado arriba.
 * No hace network. Solo lectura de window.location y localStorage.
 */
export function detectTenantSlug(): string | null {
  if (typeof window === "undefined") return null;

  // Las slugs DEBEN ser lowercase (convención web + match con el CHECK
  // de la tabla `tenants`). No normalizamos silenciosamente — rechazamos
  // input que no cumpla el formato para evitar ambigüedad.
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,49}$/;

  // 1. Subdomain
  const host = window.location.hostname || "";
  const parts = host.split(".");
  // `uni.examlab.com` → ['uni', 'examlab', 'com'] → subdomain='uni'
  // `examlab.com` → ['examlab', 'com'] → no subdomain
  // `localhost` → ['localhost'] → no subdomain
  if (parts.length >= 3) {
    const sub = parts[0] ?? "";
    if (sub && !RESERVED_SUBDOMAINS.has(sub) && SLUG_RE.test(sub)) {
      return sub;
    }
  }

  // 2. Query param ?tenant=slug
  const url = new URL(window.location.href);
  const qp = url.searchParams.get("tenant")?.trim() ?? "";
  if (qp && SLUG_RE.test(qp)) {
    // Persistir para que sobreviva navegación posterior
    try {
      window.localStorage.setItem(STORAGE_KEY, qp);
    } catch {
      /* localStorage bloqueado — ignoramos */
    }
    return qp;
  }

  // 3. localStorage
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)?.trim() ?? "";
    if (stored && SLUG_RE.test(stored)) {
      return stored;
    }
  } catch {
    /* ignoramos */
  }

  return null;
}

/**
 * Resuelve el tenant completo via RPC `resolve_tenant_by_slug`.
 * Retorna null si no hay slug detectado o si el slug no existe.
 *
 * Cachea en memoria por sesión — llamar varias veces no recarga la red.
 */
let _memoCache: { slug: string; result: ResolvedTenant | null } | null = null;

export async function resolveTenant(): Promise<ResolvedTenant | null> {
  const slug = detectTenantSlug();
  if (!slug) return null;

  if (_memoCache && _memoCache.slug === slug) {
    return _memoCache.result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("resolve_tenant_by_slug", {
    _slug: slug,
  });
  if (error) {
    console.warn("[tenant] resolve_tenant_by_slug failed:", error.message);
    _memoCache = { slug, result: null };
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  const result = (row as ResolvedTenant | undefined) ?? null;
  _memoCache = { slug, result };
  return result;
}

/**
 * Limpia el cache + localStorage. Útil al logout para no contaminar
 * la siguiente sesión con el tenant del user previo.
 */
export function clearTenantCache(): void {
  _memoCache = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignoramos */
    }
  }
}

/**
 * Construye el link de invitación para un tenant. Se lo manda el Admin
 * del tenant al estudiante/docente que va a invitar; al abrirlo, el
 * cliente detecta el slug y lo persiste en localStorage. Después el
 * estudiante puede ir directamente a `examlab.com` y seguirá viendo
 * el branding correcto.
 *
 * @param slug — slug del tenant (debe ser válido: a-z, 0-9, guiones)
 * @param origin — opcional, default a `window.location.origin`. Útil
 *                 para pre-renderizar el link en emails desde el server.
 *
 * @example
 *   buildTenantInviteUrl("uni")
 *   // → "https://app.examlab.com/?tenant=uni"
 *
 *   buildTenantInviteUrl("uni", "https://examlab.com")
 *   // → "https://examlab.com/?tenant=uni"
 */
export function buildTenantInviteUrl(slug: string, origin?: string): string {
  const o =
    origin ??
    (typeof window !== "undefined" ? window.location.origin : "https://examlab.com");
  // Quitar trailing slash del origin si lo tiene
  const base = o.replace(/\/+$/, "");
  return `${base}/?tenant=${encodeURIComponent(slug)}`;
}

/**
 * Aplica el branding del tenant a las CSS variables del documento.
 * Esto sobreescribe los colores primary/secondary del tema. Hacerlo
 * temprano en el boot para evitar flash de colores wrong.
 */
export function applyTenantBranding(tenant: ResolvedTenant | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (tenant?.primary_color) {
    root.style.setProperty("--tenant-primary", tenant.primary_color);
  } else {
    root.style.removeProperty("--tenant-primary");
  }
  if (tenant?.secondary_color) {
    root.style.setProperty("--tenant-secondary", tenant.secondary_color);
  } else {
    root.style.removeProperty("--tenant-secondary");
  }
}
