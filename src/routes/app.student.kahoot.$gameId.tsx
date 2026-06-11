/**
 * Vista JUGADOR del Kahoot en vivo (estudiante). Sigue el estado del juego
 * (`useKahootGame`) y muestra la pantalla apropiada por fase. En la fase de
 * pregunta toca una de las 4 formas de color para responder; el puntaje lo
 * calcula el servidor (`kahoot_submit_answer`). NUNCA ve la respuesta
 * correcta antes del reveal (la RLS + el RPC lo garantizan).
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
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
import { KAHOOT_SHAPES, secondsLeft } from "@/modules/polls/kahoot";
import { KahootShapeIcon } from "@/modules/polls/KahootShapeIcon";
import { CheckCircle2, XCircle, Trophy, Crown, Hourglass } from "lucide-react";

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

  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // Reset de la selección cuando cambia la pregunta activa.
  useEffect(() => {
    setSelected([]);
  }, [state?.question?.id]);

  const submit = async (optionIds: string[]) => {
    if (optionIds.length === 0 || submitting) return;
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
          <CardContent className="p-8 text-center space-y-3">
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
          <CardContent className="p-8 text-center space-y-3">
            <Hourglass className="h-10 w-10 mx-auto text-primary animate-pulse" />
            <h1 className="text-xl font-bold">{t("kahoot.youAreIn")}</h1>
            <p className="text-muted-foreground text-sm">{t("kahoot.waitForHost")}</p>
            <Badge className="text-base py-1 px-4">{me?.nickname}</Badge>
          </CardContent>
        </Card>
      )}

      {/* ── PREGUNTA ── */}
      {!hostAway && game.status === "question" && question && (
        <div className="w-full max-w-xl space-y-4">
          <div className="text-center space-y-2">
            <h1 className="text-xl sm:text-2xl font-bold">{question.text}</h1>
            <div className="h-12 w-12 mx-auto rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xl font-black tabular-nums">
              {left ?? "—"}
            </div>
          </div>

          {me?.answered ? (
            <Card>
              <CardContent className="p-8 text-center space-y-2">
                <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-500" />
                <p className="font-semibold">{t("kahoot.answerSent")}</p>
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
                      className={`flex items-center gap-3 rounded-xl ${shape.bg} text-white px-4 py-6 text-lg font-semibold shadow active:scale-[0.98] transition-transform disabled:opacity-60 ${
                        isSel ? "ring-4 ring-white/80" : ""
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
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                {t("kahoot.spectatorHint")}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* ── REVEAL (resultado de mi respuesta) ── */}
      {!hostAway && game.status === "reveal" && me && (
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-3">
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
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-3">
            <Trophy className="h-12 w-12 mx-auto text-amber-500" />
            <p className="text-sm text-muted-foreground">{t("kahoot.yourPosition")}</p>
            <p className="text-5xl font-black tabular-nums">#{me.rank}</p>
            <p className="text-lg font-semibold tabular-nums">{me.score} {t("kahoot.points")}</p>
          </CardContent>
        </Card>
      )}

      {/* ── PODIO / FIN ── */}
      {(game.status === "podium" || game.status === "ended") && (
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-3">
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
