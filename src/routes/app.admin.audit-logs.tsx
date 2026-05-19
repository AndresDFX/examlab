import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { AuditLogsView } from "@/modules/admin/AuditLogsView";

export const Route = createFileRoute("/app/admin/audit-logs")({
  component: AdminAuditLogs,
});

function AdminAuditLogs() {
  const { roles } = useAuth();
  if (!roles.includes("Admin")) {
    return <p className="text-muted-foreground p-8">Necesitas rol Admin.</p>;
  }
  return <AuditLogsView mode="admin" />;
}
