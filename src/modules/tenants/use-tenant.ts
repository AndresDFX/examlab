/**
 * useTenant() — hook que carga el tenant del usuario actual.
 *
 * Estrategia de resolución (en orden):
 *   1. Override de SuperAdmin via localStorage `examlab_tenant_override`
 *      (slug). Si el usuario es SuperAdmin y eligió ver otra
 *      institución, devolvemos ESE tenant. Útil para soporte.
 *   2. profile.tenant_id del useAuth. Resuelve a la institución del
 *      usuario logueado.
 *
 * El hook trae también el row completo del tenant (slug, name, logo,
 * branding) para que el caller pueda render branding sin otra query.
 *
 * Mientras la sesión está cargando, devuelve loading=true. Cuando hay
 * sesión pero el profile no tiene tenant_id (caso transitorio
 * pre-Fase 6), `tenant=null` y `error="missing_tenant"`.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Tenant } from "@/modules/tenants/tenant";
import { isValidTenantSlug } from "@/modules/tenants/tenant";

const OVERRIDE_KEY = "examlab_tenant_override";

/** Lee el slug override desde localStorage (SuperAdmin "ver como"). */
export function readTenantOverride(): string | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(OVERRIDE_KEY);
  if (!raw || !isValidTenantSlug(raw)) return null;
  return raw;
}

/** Escribe el slug override en localStorage. Pasar null para limpiar. */
export function setTenantOverride(slug: string | null): void {
  if (typeof window === "undefined") return;
  if (slug && isValidTenantSlug(slug)) {
    window.localStorage.setItem(OVERRIDE_KEY, slug);
  } else {
    window.localStorage.removeItem(OVERRIDE_KEY);
  }
}

export interface UseTenantResult {
  tenant: Tenant | null;
  loading: boolean;
  /** "missing_tenant" si el profile no tiene tenant asignado (transitorio);
   *  "override_not_found" si el slug en localStorage no existe;
   *  null en happy path. */
  error: "missing_tenant" | "override_not_found" | "load_error" | null;
  /** Refetch manual del tenant (ej. después de que SuperAdmin cambia override). */
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

      // SuperAdmin override: si el rol incluye SuperAdmin y hay slug en
      // localStorage, lo resolvemos primero.
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
        } else if (!data) {
          setError("override_not_found");
          setTenant(null);
        } else {
          setTenant(data as Tenant);
        }
        setLoading(false);
        return;
      }

      // Camino normal: tenant del profile.
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

  return { tenant, loading, error, refresh: () => setNonce((n) => n + 1) };
}
