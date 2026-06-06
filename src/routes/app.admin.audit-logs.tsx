/**
 * Auditoría (Admin / SuperAdmin) — combina los logs de auditoría
 * cronológicos con el panel de Errores agrupados por fingerprint.
 *
 * Antes vivían en módulos separados (`/app/admin/audit-logs` y
 * `/app/admin/errors`) con dos items en el sidebar. Se unificaron acá
 * para que la gestión de eventos del sistema (logs + errores) viva en
 * un solo lugar. La ruta `/app/admin/errors` queda como redirect a
 * `/app/admin/audit-logs?tab=errors` por compat de URLs viejas.
 *
 * AuditLogsView trae su propio wrapper con padding y max-width — la
 * tab "logs" lo renderiza directo. La tab "errors" replica ese mismo
 * wrapper para mantener la composición visual consistente entre tabs.
 */
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Shield, AlertTriangle } from "lucide-react";
import { AuditLogsView } from "@/modules/admin/AuditLogsView";
import { ErrorsPanel } from "@/modules/admin/ErrorsPanel";

type AuditTab = "logs" | "errors";

export const Route = createFileRoute("/app/admin/audit-logs")({
  component: AdminAuditLogs,
  validateSearch: (search: Record<string, unknown>): { tab?: AuditTab } => {
    const raw = search?.tab;
    if (raw === "errors" || raw === "logs") return { tab: raw };
    return {};
  },
});

function AdminAuditLogs() {
  const { roles } = useAuth();
  const { t } = useTranslation();
  const search = useSearch({ from: "/app/admin/audit-logs" });
  const initialTab: AuditTab = search.tab ?? "logs";

  if (!roles.includes("Admin") && !roles.includes("SuperAdmin")) {
    return <p className="text-muted-foreground p-8">Necesitas rol Admin o SuperAdmin.</p>;
  }

  return (
    <div className="p-4 sm:p-6 max-w-screen-xl mx-auto">
      <Tabs defaultValue={initialTab}>
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="logs" className="gap-1.5">
            <Shield className="h-3.5 w-3.5" />
            {t("audit.title", { defaultValue: "Auditoría" })}
          </TabsTrigger>
          <TabsTrigger value="errors" className="gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-rose-500" />
            Errores
          </TabsTrigger>
        </TabsList>
        {/* AuditLogsView trae su propio `<div className="p-4 sm:p-6 max-w-screen-xl ...">`.
            Al renderizarlo dentro de un wrapper que ya tiene esos paddings,
            el padding interior se duplica. Lo neutralizamos con `-mx-4 sm:-mx-6
            -mt-4 sm:-mt-6` para cancelar el padding del wrapper exterior y
            que el componente "ocupe" el espacio como en la versión solo-logs. */}
        <TabsContent value="logs" className="mt-4 -mx-4 sm:-mx-6 -mb-4 sm:-mb-6">
          <AuditLogsView mode="admin" />
        </TabsContent>
        <TabsContent value="errors" className="mt-4">
          <ErrorsPanel embedded />
        </TabsContent>
      </Tabs>
    </div>
  );
}
