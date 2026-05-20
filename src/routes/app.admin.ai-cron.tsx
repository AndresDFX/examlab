/**
 * Ruta Admin del módulo "Cron IA".
 * Gestiona la cola de calificación con IA (ai_grading_queue): ver,
 * cancelar, reintentar y procesar jobs individualmente, además del
 * botón "Procesar ahora" para drenar toda la cola pending.
 */
import { createFileRoute } from "@tanstack/react-router";
import { AiCronPage } from "@/modules/ai/AiCronPage";

export const Route = createFileRoute("/app/admin/ai-cron")({
  component: AdminAiCron,
});

function AdminAiCron() {
  return <AiCronPage isAdmin />;
}
