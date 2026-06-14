/**
 * Ruta legacy /app/admin/email-settings — sigue funcionando para
 * bookmarks existentes, pero la configuración vive ahora en
 * /app/admin/settings (tab Correos).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { readTenantOverride } from "@/modules/tenants/use-tenant";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Mail } from "lucide-react";
import { AdminEmailSettingsPanel } from "@/modules/admin/AdminEmailSettingsPanel";

export const Route = createFileRoute("/app/admin/email-settings")({
  component: AdminEmailSettings,
});

function AdminEmailSettings() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  // SuperAdmin cross-tenant: el toggle de envío de correos es por
  // institución (singleton del tenant). Sin tenant elegido el panel no
  // tiene contexto — redirigimos a Instituciones, mismo patrón que
  // AdminMyTenantPanel y AdminSettings.
  const isSuperAdminCrossTenant =
    roles.includes("SuperAdmin") &&
    activeRole === "SuperAdmin" &&
    readTenantOverride() === null;

  if (!roles.includes("Admin") && !roles.includes("SuperAdmin")) {
    return (
      <div className="container mx-auto p-6">
        <p className="text-muted-foreground">{t("hc_routesAppAdminEmailSettings.needAdminRole")}</p>
      </div>
    );
  }

  if (isSuperAdminCrossTenant) {
    return (
      <div className="container mx-auto space-y-6 p-4 sm:p-6">
        <PageHeader
          icon={<Mail className="h-6 w-6" />}
          title={t("hc_routesAppAdminEmailSettings.title")}
          subtitle={t("hc_routesAppAdminEmailSettings.subtitleToggles")}
        />
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-sm font-medium">{t("superAdmin.crossTenantTitle")}</p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              {t("superAdmin.crossTenantEmailHint")}
            </p>
            <Link
              to="/app/superadmin/tenants"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("superAdmin.goToTenants")}
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-6 p-4 sm:p-6">
      <PageHeader
        icon={<Mail className="h-6 w-6" />}
        title={t("hc_routesAppAdminEmailSettings.title")}
        subtitle={t("hc_routesAppAdminEmailSettings.subtitleToggle")}
      />
      <AdminEmailSettingsPanel />
    </div>
  );
}
