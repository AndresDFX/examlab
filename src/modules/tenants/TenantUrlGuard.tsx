/**
 * TenantUrlGuard — asegura que las rutas `/app/...` SIEMPRE tengan
 * prefijo `/t/<slug>` correcto en la URL.
 *
 * Reemplazo del guard viejo, que stripeaba el prefijo. Ahora hace lo
 * inverso: si el usuario llega a `/app/...` sin prefijo, lo redirige a
 * `/t/<userTenantSlug>/app/...`. Si llega a `/t/<otherSlug>/app/...`
 * con un tenant que NO es el suyo (y no es SuperAdmin), lo redirige a
 * `/t/<userTenantSlug>/app/...`.
 *
 * Casos cubiertos:
 *   - Usuario navega manualmente a `/app/admin/users` → redirige a
 *     `/t/<su-slug>/app/admin/users` (full reload para re-init router
 *     con basepath nuevo).
 *   - SuperAdmin navega a `/app/admin/users` SIN prefijo → permitido
 *     (modo cross-tenant).
 *   - User normal de tenant A entra a `/t/B/app/...` → redirige a
 *     `/t/A/app/...`. La RLS igual lo bloquearía pero la UI quedaría
 *     en estado vacío confuso; el redirect previene eso.
 *   - URL `/auth` o `/` → no toca nada.
 *   - Sesión sin tenant (transitorio post-creación) → no toca nada;
 *     se resuelve cuando el profile se carga.
 *
 * El componente no renderiza nada. Se monta en `__root` después del
 * loader de auth.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { getTenantSlugFromUrl, hardNavigateToTenant } from "@/modules/tenants/url";

export function TenantUrlGuard() {
  const { profile, roles, loading, user } = useAuth();
  // Cache local del slug del tenant del profile. Una sola query
  // por sesión; se invalida cuando cambia `profile?.tenant_id`.
  const [profileSlug, setProfileSlug] = useState<string | null>(null);

  // Resolver el slug del tenant del profile (solo tenemos `tenant_id`).
  useEffect(() => {
    if (loading) return;
    if (!profile?.tenant_id) {
      setProfileSlug(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("tenants")
        .select("slug")
        .eq("id", profile.tenant_id)
        .maybeSingle();
      if (cancelled) return;
      const slug = (data as { slug?: string } | null)?.slug ?? null;
      setProfileSlug(slug);
    })();
    return () => {
      cancelled = true;
    };
  }, [loading, profile?.tenant_id]);

  // Decidir si hay que redirigir.
  useEffect(() => {
    if (loading) return;
    if (typeof window === "undefined") return;
    // Sin sesión → no podemos saber el tenant; el login se encarga.
    if (!user) return;

    const path = window.location.pathname;
    // Rutas que NO deben tener prefijo de tenant.
    if (path === "/" || path.startsWith("/auth")) return;
    // Solo nos preocupan rutas dentro del app.
    if (!path.startsWith("/app") && !path.startsWith("/t/")) return;

    const urlSlug = getTenantSlugFromUrl();
    const isSuperAdmin = roles.includes("SuperAdmin");

    // Diagnóstico: el usuario reportó loops post-impersonación con
    // sospecha de que el slug URL no se aplica. Este log nos da
    // visibilidad de qué decisión toma el guard en cada render.
    // eslint-disable-next-line no-console
    console.info("[TenantUrlGuard]", {
      path,
      urlSlug,
      profileSlug,
      isSuperAdmin,
      roles,
    });

    // Caso 1: SuperAdmin sin prefijo en /app → modo cross-tenant, OK.
    if (!urlSlug && isSuperAdmin) return;

    // Caso 2: User regular sin prefijo en /app → forzar prefijo al suyo.
    if (!urlSlug && !isSuperAdmin) {
      if (!profileSlug) return; // Profile aún cargando; reintentamos en otro tick.
      // Path completo (con `/app/...`) se preserva. `hardNavigateToTenant`
      // recompila el URL con prefijo + path actual.
      hardNavigateToTenant(profileSlug, path);
      return;
    }

    // Caso 3: Slug presente pero NO matchea el profile + no es SuperAdmin
    //         → redirige al tenant del profile (la RLS igual bloquea
    //           data, evitamos UI vacía y confusión).
    if (urlSlug && !isSuperAdmin && profileSlug && urlSlug !== profileSlug) {
      // Strip el prefijo viejo (lo agregamos de nuevo con el slug correcto).
      const stripped = path.replace(/^\/t\/[^/]+/, "") || "/app";
      hardNavigateToTenant(profileSlug, stripped);
      return;
    }

    // Caso 4: SuperAdmin con prefijo → permitido (modo "ver como").
    // Caso 5: User regular con prefijo que matchea → todo bien.
  }, [loading, user, roles, profileSlug]);

  return null;
}
