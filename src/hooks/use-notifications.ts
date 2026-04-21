import { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";

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

  // Load notifications
  const load = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase
      .from("notifications")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    const items = (data ?? []) as Notification[];
    setNotifications(items);
    setUnreadCount(items.filter((n) => !n.read).length);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  // Realtime subscription for new notifications
  useEffect(() => {
    if (!userId) return;

    // Tear down any prior channel synchronously before creating a new one.
    // A lingering same-named (subscribed) channel will cause
    // `supabase.channel()` to return it and then throw on `.on()`.
    if (channelRef.current) {
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }

    // Randomized suffix guarantees the name cannot collide with a channel
    // whose cleanup is still in flight (StrictMode, fast route changes).
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
          const n = payload.new as Notification;
          setNotifications((prev) => [n, ...prev]);
          setUnreadCount((prev) => prev + 1);

          // When the tab is hidden, hand the notification to the Service Worker
          // so it can surface an OS-level toast. Requires user-granted permission.
          if (
            typeof document !== "undefined" &&
            document.visibilityState === "hidden" &&
            typeof navigator !== "undefined" &&
            navigator.serviceWorker?.controller &&
            typeof Notification !== "undefined" &&
            Notification.permission === "granted"
          ) {
            navigator.serviceWorker.controller.postMessage({
              type: "examlab:notify",
              title: n.title,
              body: n.body,
              link: n.link ?? "/app",
            });
          }
        },
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      channel.unsubscribe().finally(() => {
        supabase.removeChannel(channel);
      });
      channelRef.current = null;
    };
  }, [userId]);

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
