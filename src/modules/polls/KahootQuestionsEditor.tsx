/**
 * KahootQuestionsEditor — editor de las preguntas de un quiz Kahoot.
 *
 * Se abre desde la acción "Preguntas" del menú de fila de una encuesta
 * tipo 'kahoot'. Gestiona kahoot_questions + kahoot_question_options:
 * agregar/editar/eliminar preguntas, cada una con 2–4 opciones (formas de
 * color) y EXACTAMENTE una correcta, su tiempo límite y sus puntos.
 *
 * Guardado: sincroniza contra DB (update existentes, insert nuevas, delete
 * removidas). Las opciones de cada pregunta se reescriben (delete+insert)
 * para mantener posiciones consistentes — pensado para editar el quiz
 * ANTES de hospedarlo en vivo.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { SectionLoader } from "@/components/ui/loaders";
import { EmptyState } from "@/components/ui/empty-state";
import { RowAction } from "@/components/ui/row-action";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Check, Gamepad2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import { KAHOOT_SHAPES } from "@/modules/polls/kahoot";
import { KahootShapeIcon } from "@/modules/polls/KahootShapeIcon";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const TIME_OPTIONS = [10, 20, 30, 45, 60, 90, 120];
const POINT_OPTIONS = [500, 1000, 2000];

interface EditOption {
  id?: string;
  label: string;
  is_correct: boolean;
}
interface EditQuestion {
  id?: string;
  text: string;
  time_limit_seconds: number;
  points: number;
  /** false = una sola correcta; true = varias correctas (el alumno debe
   *  marcar el set exacto). */
  multi_select: boolean;
  options: EditOption[];
}

function blankQuestion(): EditQuestion {
  return {
    text: "",
    time_limit_seconds: 20,
    points: 1000,
    multi_select: false,
    options: [
      { label: "", is_correct: true },
      { label: "", is_correct: false },
    ],
  };
}

export function KahootQuestionsEditor({
  poll,
  onOpenChange,
}: {
  poll: { id: string; title: string } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const open = poll !== null;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [questions, setQuestions] = useState<EditQuestion[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const aiGate = useAiAuthorizationGate();
  const [aiTopics, setAiTopics] = useState("");
  const [aiCount, setAiCount] = useState(5);
  const [aiLoading, setAiLoading] = useState(false);
  // Bump para re-cargar las preguntas desde DB tras generar con IA (la IA
  // inserta directo en DB, así que recargamos para verlas).
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!poll) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setRemovedIds([]);
      const { data: qs } = await db
        .from("kahoot_questions")
        .select("id, text, time_limit_seconds, points, multi_select, position")
        .eq("poll_id", poll.id)
        .order("position");
      const qrows = (qs ?? []) as Array<{
        id: string;
        text: string;
        time_limit_seconds: number;
        points: number;
        multi_select: boolean;
      }>;
      let optsByQ: Record<string, EditOption[]> = {};
      if (qrows.length > 0) {
        const { data: opts } = await db
          .from("kahoot_question_options")
          .select("id, question_id, label, is_correct, position")
          .in(
            "question_id",
            qrows.map((q) => q.id),
          )
          .order("position");
        for (const o of (opts ?? []) as Array<{
          id: string;
          question_id: string;
          label: string;
          is_correct: boolean;
        }>) {
          (optsByQ[o.question_id] ||= []).push({ id: o.id, label: o.label, is_correct: o.is_correct });
        }
      }
      if (cancelled) return;
      setQuestions(
        qrows.map((q) => ({
          id: q.id,
          text: q.text,
          time_limit_seconds: q.time_limit_seconds,
          points: q.points,
          multi_select: !!q.multi_select,
          options: optsByQ[q.id] ?? [{ label: "", is_correct: true }, { label: "", is_correct: false }],
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [poll, reloadNonce]);

  const updateQuestion = (qi: number, patch: Partial<EditQuestion>) =>
    setQuestions((qs) => qs.map((q, i) => (i === qi ? { ...q, ...patch } : q)));

  const updateOption = (qi: number, oi: number, patch: Partial<EditOption>) =>
    setQuestions((qs) =>
      qs.map((q, i) =>
        i === qi ? { ...q, options: q.options.map((o, j) => (j === oi ? { ...o, ...patch } : o)) } : q,
      ),
    );

  // Marcar correcta: en single es exclusivo (una sola); en multiple togglea
  // (varias permitidas).
  const toggleCorrect = (qi: number, oi: number) =>
    setQuestions((qs) =>
      qs.map((q, i) => {
        if (i !== qi) return q;
        if (q.multi_select) {
          return {
            ...q,
            options: q.options.map((o, j) => (j === oi ? { ...o, is_correct: !o.is_correct } : o)),
          };
        }
        return { ...q, options: q.options.map((o, j) => ({ ...o, is_correct: j === oi })) };
      }),
    );

  // Cambiar modo single/multiple. Al volver a single, colapsamos a UNA correcta
  // (la primera marcada, o la primera opción) para no quedar con un estado
  // inválido para single.
  const setMultiSelect = (qi: number, multi: boolean) =>
    setQuestions((qs) =>
      qs.map((q, i) => {
        if (i !== qi) return q;
        if (multi) return { ...q, multi_select: true };
        const firstCorrect = q.options.findIndex((o) => o.is_correct);
        const keep = firstCorrect >= 0 ? firstCorrect : 0;
        return { ...q, multi_select: false, options: q.options.map((o, j) => ({ ...o, is_correct: j === keep })) };
      }),
    );

  const addOption = (qi: number) =>
    setQuestions((qs) =>
      qs.map((q, i) =>
        i === qi && q.options.length < 4 ? { ...q, options: [...q.options, { label: "", is_correct: false }] } : q,
      ),
    );

  const removeOption = (qi: number, oi: number) =>
    setQuestions((qs) =>
      qs.map((q, i) => {
        if (i !== qi || q.options.length <= 2) return q;
        const next = q.options.filter((_, j) => j !== oi);
        // En single: si quitamos la única correcta, marcamos la primera. En
        // multiple puede quedar 0 correctas momentáneamente (la validación al
        // guardar exige ≥1).
        if (!q.multi_select && !next.some((o) => o.is_correct)) next[0].is_correct = true;
        return { ...q, options: next };
      }),
    );

  const addQuestion = () => setQuestions((qs) => [...qs, blankQuestion()]);

  const removeQuestion = async (qi: number) => {
    const q = questions[qi];
    const ok = await confirm({
      title: t("kahoot.deleteQuestionTitle"),
      description: t("kahoot.deleteQuestionDesc"),
      tone: "destructive",
      confirmLabel: t("kahoot.delete"),
    });
    if (!ok) return;
    if (q.id) setRemovedIds((ids) => [...ids, q.id!]);
    setQuestions((qs) => qs.filter((_, i) => i !== qi));
  };

  const validate = (): string | null => {
    if (questions.length === 0) return t("kahoot.errorNoQuestions");
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.text.trim()) return t("kahoot.errorQuestionText", { n: i + 1 });
      const valid = q.options.filter((o) => o.label.trim());
      if (valid.length < 2) return t("kahoot.errorQuestionOptions", { n: i + 1 });
      if (!q.options.some((o) => o.is_correct && o.label.trim()))
        return t("kahoot.errorQuestionCorrect", { n: i + 1 });
    }
    return null;
  };

  const generateWithAI = async () => {
    if (!poll) return;
    if (!aiTopics.trim()) {
      toast.error(t("kahoot.aiNeedTopics"));
      return;
    }
    const count = Math.max(1, Math.min(20, Math.round(aiCount) || 5));
    // Mismo gate que talleres/parciales: sync inline, código de IA inmediata,
    // o encolar en ai_generation_queue (allowQueue).
    const decision = await aiGate.ensureAuthorized({ allowQueue: true });
    if (decision === "cancel") return;
    if (decision === "proceed-async") {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) {
        toast.error(t("kahoot.notAuthenticated"));
        return;
      }
      const { data: pollRow } = await db
        .from("polls")
        .select("course_id")
        .eq("id", poll.id)
        .maybeSingle();
      const { error: enqErr } = await db.from("ai_generation_queue").insert([
        {
          kind: "kahoot_questions",
          invoke_target: "ai-generate-questions",
          source_table: "polls",
          source_id: poll.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          course_id: (pollRow as any)?.course_id ?? null,
          created_by: user.user.id,
          body: {
            topics: aiTopics,
            type: "kahoot",
            count,
            examId: poll.id,
            targetTable: "kahoot_questions",
          },
        },
      ]);
      if (enqErr) {
        toast.error(friendlyError(enqErr, "No se pudo encolar la generación"));
        return;
      }
      toast.success(t("kahoot.aiQueued"));
      setAiTopics("");
      return;
    }
    setAiLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
        body: {
          topics: aiTopics,
          type: "kahoot",
          count,
          examId: poll.id,
          targetTable: "kahoot_questions",
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const edgeErr = error ?? (data as any)?.error;
      if (edgeErr) {
        toast.error(friendlyError(edgeErr));
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = (data as any)?.inserted?.length ?? 0;
      toast.success(t("kahoot.aiGenerated", { n }));
      setAiTopics("");
      // La IA insertó en DB → recargamos para ver las preguntas nuevas.
      // (OJO: descarta cambios manuales SIN guardar — genera primero, edita después.)
      setReloadNonce((x) => x + 1);
    } finally {
      setAiLoading(false);
    }
  };

  const save = async () => {
    if (!poll) return;
    const err = validate();
    if (err) {
      toast.error(err);
      return;
    }
    setSaving(true);
    try {
      // 1) Eliminar preguntas removidas (cascade borra sus opciones).
      if (removedIds.length > 0) {
        const { error: delErr } = await db.from("kahoot_questions").delete().in("id", removedIds);
        if (delErr) {
          toast.error(friendlyError(delErr));
          return;
        }
      }
      // 2) Upsert de cada pregunta + reescritura de sus opciones.
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const validOptions = q.options.filter((o) => o.label.trim());
        let questionId = q.id;
        if (questionId) {
          const { error: uErr } = await db
            .from("kahoot_questions")
            .update({
              text: q.text.trim(),
              time_limit_seconds: q.time_limit_seconds,
              points: q.points,
              multi_select: q.multi_select,
              position: i,
            })
            .eq("id", questionId);
          if (uErr) {
            toast.error(friendlyError(uErr));
            return;
          }
          await db.from("kahoot_question_options").delete().eq("question_id", questionId);
        } else {
          const { data: ins, error: iErr } = await db
            .from("kahoot_questions")
            .insert({
              poll_id: poll.id,
              text: q.text.trim(),
              time_limit_seconds: q.time_limit_seconds,
              points: q.points,
              multi_select: q.multi_select,
              position: i,
            })
            .select("id")
            .single();
          if (iErr || !ins) {
            toast.error(friendlyError(iErr));
            return;
          }
          questionId = ins.id;
        }
        const optsPayload = validOptions.map((o, j) => ({
          question_id: questionId,
          label: o.label.trim(),
          is_correct: o.is_correct,
          position: j,
        }));
        const { error: oErr } = await db.from("kahoot_question_options").insert(optsPayload);
        if (oErr) {
          toast.error(friendlyError(oErr));
          return;
        }
      }
      toast.success(t("kahoot.questionsSaved"));
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gamepad2 className="h-5 w-5 text-primary" />
            {t("kahoot.questionsTitle")}
          </DialogTitle>
          <DialogDescription>
            {poll?.title} · {t("kahoot.questionsSubtitle")}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <SectionLoader text={t("kahoot.loadingQuestions")} />
        ) : (
          <div className="space-y-4">
            {/* Generar preguntas con IA. El docente puede ajustar después
                única/múltiple por pregunta con el selector de modo. */}
            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <Wand2 className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">{t("kahoot.aiGenerate")}</span>
              </div>
              <Textarea
                value={aiTopics}
                onChange={(e) => setAiTopics(e.target.value)}
                placeholder={t("kahoot.aiTopicsPlaceholder")}
                rows={2}
                disabled={aiLoading}
              />
              <div className="flex items-center gap-2">
                <Label className="text-xs">{t("kahoot.aiCount")}</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={aiCount}
                  onChange={(e) => setAiCount(Number(e.target.value))}
                  className="h-8 w-20"
                  disabled={aiLoading}
                />
                <Button
                  size="sm"
                  className="ml-auto"
                  disabled={aiLoading || !aiTopics.trim()}
                  onClick={() => void generateWithAI()}
                >
                  {aiLoading ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <Wand2 className="h-4 w-4 mr-1" />
                  )}
                  {t("kahoot.aiGenerateBtn")}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">{t("kahoot.aiHint")}</p>
            </div>
            {questions.length === 0 && (
              <EmptyState icon={Gamepad2} text={t("kahoot.noQuestions")} />
            )}
            {questions.map((q, qi) => (
              <div key={q.id ?? `new-${qi}`} className="rounded-lg border p-3 space-y-3">
                <div className="flex items-start gap-2">
                  <span className="mt-2 text-sm font-bold text-muted-foreground tabular-nums">{qi + 1}.</span>
                  <div className="flex-1 space-y-1">
                    <Textarea
                      value={q.text}
                      onChange={(e) => updateQuestion(qi, { text: e.target.value })}
                      placeholder={t("kahoot.questionPlaceholder")}
                      rows={2}
                      maxLength={500}
                    />
                  </div>
                  <RowAction
                    label={t("kahoot.deleteQuestion")}
                    icon={Trash2}
                    tone="destructive"
                    onClick={() => void removeQuestion(qi)}
                  />
                </div>

                <div className="flex flex-wrap gap-3 pl-6">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs">{t("kahoot.timeLimit")}</Label>
                    <Select
                      value={String(q.time_limit_seconds)}
                      onValueChange={(v) => updateQuestion(qi, { time_limit_seconds: Number(v) })}
                    >
                      <SelectTrigger className="h-8 w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TIME_OPTIONS.map((s) => (
                          <SelectItem key={s} value={String(s)}>
                            {s}s
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs">{t("kahoot.points")}</Label>
                    <Select
                      value={String(q.points)}
                      onValueChange={(v) => updateQuestion(qi, { points: Number(v) })}
                    >
                      <SelectTrigger className="h-8 w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {POINT_OPTIONS.map((p) => (
                          <SelectItem key={p} value={String(p)}>
                            {p}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs">{t("kahoot.answerMode")}</Label>
                    <Select
                      value={q.multi_select ? "multiple" : "single"}
                      onValueChange={(v) => setMultiSelect(qi, v === "multiple")}
                    >
                      <SelectTrigger className="h-8 w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="single">{t("kahoot.singleAnswer")}</SelectItem>
                        <SelectItem value="multiple">{t("kahoot.multiAnswer")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2 pl-6">
                  <p className="text-[11px] text-muted-foreground">
                    {q.multi_select ? t("kahoot.markCorrectHintMulti") : t("kahoot.markCorrectHint")}
                  </p>
                  {q.options.map((o, oi) => {
                    const shape = KAHOOT_SHAPES[oi] ?? KAHOOT_SHAPES[0];
                    return (
                      <div key={oi} className="flex items-center gap-2">
                        <span className={`flex h-8 w-8 items-center justify-center rounded ${shape.bg} text-white shrink-0`}>
                          <KahootShapeIcon icon={shape.icon} className="h-4 w-4" />
                        </span>
                        <Input
                          value={o.label}
                          onChange={(e) => updateOption(qi, oi, { label: e.target.value })}
                          placeholder={t("kahoot.optionPlaceholder", { n: oi + 1 })}
                          maxLength={200}
                          className="flex-1"
                        />
                        <Button
                          type="button"
                          variant={o.is_correct ? "default" : "outline"}
                          size="sm"
                          className={o.is_correct ? "bg-emerald-600 hover:bg-emerald-700" : ""}
                          onClick={() => toggleCorrect(qi, oi)}
                          title={t("kahoot.markCorrect")}
                        >
                          <Check className="h-4 w-4" />
                        </Button>
                        {q.options.length > 2 && (
                          <RowAction
                            label={t("kahoot.removeOption")}
                            icon={Trash2}
                            tone="destructive"
                            onClick={() => removeOption(qi, oi)}
                          />
                        )}
                      </div>
                    );
                  })}
                  {q.options.length < 4 && (
                    <Button type="button" variant="outline" size="sm" onClick={() => addOption(qi)}>
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      {t("kahoot.addOption")}
                    </Button>
                  )}
                </div>
              </div>
            ))}

            <Button variant="outline" onClick={addQuestion} className="w-full">
              <Plus className="h-4 w-4 mr-1.5" />
              {t("kahoot.addQuestion")}
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("kahoot.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving || loading}>
            {saving && <Spinner size="sm" className="mr-1" />}
            {t("kahoot.saveQuestions")}
          </Button>
        </DialogFooter>
        {/* Gate de autorización IA (sync / código inmediato / cola). Se porta
            a body; solo aparece si el tenant está en modo async sin código. */}
        <aiGate.GateDialog />
      </DialogContent>
    </Dialog>
  );
}
