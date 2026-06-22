/**
 * Vista JUGADOR del Kahoot en vivo (estudiante). Sigue el estado del juego
 * (`useKahootGame`) y muestra la pantalla apropiada por fase. En la fase de
 * pregunta toca una de las 4 formas de color para responder; el puntaje lo
 * calcula el servidor (`kahoot_submit_answer`). NUNCA ve la respuesta
 * correcta antes del reveal (la RLS + el RPC lo garantizan).
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
import { KAHOOT_SHAPES, secondsLeft, getReadySecondsLeft } from "@/modules/polls/kahoot";
import { KahootShapeIcon } from "@/modules/polls/KahootShapeIcon";
import { CheckCircle2, XCircle, Trophy, Crown, Hourglass, Rocket } from "lucide-react";

export const Route = createFileRoute("/app/student/kahoot/$gameId")({ component: KahootPlayer });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

function KahootPlayer() {
  const { gameId } = Route.useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, loading, error, reload } = useKahootGame(gameId);
  const [submitting, setSubmitting] = useState(false);
  // Opciones marcadas por el alumno. Single: se setea [id] al tocar y se envía
  // al instante. Multiple: se togglean varias y se envían con "Confirmar".
  const [selected, setSelected] = useState<string[]>([]);
  const [nowMs, setNowMs] = useState(0);
  // Id de la pregunta para la que YA disparamos un submit (auto por timeout o
  // tap single). Evita el doble-disparo del auto-envío. Se limpia al cambiar
  // de pregunta.
  const autoSentRef = useRef<string | null>(null);

  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // Reset de la selección cuando cambia la pregunta activa.
  useEffect(() => {
    setSelected([]);
    autoSentRef.current = null;
  }, [state?.question?.id]);

  const submit = async (optionIds: string[], allowEmpty = false) => {
    // allowEmpty=true SOLO desde el auto-envío por timeout (participación en
    // blanco). En interacción normal seguimos exigiendo ≥1 opción.
    if ((optionIds.length === 0 && !allowEmpty) || submitting) return;
    setSubmitting(true);
    try {
      const { error: e } = await db.rpc("kahoot_submit_answer", { _game_id: gameId, _option_ids: optionIds });
      if (e) {
        toast.error(friendlyError(e));
        return;
      }
      await reload();
    } finally {
      setSubmitting(false);
    }
  };

  // Auto-envío al agotarse el tiempo (una vez por pregunta). Single ya auto-
  // envía al tocar; acá cubrimos multiple-sin-confirmar y "no tocó nada"
  // (envío en blanco → participación). El cierre REAL lo valida el servidor con
  // su ventana de gracia; este disparo es UX, no autoridad.
  useEffect(() => {
    if (!state) return;
    const { game, question, me } = state;
    if (game.status !== "question" || !question || !me || me.answered) return;
    if (submitting) return;
    const lft = secondsLeft(game.question_started_at, question.time_limit_seconds, nowMs);
    if (lft === null || lft > 0) return;
    if (autoSentRef.current === question.id) return;
    autoSentRef.current = question.id;
    void submit(selected, /* allowEmpty */ true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, nowMs, selected, submitting]);

  if (loading) return <PageLoader />;
  if (error || !state) {
    return (
      <div className="p-4 sm:p-8">
        <ErrorState message={t("kahoot.loadError")} hint={error ?? undefined} onRetry={() => void reload()} />
      </div>
    );
  }

  const { game, question, me } = state;
  const left =
    question && game.status === "question"
      ? secondsLeft(game.question_started_at, question.time_limit_seconds, nowMs)
      : null;
  // Cuenta regresiva "¡Prepárate!": question_started_at se fija unos segundos
  // en el futuro (mig 20260989000000); mientras tanto NO mostramos las opciones,
  // solo el splash. El cronómetro real (left) ya devuelve el límite completo.
  const getReady =
    question && game.status === "question"
      ? getReadySecondsLeft(game.question_started_at, nowMs)
      : null;
  // nowMs arranca en 0 (init determinista SSR-safe); hasta que el effect ponga
  // Date.now() NO evaluamos el splash, si no el primer frame mostraría un número
  // gigante (getReadySecondsLeft(started, 0) ≈ epoch/1000).
  const inGetReady = nowMs > 0 && getReady !== null && getReady > 0;
  // Docente ausente (heartbeat stale) y el juego no terminó → "Esperando al
  // docente…" en vez de la fase activa. NO lo sacamos de la sesión: cuando el
  // docente vuelve, host_present pasa a true y se reanuda la fase normal.
  const hostAway = !game.host_present && game.status !== "ended" && game.status !== "podium";

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/40 flex flex-col items-center justify-center p-4 gap-5">
      {/* Encabezado del jugador */}
      <div className="w-full max-w-md flex items-center justify-between">
        <Badge variant="secondary" className="text-sm py-1 px-3">
          {me?.nickname ?? t("kahoot.spectator")}
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

      {/* ── ESPERANDO AL DOCENTE (host ausente) ── */}
      {hostAway && (
        <Card className="w-full max-w-md">
          <CardContent className="p-4 sm:p-8 text-center space-y-3">
            <Hourglass className="h-10 w-10 mx-auto text-amber-500 animate-pulse" />
            <h1 className="text-xl font-bold">{t("kahoot.hostAwayTitle")}</h1>
            <p className="text-muted-foreground text-sm">{t("kahoot.hostAwayBody")}</p>
            {me && <Badge className="text-base py-1 px-4">{me.nickname}</Badge>}
          </CardContent>
        </Card>
      )}

      {/* ── LOBBY ── */}
      {!hostAway && game.status === "lobby" && (
        <Card className="w-full max-w-md">
          <CardContent className="p-4 sm:p-8 text-center space-y-3">
            <Hourglass className="h-10 w-10 mx-auto text-primary animate-pulse" />
            <h1 className="text-xl font-bold">{t("kahoot.youAreIn")}</h1>
            <p className="text-muted-foreground text-sm">{t("kahoot.waitForHost")}</p>
            <Badge className="text-base py-1 px-4">{me?.nickname}</Badge>
          </CardContent>
        </Card>
      )}

      {/* ── ¡PREPÁRATE! (cuenta regresiva antes de abrir la pregunta) ── */}
      {!hostAway && game.status === "question" && question && inGetReady && (
        <div
          key={`ready-${question.id}`}
          className="w-full max-w-md text-center space-y-5 animate-in fade-in zoom-in-95 duration-300"
        >
          <Rocket className="h-12 w-12 mx-auto text-primary animate-bounce" />
          <h1 className="text-2xl font-black">{t("kahoot.getReady", { defaultValue: "¡Prepárate!" })}</h1>
          <p className="text-base text-muted-foreground">{question.text}</p>
          <div
            key={`ready-n-${getReady}`}
            className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-primary text-primary-foreground text-5xl font-black tabular-nums shadow-lg animate-in zoom-in-50 duration-300"
          >
            {getReady}
          </div>
        </div>
      )}

      {/* ── PREGUNTA ── */}
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
            // Bloqueo visual inmediato: apenas el cronómetro llega a 0 (o el
            // server confirma me.answered) deshabilitamos la grilla y mostramos
            // espera, sin aguardar el round-trip del auto-envío.
            <Card>
              <CardContent className="p-4 sm:p-8 text-center space-y-2">
                {me?.answered ? (
                  <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-500" />
                ) : (
                  <Hourglass className="h-10 w-10 mx-auto text-amber-500" />
                )}
                <p className="font-semibold">
                  {me?.answered ? t("kahoot.answerSent") : t("kahoot.timeUpTitle")}
                </p>
                <p className="text-sm text-muted-foreground">{t("kahoot.waitOthers")}</p>
              </CardContent>
            </Card>
          ) : me ? (
            <>
              {question.multi_select && (
                <p className="text-center text-xs font-medium text-muted-foreground">
                  {t("kahoot.multiSelectHint")}
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {question.options.map((o) => {
                  const shape = KAHOOT_SHAPES[o.position] ?? KAHOOT_SHAPES[0];
                  const isSel = selected.includes(o.id);
                  const onPick = () => {
                    if (submitting) return;
                    if (question.multi_select) {
                      setSelected((s) => (s.includes(o.id) ? s.filter((x) => x !== o.id) : [...s, o.id]));
                    } else {
                      // Single: marcar + enviar al instante (Kahoot clásico).
                      // Marcamos el ref para que el effect de timeout no
                      // re-dispare un envío en blanco si el tap está en vuelo.
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
                  {t("kahoot.confirmAnswer")}
                </Button>
              )}
            </>
          ) : (
            <Card>
              <CardContent className="p-4 sm:p-8 text-center text-sm text-muted-foreground">
                {t("kahoot.spectatorHint")}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── REVEAL (resultado de mi respuesta) ── */}
      {!hostAway && game.status === "reveal" && me && (
        <Card className="w-full max-w-md animate-in fade-in zoom-in-95 duration-300">
          <CardContent className="p-4 sm:p-8 text-center space-y-3">
            {me.my_is_correct === true ? (
              <>
                <CheckCircle2 className="h-14 w-14 mx-auto text-emerald-500" />
                <h1 className="text-2xl font-black text-emerald-600 dark:text-emerald-400">
                  {t("kahoot.correct")}
                </h1>
                <p className="text-lg font-semibold">+{me.my_points}</p>
              </>
            ) : me.answered ? (
              <>
                <XCircle className="h-14 w-14 mx-auto text-rose-500" />
                <h1 className="text-2xl font-black text-rose-600 dark:text-rose-400">{t("kahoot.incorrect")}</h1>
              </>
            ) : (
              <>
                <Hourglass className="h-14 w-14 mx-auto text-muted-foreground" />
                <h1 className="text-xl font-bold text-muted-foreground">{t("kahoot.noAnswer")}</h1>
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

      {/* ── LEADERBOARD ── */}
      {!hostAway && game.status === "leaderboard" && me && (
        <Card className="w-full max-w-md animate-in fade-in zoom-in-95 duration-300">
          <CardContent className="p-4 sm:p-8 text-center space-y-3">
            <Trophy className="h-12 w-12 mx-auto text-amber-500" />
            <p className="text-sm text-muted-foreground">{t("kahoot.yourPosition")}</p>
            <p className="text-5xl font-black tabular-nums">#{me.rank}</p>
            <p className="text-lg font-semibold tabular-nums">{me.score} {t("kahoot.points")}</p>
          </CardContent>
        </Card>
      )}

      {/* ── PODIO / FIN ── */}
      {(game.status === "podium" || game.status === "ended") && (
        <Card className="w-full max-w-md animate-in fade-in zoom-in-95 duration-500">
          <CardContent className="p-4 sm:p-8 text-center space-y-3">
            {me && me.rank <= 3 ? (
              <Crown className="h-14 w-14 mx-auto text-amber-500" />
            ) : (
              <Trophy className="h-14 w-14 mx-auto text-muted-foreground" />
            )}
            <h1 className="text-2xl font-black">{t("kahoot.gameOver")}</h1>
            {me && (
              <>
                <p className="text-5xl font-black tabular-nums">#{me.rank}</p>
                <p className="text-lg font-semibold tabular-nums">
                  {me.score} {t("kahoot.points")}
                </p>
              </>
            )}
            {game.status === "ended" && (
              <Button variant="outline" onClick={() => navigate({ to: "/app/student/polls" })}>
                {t("kahoot.backToPolls")}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
