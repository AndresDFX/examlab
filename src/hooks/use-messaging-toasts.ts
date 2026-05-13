/**
 * useMessagingToasts — escucha realtime de `messages` y dispara un toast
 * cuando llega un mensaje dirigido a mí (soy el "otro" usuario de la
 * conversación) y NO estoy actualmente en /app/messages (el panel ya
 * pinta el mensaje en vivo, no necesita toast).
 *
 * Se monta en AppLayout para que cubra toda la app. La notificación
 * persistente del bell la crea el trigger SQL `tg_notify_new_message`
 * (es complementaria: el toast es efímero, la notificación queda).
 */
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { previewBody } from "@/lib/messaging";

// `messages`/`conversations` aún no están en types.ts generados.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface MessagePayload {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
}

export function useMessagingToasts(myUserId: string | null | undefined) {
  const navigate = useNavigate();
  const location = useLocation();
  // Capturamos `pathname` en una ref para evitar re-suscribirse al
  // channel cada vez que cambia la ruta — la suscripción es global y
  // sigue activa entre rutas.
  const pathRef = useRef(location.pathname);
  useEffect(() => {
    pathRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    if (!myUserId) return;
    const channel = supabase
      .channel(`messaging-toasts-${myUserId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        async (payload: { new: MessagePayload }) => {
          const m = payload.new;
          // Ignorar mis propios mensajes (eco del INSERT que yo hice).
          if (m.sender_id === myUserId) return;
          // Si estoy ya en /app/messages no toaster — el panel pinta en vivo.
          if (pathRef.current.startsWith("/app/messages")) return;
          // Verificar que la conversación es mía. La policy SELECT de
          // messages ya filtra al cliente pero el realtime channel manda
          // payloads sin filtro RLS — así que volvemos a chequear.
          const { data: conv } = await db
            .from("conversations")
            .select("user_a, user_b")
            .eq("id", m.conversation_id)
            .maybeSingle();
          if (!conv) return; // ni siquiera puedo leer la conv → no es mía
          if (conv.user_a !== myUserId && conv.user_b !== myUserId) return;
          // Nombre del sender (best-effort — si falla, mostramos genérico).
          const { data: profile } = await db
            .from("profiles")
            .select("full_name, institutional_email")
            .eq("id", m.sender_id)
            .maybeSingle();
          const senderName: string =
            profile?.full_name ?? profile?.institutional_email ?? "Alguien";
          toast(`💬 ${senderName}`, {
            description: previewBody(m.body, 80) || "(adjuntos)",
            action: {
              label: "Ver",
              onClick: () => {
                void navigate({
                  to: "/app/messages",
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } as any);
              },
            },
            duration: 6000,
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [myUserId, navigate]);
}
