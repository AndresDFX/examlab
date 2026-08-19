/**
 * useTenant() — resuelve el tenant activo.
 *
 * Estrategia (en orden):
 *   1. Override de SuperAdmin via localStorage `examlab_tenant_override`
 *      (slug). Si el rol incluye SuperAdmin y eligió "Ver como X",
 *      resolvemos a ESE tenant. Gana sobre el subdominio: "ver como X" es una
 *      acción deliberada y tiene que poder más que la dirección.
 *   2. SUBDOMINIO del host (`uniaj.midominio.co` → slug `uniaj`), cuando el
 *      despliegue usa un subdominio por institución, y el caller NO es
 *      SuperAdmin (para preservar `isSuperAdminCrossTenant`). Así un enlace a
 *      la institución abre en ella sin pasar por el selector. Ver
 *      `modules/tenants/subdomain.ts` y `docs/subdominios-cloudflare.md`.
 *   3. profile.tenant_id del useAuth. Resuelve a la institución del
 *      usuario autenticado.
 *
 * **Nota:** el plan original era poner el slug en la URL (`/t/<slug>/...`)
 * vía un `rewrite` de TanStack Router. NO funcionó en Lovable: el SSR
 * emite 307 redirects cuando el rewrite es asimétrico entre server y
 * client (ver `TenantUrlGuard.tsx` para detalles). Volvimos a
 * localStorage — funcionalmente equivalente, solo que el slug no es
 * visible en la barra de direcciones. La RLS server-side sigue siendo
 * la autoridad de aislamiento; el localStorage es solo UI hint para
 * SuperAdmin.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Tenant } from "@/modules/tenants/tenant";
import { isValidTenantSlug } from "@/modules/tenants/tenant";
import { subdomainTenantSlug } from "@/modules/tenants/subdomain";

const OVERRIDE_KEY = "examlab_tenant_override";

/** Lee el slug override desde localStorage. */
export function readTenantOverride(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(OVERRIDE_KEY);
    if (!raw) return null;
    // Soporte retro: el formato puede ser slug plano o JSON {slug, ts}
    // de la era URL-based (deprecada). Aceptamos ambos.
    if (isValidTenantSlug(raw)) return raw;
    try {
      const obj = JSON.parse(raw) as { slug?: string };
      if (obj.slug && isValidTenantSlug(obj.slug)) return obj.slug;
    } catch {
      // raw no es JSON ni slug válido — null
    }
    return null;
  } catch {
    return null;
  }
}

/** Setea el slug override en localStorage y notifica a useTenant() hooks. */
export function setTenantOverride(slug: string | null): void {
  if (typeof window === "undefined") return;
  if (slug && isValidTenantSlug(slug)) {
    window.localStorage.setItem(OVERRIDE_KEY, slug);
  } else {
    window.localStorage.removeItem(OVERRIDE_KEY);
  }
  // Notificamos a useTenant() montados en la misma pestaña.
  window.dispatchEvent(new CustomEvent("examlab:tenant-override-changed"));
}

/** No-op por compat con call-sites legacy del enfoque URL-based. */
export function clearTenantOverrideSilent(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(OVERRIDE_KEY);
  } catch {
    /* ignore */
  }
}

export interface UseTenantResult {
  tenant: Tenant | null;
  loading: boolean;
  error: "missing_tenant" | "override_not_found" | "load_error" | null;
  refresh: () => void;
}

export function useTenant(): UseTenantResult {
  const { profile, roles, loading: authLoading } = useAuth();
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

      // Subdominio del host. Se LEE acá pero se USA en el paso 2, más abajo:
      // el override tiene early-returns y no conviene repetir la lectura.
      // Solo aplica si el despliegue usa subdominios; en `examlab.lovable.app`
      // y en localhost devuelve null y todo sigue exactamente como hoy.
      const hostSlug =
        typeof window !== "undefined" ? subdomainTenantSlug(window.location.hostname) : null;

      // 1) Override del SuperAdmin via localStorage.
      const override = roles.includes("SuperAdmin") ? readTenantOverride() : null;
      if (override) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error: dbErr } = await (supabase as any)
          .from("tenants")
          .select("*")
          .eq("slug", override)
          .maybeSingle();
        if (cancelled) return;
        if (dbErr) {
          setError("load_error");
          setTenant(null);
          setLoading(false);
          return;
        }
        if (!data) {
          // Override stale (renombrado/eliminado). Limpiamos y caemos
          // al profile.tenant_id en el mismo run.
          clearTenantOverrideSilent();
          setError("override_not_found");
        } else {
          setTenant(data as Tenant);
          setLoading(false);
          return;
        }
      }

      // 2) Institución que dicta el SUBDOMINIO.
      //
      // Se salta a propósito para un SuperAdmin SIN override: el modo
      // cross-tenant se define como `activeRole === "SuperAdmin" && !override`
      // (invariante compartida entre AppLayout y TenantThemeProvider). Si el
      // host le fijara una institución acá, `tenant` diría "uniaj" mientras esas
      // dos pantallas siguen creyendo que está cross-tenant, y vería el nombre
      // de una institución con el tema por defecto. Para "ver como X" ya existe
      // el override, que es explícito.
      if (hostSlug && !roles.includes("SuperAdmin")) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error: dbErr } = await (supabase as any)
          .from("tenants")
          .select("*")
          .eq("slug", hostSlug)
          .maybeSingle();
        if (cancelled) return;
        // Un subdominio inexistente NO es un error fatal: se cae al
        // profile.tenant_id, que es el comportamiento de hoy. Así un enlace
        // viejo a una institución renombrada sigue abriendo la app.
        if (!dbErr && data) {
          setTenant(data as Tenant);
          setLoading(false);
          return;
        }
      }

      // 3) Fallback al profile.tenant_id.
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
  }, [authLoading, profile?.tenant_id, roles, nonce]);

  // Refresca cuando setTenantOverride se llama en otro componente.
  useEffect(() => {
    const handler = () => setNonce((n) => n + 1);
    window.addEventListener("examlab:tenant-override-changed", handler);
    // Cross-tab: storage event detecta cambios desde otras pestañas.
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("examlab:tenant-override-changed", handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  return { tenant, loading, error, refresh: () => setNonce((n) => n + 1) };
}
