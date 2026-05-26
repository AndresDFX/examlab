/**
 * Configuración de IA (Admin).
 *
 * Tabs:
 *   - Prompts: edita los prompts globales por use_case (5 tipos).
 *   - Modelo:  selecciona el provider (Lovable / OpenAI) y el modelo activo.
 *
 * Se mantiene el path `/app/admin/ai-prompts` por compatibilidad con
 * URLs y el routeTree generado, aunque el módulo ahora abarca más que
 * solo prompts.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { readTenantOverride } from "@/modules/tenants/use-tenant";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkles, Cpu, FileText } from "lucide-react";
import { AdminPromptsPanel } from "@/modules/admin/AdminPromptsPanel";
import { AdminModelPanel } from "@/modules/admin/AdminModelPanel";

export const Route = createFileRoute("/app/admin/ai-prompts")({ component: AdminAIConfig });

function AdminAIConfig() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const isAdmin = roles.includes("Admin") || roles.includes("SuperAdmin");
  // SuperAdmin cross-tenant: los prompts y el modelo IA son por institución
  // (ai_prompts.tenant_id + ai_model_settings.tenant_id). Sin tenant
  // elegido el panel no tiene scope. Redirige a Instituciones.
  const isSuperAdminCrossTenant =
    roles.includes("SuperAdmin") &&
    activeRole === "SuperAdmin" &&
    readTenantOverride() === null;

  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  if (isSuperAdminCrossTenant) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<Sparkles className="h-6 w-6 text-indigo-500" />}
          title="IA"
          subtitle="Prompts y modelo IA por institución."
        />
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <p className="text-sm font-medium">{t("superAdmin.crossTenantTitle")}</p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              {t("superAdmin.crossTenantAiHint")}
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
        icon={<Sparkles className="h-6 w-6 text-indigo-500" />}
        title="IA"
        subtitle="Configura el modelo y los prompts globales que usa la calificación con IA."
      />

      <Tabs defaultValue="prompts">
        <TabsList>
          <TabsTrigger value="prompts" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            Prompts
          </TabsTrigger>
          <TabsTrigger value="model" className="gap-1.5">
            <Cpu className="h-3.5 w-3.5" />
            Modelo
          </TabsTrigger>
        </TabsList>
        <TabsContent value="prompts" className="space-y-4 mt-4">
          <AdminPromptsPanel />
        </TabsContent>
        <TabsContent value="model" className="space-y-4 mt-4">
          <AdminModelPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
