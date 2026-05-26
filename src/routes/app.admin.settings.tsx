/**
 * Configuración de la institución (Admin).
 *
 * Tabs operativos del Admin de un tenant. Las tabs de infra-platforma
 * (Backups, Sistema, Secretos infra) viven en /app/superadmin/system —
 * son responsabilidad del dueño de la plataforma, no del Admin de
 * una institución individual.
 *
 * Tabs:
 *   - Generales:     defaults de cursos/exámenes + alerta de volumen de correos.
 *   - Institución:   branding + programas + asignaturas + periodos + certificados.
 *   - Correos:       kill switch global + toggles por categoría de email.
 *   - Compilador:    proveedor de ejecución de código.
 *   - Modelo IA:     provider/modelo + API keys per-tenant (Gemini/OpenAI/Lovable).
 *   - Cola IA:       modo sync/async + códigos override.
 *   - Auditoría:     retención de audit_logs por severidad.
 *   - Módulos:       visibilidad por rol.
 *
 * Movidas a SuperAdmin (/app/superadmin/system):
 *   - Backups, Sistema, Secretos infra.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { readTenantOverride } from "@/modules/tenants/use-tenant";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Settings,
  Mail,
  Code2,
  ScrollText,
  Sliders,
  Layers,
  Cpu,
  GraduationCap,
} from "lucide-react";
import { AdminEmailSettingsPanel } from "@/modules/admin/AdminEmailSettingsPanel";
import { AdminCodeExecutionPanel } from "@/modules/admin/AdminCodeExecutionPanel";
import { AdminAuditRetentionPanel } from "@/modules/admin/AdminAuditRetentionPanel";
import { AdminGeneralSettingsPanel } from "@/modules/admin/AdminGeneralSettingsPanel";
import { AdminCertificateSettingsPanel } from "@/modules/admin/AdminCertificateSettingsPanel";
import { AdminModuleVisibilityPanel } from "@/modules/admin/AdminModuleVisibilityPanel";
import { AdminModelPanel } from "@/modules/admin/AdminModelPanel";
import { AdminAcademicProgramsPanel } from "@/modules/admin/AdminAcademicProgramsPanel";
import { AdminAcademicPeriodsPanel } from "@/modules/admin/AdminAcademicPeriodsPanel";
import { AdminAcademicSubjectsPanel } from "@/modules/admin/AdminAcademicSubjectsPanel";
import { AdminProgramOverviewPanel } from "@/modules/admin/AdminProgramOverviewPanel";
import { AdminMyTenantPanel } from "@/modules/admin/AdminMyTenantPanel";

export const Route = createFileRoute("/app/admin/settings")({ component: AdminSettings });

function AdminSettings() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const isAdmin = roles.includes("Admin") || roles.includes("SuperAdmin");
  // SuperAdmin cross-tenant: este panel está pensado para configurar UNA
  // institución (branding, programas, periodos, etc.). Cuando el
  // SuperAdmin no eligió una vía "Ver como X", redirige a Instituciones.
  const isSuperAdminCrossTenant =
    roles.includes("SuperAdmin") &&
    activeRole === "SuperAdmin" &&
    readTenantOverride() === null;

  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  if (isSuperAdminCrossTenant) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<Settings className="h-6 w-6 text-indigo-500" />}
          title="Configuración"
          subtitle="Configuración por institución."
        />
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-sm font-medium">{t("superAdmin.crossTenantTitle")}</p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              {t("superAdmin.crossTenantSettingsHint")}
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
    <div className="space-y-5">
      <PageHeader
        icon={<Settings className="h-6 w-6 text-indigo-500" />}
        title="Configuración"
        subtitle="Parámetros operativos de tu institución."
      />

      <Tabs defaultValue="general">
        {/* Tabs en flex-wrap + h-auto: caben en 1-2 filas según viewport,
            sin scroll horizontal. */}
        <TabsList className="flex flex-wrap h-auto justify-start gap-1">
          <TabsTrigger value="general" className="gap-1.5">
            <Sliders className="h-3.5 w-3.5" />
            Generales
          </TabsTrigger>
          {/* "Institución" agrupa toda la configuración educativa:
              programas/niveles, asignaturas, periodos, certificaciones.
              Diseñado para ser neutral entre universidad, instituto
              técnico, colegio o academia — el modelo subyacente es
              flexible (todos los campos son opcionales). */}
          <TabsTrigger value="institution" className="gap-1.5">
            <GraduationCap className="h-3.5 w-3.5" />
            Institución
          </TabsTrigger>
          <TabsTrigger value="email" className="gap-1.5">
            <Mail className="h-3.5 w-3.5" />
            Correos
          </TabsTrigger>
          <TabsTrigger value="compiler" className="gap-1.5">
            <Code2 className="h-3.5 w-3.5" />
            Compilador
          </TabsTrigger>
          <TabsTrigger value="ai-model" className="gap-1.5">
            <Cpu className="h-3.5 w-3.5" />
            Modelo IA
          </TabsTrigger>
          {/* La tab 'Cola IA' (sync/async + códigos override) se movió al
              módulo Cron del sidebar. Ahí se centralizan todas las colas
              (IA + procesamiento de mensajes) en un solo lugar. */}
          <TabsTrigger value="audit" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            Auditoría
          </TabsTrigger>
          <TabsTrigger value="modules" className="gap-1.5">
            <Layers className="h-3.5 w-3.5" />
            Módulos
          </TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="space-y-4 mt-4">
          <AdminGeneralSettingsPanel />
        </TabsContent>
        <TabsContent value="institution" className="space-y-4 mt-4">
          {/* Orden intencional: branding institucional primero (lo que
              el Admin edita cuando "configura su institución"), luego
              resumen integral, luego CRUDs académicos específicos. */}
          <AdminMyTenantPanel />
          <AdminProgramOverviewPanel />
          <AdminAcademicProgramsPanel />
          <AdminAcademicSubjectsPanel />
          <AdminAcademicPeriodsPanel />
          <AdminCertificateSettingsPanel />
        </TabsContent>
        <TabsContent value="email" className="space-y-4 mt-4">
          <AdminEmailSettingsPanel />
        </TabsContent>
        <TabsContent value="compiler" className="space-y-4 mt-4">
          <AdminCodeExecutionPanel />
        </TabsContent>
        <TabsContent value="ai-model" className="space-y-4 mt-4">
          <AdminModelPanel />
        </TabsContent>
        <TabsContent value="audit" className="space-y-4 mt-4">
          <AdminAuditRetentionPanel />
        </TabsContent>
        <TabsContent value="modules" className="space-y-4 mt-4">
          <AdminModuleVisibilityPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
