/**
 * Ruta splat /t/<slug>/<resto> — captura todo lo que venga después
 * del prefijo de tenant.
 *
 * Hace exactamente lo mismo que /t/<slug> pero preservando el path
 * destino. Ej:
 *   /t/acme/app/teacher/courses → setea override (si SuperAdmin) +
 *                                  redirige a /app/teacher/courses
 *
 * Sin esta ruta, /t/acme/app/* devuelve 404 (TanStack no tiene rutas
 * literales con prefijo /t/).
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useAuth } from "@/hooks/use-auth";
import { setTenantOverride } from "@/modules/tenants/use-tenant";
import { isValidTenantSlug } from "@/modules/tenants/tenant";
import { SectionLoader } from "@/components/ui/loaders";

export const Route = createFileRoute("/t/$slug/$")({
  component: TenantSlugSplatEntry,
});

function TenantSlugSplatEntry() {
  const { slug, _splat } = Route.useParams();
  const { roles, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (isValidTenantSlug(slug) && roles.includes("SuperAdmin")) {
      setTenantOverride(slug);
    }
  }, [loading, roles, slug]);

  if (loading) return <SectionLoader text="Cargando institución…" />;
  // El splat trae el path después de /t/<slug>/. Construimos el destino
  // anteponiendo "/". Si _splat viene vacío, fallback a /app.
  const target = _splat && _splat.length > 0 ? `/${_splat}` : "/app";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return <Navigate to={target as any} replace />;
}
