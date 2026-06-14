import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { AuditLogsView } from "@/modules/admin/AuditLogsView";
import { isStaffRole } from "@/shared/lib/roles";

export const Route = createFileRoute("/app/teacher/audit-logs")({
  component: TeacherAuditLogs,
});

function TeacherAuditLogs() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  // SA accede a pantallas Docente para soporte / diagnóstico — sin SA
  // en el set, recibía "Necesitas rol Docente" silencioso al entrar.
  if (!isStaffRole(roles)) {
    return <p className="text-muted-foreground p-4 sm:p-8">{t("hc_routesAppTeacherAuditLogs.needTeacherRole")}</p>;
  }
  return <AuditLogsView mode="teacher" />;
}
