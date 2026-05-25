/**
 * Ruta /t/<slug> — punto de entrada por URL del tenant.
 *
 * El `TenantUrlGuard` global ya intenta strippear el prefijo via
 * `replaceState`, pero corre DESPUÉS de que el router de TanStack
 * resuelve la ruta. Sin un componente que matchee `/t/<slug>`, el
 * router devuelve 404 antes que el guard tenga oportunidad.
 *
 * Por eso registramos esta ruta + el splat `t.$slug.$.tsx` que cubren:
 *   /t/<slug>           → redirect a /app (con override si SuperAdmin)
 *   /t/<slug>/<resto>   → redirect a /<resto>
 *
 * El componente renderiza un SectionLoader mientras la redirección
 * ocurre para evitar flash de pantalla en blanco.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { setTenantOverride } from "@/modules/tenants/use-tenant";
import { isValidTenantSlug } from "@/modules/tenants/tenant";
import { SectionLoader } from "@/components/ui/loaders";

export const Route = createFileRoute("/t/$slug")({
  component: TenantSlugEntry,
});

function TenantSlugEntry() {
  const { slug } = Route.useParams();
  const { roles, loading } = useAuth();

  useEffect(() => {
    // Setear override solo si SuperAdmin Y slug válido. Para users
    // normales el override no aplica (RLS los aisla a su tenant real),
    // pero igual seguimos redirigiendo a /app para que la URL quede limpia.
    if (loading) return;
    if (isValidTenantSlug(slug) && roles.includes("SuperAdmin")) {
      setTenantOverride(slug);
    }
  }, [loading, roles, slug]);

  if (loading) return <SectionLoader text="Cargando institución…" />;
  // Navigate de TanStack — redirige al dashboard sin agregar entrada al
  // history.
  return <Navigate to="/app" replace />;
}
