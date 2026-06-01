/**
 * useTenant() — hook que resuelve el tenant activo desde el URL.
 *
 * **Cambio importante (URL-driven multi-tenant):** la fuente de verdad
 * del tenant ahora es el SEGMENTO de URL `/t/<slug>/...`. El router de
 * TanStack se configura con `basepath: "/t/<slug>"` al boot (ver
 * [`router.tsx`](src/router.tsx)), así que dentro del app el `pathname`
 * sin prefix es lo que ve TanStack — pero `window.location.pathname` sí
 * tiene el `/t/<slug>` que el browser muestra.
 *
 * Estrategia de resolución (en orden):
 *   1. Slug en URL (`/t/<slug>/...`). Si presente, se resuelve por ese
 *      slug. Para SuperAdmin esto es el modo "viendo institución X";
 *      para users normales SOLO debe pasar si coincide con su
 *      `profile.tenant_id` (la RLS los bloquea igual, pero el
 *      `TenantUrlGuard` los redirige al suyo para no mostrar UI rota).
 *   2. Fallback a `profile.tenant_id`. Caso pre-redirect o
 *      compatibilidad con URLs viejas sin prefijo (el guard las
 *      corrige).
 *   3. Sin slug ni profile → `tenant=null` (SuperAdmin cross-tenant o
 *      sesión sin tenant asignado).
 *
 * **Backward-compat:**
 *   - `readTenantOverride()` y `setTenantOverride()` se mantienen como
 *     wrappers de la lógica URL: el primero lee del path; el segundo
 *     hace `hardNavigateToTenant()` (recarga). Esto preserva los
 *     call-sites existentes que detectan "modo SuperAdmin cross-tenant"
 *     con `activeRole === "SuperAdmin" && !readTenantOverride()`.
 *   - `clearTenantOverrideSilent()` queda como no-op (la URL no se
 *     puede limpiar "en silencio"; quien quiera salir del modo
 *     institución debe navegar a /app sin prefijo).
 */
import { useEffect, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Tenant } from "@/modules/tenants/tenant";
import { getTenantSlugFromUrl, hardNavigateToTenant } from "@/modules/tenants/url";

/**
 * Lee el slug de tenant activo. Antes leía localStorage; ahora lee el
 * URL. Mantiene el mismo nombre para no romper call-sites existentes.
 */
export function readTenantOverride(): string | null {
  return getTenantSlugFromUrl();
}

/**
 * Cambia el tenant activo via hard navigation (recarga la página para
 * re-inicializar el `basepath` del router). Pasar `null` para limpiar
 * el prefix (modo cross-tenant del SuperAdmin).
 *
 * Triggers típicos:
 *   - Click en "Ver como X" desde `/app/superadmin/tenants`.
 *   - Click en "Salir del modo institución" desde `TenantOverrideBanner`.
 */
export function setTenantOverride(slug: string | null): void {
  hardNavigateToTenant(slug, "/app");
}

/**
 * No-op. La firma se mantiene por compat — antes limpiaba localStorage.
 * Si necesitás salir del prefix, usá `setTenantOverride(null)` (hace
 * full reload).
 */
export function clearTenantOverrideSilent(): void {
  /* intencionalmente vacío — la URL es ahora la fuente de verdad y no
   * se puede modificar sin navegar. */
}

export interface UseTenantResult {
  tenant: Tenant | null;
  loading: boolean;
  /** "missing_tenant" si no hay slug en URL ni profile;
   *  "override_not_found" si el slug del URL no resuelve a un tenant;
   *  "load_error" si la query falló. */
  error: "missing_tenant" | "override_not_found" | "load_error" | null;
  /** Refetch manual (raramente necesario — la URL cambia con reload). */
  refresh: () => void;
}

export function useTenant(): UseTenantResult {
  const { profile, loading: authLoading } = useAuth();
  // Subscribirse al pathname interno del router para que cambios de ruta
  // dentro del mismo basepath (ej. /app → /app/admin/users) no
  // re-disparen este effect — sí queremos re-trigger si EL SLUG cambia,
  // pero eso requiere reload completo y por tanto no necesita reactivo.
  // Lo usamos solo para invalidación cuando el caller hace `refresh()`.
  const routerPathname = useRouterState({ select: (s) => s.location.pathname });
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<UseTenantResult["error"]>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (authLoading) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);

      // 1) Slug del URL — fuente autoritativa.
      const urlSlug = getTenantSlugFromUrl();
      if (urlSlug) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error: dbErr } = await (supabase as any)
          .from("tenants")
          .select("*")
          .eq("slug", urlSlug)
          .maybeSingle();
        if (cancelled) return;
        if (dbErr) {
          setError("load_error");
          setTenant(null);
        } else if (!data) {
          // El slug en URL no resuelve. Para non-SuperAdmin la RLS
          // probablemente lo bloqueó; para SuperAdmin significa
          // tenant inexistente. Caemos al profile como red.
          setError("override_not_found");
          // Fall through al fallback de abajo.
        } else {
          setTenant(data as Tenant);
          setLoading(false);
          return;
        }
      }

      // 2) Fallback a profile.tenant_id (pre-guard redirect, landing,
      //    SuperAdmin cross-tenant sin URL slug).
      if (!profile?.tenant_id) {
        setTenant(null);
        setError(profile ? "missing_tenant" : null);
        setLoading(false);
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: dbErr } = await (supabase as any)
        .from("tenants")
        .select("*")
        .eq("id", profile.tenant_id)
        .maybeSingle();
      if (cancelled) return;
      if (dbErr) {
        setError("load_error");
        setTenant(null);
      } else {
        setTenant((data as Tenant | null) ?? null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // `routerPathname` está acá para re-evaluar si el path cambia en la
    // misma sesión (ej. navegación legacy). El slug típicamente no
    // cambia sin reload, pero ante un edge case esto evita stale data.
  }, [authLoading, profile?.tenant_id, routerPathname, nonce]);

  return { tenant, loading, error, refresh: () => setNonce((n) => n + 1) };
}
