/**
 * Redirect legacy: el módulo de Errores se unificó dentro de Auditoría.
 *
 * Antes: `/app/admin/errors` mostraba un panel propio con tiles de
 * conteo + grid agrupado por fingerprint. Mantenemos la URL viva para
 * que cualquier link/bookmark/notificación que apunte acá siga
 * funcionando — redirige a `/app/admin/audit-logs?tab=errors`, que
 * renderiza el mismo panel como una tab dentro de Auditoría.
 *
 * La lógica del panel vive en `src/modules/admin/ErrorsPanel.tsx`.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";

export const Route = createFileRoute("/app/admin/errors")({
  component: ErrorsRedirect,
});

function ErrorsRedirect() {
  return <Navigate to="/app/admin/audit-logs" search={{ tab: "errors" }} replace />;
}
