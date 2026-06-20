/**
 * KahootLiveBanner — notificación GLOBAL y persistente "arriba del navegador"
 * que avisa al alumno cuando hay un Kahoot EN VIVO en alguno de sus cursos y lo
 * lleva al juego con UN CLICK ("login directo": su cuenta institucional ya es
 * la credencial — no teclea PIN). Se monta en AppLayout, así que aparece en
 * CUALQUIER pantalla mientras el juego siga activo.
 *
 * Decide entre:
 *   - RECONECTAR: ya soy jugador de un juego vivo → entro directo.
 *   - ENTRAR: hay un juego en LOBBY de mi curso → me uno por id
 *     (kahoot_join_game_by_id, sin PIN) y entro.
 * Para juegos YA arrancados en los que NO soy jugador, no muestro nada (perdí
 * la ventana de ingreso — el server igual lo rechazaría).
 *
 * Se oculta solo cuando ya estoy DENTRO de la vista del juego (para no taparla).
 * Refresca por realtime (cambios en kahoot_games) + un poll de respaldo, igual
 * que el resto del módulo (Supabase Realtime no re-emite tras caídas de red).
 */
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { Gamepad2, ArrowRight, RotateCcw } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const RESYNC_MS = 15000;

interface LiveGame {
  id: string;
  title: string;
  amIPlayer: boolean;
}

export function KahootLiveBanner() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [game, setGame] = useState<LiveGame | null>(null);
  const [joining, setJoining] = useState(false);
  // Evita relanzar la carga en cada render; el effect la define.
  const loadRef = useRef<() => void>(() => {});

  // Si ya estoy DENTRO del juego, no muestro el banner (taparía la vista).
  const insideGame = location.pathname.startsWith("/app/student/kahoot/");

  useEffect(() => {
    if (!user) {
      setGame(null);
      return;
    }
    let cancelled = false;

    const load = async () => {
      const [liveRes, mineRes] = await Promise.all([
        db
          .from("kahoot_games")
          .select("id, status, poll:polls(title, deleted_at)")
          .neq("status", "ended"),
        db.from("kahoot_players").select("game_id").eq("user_id", user.id),
      ]);
      if (cancelled) return;
      const mine = new Set(
        ((mineRes.data ?? []) as { game_id: string }[]).map((r) => r.game_id),
      );
      const live = ((liveRes.data ?? []) as {
        id: string;
        status: string;
        poll: { title: string; deleted_at: string | null } | null;
      }[])
        .filter((g) => g.poll && !g.poll.deleted_at)
        .map((g) => ({
          id: g.id,
          status: g.status,
          title: g.poll!.title,
          amIPlayer: mine.has(g.id),
        }))
        // Mostrable: ya soy jugador (reconectar) o está en lobby (puedo entrar).
        .filter((g) => g.amIPlayer || g.status === "lobby")
        // Preferir un juego donde ya estoy (reconexión) sobre un lobby nuevo.
        .sort((a, b) => Number(b.amIPlayer) - Number(a.amIPlayer));
      setGame(live[0] ? { id: live[0].id, title: live[0].title, amIPlayer: live[0].amIPlayer } : null);
    };
    loadRef.current = () => void load();
    void load();

    // Realtime: cualquier cambio en kahoot_games (nuevo lobby, fin, etc.).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 250);
    };
    const channel = supabase
      .channel("kahoot-live-banner")
      .on("postgres_changes", { event: "*", schema: "public", table: "kahoot_games" }, trigger)
      .subscribe();
    const poll = setInterval(() => void load(), RESYNC_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [user]);

  if (insideGame || !game) return null;

  const go = async () => {
    if (joining) return;
    if (game.amIPlayer) {
      navigate({ to: "/app/student/kahoot/$gameId", params: { gameId: game.id } });
      return;
    }
    setJoining(true);
    try {
      const { error } = await db.rpc("kahoot_join_game_by_id", { _game_id: game.id });
      if (error) {
        toast.error(friendlyError(error, t("kahoot.joinError")));
        // Probablemente el juego arrancó entre el render y el click → refrescar.
        loadRef.current();
        return;
      }
      navigate({ to: "/app/student/kahoot/$gameId", params: { gameId: game.id } });
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="sticky top-14 md:top-0 z-30 animate-in slide-in-from-top-2 duration-300">
      <div className="flex items-center gap-3 border-b border-primary/40 bg-gradient-to-r from-primary/20 via-primary/10 to-primary/20 px-4 py-2.5">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
        </span>
        <Gamepad2 className="h-5 w-5 text-primary shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">
            {t("kahoot.liveBannerTitle", { defaultValue: "¡Kahoot en vivo!" })}
            {game.title ? ` · ${game.title}` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground truncate">
            {game.amIPlayer
              ? t("kahoot.liveBannerReconnect", { defaultValue: "Tu juego sigue activo — vuelve a entrar." })
              : t("kahoot.liveBannerJoin", { defaultValue: "Únete ahora con tu cuenta — sin PIN." })}
          </p>
        </div>
        <Button size="sm" disabled={joining} onClick={() => void go()} className="shrink-0 animate-pulse">
          {joining ? (
            <Spinner size="sm" className="mr-1" />
          ) : game.amIPlayer ? (
            <RotateCcw className="h-4 w-4 mr-1" />
          ) : (
            <ArrowRight className="h-4 w-4 mr-1" />
          )}
          {game.amIPlayer
            ? t("kahoot.reconnect", { defaultValue: "Reconectar" })
            : t("kahoot.liveBannerEnter", { defaultValue: "Entrar ahora" })}
        </Button>
      </div>
    </div>
  );
}
