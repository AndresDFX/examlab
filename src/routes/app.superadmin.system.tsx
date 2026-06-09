/**
 * SuperAdmin → Sistema.
 *
 * Tabs exclusivas del dueño de la plataforma:
 *   - Backups:  snapshots lógicos de la BD (manual + cron semanal).
 *   - Sistema:  diagnósticos generales (storage, edge functions, etc.).
 *   - Secretos: keys de servicios externos manejadas a nivel infra
 *               (Lovable AI, Resend, etc.). Los Admins ya no las ven
 *               porque cada tenant gestiona SUS propias keys en
 *               Configuración → Modelo IA.
 *
 * Las tabs operativas del Admin de cada tenant (Generales, Institución,
 * Correos, Compilador, Modelo IA, Cola IA, Auditoría, Módulos) viven en
 * /app/admin/settings.
 */
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Database, KeyRound, Wrench, ShieldEllipsis, Settings2, Mail } from "lucide-react";
import { AdminEdgeSecretsPanel } from "@/modules/admin/AdminEdgeSecretsPanel";
import { SystemDiagnosticsPanel } from "@/modules/admin/SystemDiagnosticsPanel";
import { DbBackupsPanel } from "@/modules/admin/DbBackupsPanel";
import { PlatformSettingsPanel } from "@/modules/superadmin/PlatformSettingsPanel";
import { AdminEmailSettingsPanel } from "@/modules/admin/AdminEmailSettingsPanel";
import { SectionLoader } from "@/components/ui/loaders";

export const Route = createFileRoute("/app/superadmin/system")({
  component: SuperAdminSystem,
});

function SuperAdminSystem() {
  const { t } = useTranslation();
  const { roles, loading } = useAuth();
  if (loading) return <SectionLoader text="Cargando…" />;
  if (!roles.includes("SuperAdmin")) return <Navigate to="/app" />;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ShieldEllipsis className="h-6 w-6 text-rose-500" />}
        title={t("superadminSystem.title")}
        subtitle={t("superadminSystem.subtitle")}
      />

      <Tabs defaultValue="platform">
        <TabsList className="flex flex-wrap h-auto justify-start gap-1">
          <TabsTrigger value="platform" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" />
            {t("superadminSystem.tabPlatform")}
          </TabsTrigger>
          <TabsTrigger value="emails" className="gap-1.5">
            <Mail className="h-3.5 w-3.5" />
            {t("superadminSystem.tabEmails")}
          </TabsTrigger>
          <TabsTrigger value="backups" className="gap-1.5">
            <Database className="h-3.5 w-3.5" />
            {t("superadminSystem.tabBackups")}
          </TabsTrigger>
          <TabsTrigger value="system" className="gap-1.5">
            <Wrench className="h-3.5 w-3.5" />
            {t("superadminSystem.tabSystem")}
          </TabsTrigger>
          <TabsTrigger value="secrets" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />
            {t("superadminSystem.tabSecrets")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="platform" className="space-y-4 mt-4">
          <PlatformSettingsPanel />
        </TabsContent>
        <TabsContent value="emails" className="space-y-4 mt-4">
          {/* Mismo panel que el Admin del tenant ve en /app/admin/settings.
              Edita la fila global de email_settings (id=1) que aplica a
              TODA la plataforma. El SA ahora puede toggle kinds de email
              cross-tenant sin tener que cambiar de rol. */}
          <AdminEmailSettingsPanel />
        </TabsContent>
        <TabsContent value="backups" className="space-y-4 mt-4">
          <DbBackupsPanel />
        </TabsContent>
        <TabsContent value="system" className="space-y-4 mt-4">
          <SystemDiagnosticsPanel />
        </TabsContent>
        <TabsContent value="secrets" className="space-y-4 mt-4">
          <AdminEdgeSecretsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
