/**
 * MessagesFab — Floating Action Button para mensajes + notificaciones,
 * visible solo cuando el sidebar NO está visible (mobile o colapsado).
 *
 * En desktop con sidebar expandido, el bell del header ya cumple el
 * mismo rol, así que este FAB es redundante y se oculta. En mobile el
 * sidebar es un drawer cerrado por default → el FAB siempre aparece.
 *
 * Funcionalidad:
 *  - Badge con el TOTAL de no-leídos (notifications + conversaciones).
 *  - Click → Popover con lista de notificaciones + acceso a /app/messages.
 *  - Botón "Marcar todo leído" llama `markAllAsRead` (notifs) +
 *    RPC `mark_all_conversations_read` (mensajes) en paralelo.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { useNotifications, type Notification } from "@/hooks/use-notifications";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/shared/lib/utils";
import {
  MessageSquare,
  CheckCheck,
  FileText,
  Hammer,
  Award,
  Info,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";
import { Link } from "@tanstack/react-router";

const KIND_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  exam: FileText,
  workshop: Hammer,
  grade: Award,
  system: AlertTriangle,
  info: Info,
};

function timeAgo(date: string): string {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `hace ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `hace ${days}d`;
}

interface MessagesFabProps {
  /** Si el sidebar de desktop está colapsado. En mobile siempre se
   *  considera "no visible" (el sidebar es un Sheet drawer cerrado por
   *  default). Cuando es `false` en desktop, el FAB se oculta. */
  sidebarCollapsed: boolean;
}

export function MessagesFab({ sidebarCollapsed }: MessagesFabProps) {
  const { user } = useAuth();
  const activeRole = useActiveRole();
  const { notifications, unreadCount, markAsRead, markAllAsRead } = useNotifications(
    user?.id,
    activeRole,
  );
  const navigate = useNavigate();
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [open, setOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);

  // Polling ligero del count de mensajes sin responder. Idéntico patrón
  // al dashboard del docente — el RPC es simétrico y filtra por uid.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    const load = async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any).rpc("count_unanswered_conversations");
      if (cancelled) return;
      setUnreadMessages(typeof data === "number" ? data : 0);
    };
    void load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user?.id]);

  const totalUnread = unreadCount + unreadMessages;

  // En desktop con sidebar expandido, ocultamos el FAB — el bell del
  // header ya cumple el mismo rol y no queremos duplicar el badge.
  // En mobile o desktop colapsado, lo mostramos.
  if (!user) return null;
  const hideOnDesktop = !sidebarCollapsed;

  const handleNotificationClick = (n: Notification) => {
    if (!n.read) markAsRead(n.id);
    setOpen(false);
    if (!n.link) return;
    const [pathname, queryString] = n.link.split("?");
    if (queryString) {
      const params = new URLSearchParams(queryString);
      const search: Record<string, string> = {};
      params.forEach((value, key) => {
        search[key] = value;
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      navigate({ to: pathname, search } as any);
    } else {
      navigate({ to: pathname });
    }
  };

  const handleMarkAll = async () => {
    setMarkingAll(true);
    try {
      // Notifications y conversaciones en paralelo. Si una falla, la
      // otra igual progresa.
      await Promise.all([
        Promise.resolve(markAllAsRead()),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).rpc("mark_all_conversations_read"),
      ]);
      setUnreadMessages(0);
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="default"
          size="icon"
          aria-label={`Mensajes y notificaciones (${totalUnread} sin leer)`}
          className={cn(
            // En mobile: bottom-20 para no chocar con el bottom-nav nativo
            //   (que vive en `md:hidden ... fixed bottom-0`). En md+ no
            //   hay bottom-nav → pegamos a bottom-4.
            "fixed bottom-20 md:bottom-4 right-4 z-50 h-12 w-12 rounded-full shadow-lg",
            // En desktop con sidebar expandido se oculta. md:hidden
            // aplica a md+ (no a < md) — coherente con la breakpoint
            // donde el sidebar deja de ser un drawer.
            hideOnDesktop && "md:hidden",
          )}
        >
          <MessageSquare className="h-5 w-5" />
          {totalUnread > 0 && (
            <span className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
              {totalUnread > 99 ? "99+" : totalUnread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-80 p-0 mr-1">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-medium">Bandeja</span>
          {totalUnread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => void handleMarkAll()}
              disabled={markingAll}
            >
              <CheckCheck className="h-3 w-3" />
              {markingAll ? "Marcando…" : "Marcar todo"}
            </Button>
          )}
        </div>

        {/* Resumen — mensajes + notificaciones */}
        <Link
          to="/app/messages"
          onClick={() => setOpen(false)}
          className="flex items-center justify-between gap-2 px-3 py-2.5 border-b hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <MessageSquare className="h-3.5 w-3.5" />
            </div>
            <div className="text-sm">
              Mensajes
              {unreadMessages > 0 && (
                <span className="ml-1 text-xs text-muted-foreground">
                  ({unreadMessages} sin responder)
                </span>
              )}
            </div>
          </div>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
        </Link>

        <div className="px-3 py-1.5 border-b text-[11px] uppercase tracking-wide text-muted-foreground">
          Notificaciones {unreadCount > 0 && `(${unreadCount} sin leer)`}
        </div>
        <div className="max-h-72 overflow-y-auto overscroll-contain">
          {notifications.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              Sin notificaciones
            </div>
          ) : (
            <div className="divide-y">
              {notifications.slice(0, 12).map((n) => {
                const Icon = KIND_ICON[n.kind] ?? Info;
                return (
                  <button
                    key={n.id}
                    onClick={() => handleNotificationClick(n)}
                    className={cn(
                      "w-full text-left px-3 py-2 flex gap-2.5 hover:bg-muted/50 transition-colors",
                      !n.read && "bg-primary/5",
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 h-6 w-6 rounded-full flex items-center justify-center shrink-0",
                        !n.read ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                      )}
                    >
                      <Icon className="h-3 w-3" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("text-xs truncate", !n.read && "font-medium")}>
                          {n.title}
                        </span>
                        {!n.read && (
                          <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                        )}
                      </div>
                      <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5">
                        {n.body}
                      </p>
                      <span className="text-[10px] text-muted-foreground/70 mt-0.5">
                        {timeAgo(n.created_at)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
