import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/ui/page-header";
import { SystemDiagnosticsPanel } from "@/modules/admin/SystemDiagnosticsPanel";
import { Wrench } from "lucide-react";

export const Route = createFileRoute("/app/admin/system")({
  component: AdminSystem,
});

// Pagina de utilidades de admin para inspeccionar la infraestructura
// externa (Supabase, edge functions, secrets, etc.). NO datos
// academicos.
//
// La logica de los chequeos vive en SystemDiagnosticsPanel — los cards
// se actualizan en paralelo cuando el admin click "Refrescar".
function AdminSystem() {
  const { t } = useTranslation();
  return (
    <div className="container mx-auto space-y-6 p-4 sm:p-6">
      <PageHeader
        icon={<Wrench className="h-6 w-6" />}
        title={t("adminSystem.pageTitle", { defaultValue: "Sistema" })}
        subtitle={t("adminSystem.pageSubtitle", {
          defaultValue:
            "Diagnóstico de la infraestructura externa (DB, edge functions, IA, push, storage, auth)",
        })}
      />
      <SystemDiagnosticsPanel />
    </div>
  );
}
