import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { AuditLogsView } from "@/modules/admin/AuditLogsView";

export const Route = createFileRoute("/app/teacher/audit-logs")({
  component: TeacherAuditLogs,
});

function TeacherAuditLogs() {
  const { roles } = useAuth();
  if (!roles.includes("Docente")) {
    return <p className="text-muted-foreground p-8">Necesitas rol Docente.</p>;
  }
  return <AuditLogsView mode="teacher" />;
}
