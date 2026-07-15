/**
 * DEPRECADO: el Asistente IA de plataforma ahora es universal en /app/assistant
 * (todos los roles). Esta ruta redirige para no romper enlaces/bookmarks viejos.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/app/admin/support-assistant")({
  beforeLoad: () => {
    throw redirect({ to: "/app/assistant" });
  },
});
