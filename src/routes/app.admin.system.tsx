import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/ui/page-header";
import { EdgeFunctionHealthCheck } from "@/components/EdgeFunctionHealthCheck";
import { Wrench } from "lucide-react";

export const Route = createFileRoute("/app/admin/system")({
  component: AdminSystem,
});

// Pagina de utilidades de admin enfocadas en la infraestructura
// (Supabase, edge functions, pipeline). NO datos académicos.
//
// Inicialmente solo expone el boton de health-check; aqui caben en el
// futuro herramientas como: ver version de cada edge function
// desplegada, ver lag del realtime, ver tamano de la DB, etc.
function AdminSystem() {
  return (
    <div className="container mx-auto space-y-6 p-4 sm:p-6">
      <PageHeader
        backTo="/app"
        icon={<Wrench className="h-6 w-6" />}
        title="Sistema"
        subtitle="Herramientas de diagnóstico de la infraestructura"
      />
      <EdgeFunctionHealthCheck />
    </div>
  );
}
