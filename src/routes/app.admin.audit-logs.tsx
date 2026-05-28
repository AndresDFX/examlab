import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { AuditLogsView } from "@/modules/admin/AuditLogsView";

export const Route = createFileRoute("/app/admin/audit-logs")({
  component: AdminAuditLogs,
});

function AdminAuditLogs() {
  const { roles } = useAuth();
  // SuperAdmin hereda la ruta /app/admin/* (mismo patrón que el resto de
  // módulos compartidos). Antes solo dejaba pasar a `Admin` y bloqueaba al
  // SuperAdmin con "Necesitas rol Admin" — inconsistente con Usuarios,
  // Cursos, Errores, Cola, etc.
  if (!roles.includes("Admin") && !roles.includes("SuperAdmin")) {
    return <p className="text-muted-foreground p-8">Necesitas rol Admin o SuperAdmin.</p>;
  }
  return <AuditLogsView mode="admin" />;
}
