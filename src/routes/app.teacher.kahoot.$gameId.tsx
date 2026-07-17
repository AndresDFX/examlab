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
import { Switch } from "@/components/ui/switch";
import { PageLoader } from "@/components/ui/loaders";
import { ErrorState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useKahootGame } from "@/modules/polls/use-kahoot-game";
import { KAHOOT_SHAPES, secondsLeft, getReadySecondsLeft, buildKahootJoinUrl } from "@/modules/polls/kahoot";
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
  Zap,
  Rocket,
  CheckCircle2,
  Copy,
  Check,
  Link2,
} from "lucide-react";

// Clave de localStorage para la preferencia "auto-avanzar cuando todos
// respondan". Compartida por todos los hosts del docente (no por juego).
const AUTO_ADVANCE_STORAGE_KEY = "examlab_kahoot_auto_advance";

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
  // Preferencia del docente: pasar a 'reveal' apenas todos respondan, sin
  // esperar al timer. Default ON — el feature nace para acortar la espera.
  // Hydration-safe: init determinístico, leemos localStorage post-mount.
  const [autoAdvance, setAutoAdvance] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const autoLockedRef = useRef<string | null>(null);

  // Hidratar la preferencia desde localStorage al montar.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(AUTO_ADVANCE_STORAGE_KEY);
      if (stored !== null) setAutoAdvance(stored === "1");
    } catch {
      /* SSR / storage deshabilitado */
    }
  }, []);

  // Persistir cada cambio sin un effect adicional (write-on-toggle).
  const toggleAutoAdvance = (next: boolean) => {
    setAutoAdvance(next);
    try {
      localStorage.setItem(AUTO_ADVANCE_STORAGE_KEY, next ? "1" : "0");
    } catch {
      /* no-op */
    }
  };

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
      // supabase-js PostgrestBuilder es LAZY: `void db.rpc(...)` evalúa el
      // builder pero nunca llama `.then()`, así que NO se dispara el fetch.
      // El `.then(noop, noop)` fuerza la ejecución y swallowea errores
      // (fire-and-forget intencional — un heartbeat perdido no debe romper
      // la UI; el próximo a los 8s reintenta).
      db.rpc("kahoot_host_heartbeat", { _game_id: gameId }).then(
        () => {},
        () => {},
      );
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

  // Origin para el QR + el enlace de unión. Se lee POST-mount (no en render)
  // para no romper la hidratación SSR (regla del proyecto: nunca window.* en render).
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  // Enlace público para unirse SIN escanear (los alumnos lo abren y solo ponen
  // su correo institucional). Mismo destino que el QR: /reto/<pin>.
  const joinUrl = origin && state?.game?.pin ? buildKahootJoinUrl(origin, state.game.pin) : "";
  const [linkCopied, setLinkCopied] = useState(false);
  const copyJoinLink = async () => {
    if (!joinUrl) return;
    try {
      await navigator.clipboard.writeText(joinUrl);
      setLinkCopied(true);
      toast.success(t("kahoot.linkCopied", { defaultValue: "Enlace copiado" }));
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      toast.error(t("kahoot.linkCopyError", { defaultValue: "No se pudo copiar el enlace" }));
    }
  };

  // Animación del leaderboard: al abrir la tabla de posiciones, cada puntaje
  // "cuenta hacia arriba" desde el de la RONDA ANTERIOR hasta el nuevo. Guardamos
  // los puntajes de la última tabla mostrada (prevScoresRef) y, al ENTRAR al
  // estado 'leaderboard', fijamos el `from` (lbFrom) con esos valores y
  // actualizamos el ref a los actuales para la próxima vuelta.
  const prevScoresRef = useRef<Record<string, number>>({});
  const [lbFrom, setLbFrom] = useState<Record<string, number>>({});
  const lastStatusRef = useRef<string>("");
  useEffect(() => {
    if (!state) return;
    const st = state.game.status;
    if (st === "leaderboard" && lastStatusRef.current !== "leaderboard") {
      setLbFrom({ ...prevScoresRef.current });
      const snap: Record<string, number> = {};
      for (const p of state.players) snap[p.id] = p.score;
      prevScoresRef.current = snap;
    }
    lastStatusRef.current = st;
  }, [state]);

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
  // "¡Prepárate!": question_started_at se fija unos segundos en el futuro
  // (mig 20260989000000). Mientras tanto, splash de cuenta regresiva.
  const getReady =
    state?.question && state.game.status === "question"
      ? getReadySecondsLeft(state.game.question_started_at, nowMs)
      : null;
  // nowMs arranca en 0 hasta que el effect ponga Date.now(); sin este gate, el
  // primer frame mostraría un número gigante en el splash (epoch/1000).
  const inGetReady = nowMs > 0 && getReady !== null && getReady > 0;

  // Auto-bloqueo cuando se acaba el tiempo (se siente como Kahoot real).
  useEffect(() => {
    if (
      state?.game.status === "question" &&
      !state.game.question_locked &&
      left === 0 &&
      autoLockedRef.current !== state.game.question_started_at
    ) {
      autoLockedRef.current = state.game.question_started_at;
      // INVARIANTE CROSS-FILE: esperar la VENTANA DE GRACIA del servidor
      // (v_grace_ms=2000ms en kahoot_submit_answer, mig 20260936000000) antes de
      // pasar a 'reveal', para que los auto-envíos del alumno en left===0 entren
      // mientras el status sigue 'question'. El cierre REAL es server-side por
      // tiempo; este delay solo sincroniza el reveal visual del host. El lock
      // MANUAL (botón) sigue cerrando al instante a propósito.
      const id = setTimeout(() => void advance("lock"), 2200);
      return () => clearTimeout(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left, state?.game.status]);

  // Auto-avanzar cuando TODOS respondieron (sin esperar al timer). Comparte
  // `autoLockedRef` con el effect de tiempo agotado para evitar doble lock
  // sobre la misma ronda (question_started_at identifica la ronda actual).
  // El delay corto (800ms) deja que la UI muestre "x / x respondieron" un
  // instante antes del corte — feedback visual antes del reveal.
  // Decisión: solo automatiza el lock; reveal→leaderboard→next se controlan
  // con clicks ("Ver posiciones" / "Siguiente pregunta") para no quitarle
  // al docente el momento dramático y la lectura del aula.
  useEffect(() => {
    if (!autoAdvance) return;
    if (!state) return;
    if (state.game.status !== "question" || state.game.question_locked) return;
    if (state.players.length === 0) return;
    if (state.answer_count < state.players.length) return;
    if (autoLockedRef.current === state.game.question_started_at) return;
    autoLockedRef.current = state.game.question_started_at;
    const id = setTimeout(() => void advance("lock"), 800);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    autoAdvance,
    state?.answer_count,
    state?.players.length,
    state?.game.status,
    state?.game.question_locked,
    state?.game.question_started_at,
  ]);

  if (loading) return <PageLoader />;
  if (error || !state) {
    return (
      <div className="p-4 sm:p-8">
        <ErrorState message={t("kahoot.loadError")} hint={error ?? undefined} onRetry={() => void reload()} />
      </div>
    );
  }

  const { game, question, players, answer_count, responders_by_option } = state;
  const ranked = [...players].sort((a, b) => b.score - a.score);
  // "Todos respondieron" — habilita el highlight del botón Lock y dispara
  // el auto-advance si el toggle está ON. Requiere al menos un jugador.
  const allAnswered =
    game.status === "question" &&
    !game.question_locked &&
    players.length > 0 &&
    answer_count >= players.length;

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
          {/* Toggle "auto-avanzar cuando todos respondieron". Persistido en
              localStorage. Cuando ON + status='question' + answer_count===players.length,
              el effect llama advance("lock") tras 800 ms (ver useEffect). */}
          <label
            className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none"
            title={t("kahoot.autoAdvanceHint")}
          >
            <Zap className="h-3.5 w-3.5 text-amber-500" />
            <span>{t("kahoot.autoAdvance")}</span>
            <Switch checked={autoAdvance} onCheckedChange={toggleAutoAdvance} />
          </label>
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
                    <QRCodeSVG value={joinUrl} size={148} />
                  </div>
                  <span className="text-[11px] text-muted-foreground">{t("kahoot.scanToJoin")}</span>
                </div>
              )}
            </div>

            {/* Enlace para unirse SIN escanear: el docente lo copia y lo comparte
                (chat de clase, plataforma, proyector); el alumno lo abre y solo
                pone su correo institucional. Mismo destino que el QR. */}
            {joinUrl && (
              <div className="mx-auto w-full max-w-xl space-y-2">
                <p className="text-xs text-muted-foreground">
                  {t("kahoot.orShareLink", { defaultValue: "O comparte este enlace para unirse sin escanear:" })}
                </p>
                <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2">
                  <Link2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate text-left text-sm font-medium tabular-nums" title={joinUrl}>
                    {joinUrl.replace(/^https?:\/\//, "")}
                  </span>
                  <Button
                    size="sm"
                    variant={linkCopied ? "secondary" : "default"}
                    onClick={() => void copyJoinLink()}
                    className="shrink-0 gap-1.5"
                  >
                    {linkCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {linkCopied
                      ? t("kahoot.linkCopied", { defaultValue: "Copiado" })
                      : t("kahoot.copyLink", { defaultValue: "Copiar enlace" })}
                  </Button>
                </div>
              </div>
            )}
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

        {/* ── ¡PREPÁRATE! (cuenta regresiva antes de abrir la pregunta) ── */}
        {game.status === "question" && question && inGetReady && (
          <div
            key={`ready-${question.id}`}
            className="w-full max-w-3xl text-center space-y-6 animate-in fade-in zoom-in-95 duration-300"
          >
            <Rocket className="h-16 w-16 mx-auto text-primary animate-bounce" />
            <p className="text-lg uppercase tracking-widest text-muted-foreground">
              {t("kahoot.questionProgress", { n: game.current_index + 1, total: game.total_questions })}
            </p>
            <h1 className="text-3xl sm:text-5xl font-black">
              {t("kahoot.getReady", { defaultValue: "¡Prepárate!" })}
            </h1>
            <p className="text-xl sm:text-2xl">{question.text}</p>
            <div
              key={`ready-n-${getReady}`}
              className="mx-auto flex h-28 w-28 items-center justify-center rounded-full bg-primary text-primary-foreground text-6xl font-black tabular-nums shadow-xl animate-in zoom-in-50 duration-300"
            >
              {getReady}
            </div>
          </div>
        )}

        {/* ── PREGUNTA (host ve la correcta) ── */}
        {(game.status === "question" || game.status === "reveal") && question && !inGetReady && (
          <div className="w-full max-w-5xl space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="text-center space-y-3">
              <h1 className="text-2xl sm:text-4xl font-bold">{question.text}</h1>
              {game.status === "question" && (
                <div className="flex items-center justify-center gap-4">
                  <div
                    className={`h-16 w-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-2xl font-black tabular-nums ${left !== null && left <= 5 ? "animate-pulse ring-4 ring-primary/40" : ""}`}
                  >
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
                // Quiénes eligieron esta opción (host-only, mig 20260989000000).
                const responders = responders_by_option?.[o.id] ?? [];
                return (
                  <div
                    key={o.id}
                    className={`flex flex-col gap-2 rounded-xl ${shape.bg} text-white px-4 py-5 shadow transition-opacity animate-in fade-in zoom-in-95 duration-300 ${dim ? "opacity-40" : ""}`}
                  >
                    <div className="flex items-center gap-3 text-lg font-semibold">
                      <KahootShapeIcon icon={shape.icon} className="h-7 w-7 shrink-0" />
                      <span className="flex-1">{o.label}</span>
                      {/* El conteo POR OPCIÓN solo se muestra en el REVEAL (al
                          terminar el tiempo). Durante la pregunta la pantalla del
                          host está proyectada a la clase: mostrar cuántos van por
                          cada opción revelaría la respuesta y arrastraría el voto. */}
                      {game.status === "reveal" && (
                        <span className="tabular-nums text-base opacity-90">{responders.length}</span>
                      )}
                      {game.status === "reveal" && o.is_correct === true && (
                        <Crown className="h-6 w-6 shrink-0" />
                      )}
                    </div>
                    {/* Quiénes respondieron cada opción — SOLO en el reveal, por la
                        misma razón (no exponer quién eligió qué en vivo). */}
                    {game.status === "reveal" && responders.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {responders.map((r) => (
                          <span
                            key={r.player_id}
                            className="inline-flex max-w-[160px] items-center gap-1 truncate rounded bg-white/20 px-1.5 py-0.5 text-[11px] font-medium"
                            title={r.nickname}
                          >
                            {r.is_correct && <CheckCircle2 className="h-3 w-3 shrink-0" />}
                            <span className="truncate">{r.nickname}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex flex-col items-center gap-2">
              {game.status === "question" && (
                <>
                  <Button
                    size="lg"
                    disabled={advancing}
                    onClick={() => void advance("lock")}
                    className={allAnswered ? "animate-pulse ring-2 ring-amber-400" : ""}
                  >
                    <Lock className="h-5 w-5 mr-2" />
                    {allAnswered ? t("kahoot.lockNow") : t("kahoot.lockReveal")}
                  </Button>
                  {allAnswered && (
                    <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1">
                      <Zap className="h-3 w-3" />
                      {autoAdvance ? t("kahoot.autoAdvanceFiring") : t("kahoot.allAnswered")}
                    </span>
                  )}
                </>
              )}
              {game.status === "reveal" && (
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button
                    size="lg"
                    variant="outline"
                    disabled={advancing}
                    onClick={() => void advance("leaderboard")}
                  >
                    <Trophy className="h-5 w-5 mr-2" /> {t("kahoot.showLeaderboard")}
                  </Button>
                  {/* Atajo: saltar leaderboard y pasar directo a la siguiente
                      pregunta (o al podio si era la última). Útil cuando el
                      docente prefiere ritmo rápido sin pausa de ranking. */}
                  <Button size="lg" disabled={advancing} onClick={() => void advance("next")}>
                    <ChevronRight className="h-5 w-5 mr-2" />
                    {game.current_index + 1 >= game.total_questions
                      ? t("kahoot.showPodium")
                      : t("kahoot.nextQuestion")}
                  </Button>
                </div>
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
            <Leaderboard ranked={ranked} prevScores={lbFrom} />
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

/** Cuenta un número de `from` a `to` con easeOutCubic (~1s), driveado por
 *  requestAnimationFrame (usa el timestamp del rAF — sin Date.now/performance).
 *  Init determinista (val=from) → SSR-safe; la animación corre post-mount. */
function useCountUp(from: number, to: number, durationMs = 1000): number {
  const [val, setVal] = useState(from);
  useEffect(() => {
    if (from === to) {
      setVal(to);
      return;
    }
    let raf = 0;
    let startTs: number | null = null;
    const step = (ts: number) => {
      if (startTs === null) startTs = ts;
      const t = Math.min(1, (ts - startTs) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(from + (to - from) * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [from, to, durationMs]);
  return val;
}

function LeaderboardRow({
  rank,
  nickname,
  from,
  to,
  max,
}: {
  rank: number;
  nickname: string;
  from: number;
  to: number;
  max: number;
}) {
  // El puntaje cuenta hacia arriba; la barra crece con el MISMO valor animado
  // para que número y barra suban al unísono (efecto tipo Kahoot).
  const value = useCountUp(from, to);
  const widthPct = Math.max(18, (value / max) * 100);
  return (
    <div className="flex items-center gap-3">
      <span className="w-6 text-right font-bold tabular-nums text-muted-foreground">{rank}</span>
      <div className="flex-1 rounded-lg bg-muted/50 overflow-hidden">
        <div
          className="bg-primary/80 text-primary-foreground px-3 py-2 rounded-lg flex items-center justify-between min-w-fit"
          style={{ width: `${widthPct}%` }}
        >
          <span className="font-medium truncate">{nickname}</span>
          <span className="font-bold tabular-nums ml-2">{value}</span>
        </div>
      </div>
    </div>
  );
}

function Leaderboard({
  ranked,
  prevScores,
}: {
  ranked: { id: string; nickname: string; score: number }[];
  /** Puntaje de cada jugador en la RONDA ANTERIOR (para animar el aumento). */
  prevScores?: Record<string, number>;
}) {
  const max = Math.max(1, ...ranked.map((p) => p.score));
  return (
    <div className="space-y-2">
      {ranked.slice(0, 8).map((p, i) => (
        <LeaderboardRow
          key={p.id}
          rank={i + 1}
          nickname={p.nickname}
          from={prevScores?.[p.id] ?? 0}
          to={p.score}
          max={max}
        />
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
