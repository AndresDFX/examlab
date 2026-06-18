/**
 * PollQuestionsEditor — editor de las preguntas de una encuesta MIXTA
 * (poll_type='mixed'). Espejo recortado del editor de preguntas de talleres:
 * un MIX de tipos de pregunta por encuesta.
 *
 * Tipos v1:
 *   - `abierta`  → texto libre (opcional: máx. de caracteres).
 *   - `cerrada`  → opción única (lista de choices; el alumno elige una).
 *
 * Gestiona poll_questions (+ poll_question_responses como solo-lectura para
 * decidir el lock). Guardado: borra las removidas, hace upsert del resto con
 * su posición. Si una pregunta YA tiene respuestas, su TIPO y sus CHOICES
 * quedan read-only — cambiarlas corrompería los `selected_index` guardados
 * (el trigger DB `tg_poll_question_immutable` lo rechaza server-side; acá lo
 * reflejamos en la UI).
 *
 * Strings con `defaultValue` español inline (mismo patrón que los toasts de
 * app.teacher.polls.tsx) — es-CO es el locale por defecto.
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
import { Switch } from "@/components/ui/switch";
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
import { Plus, Trash2, ListChecks, MessageSquareText, Lock, ChevronUp, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useConfirm } from "@/shared/components/ConfirmDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type PollQType = "abierta" | "cerrada";

interface EditPollQuestion {
  id?: string;
  type: PollQType;
  text: string;
  required: boolean;
  /** abierta: tope opcional de caracteres (null = sin tope). */
  maxChars: number | null;
  /** cerrada: opciones a elegir. */
  choices: string[];
  /** Si ya tiene respuestas → tipo + choices read-only (lock). */
  locked: boolean;
}

function blankQuestion(type: PollQType): EditPollQuestion {
  return {
    type,
    text: "",
    required: true,
    maxChars: type === "abierta" ? 500 : null,
    choices: type === "cerrada" ? ["", ""] : [],
    locked: false,
  };
}

export function PollQuestionsEditor({
  poll,
  onOpenChange,
  onSaved,
}: {
  poll: { id: string; title: string } | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const open = poll !== null;
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [questions, setQuestions] = useState<EditPollQuestion[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);

  useEffect(() => {
    if (!poll) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setRemovedIds([]);
      const { data: qs } = await db
        .from("poll_questions")
        .select("id, type, text, required, max_chars, options, position")
        .eq("poll_id", poll.id)
        .order("position");
      const rows = (qs ?? []) as Array<{
        id: string;
        type: PollQType;
        text: string;
        required: boolean;
        max_chars: number | null;
        options: { choices?: string[] } | null;
      }>;
      // ¿Qué preguntas ya tienen respuestas? Esas se bloquean (tipo+choices).
      let answered = new Set<string>();
      if (rows.length > 0) {
        const { data: resp } = await db
          .from("poll_question_responses")
          .select("question_id")
          .in(
            "question_id",
            rows.map((r) => r.id),
          );
        answered = new Set(
          ((resp ?? []) as Array<{ question_id: string }>).map((r) => r.question_id),
        );
      }
      if (cancelled) return;
      setQuestions(
        rows.map((r) => ({
          id: r.id,
          type: r.type,
          text: r.text,
          required: !!r.required,
          maxChars: r.max_chars ?? null,
          choices: Array.isArray(r.options?.choices) ? r.options!.choices! : [],
          locked: answered.has(r.id),
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [poll]);

  const updateQuestion = (qi: number, patch: Partial<EditPollQuestion>) =>
    setQuestions((qs) => qs.map((q, i) => (i === qi ? { ...q, ...patch } : q)));

  const setType = (qi: number, type: PollQType) =>
    setQuestions((qs) =>
      qs.map((q, i) => {
        if (i !== qi) return q;
        // Al cambiar de tipo, inicializamos los campos del tipo nuevo sin
        // perder el texto ya escrito.
        if (type === "cerrada") {
          return { ...q, type, choices: q.choices.length >= 2 ? q.choices : ["", ""], maxChars: null };
        }
        return { ...q, type, maxChars: q.maxChars ?? 500 };
      }),
    );

  const updateChoice = (qi: number, ci: number, value: string) =>
    setQuestions((qs) =>
      qs.map((q, i) =>
        i === qi ? { ...q, choices: q.choices.map((c, j) => (j === ci ? value : c)) } : q,
      ),
    );

  const addChoice = (qi: number) =>
    setQuestions((qs) =>
      qs.map((q, i) => (i === qi && q.choices.length < 8 ? { ...q, choices: [...q.choices, ""] } : q)),
    );

  const removeChoice = (qi: number, ci: number) =>
    setQuestions((qs) =>
      qs.map((q, i) =>
        i === qi && q.choices.length > 2
          ? { ...q, choices: q.choices.filter((_, j) => j !== ci) }
          : q,
      ),
    );

  const moveQuestion = (qi: number, dir: -1 | 1) =>
    setQuestions((qs) => {
      const next = [...qs];
      const j = qi + dir;
      if (j < 0 || j >= next.length) return qs;
      [next[qi], next[j]] = [next[j], next[qi]];
      return next;
    });

  const addQuestion = (type: PollQType) => setQuestions((qs) => [...qs, blankQuestion(type)]);

  const removeQuestion = async (qi: number) => {
    const q = questions[qi];
    const ok = await confirm({
      title: t("pollQuestions.deleteTitle", { defaultValue: "¿Eliminar pregunta?" }),
      description: q.locked
        ? t("pollQuestions.deleteWithResponses", {
            defaultValue:
              "Esta pregunta ya tiene respuestas. Eliminarla borra también esas respuestas. Esta acción no se puede deshacer.",
          })
        : t("pollQuestions.deleteDesc", {
            defaultValue: "Se quitará la pregunta de la encuesta. Esta acción no se puede deshacer.",
          }),
      tone: "destructive",
      confirmLabel: t("common.delete", { defaultValue: "Eliminar" }),
    });
    if (!ok) return;
    if (q.id) setRemovedIds((ids) => [...ids, q.id!]);
    setQuestions((qs) => qs.filter((_, i) => i !== qi));
  };

  const validate = (): string | null => {
    if (questions.length === 0)
      return t("pollQuestions.errNoQuestions", { defaultValue: "Agrega al menos una pregunta." });
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.text.trim())
        return t("pollQuestions.errText", {
          defaultValue: "La pregunta {{n}} necesita un enunciado.",
          n: i + 1,
        });
      if (q.type === "cerrada") {
        const valid = q.choices.filter((c) => c.trim());
        if (valid.length < 2)
          return t("pollQuestions.errChoices", {
            defaultValue: "La pregunta {{n}} (cerrada) necesita al menos 2 opciones.",
            n: i + 1,
          });
      }
    }
    return null;
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
      if (removedIds.length > 0) {
        const { error: delErr } = await db.from("poll_questions").delete().in("id", removedIds);
        if (delErr) {
          toast.error(friendlyError(delErr));
          return;
        }
      }
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const payload = {
          poll_id: poll.id,
          position: i,
          type: q.type,
          text: q.text.trim(),
          required: q.required,
          max_chars: q.type === "abierta" ? (q.maxChars ?? null) : null,
          options:
            q.type === "cerrada"
              ? { choices: q.choices.map((c) => c.trim()).filter(Boolean) }
              : null,
        };
        if (q.id) {
          const { error: uErr } = await db.from("poll_questions").update(payload).eq("id", q.id);
          if (uErr) {
            toast.error(friendlyError(uErr));
            return;
          }
        } else {
          const { error: iErr } = await db.from("poll_questions").insert(payload);
          if (iErr) {
            toast.error(friendlyError(iErr));
            return;
          }
        }
      }
      toast.success(t("pollQuestions.saved", { defaultValue: "Preguntas guardadas" }));
      onSaved?.();
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
            <ListChecks className="h-5 w-5 text-sky-500" />
            {t("pollQuestions.title", { defaultValue: "Preguntas de la encuesta" })}
          </DialogTitle>
          <DialogDescription>
            {poll?.title} ·{" "}
            {t("pollQuestions.subtitle", {
              defaultValue: "Mezcla preguntas abiertas (texto) y cerradas (opción única).",
            })}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <SectionLoader text={t("pollQuestions.loading", { defaultValue: "Cargando preguntas…" })} />
        ) : (
          <div className="space-y-4">
            {questions.length === 0 && (
              <EmptyState
                icon={ListChecks}
                text={t("pollQuestions.empty", {
                  defaultValue: "Aún no hay preguntas. Agrega una abierta o una cerrada.",
                })}
              />
            )}

            {questions.map((q, qi) => (
              <div key={q.id ?? `new-${qi}`} className="rounded-lg border p-3 space-y-3">
                <div className="flex items-start gap-2">
                  <span className="mt-2 text-sm font-bold text-muted-foreground tabular-nums">
                    {qi + 1}.
                  </span>
                  <div className="flex-1 min-w-0 space-y-2">
                    <Textarea
                      value={q.text}
                      onChange={(e) => updateQuestion(qi, { text: e.target.value })}
                      placeholder={t("pollQuestions.textPlaceholder", {
                        defaultValue: "Escribe el enunciado de la pregunta…",
                      })}
                      rows={2}
                      maxLength={2000}
                    />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <RowAction
                      label={t("pollQuestions.moveUp", { defaultValue: "Subir" })}
                      icon={ChevronUp}
                      onClick={() => moveQuestion(qi, -1)}
                      disabled={qi === 0}
                    />
                    <RowAction
                      label={t("pollQuestions.moveDown", { defaultValue: "Bajar" })}
                      icon={ChevronDown}
                      onClick={() => moveQuestion(qi, 1)}
                      disabled={qi === questions.length - 1}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 pl-6">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs">
                      {t("pollQuestions.fieldType", { defaultValue: "Tipo" })}
                    </Label>
                    <Select
                      value={q.type}
                      onValueChange={(v) => setType(qi, v as PollQType)}
                      disabled={q.locked}
                    >
                      <SelectTrigger className="h-8 w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="abierta">
                          {t("pollQuestions.typeOpen", { defaultValue: "Abierta (texto)" })}
                        </SelectItem>
                        <SelectItem value="cerrada">
                          {t("pollQuestions.typeClosed", { defaultValue: "Cerrada (opción única)" })}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer select-none">
                    <Switch
                      checked={q.required}
                      onCheckedChange={(v) => updateQuestion(qi, { required: v })}
                    />
                    <span className="text-xs">
                      {t("pollQuestions.required", { defaultValue: "Obligatoria" })}
                    </span>
                  </label>
                  {q.type === "abierta" && (
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs">
                        {t("pollQuestions.maxChars", { defaultValue: "Máx. caracteres" })}
                      </Label>
                      <Input
                        type="number"
                        min={1}
                        max={10000}
                        value={q.maxChars ?? ""}
                        placeholder="500"
                        onChange={(e) =>
                          updateQuestion(qi, {
                            maxChars: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        className="h-8 w-24"
                      />
                    </div>
                  )}
                  {q.locked && (
                    <span className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
                      <Lock className="h-3 w-3" />
                      {t("pollQuestions.lockedNote", {
                        defaultValue: "Con respuestas — tipo y opciones no editables",
                      })}
                    </span>
                  )}
                </div>

                {q.type === "cerrada" && (
                  <div className="space-y-2 pl-6">
                    {q.choices.map((c, ci) => (
                      <div key={ci} className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground w-5 text-right tabular-nums">
                          {ci + 1}.
                        </span>
                        <Input
                          value={c}
                          onChange={(e) => updateChoice(qi, ci, e.target.value)}
                          placeholder={t("pollQuestions.choicePlaceholder", {
                            defaultValue: "Opción {{n}}",
                            n: ci + 1,
                          })}
                          maxLength={300}
                          disabled={q.locked}
                          className="flex-1"
                        />
                        {!q.locked && q.choices.length > 2 && (
                          <RowAction
                            label={t("pollQuestions.removeChoice", { defaultValue: "Quitar opción" })}
                            icon={Trash2}
                            tone="destructive"
                            onClick={() => removeChoice(qi, ci)}
                          />
                        )}
                      </div>
                    ))}
                    {!q.locked && q.choices.length < 8 && (
                      <Button type="button" variant="outline" size="sm" onClick={() => addChoice(qi)}>
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        {t("pollQuestions.addChoice", { defaultValue: "Agregar opción" })}
                      </Button>
                    )}
                  </div>
                )}

                <div className="flex justify-end pl-6">
                  <RowAction
                    label={t("pollQuestions.deleteQuestion", { defaultValue: "Eliminar pregunta" })}
                    icon={Trash2}
                    tone="destructive"
                    onClick={() => void removeQuestion(qi)}
                  />
                </div>
              </div>
            ))}

            <div className="flex flex-col sm:flex-row gap-2">
              <Button variant="outline" onClick={() => addQuestion("abierta")} className="flex-1">
                <MessageSquareText className="h-4 w-4 mr-1.5" />
                {t("pollQuestions.addOpen", { defaultValue: "Agregar abierta" })}
              </Button>
              <Button variant="outline" onClick={() => addQuestion("cerrada")} className="flex-1">
                <ListChecks className="h-4 w-4 mr-1.5" />
                {t("pollQuestions.addClosed", { defaultValue: "Agregar cerrada" })}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel", { defaultValue: "Cancelar" })}
          </Button>
          <Button onClick={() => void save()} disabled={saving || loading}>
            {saving && <Spinner size="sm" className="mr-1" />}
            {t("pollQuestions.save", { defaultValue: "Guardar preguntas" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
