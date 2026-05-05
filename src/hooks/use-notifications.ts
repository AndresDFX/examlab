import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  body: string;
  kind: string;
  link: string | null;
  read: boolean;
  created_at: string;
}

export function useNotifications(userId: string | undefined) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Tracking del último id visto. Cuando load() detecta un id nuevo
  // arriba, dispara el toast — eso permite que el toast se vea tanto
  // si la notificación llegó por realtime como si llegó por polling.
  // El handler de realtime también llama load(), así que la lógica
  // queda en un solo lugar y sin duplicados.
  const lastSeenIdRef = useRef<string | null>(null);
  const load = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) {
      console.warn("[notifications] load error", error);
      return;
    }
    const items = (data ?? []) as Notification[];
    const previousTopId = lastSeenIdRef.current;
    const isInitialLoad = previousTopId === null;

    if (items.length > 0 && items[0].id !== previousTopId) {
      lastSeenIdRef.current = items[0].id;
      const fresh = isInitialLoad ? "initial load" : "new top notification";
      console.debug(`[notifications] ${fresh}: ${items[0].title}`);
      // Toast para notificaciones genuinamente nuevas (no en el primer
      // load post-mount, que solo está repintando lo que ya estaba).
      if (!isInitialLoad && typeof document !== "undefined" && document.visibilityState === "visible") {
        const n = items[0];
        toast(n.title ?? "Notificación nueva", {
          description: n.body ?? undefined,
          duration: 6000,
          action: n.link
            ? {
                label: "Ver",
                onClick: () => {
                  if (typeof window !== "undefined" && n.link) {
                    window.location.href = n.link;
                  }
                },
              }
            : undefined,
        });
      }
    }
    setNotifications(items);
    setUnreadCount(items.filter((n) => !n.read).length);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime subscription for new notifications. Si por alguna razón el
  // subscribe nunca llega a SUBSCRIBED (proxy, replica_identity, etc.)
  // tenemos un poll cada 30 s + refresh al volver a la pestaña que
  // funcionan como red de seguridad. En el camino feliz, realtime
  // entrega en ms y los fallbacks no aportan ningún round-trip extra
  // porque la lista local ya tiene la fila.
  useEffect(() => {
    if (!userId) return;

    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    const channelName = `notif-${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const channel = supabase.channel(channelName);

    channel
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          console.debug("[notifications] realtime INSERT", payload?.new);
          // Refetch + lógica de toast vive en load(). El handler aquí
          // solo dispara el push del SW si el tab está oculto, porque
          // load() no haría toast in-app de todos modos.
          void load();

          const n = payload.new as Notification | undefined;
          if (
            n &&
            typeof document !== "undefined" &&
            document.visibilityState === "hidden" &&
            typeof navigator !== "undefined" &&
            navigator.serviceWorker?.controller &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            navigator.serviceWorker.controller.postMessage({
              type: "examlab:notify",
              title: n.title ?? "Notificación",
              body: n.body ?? "",
              link: n.link ?? "/app",
            });
          }
        },
      )
      .subscribe((status, err) => {
        console.debug("[notifications] realtime status", status, err ?? "");
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || err) {
          console.warn("[notifications] realtime subscribe", status, err);
        }
      });

    channelRef.current = channel;

    return () => {
      channel.unsubscribe().finally(() => {
        supabase.removeChannel(channel);
      });
      channelRef.current = null;
    };
  }, [userId]);

  // Refetch al volver a la pestaña: cubre el caso clásico de
  // "estaba en otro tab y al volver no me había llegado nada".
  useEffect(() => {
    if (!userId || typeof document === "undefined") return;
    const onVis = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [userId, load]);

  // Polling cada 15 s mientras el tab está visible. Garantiza que las
  // notificaciones aparezcan aunque realtime esté caído. Bajamos de
  // 30 s a 15 s porque en pruebas con un solo usuario es notorio
  // el delay; el costo de un GET cada 15 s es trivial.
  useEffect(() => {
    if (!userId) return;
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void load();
      }
    }, 15_000);
    return () => clearInterval(id);
  }, [userId, load]);

  const markAsRead = useCallback(async (id: string) => {
    await supabase.from("notifications").update({ read: true }).eq("id", id);
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    setUnreadCount((prev) => Math.max(0, prev - 1));
  }, []);

  const markAllAsRead = useCallback(async () => {
    if (!userId) return;
    await supabase
      .from("notifications")
      .update({ read: true })
      .eq("user_id", userId)
      .eq("read", false);
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);
  }, [userId]);

  return { notifications, unreadCount, markAsRead, markAllAsRead, reload: load };
}
