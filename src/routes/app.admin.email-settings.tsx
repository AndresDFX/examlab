/**
 * Ruta legacy /app/admin/email-settings — sigue funcionando para
 * bookmarks existentes, pero la configuración vive ahora en
 * /app/admin/settings (tab Correos).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader } from "@/components/ui/page-header";
import { Mail } from "lucide-react";
import { AdminEmailSettingsPanel } from "@/modules/admin/AdminEmailSettingsPanel";

export const Route = createFileRoute("/app/admin/email-settings")({
  component: AdminEmailSettings,
});

function AdminEmailSettings() {
  const { roles } = useAuth();
  if (!roles.includes("Admin")) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-muted-foreground">Necesitas rol Admin.</p>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-6 p-4 sm:p-6">
      <PageHeader
        icon={<Mail className="h-6 w-6" />}
        title="Configuración de correos"
        subtitle="Activa o desactiva el envío de correos por categoría."
      />
      <AdminEmailSettingsPanel />
    </div>
  );
}
