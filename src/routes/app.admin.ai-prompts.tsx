/**
 * Configuración de Prompts (Admin).
 *
 * Tabs:
 *   - Prompts: edita los prompts globales por use_case.
 *   - Modelo:  selecciona el provider (Lovable / OpenAI) y el modelo activo.
 *
 * Se mantiene el path `/app/admin/ai-prompts` por compatibilidad con
 * URLs y el routeTree generado.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { readTenantOverride } from "@/modules/tenants/use-tenant";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/ui/page-header";
import { FileText, Sparkles, Cpu } from "lucide-react";
import { AdminPromptsPanel } from "@/modules/admin/AdminPromptsPanel";
import { AdminModelPanel } from "@/modules/admin/AdminModelPanel";

export const Route = createFileRoute("/app/admin/ai-prompts")({ component: AdminAIConfig });

function AdminAIConfig() {
  const { t } = useTranslation();
  const { roles, loading: authLoading } = useAuth();
  const activeRole = useActiveRole();
  const isAdmin = roles.includes("Admin") || roles.includes("SuperAdmin");
  // SuperAdmin cross-tenant: ahora SÍ entra al panel — edita el
  // "platform default" (filas con tenant_id IS NULL, course_id IS NULL).
  // Cada Admin sigue editando el override de su institución, que cuando
  // existe gana sobre el platform default. Si la institución no tiene
  // override, la calificación cae al platform del SuperAdmin (mig
  // 20260718000000). El AdminPromptsPanel detecta el scope solo.
  const isSuperAdminCrossTenant =
    roles.includes("SuperAdmin") && activeRole === "SuperAdmin" && readTenantOverride() === null;

  if (authLoading) return null;
  if (!isAdmin) return <p className="text-muted-foreground">{t("adminAiConfig.needsAdmin")}</p>;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Sparkles className="h-6 w-6 text-indigo-500" />}
        title={t("adminAiConfig.title")}
        subtitle={
          isSuperAdminCrossTenant
            ? t("adminAiConfig.subtitleSuperAdmin")
            : t("adminAiConfig.subtitleAdmin")
        }
      />

      <Tabs defaultValue="prompts">
        <TabsList>
          <TabsTrigger value="prompts" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            {t("adminAiConfig.tabPrompts")}
          </TabsTrigger>
          {/* Modelo IA: SuperAdmin (cross-tenant) ahora edita el
              "platform default" (mig 20260719000000); Admin sigue
              editando el override de su institución. Cuando el tenant
              no tiene fila propia, la calificación cae al platform
              default — incluyendo la Gemini/OpenAI key del SuperAdmin
              si la dejó configurada acá. */}
          <TabsTrigger value="model" className="gap-1.5">
            <Cpu className="h-3.5 w-3.5" />
            {t("adminAiConfig.tabModel")}
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
