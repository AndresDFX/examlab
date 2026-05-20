import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Spinner } from "@/components/ui/spinner";
import { AlertTriangle, Bot, Check, Users } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";

/**
 * Modal de "Revisión de integridad" por estudiante. Une las dos señales
 * (sospecha de IA a nivel submission + pares de copia por pregunta) en
 * una sola vista accionable. Sustituye al `<FraudPanel>` cuando lo
 * abrimos desde el grid del monitor.
 *
 * - La sospecha IA es a nivel submission (no por pregunta) — no hay
 *   forma actual de saber qué pregunta disparó la sospecha.
 * - Las copias SÍ tienen `question_id` cuando aplica — mostramos una
 *   fila por pregunta con `peerName` y un score.
 * - "Sugerencia combinada" = currentGrade × (1 - max(aiScore, copyMax)).
 *   El docente puede editar el valor antes de aplicar.
 */

export type IntegrityKind = "exam" | "workshop" | "project";

export interface IntegrityAiSignal {
  submissionId: string;
  score: number;
  reasons: string | null;
  reviewedAt: string | null;
}

export interface IntegrityCopyPair {
  id: string;
  questionId: string | null;
  peerId: string;
  score: number;
  reasons: string | null;
  reviewedAt: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: IntegrityKind;
  /** Estudiante objetivo del modal. */
  userId: string;
  userName: string;
  /** Submission del estudiante para este examen/taller/proyecto. */
  submissionId: string | null;
  /** Nota actual (override > IA). Null si no se ha calificado. */
  currentGrade: number | null;
  /** Máx. de la escala (5 para exámenes, max_score para taller/proyecto). */
  maxScore: number;
  /** Datos pre-cargados por el padre. */
  aiSignal: IntegrityAiSignal | null;
  copyPairs: IntegrityCopyPair[];
  questionLabels: Record<string, string>;
  userNames: Record<string, string>;
  /** Callback que persiste la nota override y refresca el estado en el padre. */
  onApplyGrade: (gradeToApply: number) => Promise<{ ok: boolean; error?: string }>;
  /** Callbacks para marcar revisado. Devuelven true si OK. */
  onToggleAiReviewed: (submissionId: string, currentlyReviewed: boolean) => Promise<boolean>;
  onToggleCopyReviewed: (pairId: string, currentlyReviewed: boolean) => Promise<boolean>;
}

const INTEGRITY_THRESHOLD = 0.6;

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function scoreVariant(score: number): "destructive" | "default" | "secondary" {
  if (score >= 0.85) return "destructive";
  if (score >= 0.7) return "default";
  return "secondary";
}

function shortName(userId: string, names: Record<string, string>): string {
  return names[userId] ?? userId.slice(0, 8);
}

/** Texto largo con toggle "Ver más"/"Ver menos". Útil para razones de IA
 *  que pueden ser de varios párrafos y rompían el grid. */
export function CollapsibleReasons({ text }: { text: string | null }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (!text) return <span className="text-xs text-muted-foreground">—</span>;
  const isLong = text.length > 180;
  if (!isLong) return <p className="text-xs text-muted-foreground whitespace-pre-wrap">{text}</p>;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground whitespace-pre-wrap">
        {expanded ? text : `${text.slice(0, 180)}…`}
      </p>
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="text-[11px] text-primary hover:underline"
      >
        {expanded ? t("integrity.showLess") : t("integrity.showMore")}
      </button>
    </div>
  );
}

export function IntegrityReviewDialog({
  open,
  onOpenChange,
  userName,
  currentGrade,
  maxScore,
  aiSignal,
  copyPairs,
  questionLabels,
  userNames,
  submissionId,
  onApplyGrade,
  onToggleAiReviewed,
  onToggleCopyReviewed,
}: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [editedSuggestion, setEditedSuggestion] = useState<number | null | undefined>(undefined);

  const aiScore = aiSignal?.score ?? 0;
  const copyMax = useMemo(() => copyPairs.reduce((m, p) => Math.max(m, p.score), 0), [copyPairs]);
  const severity = Math.max(
    aiScore >= INTEGRITY_THRESHOLD ? aiScore : 0,
    copyMax >= INTEGRITY_THRESHOLD ? copyMax : 0,
  );
  const computedSuggestion =
    severity > 0 && currentGrade != null
      ? Math.max(0, Number((currentGrade * (1 - severity)).toFixed(2)))
      : null;
  const suggestionValue = editedSuggestion === undefined ? computedSuggestion : editedSuggestion;
  const canApply =
    submissionId != null &&
    suggestionValue != null &&
    !Number.isNaN(suggestionValue) &&
    suggestionValue >= 0 &&
    suggestionValue <= maxScore;

  const sourceKey =
    aiScore >= INTEGRITY_THRESHOLD && copyMax >= INTEGRITY_THRESHOLD
      ? "ambas"
      : aiScore >= INTEGRITY_THRESHOLD
        ? "ai"
        : copyMax >= INTEGRITY_THRESHOLD
          ? "plagio"
          : null;

  const apply = async () => {
    if (!canApply || suggestionValue == null) return;
    setBusy(true);
    try {
      const res = await onApplyGrade(suggestionValue);
      if (res.ok) {
        toast.success(t("integrity.applySuccess", { value: suggestionValue.toFixed(2) }));
        setEditedSuggestion(undefined);
      } else {
        toast.error(res.error ?? t("integrity.applyError"));
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleAi = async () => {
    if (!aiSignal) return;
    setBusy(true);
    try {
      await onToggleAiReviewed(aiSignal.submissionId, aiSignal.reviewedAt != null);
    } finally {
      setBusy(false);
    }
  };

  const toggleCopy = async (pair: IntegrityCopyPair) => {
    setBusy(true);
    try {
      await onToggleCopyReviewed(pair.id, pair.reviewedAt != null);
    } finally {
      setBusy(false);
    }
  };

  const overallPair = copyPairs.find((p) => p.questionId == null);
  const perQuestion = copyPairs.filter((p) => p.questionId != null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-primary" />
            {t("integrity.reviewDialogTitle")} — {userName}
          </DialogTitle>
          <DialogDescription>{t("integrity.reviewDialogSubtitle")}</DialogDescription>
        </DialogHeader>

        {/* Resumen + Sugerencia combinada */}
        <div className="rounded-md border p-3 grid grid-cols-1 md:grid-cols-3 gap-3 bg-muted/30">
          <div>
            <div className="text-[11px] uppercase text-muted-foreground tracking-wide">
              {t("integrity.currentGrade")}
            </div>
            <div className="font-semibold tabular-nums">
              {currentGrade != null
                ? `${currentGrade.toFixed(2)} / ${maxScore}`
                : t("integrity.noCurrentGrade")}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase text-muted-foreground tracking-wide flex items-center gap-1">
              <Bot className="h-3 w-3" /> {t("integrity.aiProbability")}
            </div>
            <div>
              {aiScore > 0 ? (
                <Badge variant={scoreVariant(aiScore)}>{formatScore(aiScore)}</Badge>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase text-muted-foreground tracking-wide flex items-center gap-1">
              <Users className="h-3 w-3" /> {t("integrity.copyScore")}
            </div>
            <div>
              {copyMax > 0 ? (
                <Badge variant={scoreVariant(copyMax)}>{formatScore(copyMax)}</Badge>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </div>
          </div>
        </div>

        {severity > 0 && currentGrade != null && (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 dark:bg-amber-500/5 dark:border-amber-500/20 p-3 flex items-center gap-3">
            <div className="flex-1">
              <div className="text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-300">
                {t("integrity.suggestedGrade")}
                {sourceKey && (
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    {t(`integrity.scope_${sourceKey}`)}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {currentGrade.toFixed(2)} × (1 − {Math.round(severity * 100)}%) ={" "}
                <span className="font-semibold text-amber-700 dark:text-amber-300">
                  {computedSuggestion?.toFixed(2)}
                </span>
              </div>
            </div>
            <DecimalInput
              min={0}
              max={maxScore}
              value={suggestionValue}
              onChange={(v) => setEditedSuggestion(v)}
              placeholder="—"
              className="h-8 w-24 text-sm text-right font-semibold text-amber-700 dark:text-amber-300"
              aria-label={t("integrity.suggestedGrade")}
            />
            <Button size="sm" onClick={apply} disabled={!canApply || busy}>
              {busy ? <Spinner size="sm" className="mr-1" /> : <Check className="h-3 w-3 mr-1" />}
              {t("integrity.applySuggestion")}
            </Button>
          </div>
        )}

        {/* Sección IA */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Bot className="h-4 w-4 text-muted-foreground" />
            {t("integrity.aiSection")}
            {aiSignal && (
              <Badge variant={scoreVariant(aiSignal.score)} className="ml-auto">
                {formatScore(aiSignal.score)}
              </Badge>
            )}
          </div>
          {!aiSignal ? (
            <p className="text-xs text-muted-foreground">{t("integrity.aiNoSignal")}</p>
          ) : (
            <div className="rounded-md border p-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {t("integrity.aiReasons")}
              </div>
              <CollapsibleReasons text={aiSignal.reasons} />
              <div className="flex items-center justify-end gap-2 pt-1">
                {aiSignal.reviewedAt ? (
                  <>
                    <Badge
                      variant="outline"
                      className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                    >
                      <Check className="h-3 w-3 mr-1" />
                      {t("integrity.reviewed")}
                    </Badge>
                    <Button size="sm" variant="ghost" onClick={toggleAi} disabled={busy}>
                      {t("integrity.reopen")}
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={toggleAi} disabled={busy}>
                    <Check className="h-3 w-3 mr-1" />
                    {t("integrity.markReviewed")}
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Sección Copia */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Users className="h-4 w-4 text-muted-foreground" />
            {t("integrity.copySection")}
            {copyPairs.length > 0 && (
              <Badge variant="outline" className="ml-auto text-[11px]">
                {copyPairs.length}
              </Badge>
            )}
          </div>
          {copyPairs.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("integrity.copyNoSignal")}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("integrity.copyQuestion")}</TableHead>
                  <TableHead>{t("integrity.copyPeer")}</TableHead>
                  <TableHead className="w-24">{t("integrity.copyScore")}</TableHead>
                  <TableHead>{t("integrity.aiReasons")}</TableHead>
                  <TableHead className="w-32 text-right">{t("common.action")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overallPair && (
                  <TableRow key={overallPair.id}>
                    <TableCell className="text-xs italic text-muted-foreground">
                      {t("integrity.copyOverall")}
                    </TableCell>
                    <TableCell className="font-medium">
                      {shortName(overallPair.peerId, userNames)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={scoreVariant(overallPair.score)}>
                        {formatScore(overallPair.score)}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <CollapsibleReasons text={overallPair.reasons} />
                    </TableCell>
                    <TableCell className="text-right">
                      {overallPair.reviewedAt ? (
                        <div className="flex flex-col items-end gap-1">
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                          >
                            <Check className="h-3 w-3 mr-1" />
                            {t("integrity.reviewed")}
                          </Badge>
                          <button
                            type="button"
                            className="text-[10px] text-muted-foreground hover:text-foreground underline"
                            onClick={() => toggleCopy(overallPair)}
                          >
                            {t("integrity.reopen")}
                          </button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => toggleCopy(overallPair)}
                          disabled={busy}
                        >
                          <Check className="h-3 w-3 mr-1" />
                          {t("integrity.markReviewed")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )}
                {perQuestion.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="text-xs">
                      {p.questionId ? (questionLabels[p.questionId] ?? "—") : "—"}
                    </TableCell>
                    <TableCell className="font-medium">{shortName(p.peerId, userNames)}</TableCell>
                    <TableCell>
                      <Badge variant={scoreVariant(p.score)}>{formatScore(p.score)}</Badge>
                    </TableCell>
                    <TableCell className="max-w-xs">
                      <CollapsibleReasons text={p.reasons} />
                    </TableCell>
                    <TableCell className="text-right">
                      {p.reviewedAt ? (
                        <div className="flex flex-col items-end gap-1">
                          <Badge
                            variant="outline"
                            className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                          >
                            <Check className="h-3 w-3 mr-1" />
                            {t("integrity.reviewed")}
                          </Badge>
                          <button
                            type="button"
                            className="text-[10px] text-muted-foreground hover:text-foreground underline"
                            onClick={() => toggleCopy(p)}
                          >
                            {t("integrity.reopen")}
                          </button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => toggleCopy(p)}
                          disabled={busy}
                        >
                          <Check className="h-3 w-3 mr-1" />
                          {t("integrity.markReviewed")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Helper: cuenta cuántas señales pendientes (no revisadas) tiene cada
 *  usuario para el grid del monitor.
 *  - AI: 1 si la submission del usuario tiene `ai_detected=true` y no
 *    está revisada; 0 si no.
 *  - Copia: número de pairs donde el usuario aparece (a o b) y no tienen
 *    `reviewed_at`.
 */
export function countPendingByUser(
  aiSignals: Array<{ userId: string; reviewedAt: string | null; score: number }>,
  pairs: Array<{ user_a: string; user_b: string; reviewed_at?: string | null; score: number }>,
): { aiByUser: Map<string, number>; copyByUser: Map<string, number> } {
  const aiByUser = new Map<string, number>();
  const copyByUser = new Map<string, number>();
  for (const s of aiSignals) {
    if (s.score < INTEGRITY_THRESHOLD) continue;
    if (s.reviewedAt) continue;
    aiByUser.set(s.userId, (aiByUser.get(s.userId) ?? 0) + 1);
  }
  for (const p of pairs) {
    if (p.score < INTEGRITY_THRESHOLD) continue;
    if (p.reviewed_at) continue;
    copyByUser.set(p.user_a, (copyByUser.get(p.user_a) ?? 0) + 1);
    copyByUser.set(p.user_b, (copyByUser.get(p.user_b) ?? 0) + 1);
  }
  return { aiByUser, copyByUser };
}

/** Centraliza las RPCs de marca de revisión para reusar entre monitor y
 *  cualquier otro consumidor. */
export async function rpcMarkAiReviewed(
  kind: IntegrityKind,
  submissionId: string,
  unmark: boolean,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc("mark_ai_suspicion_reviewed", {
    p_kind: kind,
    p_submission_id: submissionId,
    p_unmark: unmark,
  });
  if (error) {
    toast.error(friendlyError(error));
    return false;
  }
  return true;
}

export async function rpcMarkCopyReviewed(pairId: string, unmark: boolean): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).rpc("mark_similarity_pair_reviewed", {
    p_pair_id: pairId,
    p_unmark: unmark,
  });
  if (error) {
    toast.error(friendlyError(error));
    return false;
  }
  return true;
}
