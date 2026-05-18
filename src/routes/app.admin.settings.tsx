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
import { Settings, Mail, Code2, ScrollText, Sliders, Award } from "lucide-react";
import { AdminEmailSettingsPanel } from "@/components/admin/AdminEmailSettingsPanel";
import { AdminCodeExecutionPanel } from "@/components/admin/AdminCodeExecutionPanel";
import { AdminAuditRetentionPanel } from "@/components/admin/AdminAuditRetentionPanel";
import { AdminGeneralSettingsPanel } from "@/components/admin/AdminGeneralSettingsPanel";
import { AdminCertificateSettingsPanel } from "@/components/admin/AdminCertificateSettingsPanel";

export const Route = createFileRoute("/app/admin/settings")({ component: AdminSettings });

function AdminSettings() {
  const { roles } = useAuth();
  const isAdmin = roles.includes("Admin");

  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Settings className="h-6 w-6 text-indigo-500" />
            Configuración
          </h1>
          <p className="text-sm text-muted-foreground">
            Parámetros operativos de la plataforma.
          </p>
        </div>
      </div>

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
          <TabsTrigger value="audit" className="gap-1.5">
            <ScrollText className="h-3.5 w-3.5" />
            Auditoría
          </TabsTrigger>
          <TabsTrigger value="certificates" className="gap-1.5">
            <Award className="h-3.5 w-3.5" />
            Certificaciones
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
        <TabsContent value="audit" className="space-y-4 mt-4">
          <AdminAuditRetentionPanel />
        </TabsContent>
        <TabsContent value="certificates" className="space-y-4 mt-4">
          <AdminCertificateSettingsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
