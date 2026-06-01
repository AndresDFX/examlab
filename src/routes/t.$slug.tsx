/**
 * Ruta legacy `/t/<slug>` — quedó del sistema viejo cuando el guard
 * stripeaba el prefijo del URL. Con la nueva arquitectura URL-driven,
 * el router se inicializa con `basepath: "/t/<slug>"` al boot, así que
 * esta ruta NUNCA matchea (TanStack ve `/`, no `/t/<slug>`).
 *
 * Mantenemos el archivo para evitar regenerar `routeTree.gen.ts` y por
 * si algún día el basepath no se aplica (ej. URL inválido) — devuelve
 * un componente no-op con redirect al index.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/t/$slug")({
  component: () => <Navigate to="/" replace />,
});
