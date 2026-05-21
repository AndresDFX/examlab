/**
 * Configuración global (Admin).
 *
 * Módulo central para parámetros operativos de la plataforma.
 * Tabs:
 *   - Generales: defaults de cursos/exámenes + alerta de volumen de correos.
 *   - Correos:   kill switch global + toggles por categoría de email.
 *   - Compilador: proveedor de ejecución de código.
 *   - Auditoría: retención de audit_logs por severidad.
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
  Award,
  KeyRound,
  Layers,
  Cpu,
  Wrench,
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
        <TabsList>
          <TabsTrigger value="general" className="gap-1.5">
            <Sliders className="h-3.5 w-3.5" />
            Generales
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
            <Cpu className="h-3.5 w-3.5" />
            IA / Cola
          </TabsTrigger>
          <TabsTrigger value="audit" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            Auditoría
          </TabsTrigger>
          <TabsTrigger value="certificates" className="gap-1.5">
            <Award className="h-3.5 w-3.5" />
            Certificaciones
          </TabsTrigger>
          <TabsTrigger value="secrets" className="gap-1.5">
            <KeyRound className="h-3.5 w-3.5" />
            Secretos
          </TabsTrigger>
          <TabsTrigger value="modules" className="gap-1.5">
            <Layers className="h-3.5 w-3.5" />
            Módulos
          </TabsTrigger>
          <TabsTrigger value="system" className="gap-1.5">
            <Wrench className="h-3.5 w-3.5" />
            Sistema
          </TabsTrigger>
        </TabsList>
        <TabsContent value="general" className="space-y-4 mt-4">
          <AdminGeneralSettingsPanel />
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
        <TabsContent value="certificates" className="space-y-4 mt-4">
          <AdminCertificateSettingsPanel />
        </TabsContent>
        <TabsContent value="secrets" className="space-y-4 mt-4">
          <AdminEdgeSecretsPanel />
        </TabsContent>
        <TabsContent value="modules" className="space-y-4 mt-4">
          <AdminModuleVisibilityPanel />
        </TabsContent>
        <TabsContent value="system" className="space-y-4 mt-4">
          <SystemDiagnosticsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
