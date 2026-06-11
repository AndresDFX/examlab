/**
 * Vista HOST del Kahoot en vivo (docente). Proyectable a pantalla
 * completa. Recorre la máquina de estados del juego (lobby → pregunta →
 * reveal → leaderboard → … → podio → fin) llamando al RPC
 * `kahoot_advance_game`. El estado lo provee `useKahootGame` (realtime +
 * `kahoot_get_state`).
 *
 * El host VE la respuesta correcta y el contador en vivo de respuestas;
 * los jugadores no (lo garantiza la RLS + el RPC).
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageLoader } from "@/components/ui/loaders";
import { ErrorState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useKahootGame } from "@/modules/polls/use-kahoot-game";
import { KAHOOT_SHAPES, secondsLeft, buildKahootJoinUrl } from "@/modules/polls/kahoot";
import { KahootShapeIcon } from "@/modules/polls/KahootShapeIcon";
import { QRCodeSVG } from "qrcode.react";
import {
  Play,
  Lock,
  Trophy,
  ChevronRight,
  Flag,
  Maximize,
  Minimize,
  Users,
  Crown,
} from "lucide-react";

export const Route = createFileRoute("/app/teacher/kahoot/$gameId")({ component: KahootHost });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

function KahootHost() {
  const { gameId } = Route.useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, loading, error, reload } = useKahootGame(gameId);
  const [advancing, setAdvancing] = useState(false);
  const [nowMs, setNowMs] = useState(0);
  const [isFs, setIsFs] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const autoLockedRef = useRef<string | null>(null);

  // Reloj para el countdown (deterministic init=0; arranca post-mount).
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // Heartbeat de presencia del host: mientras esta vista esté montada, el
  // docente "late" cada 8s (kahoot_host_heartbeat). Si cierra la pestaña o se
  // va, deja de latir y a los ~25s la sala se marca SIN docente
  // (kahoot_get_state.host_present=false): los alumnos ven "Esperando al
  // docente…" y kahoot_join_game rechaza nuevos ingresos a la sala huérfana.
  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    const beat = () => {
      void db.rpc("kahoot_host_heartbeat", { _game_id: gameId });
    };
    beat();
    const id = setInterval(() => {
      if (!cancelled) beat();
    }, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [gameId]);

  // Origin para el QR de unión. Se lee POST-mount (no en render) para no
  // romper la hidratación SSR (regla del proyecto: nunca window.* en render).
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  const advance = async (action: string) => {
    setAdvancing(true);
    try {
      const { error: e } = await db.rpc("kahoot_advance_game", { _game_id: gameId, _action: action });
      if (e) {
        toast.error(friendlyError(e));
        return;
      }
      await reload();
    } finally {
      setAdvancing(false);
    }
  };

  const toggleFs = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void rootRef.current?.requestFullscreen();
    }
  };

  const left =
    state?.question && state.game.status === "question"
      ? secondsLeft(state.game.question_started_at, state.question.time_limit_seconds, nowMs)
      : null;

  // Auto-bloqueo cuando se acaba el tiempo (se siente como Kahoot real).
  useEffect(() => {
    if (
      state?.game.status === "question" &&
      !state.game.question_locked &&
      left === 0 &&
      autoLockedRef.current !== state.game.question_started_at
    ) {
      autoLockedRef.current = state.game.question_started_at;
      void advance("lock");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, state?.game.status]);

  if (loading) return <PageLoader />;
  if (error || !state) {
    return (
      <div className="p-4 sm:p-8">
        <ErrorState message={t("kahoot.loadError")} hint={error ?? undefined} onRetry={() => void reload()} />
      </div>
    );
  }

  const { game, question, players, answer_count } = state;
  const ranked = [...players].sort((a, b) => b.score - a.score);

  return (
    <div ref={rootRef} className="min-h-screen bg-gradient-to-b from-background to-muted/40 flex flex-col">
      {/* Barra superior */}
      <div className="flex items-center justify-between gap-2 p-3 border-b bg-card/60 backdrop-blur">
        <div className="flex items-center gap-2 text-sm">
          <Trophy className="h-4 w-4 text-amber-500" />
          <span className="font-semibold">{t("kahoot.hostTitle")}</span>
          {game.status !== "lobby" && game.status !== "ended" && (
            <Badge variant="secondary" className="tabular-nums">
              {t("kahoot.questionProgress", { n: game.current_index + 1, total: game.total_questions })}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1">
            <Users className="h-3 w-3" /> {players.length}
          </Badge>
          <Button variant="ghost" size="icon" onClick={toggleFs} title={t("kahoot.fullscreen")}>
            {isFs ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 gap-6">
        {/* ── LOBBY ── */}
        {game.status === "lobby" && (
          <div className="text-center space-y-6 w-full max-w-3xl">
            <p className="text-muted-foreground">{t("kahoot.lobbyJoinHint")}</p>
            <div className="rounded-2xl border-2 border-primary/30 bg-card py-8 px-6 flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-10">
              <div>
                <p className="text-sm uppercase tracking-widest text-muted-foreground">{t("kahoot.pinLabel")}</p>
                <p className="text-6xl sm:text-7xl font-black tracking-[0.2em] tabular-nums text-primary mt-2">
                  {game.pin}
                </p>
              </div>
              {/* QR para unirse escaneando: deep-link a
                  /app/student/polls?kahootPin=… → el alumno escanea, hace login
                  si hace falta (returnTo lo trae de vuelta) y la página
                  auto-une por PIN. `origin` se setea post-mount (SSR-safe).
                  Fondo blanco fijo para que el QR contraste en cualquier tema. */}
              {origin && game.pin && (
                <div className="flex flex-col items-center gap-1.5">
                  <div className="rounded-lg bg-white p-3">
                    <QRCodeSVG value={buildKahootJoinUrl(origin, game.pin)} size={148} />
                  </div>
                  <span className="text-[11px] text-muted-foreground">{t("kahoot.scanToJoin")}</span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2 min-h-12">
              {players.length === 0 ? (
                <span className="text-sm text-muted-foreground">{t("kahoot.waitingPlayers")}</span>
              ) : (
                players.map((p) => (
                  <Badge key={p.id} variant="secondary" className="text-sm py-1 px-3">
                    {p.nickname}
                  </Badge>
                ))
              )}
            </div>
            <Button size="lg" disabled={advancing || players.length === 0} onClick={() => void advance("start")}>
              {advancing ? <Spinner size="sm" className="mr-2" /> : <Play className="h-5 w-5 mr-2" />}
              {t("kahoot.start")}
            </Button>
          </div>
        )}

        {/* ── PREGUNTA (host ve la correcta) ── */}
        {(game.status === "question" || game.status === "reveal") && question && (
          <div className="w-full max-w-5xl space-y-6">
            <div className="text-center space-y-3">
              <h1 className="text-2xl sm:text-4xl font-bold">{question.text}</h1>
              {game.status === "question" && (
                <div className="flex items-center justify-center gap-4">
                  <div className="h-16 w-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-2xl font-black tabular-nums">
                    {left ?? "—"}
                  </div>
                  <Badge variant="outline" className="gap-1 text-base py-1">
                    <Users className="h-4 w-4" /> {answer_count} / {players.length}
                  </Badge>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {question.options.map((o) => {
                const shape = KAHOOT_SHAPES[o.position] ?? KAHOOT_SHAPES[0];
                const dim = game.status === "reveal" && o.is_correct === false;
                return (
                  <div
                    key={o.id}
                    className={`flex items-center gap-3 rounded-xl ${shape.bg} text-white px-4 py-5 text-lg font-semibold shadow ${dim ? "opacity-40" : ""}`}
                  >
                    <KahootShapeIcon icon={shape.icon} className="h-7 w-7 shrink-0" />
                    <span className="flex-1">{o.label}</span>
                    {game.status === "reveal" && o.is_correct === true && (
                      <Crown className="h-6 w-6 shrink-0" />
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-center gap-2">
              {game.status === "question" && (
                <Button size="lg" disabled={advancing} onClick={() => void advance("lock")}>
                  <Lock className="h-5 w-5 mr-2" /> {t("kahoot.lockReveal")}
                </Button>
              )}
              {game.status === "reveal" && (
                <Button size="lg" disabled={advancing} onClick={() => void advance("leaderboard")}>
                  <Trophy className="h-5 w-5 mr-2" /> {t("kahoot.showLeaderboard")}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* ── LEADERBOARD ── */}
        {game.status === "leaderboard" && (
          <div className="w-full max-w-2xl space-y-4">
            <h2 className="text-3xl font-bold text-center flex items-center justify-center gap-2">
              <Trophy className="h-7 w-7 text-amber-500" /> {t("kahoot.leaderboard")}
            </h2>
            <Leaderboard ranked={ranked} />
            <div className="flex justify-center">
              <Button size="lg" disabled={advancing} onClick={() => void advance("next")}>
                <ChevronRight className="h-5 w-5 mr-2" />
                {game.current_index + 1 >= game.total_questions ? t("kahoot.showPodium") : t("kahoot.nextQuestion")}
              </Button>
            </div>
          </div>
        )}

        {/* ── PODIO ── */}
        {(game.status === "podium" || game.status === "ended") && (
          <div className="w-full max-w-2xl space-y-6 text-center">
            <h2 className="text-4xl font-black flex items-center justify-center gap-2">
              <Crown className="h-9 w-9 text-amber-500" /> {t("kahoot.podium")}
            </h2>
            <Podium ranked={ranked} />
            {game.status === "podium" ? (
              <Button size="lg" disabled={advancing} onClick={() => void advance("end")}>
                <Flag className="h-5 w-5 mr-2" /> {t("kahoot.finish")}
              </Button>
            ) : (
              <Button size="lg" variant="outline" onClick={() => navigate({ to: "/app/teacher/polls" })}>
                {t("kahoot.backToPolls")}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Leaderboard({ ranked }: { ranked: { id: string; nickname: string; score: number }[] }) {
  const max = Math.max(1, ...ranked.map((p) => p.score));
  return (
    <div className="space-y-2">
      {ranked.slice(0, 8).map((p, i) => (
        <div key={p.id} className="flex items-center gap-3">
          <span className="w-6 text-right font-bold tabular-nums text-muted-foreground">{i + 1}</span>
          <div className="flex-1 rounded-lg bg-muted/50 overflow-hidden">
            <div
              className="bg-primary/80 text-primary-foreground px-3 py-2 rounded-lg flex items-center justify-between min-w-fit transition-all"
              style={{ width: `${Math.max(18, (p.score / max) * 100)}%` }}
            >
              <span className="font-medium truncate">{p.nickname}</span>
              <span className="font-bold tabular-nums ml-2">{p.score}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function Podium({ ranked }: { ranked: { id: string; nickname: string; score: number }[] }) {
  const top = ranked.slice(0, 3);
  const heights = ["h-40", "h-32", "h-24"];
  const order = [1, 0, 2]; // 2º, 1º, 3º para el clásico podio centrado
  return (
    <>
      <div className="flex items-end justify-center gap-3">
        {order.map((idx) => {
          const p = top[idx];
          if (!p) return <div key={idx} className="w-24" />;
          return (
            <div key={p.id} className="flex flex-col items-center gap-2 w-24">
              <span className="font-semibold truncate max-w-full text-sm">{p.nickname}</span>
              <div
                className={`w-full ${heights[idx]} rounded-t-lg flex flex-col items-center justify-start pt-2 ${idx === 0 ? "bg-amber-400 text-amber-950" : idx === 1 ? "bg-slate-300 text-slate-900" : "bg-orange-400 text-orange-950"}`}
              >
                <span className="text-2xl font-black">{idx + 1}</span>
                <span className="text-sm font-bold tabular-nums">{p.score}</span>
              </div>
            </div>
          );
        })}
      </div>
      {ranked.length > 3 && (
        <div className="space-y-1 max-w-sm mx-auto pt-4">
          {ranked.slice(3, 10).map((p, i) => (
            <div key={p.id} className="flex items-center justify-between text-sm px-2">
              <span className="text-muted-foreground">
                {i + 4}. {p.nickname}
              </span>
              <span className="font-medium tabular-nums">{p.score}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
