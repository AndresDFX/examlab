/**
 * Ruta Admin del módulo "Cola".
 * Gestiona la cola de calificación con IA (ai_grading_queue): ver,
 * cancelar, reintentar y procesar jobs individualmente.
 *
 * La tab "Tareas programadas" (pg_cron) NO se renderiza acá — eso es
 * infraestructura y vive en /app/superadmin/system. El Admin de un
 * tenant solo necesita la cola IA de su propia institución.
 *
 * Para acceder a la cola desde SuperAdmin: mismo URL, con showInfraTab
 * habilitado abajo.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "@/hooks/use-auth";
import { AiCronPage } from "@/modules/ai/AiCronPage";

export const Route = createFileRoute("/app/admin/ai-cron")({
  component: AdminAiCron,
});

function AdminAiCron() {
  const { roles } = useAuth();
  const isSuperAdmin = roles.includes("SuperAdmin");
  // SuperAdmin ve la tab de pg_cron además de la cola. Admin normal
  // solo la cola IA — pg_cron es infra cross-tenant.
  return <AiCronPage isAdmin showInfraTab={isSuperAdmin} />;
}
