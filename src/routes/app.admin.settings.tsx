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
 *   - Institución:   branding + certificados. (La estructura académica —
 *                    carreras/asignaturas/periodos — vive en /app/admin/academic.)
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
import { AdminMyTenantPanel } from "@/modules/admin/AdminMyTenantPanel";

export const Route = createFileRoute("/app/admin/settings")({ component: AdminSettings });

function AdminSettings() {
  const { t } = useTranslation();
  const { roles, loading: authLoading } = useAuth();
  const activeRole = useActiveRole();
  const isAdmin = roles.includes("Admin") || roles.includes("SuperAdmin");
  // SuperAdmin cross-tenant: este panel está pensado para configurar UNA
  // institución (branding, programas, periodos, etc.). Cuando el
  // SuperAdmin no eligió una vía "Ver como X", redirige a Instituciones.
  const isSuperAdminCrossTenant =
    roles.includes("SuperAdmin") && activeRole === "SuperAdmin" && readTenantOverride() === null;

  if (authLoading) return null;
  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  // SuperAdmin cross-tenant: en lugar de bloquear toda la página, mostramos
  // SOLO las tabs que son verdaderamente PLATAFORMA-GLOBAL (las tablas no
  // tienen `tenant_id` y guardan una única fila para todo el deploy):
  //   - Módulos       (module_visibility)        — orden + visibilidad del sidebar
  //   - Compilador    (code_execution_settings)  — proveedor del runner de código
  //   - Auditoría     (audit_retention_settings) — retención de audit_logs (singleton)
  //
  // Las tabs per-tenant (Generales, Institución, Correos, Modelo IA) quedan
  // detrás del flujo "Ver como esta institución" desde /app/superadmin/tenants
  // porque dependen del tenant activo. El banner las explica.
  //
  // El acceso de escritura para un SuperAdmin puro (sin rol Admin) se habilitó
  // en la migración 20260714000000_global_settings_super_admin_access.sql, que
  // agregó `OR is_super_admin()` a las policies de write de esas 3 tablas.
  if (isSuperAdminCrossTenant) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<Settings className="h-6 w-6 text-indigo-500" />}
          title="Configuración"
          subtitle="Configuración global de la plataforma."
        />

        <Card>
          <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0 space-y-1">
              <p className="text-sm font-medium">Configuración por institución</p>
              <p className="text-xs text-muted-foreground">
                Branding, correos, modelo IA y otros ajustes son por institución. Entrá a una
                institución con "Ver como esta institución" para configurarlos. Acá solo aparece la
                configuración global de la plataforma.
              </p>
            </div>
            <Link
              to="/app/superadmin/tenants"
              className="inline-flex shrink-0 items-center justify-center rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t("superAdmin.goToTenants")}
            </Link>
          </CardContent>
        </Card>

        <Tabs defaultValue="modules">
          <TabsList className="flex flex-wrap h-auto justify-start gap-1">
            <TabsTrigger value="modules" className="gap-1.5">
              <Layers className="h-3.5 w-3.5" />
              Módulos
            </TabsTrigger>
            <TabsTrigger value="compiler" className="gap-1.5">
              <Code2 className="h-3.5 w-3.5" />
              Compilador
            </TabsTrigger>
            <TabsTrigger value="audit" className="gap-1.5">
              <ScrollText className="h-3.5 w-3.5" />
              Auditoría
            </TabsTrigger>
          </TabsList>
          <TabsContent value="modules" className="space-y-4 mt-4">
            <AdminModuleVisibilityPanel />
          </TabsContent>
          <TabsContent value="compiler" className="space-y-4 mt-4">
            <AdminCodeExecutionPanel />
          </TabsContent>
          <TabsContent value="audit" className="space-y-4 mt-4">
            <AdminAuditRetentionPanel />
          </TabsContent>
        </Tabs>
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
          {/* Branding institucional + certificados. La estructura académica
              (carreras / asignaturas / periodos) se movió a su módulo propio
              /app/admin/academic para darle visibilidad en el sidebar. */}
          <AdminMyTenantPanel />
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
