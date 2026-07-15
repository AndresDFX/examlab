/**
 * Asistente IA de plataforma — ruta universal para TODOS los roles.
 * El componente vive en @/modules/assistant y el edge adapta la KB + el prompt
 * al rol activo del usuario. (La vieja ruta /app/admin/support-assistant
 * redirige aquí.)
 */
import { createFileRoute } from "@tanstack/react-router";
import { PlatformAssistantChat } from "@/modules/assistant/PlatformAssistantChat";

export const Route = createFileRoute("/app/assistant")({
  component: PlatformAssistantChat,
});
