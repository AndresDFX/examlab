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

/**
 * TTL del override en ms. Si el SuperAdmin dejó "Ver como X" activo y
 * pasaron más de 60 min sin tocarlo, lo descartamos al leer.
 *
 * Por qué: olvidarse del override es fácil (cerrar tab, irse a almorzar,
 * volver). Sin TTL el branding del último tenant visto puede persistir
 * indefinidamente, lo cual es UX confusa (¿soy yo o estoy viendo como X?).
 * No es control de seguridad — la RLS ya bloquea acceso real cross-tenant
 * para non-SuperAdmin; y para SuperAdmin el override es legítimo. Es un
 * nudge para que el modo "ver como" no se pegue.
 */
const OVERRIDE_TTL_MS = 60 * 60 * 1000;

interface StoredOverride {
  slug: string;
  /** epoch ms cuando se setteó / refrescó. */
  ts: number;
}

function parseStored(raw: string | null): StoredOverride | null {
  if (!raw) return null;
  // Soporte retro: si vino el slug "pelado" (versión vieja), lo aceptamos
  // sin TTL y migramos al setear de nuevo. Evita romper sesiones activas.
  if (isValidTenantSlug(raw)) return { slug: raw, ts: Date.now() };
  try {
    const obj = JSON.parse(raw) as Partial<StoredOverride>;
    if (typeof obj.slug === "string" && isValidTenantSlug(obj.slug) && typeof obj.ts === "number") {
      return { slug: obj.slug, ts: obj.ts };
    }
  } catch {
    // Basura — caemos al null.
  }
  return null;
}

/**
 * Lee el slug override desde localStorage (SuperAdmin "ver como").
 * Si pasaron más de `OVERRIDE_TTL_MS` desde el último set, expira: limpia
 * el storage y devuelve null.
 */
export function readTenantOverride(): string | null {
  if (typeof window === "undefined") return null;
  const stored = parseStored(window.localStorage.getItem(OVERRIDE_KEY));
  if (!stored) return null;
  if (Date.now() - stored.ts > OVERRIDE_TTL_MS) {
    window.localStorage.removeItem(OVERRIDE_KEY);
    return null;
  }
  return stored.slug;
}

/** Escribe el slug override en localStorage. Pasar null para limpiar. */
export function setTenantOverride(slug: string | null): void {
  if (typeof window === "undefined") return;
  if (slug && isValidTenantSlug(slug)) {
    const payload: StoredOverride = { slug, ts: Date.now() };
    window.localStorage.setItem(OVERRIDE_KEY, JSON.stringify(payload));
  } else {
    window.localStorage.removeItem(OVERRIDE_KEY);
  }
  // Notificamos a useTenant() hooks montados en la misma pestaña.
  // localStorage 'storage' event solo dispara en OTRAS pestañas; para
  // refresh dentro de la misma pestaña usamos un CustomEvent custom.
  window.dispatchEvent(new CustomEvent("examlab:tenant-override-changed"));
}

/**
 * Clears the override sin notificar (para usar cuando ya estás en un
 * effect que va a re-resolver el tenant igual, evita doble fetch).
 * Útil para `TenantOverrideBanner` cuando detecta que el slug es inválido.
 */
export function clearTenantOverrideSilent(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(OVERRIDE_KEY);
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
          setLoading(false);
          return;
        }
        if (!data) {
          // Override stale (renombrado / eliminado). Limpiamos silencioso
          // y caemos al camino normal (tenant del profile) en el próximo
          // tick — evita dejar el branding pegado en un slug inválido.
          clearTenantOverrideSilent();
          setError("override_not_found");
          // No retornamos acá — seguimos al fallback de profile.tenant_id
          // dentro de la misma corrida del effect.
        } else {
          setTenant(data as Tenant);
          setLoading(false);
          return;
        }
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

  // Reacciona cuando otro componente llama setTenantOverride (ej. el
  // SuperAdmin clica "Ver como"). Sin esto, el branding del sidebar no
  // se actualizaba hasta refrescar la página.
  useEffect(() => {
    const handler = () => setNonce((n) => n + 1);
    window.addEventListener("examlab:tenant-override-changed", handler);
    // También escuchamos 'storage' por si el override cambió en OTRA
    // pestaña — útil para mantener consistencia cross-tab.
    window.addEventListener("storage", handler);
    return () => {
      window.removeEventListener("examlab:tenant-override-changed", handler);
      window.removeEventListener("storage", handler);
    };
  }, []);

  return { tenant, loading, error, refresh: () => setNonce((n) => n + 1) };
}
