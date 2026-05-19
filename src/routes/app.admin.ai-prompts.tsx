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
import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sparkles, Cpu, FileText } from "lucide-react";
import { AdminPromptsPanel } from "@/modules/admin/AdminPromptsPanel";
import { AdminModelPanel } from "@/modules/admin/AdminModelPanel";

export const Route = createFileRoute("/app/admin/ai-prompts")({ component: AdminAIConfig });

function AdminAIConfig() {
  const { roles } = useAuth();
  const isAdmin = roles.includes("Admin");

  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Sparkles className="h-6 w-6 text-indigo-500" />
            IA
          </h1>
          <p className="text-sm text-muted-foreground">
            Configura el modelo y los prompts globales que usa la calificación con IA.
          </p>
        </div>
      </div>

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
