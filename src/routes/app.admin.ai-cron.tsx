/**
 * Ruta Admin del módulo "Cola".
 * Gestiona la cola de calificación con IA (ai_grading_queue): ver,
 * cancelar, reintentar y procesar jobs individualmente. También expone
 * el panel "Tareas programadas" con los jobs pg_cron del proyecto
 * (ai-grading-worker-hourly, db-backup-weekly, etc.) para pausar /
 * reagendar / describir.
 */
import { createFileRoute } from "@tanstack/react-router";
import { AiCronPage } from "@/modules/ai/AiCronPage";

export const Route = createFileRoute("/app/admin/ai-cron")({
  component: AdminAiCron,
});

function AdminAiCron() {
  return <AiCronPage isAdmin />;
}
