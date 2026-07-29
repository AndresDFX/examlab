import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { CheckCircle2, ChevronLeft, ChevronRight, X } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { MarkdownInline } from "@/shared/components/MarkdownInline";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type PlayedQuestion = { id: string; index: number; text: string };
type ReviewOption = { id: string; label: string; position: number; is_correct: boolean };
type Review = {
  question: {
    id: string;
    index: number;
    text: string;
    image_url: string | null;
    multi_select: boolean;
    points: number;
    options: ReviewOption[];
  };
  me: { answered: boolean; my_option_ids: string[] | null; my_is_correct: boolean | null; my_points: number } | null;
};

/** Formas/colores de las 4 opciones — mismos que el juego (por posición). */
const OPT_TONE = [
  "border-rose-400/60",
  "border-sky-400/60",
  "border-amber-400/60",
  "border-emerald-400/60",
];

/**
 * Revisión SOLO LECTURA de las preguntas ya jugadas de un Reto en vivo. Permite
 * "volver" a una pregunta anterior para verla (enunciado + opciones con la
 * correcta marcada + la propia respuesta) — NUNCA se puede responder (no hay
 * botones de respuesta; el server tampoco lo permitiría). No toca el estado del
 * juego: usa RPCs read-only. Sirve al jugador autenticado (variant="authed") y al
 * público de /reto (variant="public" + playerId).
 */
export function KahootReviewDialog({
  gameId,
  variant = "authed",
  playerId,
  showMyAnswer = true,
  onClose,
}: Readonly<{
  gameId: string;
  variant?: "authed" | "public";
  playerId?: string | null;
  /** El host no marca "mi respuesta" (no jugó); alumnos sí. */
  showMyAnswer?: boolean;
  onClose: () => void;
}>) {
  const { t } = useTranslation();
  const [list, setList] = useState<PlayedQuestion[] | null>(null);
  const [pos, setPos] = useState(0);
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const listRpc = variant === "public" ? "kahoot_list_played_questions_public" : "kahoot_list_played_questions";
  const reviewRpc = variant === "public" ? "kahoot_get_question_review_public" : "kahoot_get_question_review";

  // Cargar la lista de preguntas jugadas (una vez).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const args = variant === "public" ? { _game_id: gameId, _player_id: playerId } : { _game_id: gameId };
      const { data, error: e } = await db.rpc(listRpc, args);
      if (cancelled) return;
      if (e) {
        setError(friendlyError(e));
        setLoading(false);
        return;
      }
      const played = (data ?? []) as PlayedQuestion[];
      setList(played);
      // Arrancar en la última jugada (la más reciente) — es lo más útil.
      setPos(Math.max(0, played.length - 1));
      if (played.length === 0) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, variant, playerId, listRpc]);

  // Cargar la revisión de la pregunta en `pos`.
  const loadReview = useCallback(
    async (qid: string) => {
      setLoading(true);
      setError(null);
      const args =
        variant === "public"
          ? { _game_id: gameId, _player_id: playerId, _question_id: qid }
          : { _game_id: gameId, _question_id: qid };
      const { data, error: e } = await db.rpc(reviewRpc, args);
      if (e) {
        setError(friendlyError(e));
        setReview(null);
      } else {
        setReview(data as Review);
      }
      setLoading(false);
    },
    [gameId, variant, playerId, reviewRpc],
  );

  useEffect(() => {
    if (!list || list.length === 0) return;
    const q = list[pos];
    if (q) void loadReview(q.id);
  }, [list, pos, loadReview]);

  const total = list?.length ?? 0;
  const myIds = new Set(review?.me?.my_option_ids ?? []);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <span>{t("kahootReview.title", { defaultValue: "Revisar preguntas" })}</span>
            {total > 0 && (
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {t("kahootReview.counter", {
                  defaultValue: "{{n}} de {{total}}",
                  n: pos + 1,
                  total,
                })}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {total === 0 && !loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {error ?? t("kahootReview.empty", { defaultValue: "Todavía no hay preguntas para revisar." })}
          </p>
        ) : (
          <div className="space-y-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {loading || !review ? (
              <div className="flex justify-center py-10">
                <Spinner size="md" />
              </div>
            ) : (
              <>
                <div className="text-sm font-medium">
                  <MarkdownInline>{review.question.text}</MarkdownInline>
                </div>
                <div className="space-y-1.5">
                  {review.question.options.map((o) => {
                    const chosen = myIds.has(o.id);
                    return (
                      <div
                        key={o.id}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${OPT_TONE[o.position % 4]} ${
                          o.is_correct
                            ? "bg-emerald-500/10 border-emerald-500/60 font-medium"
                            : chosen
                              ? "bg-muted"
                              : "opacity-70"
                        }`}
                      >
                        {o.is_correct && (
                          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                        )}
                        <span className="flex-1">{o.label}</span>
                        {chosen && (
                          <span className="text-3xs rounded bg-foreground/10 px-1.5 py-0.5">
                            {t("kahootReview.yourChoice", { defaultValue: "Tu respuesta" })}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {showMyAnswer && review.me?.answered && (
                  <p
                    className={`text-sm font-medium ${
                      review.me.my_is_correct
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-destructive"
                    }`}
                  >
                    {review.me.my_is_correct
                      ? t("kahootReview.gotItRight", { defaultValue: "Acertaste (+{{pts}} pts)", pts: review.me.my_points })
                      : t("kahootReview.gotItWrong", { defaultValue: "No acertaste" })}
                  </p>
                )}
                {showMyAnswer && review.me && !review.me.answered && (
                  <p className="text-sm text-muted-foreground">
                    {t("kahootReview.notAnswered", { defaultValue: "No respondiste esta pregunta." })}
                  </p>
                )}
              </>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                disabled={pos <= 0 || loading}
                onClick={() => setPos((p) => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                {t("kahootReview.prev", { defaultValue: "Anterior" })}
              </Button>
              <Button variant="ghost" size="sm" onClick={onClose}>
                <X className="h-4 w-4 mr-1" />
                {t("kahootReview.backToLive", { defaultValue: "Volver al vivo" })}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pos >= total - 1 || loading}
                onClick={() => setPos((p) => Math.min(total - 1, p + 1))}
              >
                {t("kahootReview.next", { defaultValue: "Siguiente" })}
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
