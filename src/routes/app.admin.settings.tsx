/**
 * Configuración global (Admin).
 *
 * Módulo central para parámetros operativos de la plataforma.
 * Tabs:
 *   - Generales:     defaults de cursos/exámenes + alerta de volumen de correos.
 *   - Correos:       kill switch global + toggles por categoría de email.
 *   - Compilador:    proveedor de ejecución de código.
 *   - Cola:          modo sync/async + códigos override.
 *   - Auditoría:     retención de audit_logs por severidad.
 *   - Certificados:  parámetros del certificado de finalización.
 *   - Secretos:      keys de servicios externos (Lovable AI, Gemini, etc.).
 *   - Módulos:       visibilidad por rol.
 *   - Backups:       snapshots lógicos de la BD (manual + cron semanal).
 *   - Sistema:       diagnósticos generales (storage, edge functions, etc.).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import {
  Settings,
  Mail,
  Code2,
  ScrollText,
  Sliders,
  KeyRound,
  Layers,
  ListOrdered,
  Wrench,
  Database,
  GraduationCap,
} from "lucide-react";
import { AdminEmailSettingsPanel } from "@/modules/admin/AdminEmailSettingsPanel";
import { AdminCodeExecutionPanel } from "@/modules/admin/AdminCodeExecutionPanel";
import { AdminAuditRetentionPanel } from "@/modules/admin/AdminAuditRetentionPanel";
import { AdminGeneralSettingsPanel } from "@/modules/admin/AdminGeneralSettingsPanel";
import { AdminCertificateSettingsPanel } from "@/modules/admin/AdminCertificateSettingsPanel";
import { AdminEdgeSecretsPanel } from "@/modules/admin/AdminEdgeSecretsPanel";
import { AdminModuleVisibilityPanel } from "@/modules/admin/AdminModuleVisibilityPanel";
import { AdminAiGradingPanel } from "@/modules/admin/AdminAiGradingPanel";
import { SystemDiagnosticsPanel } from "@/modules/admin/SystemDiagnosticsPanel";
import { DbBackupsPanel } from "@/modules/admin/DbBackupsPanel";
import { AdminAcademicProgramsPanel } from "@/modules/admin/AdminAcademicProgramsPanel";
import { AdminAcademicPeriodsPanel } from "@/modules/admin/AdminAcademicPeriodsPanel";
import { AdminAcademicSubjectsPanel } from "@/modules/admin/AdminAcademicSubjectsPanel";
import { AdminProgramOverviewPanel } from "@/modules/admin/AdminProgramOverviewPanel";

export const Route = createFileRoute("/app/admin/settings")({ component: AdminSettings });

function AdminSettings() {
  const { roles } = useAuth();
  const isAdmin = roles.includes("Admin");

  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Settings className="h-6 w-6 text-indigo-500" />}
        title="Configuración"
        subtitle="Parámetros operativos de la plataforma."
      />

      <Tabs defaultValue="general">
        {/* Tabs en flex-wrap + h-auto: 10 pestañas no caben en una sola
            fila en monitores estándar, así que dejamos que envuelvan a
            varias filas en lugar de scroll horizontal. */}
        <TabsList className="flex flex-wrap h-auto justify-start gap-1">
          <TabsTrigger value="general" className="gap-1.5">
            <Sliders className="h-3.5 w-3.5" />
            Generales
          </TabsTrigger>
          {/* "Universidad" agrupa toda la configuración institucional:
              programas académicos, periodos, datos de la institución
              que aparecen en certificados/actas, y firmantes. La idea
              es que el admin tenga UN solo lugar para "configurar la
              universidad" en vez de 3 tabs separados. */}
          <TabsTrigger value="university" className="gap-1.5">
            <GraduationCap className="h-3.5 w-3.5" />
            Universidad
          </TabsTrigger>
          <TabsTrigger value="email" className="gap-1.5">
            <Mail className="h-3.5 w-3.5" />
            Correos
          </TabsTrigger>
          <TabsTrigger value="compiler" className="gap-1.5">
            <Code2 className="h-3.5 w-3.5" />
            Compilador
          </TabsTrigger>
          <TabsTrigger value="ai-grading" className="gap-1.5">
            <ListOrdered className="h-3.5 w-3.5" />
            Cola
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            Auditoría
          </TabsTrigger>
          <TabsTrigger value="secrets" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />
            Secretos
          </TabsTrigger>
          <TabsTrigger value="modules" className="gap-1.5">
            <Layers className="h-3.5 w-3.5" />
            Módulos
          </TabsTrigger>
          <TabsTrigger value="backups" className="gap-1.5">
            <Database className="h-3.5 w-3.5" />
            Backups
          </TabsTrigger>
          <TabsTrigger value="system" className="gap-1.5">
            <Wrench className="h-3.5 w-3.5" />
            Sistema
          </TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="space-y-4 mt-4">
          <AdminGeneralSettingsPanel />
        </TabsContent>
        <TabsContent value="university" className="space-y-4 mt-4">
          {/* Programas + Periodos + Certificaciones (datos de la
              institución como nombre, logo, firma, etc.). Todos cuelgan
              de "la Universidad" — el docente nunca los toca, son del
              Admin. Mantener cards separados pero bajo el mismo tab
              evita que el admin tenga que saltar entre 'Académico' y
              'Certificaciones' para configurar cosas relacionadas. */}
          {/* Orden intencional: resumen integral primero (vista de salud
              institucional), luego CRUDs específicos. */}
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
        <TabsContent value="ai-grading" className="space-y-4 mt-4">
          <AdminAiGradingPanel />
        </TabsContent>
        <TabsContent value="audit" className="space-y-4 mt-4">
          <AdminAuditRetentionPanel />
        </TabsContent>
        <TabsContent value="secrets" className="space-y-4 mt-4">
          <AdminEdgeSecretsPanel />
        </TabsContent>
        <TabsContent value="modules" className="space-y-4 mt-4">
          <AdminModuleVisibilityPanel />
        </TabsContent>
        <TabsContent value="backups" className="space-y-4 mt-4">
          <DbBackupsPanel />
        </TabsContent>
        <TabsContent value="system" className="space-y-4 mt-4">
          <SystemDiagnosticsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
