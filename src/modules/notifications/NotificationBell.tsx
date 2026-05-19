import { useNavigate } from "@tanstack/react-router";
import { useNotifications, type Notification } from "@/hooks/use-notifications";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { Bell, CheckCheck, FileText, Hammer, Award, Info, AlertTriangle } from "lucide-react";
import { cn } from "@/shared/lib/utils";

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

interface NotificationBellProps {
  userId: string | undefined;
  variant?: "sidebar" | "default";
  /** Rol activo del viewer — usado para filtrar notificaciones del
   *  MISMO rol (un docente no debe ver notificaciones generadas por
   *  otros docentes). Si no se pasa, no se filtra por rol. */
  viewerRole?: string | null;
}

export function NotificationBell({
  userId,
  variant = "default",
  viewerRole,
}: NotificationBellProps) {
  const { notifications, unreadCount, markAsRead, markAllAsRead } = useNotifications(
    userId,
    viewerRole,
  );
  const navigate = useNavigate();

  const handleClick = (n: Notification) => {
    if (!n.read) markAsRead(n.id);
    if (!n.link) return;
    // El link puede traer query string (ej. ?project=X&submission=Y para
    // notificaciones de feedback). TanStack Router con `navigate({ to })`
    // sin schema de search declarado puede ignorar el query — partimos
    // pathname y search para que se pase correctamente.
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

  const isSidebar = variant === "sidebar";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "relative",
            isSidebar &&
              "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground",
          )}
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-medium">Notificaciones</span>
          {unreadCount > 0 && (
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={markAllAsRead}>
              <CheckCheck className="h-3 w-3" /> Marcar todo
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto overscroll-contain">
          {notifications.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Sin notificaciones</div>
          ) : (
            <div className="divide-y">
              {notifications.map((n) => {
                const Icon = KIND_ICON[n.kind] ?? Info;
                return (
                  <button
                    key={n.id}
                    onClick={() => handleClick(n)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 flex gap-2.5 hover:bg-muted/50 transition-colors",
                      !n.read && "bg-primary/5",
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 h-7 w-7 rounded-full flex items-center justify-center shrink-0",
                        !n.read ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("text-sm truncate", !n.read && "font-medium")}>
                          {n.title}
                        </span>
                        {!n.read && (
                          <span className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{n.body}</p>
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
