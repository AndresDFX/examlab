/**
 * TenantUrlGuard — intercepta URLs `/t/<slug>/...` y las normaliza.
 *
 * Comportamiento al cargar (o al cambiar de pathname):
 *   1. Si el URL trae prefijo `/t/<slug>/` válido:
 *      - SuperAdmin: setea override de tenant en localStorage al slug del
 *        URL, luego strip del prefijo y replaceState al path sin /t/<slug>.
 *      - User normal: si el slug del URL coincide con su tenant, strip y
 *        replaceState (caso shareable link). Si NO coincide, también
 *        strip (rechazamos el cambio cross-tenant silenciosamente — el
 *        RLS ya garantiza que no podría leer datos del otro tenant).
 *   2. Si NO trae prefijo, no hacemos nada — la app funciona normal con
 *      el tenant del session.
 *
 * El componente NO renderiza nada visible. Se monta en __root entre los
 * providers y el Outlet. Es pura lógica de efecto.
 *
 * Por qué este enfoque y NO renombrar todas las rutas a `t.$slug.app.*.tsx`:
 *   - Renombrar 60+ archivos de ruta es alto riesgo + huge diff.
 *   - El aislamiento de datos ya está garantizado por DB (Fases 1-5).
 *   - El prefijo /t/<slug> es UI/UX (shareable, SuperAdmin context-switch),
 *     no requisito de seguridad.
 *   - Si en el futuro queremos URL-routing real (cada tenant con su árbol),
 *     migramos archivo por archivo sin presionar para el v1.
 */
import { useEffect } from "react";
import { decideTenantUrlAction } from "@/modules/tenants/tenant";
import { setTenantOverride } from "@/modules/tenants/use-tenant";
import { useAuth } from "@/hooks/use-auth";

export function TenantUrlGuard() {
  const { roles, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (typeof window === "undefined") return;

    const apply = () => {
      const action = decideTenantUrlAction(
        window.location.pathname,
        roles.includes("SuperAdmin"),
      );
      if (action.strippedPath === null) return;

      if (action.overrideSlug) {
        setTenantOverride(action.overrideSlug);
      }

      const url = new URL(window.location.href);
      url.pathname = action.strippedPath;
      // replaceState para no agregar entrada al history.
      window.history.replaceState({}, "", url.toString());
    };

    apply();
    // Si el user navega a otra URL con prefijo (ej. compartió un link),
    // re-evaluamos en popstate.
    const onPop = () => apply();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [loading, roles]);

  return null;
}
