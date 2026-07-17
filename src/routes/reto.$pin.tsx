/**
 * Reto en vivo PÚBLICO — unirse escaneando el QR SIN loguearse.
 *
 * Ruta: /reto/<pin>   (pública, fuera de /app → sin AppLayout ni auth guard)
 *
 * Flujo:
 *   1) El jugador escanea el QR → aterriza acá con el PIN.
 *   2) Ingresa su CORREO INSTITUCIONAL (sin login). El RPC anon
 *      `kahoot_join_public(pin, email)` valida que el correo esté matriculado
 *      en el curso del reto (si no, lo rechaza) y que nadie más se haya unido
 *      con ese correo (un jugador por correo). Devuelve un TOKEN (player_id).
 *   3) Guardamos el token en localStorage (keyed por PIN) para poder RESUMIR
 *      en el mismo dispositivo sin re-unirse, y entramos a jugar.
 *
 * La seguridad la enforzan los RPCs `kahoot_*_public` (SECURITY DEFINER,
 * GRANT anon). El PIN por sí solo no da acceso: hace falta un correo
 * matriculado. El puntaje lo calcula el server (misma fórmula que el flujo
 * logueado).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { usePublicKahootGame } from "@/modules/polls/use-public-kahoot-game";
import { KAHOOT_SHAPES, secondsLeft, getReadySecondsLeft } from "@/modules/polls/kahoot";
import { KahootShapeIcon } from "@/modules/polls/KahootShapeIcon";
import {
  CheckCircle2,
  XCircle,
  Trophy,
  Crown,
  Hourglass,
  Rocket,
  Radio,
  Mail,
} from "lucide-react";

export const Route = createFileRoute("/reto/$pin")({
  head: () => ({
    meta: [{ title: "Reto en vivo · ExamLab" }, { name: "robots", content: "noindex, nofollow" }],
  }),
  component: RetoPublic,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface StoredPlayer {
  playerId: string;
  gameId: string;
  nickname: string;
}

const storageKey = (pin: string) => `examlab_reto:${pin}`;

function readStored(pin: string): StoredPlayer | null {
  try {
    const raw = localStorage.getItem(storageKey(pin));
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.playerId === "string" && typeof p.gameId === "string") return p as StoredPlayer;
  } catch {
    /* noop */
  }
  return null;
}

function RetoPublic() {
  const { pin } = Route.useParams();
  // Init determinista SSR-safe: NO leemos localStorage en el initializer
  // (hydration mismatch, ver CLAUDE.md). Lo cargamos en un effect post-mount.
  const [player, setPlayer] = useState<StoredPlayer | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPlayer(readStored(pin));
    setHydrated(true);
  }, [pin]);

  const onJoined = (p: StoredPlayer) => {
    try {
      localStorage.setItem(storageKey(pin), JSON.stringify(p));
    } catch {
      /* noop */
    }
    setPlayer(p);
  };

  const onReset = () => {
    try {
      localStorage.removeItem(storageKey(pin));
    } catch {
      /* noop */
    }
    setPlayer(null);
  };

  if (!hydrated) return null;
  if (!player) return <EmailGate pin={pin} onJoined={onJoined} />;
  return <RetoPlay pin={pin} player={player} onReset={onReset} />;
}

// ── Compuerta de correo institucional ──
function EmailGate({ pin, onJoined }: { pin: string; onJoined: (p: StoredPlayer) => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const join = async () => {
    const clean = email.trim();
    if (!clean || clean.indexOf("@") < 1) {
      toast.error("Ingresa un correo institucional válido");
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await db.rpc("kahoot_join_public", { _pin: pin, _email: clean });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      onJoined({ playerId: data.player_id, gameId: data.game_id, nickname: data.nickname });
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/40 flex flex-col items-center justify-center p-4 gap-5">
      <div className="flex items-center gap-2 text-primary">
        <Radio className="h-6 w-6" />
        <span className="text-lg font-black tracking-tight">Reto en vivo</span>
      </div>
      <Card className="w-full max-w-sm">
        <CardContent className="p-6 space-y-4">
          <div className="text-center space-y-1">
            <h1 className="text-xl font-bold">Únete al reto</h1>
            <p className="text-sm text-muted-foreground">
              Ingresa tu <strong>correo institucional</strong> para participar. No necesitas iniciar sesión.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reto-email" required>
              Correo institucional
            </Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="reto-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="tu.nombre@institucion.edu.co"
                className="pl-9"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !busy) void join();
                }}
                disabled={busy}
              />
            </div>
          </div>
          <Button className="w-full" size="lg" disabled={busy} onClick={() => void join()}>
            {busy ? <Spinner size="sm" className="mr-2" /> : null}
            Entrar al reto
          </Button>
          <p className="text-center text-[11px] leading-tight text-muted-foreground">
            Solo pueden participar los correos matriculados en el curso. Un jugador por correo.
          </p>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground tabular-nums">PIN {pin}</p>
    </div>
  );
}

// ── Juego (mismo flujo que el jugador logueado, con token público) ──
function RetoPlay({
  pin,
  player,
  onReset,
}: {
  pin: string;
  player: StoredPlayer;
  onReset: () => void;
}) {
  const { state, loading, error, reload } = usePublicKahootGame(player.gameId, player.playerId);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const autoSentRef = useRef<string | null>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setSelected([]);
    autoSentRef.current = null;
  }, [state?.question?.id]);

  const submit = async (optionIds: string[], allowEmpty = false) => {
    if ((optionIds.length === 0 && !allowEmpty) || submitting) return;
    setSubmitting(true);
    try {
      const { error: e } = await db.rpc("kahoot_answer_public", {
        _player_id: player.playerId,
        _option_ids: optionIds,
      });
      if (e) {
        toast.error(friendlyError(e));
        return;
      }
      await reload();
    } finally {
      setSubmitting(false);
    }
  };

  // Auto-envío al agotarse el tiempo (una vez por pregunta) — igual que el
  // jugador logueado. El cierre real lo valida el server con su ventana de gracia.
  useEffect(() => {
    if (!state) return;
    const { game, question, me } = state;
    if (game.status !== "question" || !question || !me || me.answered) return;
    if (submitting) return;
    const lft = secondsLeft(game.question_started_at, question.time_limit_seconds, nowMs);
    if (lft === null || lft > 0) return;
    if (autoSentRef.current === question.id) return;
    autoSentRef.current = question.id;
    void submit(selected, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, nowMs, selected, submitting]);

  const left = useMemo(() => {
    if (!state?.question || state.game.status !== "question") return null;
    return secondsLeft(state.game.question_started_at, state.question.time_limit_seconds, nowMs);
  }, [state, nowMs]);

  if (loading && !state) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }
  if (error && !state) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 gap-4">
        <ErrorState
          message="No pudimos conectarte al reto"
          hint="El reto pudo haber terminado o el enlace ya no es válido."
          onRetry={() => void reload()}
        />
        <Button variant="outline" onClick={onReset}>
          Usar otro correo
        </Button>
      </div>
    );
  }
  if (!state) return null;

  const { game, question, me } = state;
  const getReady =
    question && game.status === "question" ? getReadySecondsLeft(game.question_started_at, nowMs) : null;
  const inGetReady = nowMs > 0 && getReady !== null && getReady > 0;
  const hostAway = !game.host_present && game.status !== "ended" && game.status !== "podium";

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/40 flex flex-col items-center justify-center p-4 gap-5">
      {/* Encabezado del jugador */}
      <div className="w-full max-w-md flex items-center justify-between">
        <Badge variant="secondary" className="text-sm py-1 px-3 max-w-[60vw] truncate">
          {me?.nickname ?? player.nickname}
        </Badge>
        {me && (
          <div className="flex items-center gap-2 text-sm">
            <Badge variant="outline" className="gap-1 tabular-nums">
              <Trophy className="h-3 w-3" /> {me.score}
            </Badge>
            <Badge variant="outline" className="tabular-nums">
              #{me.rank}
            </Badge>
          </div>
        )}
      </div>

      {/* Host ausente */}
      {hostAway && (
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center space-y-3">
            <Hourglass className="h-10 w-10 mx-auto text-amber-500 animate-pulse" />
            <h1 className="text-xl font-bold">Esperando al docente…</h1>
            <p className="text-muted-foreground text-sm">
              El docente no está presente en la sala. Cuando regrese, el reto continúa.
            </p>
            {me && <Badge className="text-base py-1 px-4">{me.nickname}</Badge>}
          </CardContent>
        </Card>
      )}

      {/* Lobby */}
      {!hostAway && game.status === "lobby" && (
        <Card className="w-full max-w-md">
          <CardContent className="p-6 text-center space-y-3">
            <Hourglass className="h-10 w-10 mx-auto text-primary animate-pulse" />
            <h1 className="text-xl font-bold">¡Ya estás dentro!</h1>
            <p className="text-muted-foreground text-sm">Espera a que el docente inicie el reto.</p>
            <Badge className="text-base py-1 px-4">{me?.nickname}</Badge>
          </CardContent>
        </Card>
      )}

      {/* ¡Prepárate! */}
      {!hostAway && game.status === "question" && question && inGetReady && (
        <div
          key={`ready-${question.id}`}
          className="w-full max-w-md text-center space-y-5 animate-in fade-in zoom-in-95 duration-300"
        >
          <Rocket className="h-12 w-12 mx-auto text-primary animate-bounce" />
          <h1 className="text-2xl font-black">¡Prepárate!</h1>
          <p className="text-base text-muted-foreground">{question.text}</p>
          <div
            key={`ready-n-${getReady}`}
            className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-primary text-primary-foreground text-5xl font-black tabular-nums shadow-lg animate-in zoom-in-50 duration-300"
          >
            {getReady}
          </div>
        </div>
      )}

      {/* Pregunta */}
      {!hostAway && game.status === "question" && question && !inGetReady && (
        <div className="w-full max-w-xl space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="text-center space-y-2">
            <h1 className="text-xl sm:text-2xl font-bold">{question.text}</h1>
            <div
              className={`h-12 w-12 mx-auto rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xl font-black tabular-nums ${left !== null && left <= 5 ? "animate-pulse ring-4 ring-primary/40" : ""}`}
            >
              {left ?? "—"}
            </div>
          </div>

          {me?.answered || (left !== null && left <= 0) ? (
            <Card>
              <CardContent className="p-6 text-center space-y-2">
                {me?.answered ? (
                  <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-500" />
                ) : (
                  <Hourglass className="h-10 w-10 mx-auto text-amber-500" />
                )}
                <p className="font-semibold">{me?.answered ? "¡Respuesta enviada!" : "¡Tiempo!"}</p>
                <p className="text-sm text-muted-foreground">Espera a los demás…</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {question.multi_select && (
                <p className="text-center text-xs font-medium text-muted-foreground">
                  Puedes marcar varias opciones y confirmar.
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {question.options.map((o) => {
                  const shape = KAHOOT_SHAPES[o.position] ?? KAHOOT_SHAPES[0];
                  const isSel = selected.includes(o.id);
                  const onPick = () => {
                    if (submitting) return;
                    if (question.multi_select) {
                      setSelected((s) =>
                        s.includes(o.id) ? s.filter((x) => x !== o.id) : [...s, o.id],
                      );
                    } else {
                      autoSentRef.current = question.id;
                      setSelected([o.id]);
                      void submit([o.id]);
                    }
                  };
                  return (
                    <button
                      key={o.id}
                      type="button"
                      disabled={submitting}
                      onClick={onPick}
                      className={`flex items-center gap-3 rounded-xl ${shape.bg} text-white px-4 py-6 text-lg font-semibold shadow transition-transform hover:scale-[1.02] active:scale-[0.98] disabled:opacity-60 animate-in fade-in zoom-in-95 duration-300 ${
                        isSel ? "ring-4 ring-white/80 scale-[1.02]" : ""
                      }`}
                    >
                      {submitting && isSel && !question.multi_select ? (
                        <Spinner size="sm" className="text-white" />
                      ) : question.multi_select && isSel ? (
                        <CheckCircle2 className="h-7 w-7 shrink-0" />
                      ) : (
                        <KahootShapeIcon icon={shape.icon} className="h-7 w-7 shrink-0" />
                      )}
                      <span className="flex-1 text-left">{o.label}</span>
                    </button>
                  );
                })}
              </div>
              {question.multi_select && (
                <Button
                  size="lg"
                  className="w-full"
                  disabled={submitting || selected.length === 0}
                  onClick={() => void submit(selected)}
                >
                  {submitting ? <Spinner size="sm" className="mr-2" /> : null}
                  Confirmar respuesta
                </Button>
              )}
            </>
          )}
        </div>
      )}

      {/* Reveal */}
      {!hostAway && game.status === "reveal" && me && (
        <Card className="w-full max-w-md animate-in fade-in zoom-in-95 duration-300">
          <CardContent className="p-6 text-center space-y-3">
            {me.my_is_correct === true ? (
              <>
                <CheckCircle2 className="h-14 w-14 mx-auto text-emerald-500" />
                <h1 className="text-2xl font-black text-emerald-600 dark:text-emerald-400">¡Correcto!</h1>
                <p className="text-lg font-semibold">+{me.my_points}</p>
              </>
            ) : me.answered ? (
              <>
                <XCircle className="h-14 w-14 mx-auto text-rose-500" />
                <h1 className="text-2xl font-black text-rose-600 dark:text-rose-400">Incorrecto</h1>
              </>
            ) : (
              <>
                <Hourglass className="h-14 w-14 mx-auto text-muted-foreground" />
                <h1 className="text-xl font-bold text-muted-foreground">Sin respuesta</h1>
              </>
            )}
            <div className="flex items-center justify-center gap-2 pt-2">
              <Badge variant="outline" className="gap-1 tabular-nums">
                <Trophy className="h-3 w-3" /> {me.score}
              </Badge>
              <Badge variant="outline" className="tabular-nums">
                #{me.rank}
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Leaderboard */}
      {!hostAway && game.status === "leaderboard" && me && (
        <Card className="w-full max-w-md animate-in fade-in zoom-in-95 duration-300">
          <CardContent className="p-6 text-center space-y-3">
            <Trophy className="h-12 w-12 mx-auto text-amber-500" />
            <p className="text-sm text-muted-foreground">Tu posición</p>
            <p className="text-5xl font-black tabular-nums">#{me.rank}</p>
            <p className="text-lg font-semibold tabular-nums">{me.score} pts</p>
          </CardContent>
        </Card>
      )}

      {/* Podio / Fin */}
      {(game.status === "podium" || game.status === "ended") && (
        <Card className="w-full max-w-md animate-in fade-in zoom-in-95 duration-500">
          <CardContent className="p-6 text-center space-y-3">
            {me && me.rank <= 3 ? (
              <Crown className="h-14 w-14 mx-auto text-amber-500" />
            ) : (
              <Trophy className="h-14 w-14 mx-auto text-muted-foreground" />
            )}
            <h1 className="text-2xl font-black">¡Fin del reto!</h1>
            {me && (
              <>
                <p className="text-5xl font-black tabular-nums">#{me.rank}</p>
                <p className="text-lg font-semibold tabular-nums">{me.score} pts</p>
              </>
            )}
            {game.status === "ended" && (
              <p className="text-xs text-muted-foreground">Gracias por participar. Ya puedes cerrar esta página.</p>
            )}
          </CardContent>
        </Card>
      )}
      <p className="text-[11px] text-muted-foreground tabular-nums">PIN {pin}</p>
    </div>
  );
}
