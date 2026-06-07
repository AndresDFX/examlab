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
import { useAuth } from "@/hooks/use-auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Database, KeyRound, Wrench, ShieldEllipsis, Settings2 } from "lucide-react";
import { AdminEdgeSecretsPanel } from "@/modules/admin/AdminEdgeSecretsPanel";
import { SystemDiagnosticsPanel } from "@/modules/admin/SystemDiagnosticsPanel";
import { DbBackupsPanel } from "@/modules/admin/DbBackupsPanel";
import { PlatformSettingsPanel } from "@/modules/superadmin/PlatformSettingsPanel";
import { SectionLoader } from "@/components/ui/loaders";

export const Route = createFileRoute("/app/superadmin/system")({
  component: SuperAdminSystem,
});

function SuperAdminSystem() {
  const { roles, loading } = useAuth();
  if (loading) return <SectionLoader text="Cargando…" />;
  if (!roles.includes("SuperAdmin")) return <Navigate to="/app" />;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ShieldEllipsis className="h-6 w-6 text-rose-500" />}
        title="Sistema"
        subtitle="Infraestructura de plataforma — exclusivo SuperAdmin."
      />

      <Tabs defaultValue="platform">
        <TabsList className="flex flex-wrap h-auto justify-start gap-1">
          <TabsTrigger value="platform" className="gap-1.5">
            <Settings2 className="h-3.5 w-3.5" />
            Plataforma
          </TabsTrigger>
          <TabsTrigger value="backups" className="gap-1.5">
            <Database className="h-3.5 w-3.5" />
            Backups
          </TabsTrigger>
          <TabsTrigger value="system" className="gap-1.5">
            <Wrench className="h-3.5 w-3.5" />
            Diagnósticos
          </TabsTrigger>
          <TabsTrigger value="secrets" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />
            Secretos infra
          </TabsTrigger>
        </TabsList>
        <TabsContent value="platform" className="space-y-4 mt-4">
          <PlatformSettingsPanel />
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
