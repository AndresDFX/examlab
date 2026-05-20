/**
 * Ruta Docente del módulo "Cron IA".
 * Gestiona la cola IA limitada al alcance del docente (vía RLS de
 * ai_grading_queue: el docente solo ve jobs de sus cursos). El docente
 * NO tiene el botón "Procesar ahora" global — eso es admin-only — pero
 * sí puede procesar UN job ahora mismo con el botón individual.
 */
import { createFileRoute } from "@tanstack/react-router";
import { AiCronPage } from "@/modules/ai/AiCronPage";

export const Route = createFileRoute("/app/teacher/ai-cron")({
  component: TeacherAiCron,
});

function TeacherAiCron() {
  return <AiCronPage />;
}
