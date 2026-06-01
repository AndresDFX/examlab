/**
 * Ruta legacy `/t/<slug>/<resto>` — superseded por el router basepath
 * dinámico (ver `router.tsx`). Como el basepath ya consume el prefijo,
 * esta ruta no se alcanza. La dejamos como no-op fallback por si una
 * URL llega con slug inválido (que no matchea el regex de basepath).
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/t/$slug/$")({
  component: () => <Navigate to="/" replace />,
});
