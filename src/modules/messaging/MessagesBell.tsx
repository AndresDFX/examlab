/**
 * MessagesBell — icono de mensajes para el header, junto al
 * NotificationBell. Reemplaza al item "Mensajes" del sidebar:
 *  - Badge con conteo de conversaciones sin responder (RPC
 *    `count_unanswered_conversations`).
 *  - Popover con resumen + botón "Marcar todo leído" + link
 *    "Ir a la bandeja".
 *  - Sin lista detallada (eso vive en /app/messages); aquí solo
 *    aviso rápido y accesos.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MessageSquare, CheckCheck, ArrowRight, Inbox } from "lucide-react";
import { cn } from "@/shared/lib/utils";

export function MessagesBell() {
  const { user } = useAuth();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);

  const load = async () => {
    if (!user?.id) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any).rpc("count_unanswered_conversations");
    setUnread(typeof data === "number" ? data : 0);
  };

  // Polling cada 30s + refetch al volver al tab. Mismo patrón del
  // NotificationBell — suficientemente reactivo sin saturar requests.
  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    void load();
    const interval = setInterval(() => {
      if (!cancelled) void load();
    }, 30_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleMarkAll = async () => {
    setMarking(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).rpc("mark_all_conversations_read");
      setUnread(0);
    } finally {
      setMarking(false);
    }
  };

  if (!user) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8"
          aria-label={`Mensajes (${unread} sin leer)`}
        >
          <MessageSquare className="h-4 w-4" />
          {unread > 0 && (
            <span
              className={cn(
                "absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center",
                "rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground",
              )}
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-medium flex items-center gap-1.5">
            <Inbox className="h-3.5 w-3.5" />
            Bandeja de mensajes
          </span>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => void handleMarkAll()}
              disabled={marking}
            >
              <CheckCheck className="h-3 w-3" />
              {marking ? "Marcando…" : "Marcar todo"}
            </Button>
          )}
        </div>
        <div className="px-3 py-3 text-sm text-muted-foreground">
          {unread === 0 ? (
            <span>No tienes mensajes sin responder.</span>
          ) : (
            <span>
              <strong className="text-foreground">{unread}</strong>{" "}
              {unread === 1
                ? "conversación pendiente por responder."
                : "conversaciones pendientes por responder."}
            </span>
          )}
        </div>
        <Link
          to="/app/messages"
          onClick={() => setOpen(false)}
          className="flex items-center justify-between gap-2 px-3 py-2.5 border-t hover:bg-muted/50 transition-colors text-sm"
        >
          <span>Abrir bandeja completa</span>
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
        </Link>
      </PopoverContent>
    </Popover>
  );
}
