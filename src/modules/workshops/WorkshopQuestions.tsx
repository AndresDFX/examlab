import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { logEvent } from "@/shared/lib/audit";
import { useAuth } from "@/hooks/use-auth";
import { scoreCerradaMulti } from "@/modules/exams/question-scoring";
import { Button } from "@/components/ui/button";
import { RowAction } from "@/components/ui/row-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Sparkles,
  Send,
  Pencil,
  Save,
  X,
  ChevronUp,
  ChevronDown,
  Library,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { QuestionBankImportDialog } from "@/modules/code/QuestionBankImportDialog";
import { CodeEditor, JAVA_STARTER } from "@/modules/code/CodeEditor";
import { DiagramEditor } from "@/modules/code/DiagramEditor";
import { JavaGuiRunner, JAVA_GUI_STARTER } from "@/modules/code/JavaGuiRunner";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import {
  getProcessingMode,
  readOverrideExpiry,
  PENDING_AI_FEEDBACK,
  QUEUED_STUDENT_TITLE,
  QUEUED_STUDENT_BODY,
} from "@/modules/ai/ai-grading";

export type WorkshopQuestion = {
  id: string;
  workshop_id: string;
  type: "abierta" | "cerrada" | "cerrada_multi" | "codigo" | "diagrama" | "java_gui";
  content: string;
  options: any;
  position: number;
  points: number;
  expected_rubric: string | null;
  starter_code: string | null;
  language: string | null;
};

/* =========================================================================
   TEACHER: Editor of workshop questions (manual + AI)
   ========================================================================= */
export function TeacherWorkshopQuestionsEditor({
  workshopId,
  courseLanguage = "es",
}: {
  workshopId: string;
  courseLanguage?: "es" | "en";
}) {
  const confirm = useConfirm();
  // Gate IA: en modo async sin override pedimos confirmación antes de
  // gastar cuota Gemini en la generación de preguntas.
  const aiGate = useAiAuthorizationGate();
  const [questions, setQuestions] = useState<WorkshopQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  // course_id del workshop — necesario para abrir el banco de preguntas
  // (filtrado por curso). Se carga junto con las preguntas.
  const [workshopCourseId, setWorkshopCourseId] = useState<string | null>(null);
  const [bankDialogOpen, setBankDialogOpen] = useState(false);

  // manual question form (sirve tanto para crear como para editar:
  // cuando editingId !== null, el submit hace UPDATE en vez de INSERT)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("list");
  const [qType, setQType] = useState<WorkshopQuestion["type"]>("abierta");
  const [qContent, setQContent] = useState("");
  const [qRubric, setQRubric] = useState("");
  const [qChoices, setQChoices] = useState(["", "", "", ""]);
  const [qCorrect, setQCorrect] = useState(0);
  // Multi-select state (cerrada_multi)
  const [qCorrectIndices, setQCorrectIndices] = useState<number[]>([]);
  const [qMinSelections, setQMinSelections] = useState<number | "">("");
  const [qMaxSelections, setQMaxSelections] = useState<number | "">("");
  const [qPoints, setQPoints] = useState(1);
  const [qLanguage, setQLanguage] = useState("java");

  const resetForm = () => {
    setEditingId(null);
    setQType("abierta");
    setQContent("");
    setQRubric("");
    setQChoices(["", "", "", ""]);
    setQCorrect(0);
    setQCorrectIndices([]);
    setQMinSelections("");
    setQMaxSelections("");
    setQPoints(1);
    setQLanguage("java");
  };

  const loadIntoForm = (q: WorkshopQuestion) => {
    setEditingId(q.id);
    setQType(q.type);
    setQContent(q.content);
    setQRubric(q.expected_rubric ?? "");
    const choices = (q.options?.choices ?? []) as string[];
    setQChoices([0, 1, 2, 3].map((i) => choices[i] ?? ""));
    setQCorrect(Number(q.options?.correct_index ?? 0));
    const ci = (q.options as any)?.correct_indices;
    setQCorrectIndices(Array.isArray(ci) ? ci : []);
    const minS = (q.options as any)?.min_selections;
    const maxS = (q.options as any)?.max_selections;
    setQMinSelections(typeof minS === "number" ? minS : "");
    setQMaxSelections(typeof maxS === "number" ? maxS : "");
    setQPoints(q.points);
    setQLanguage(q.language ?? "java");
    setActiveTab("manual");
  };

  // AI form
  const [aiTopics, setAiTopics] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  type AiRow = { type: WorkshopQuestion["type"]; count: number; language: string };
  const [aiRows, setAiRows] = useState<AiRow[]>([{ type: "abierta", count: 3, language: "java" }]);
  const updateAiRow = (i: number, patch: Partial<AiRow>) =>
    setAiRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addAiRow = () =>
    setAiRows((rows) => [...rows, { type: "abierta", count: 1, language: "java" }]);
  const removeAiRow = (i: number) => setAiRows((rows) => rows.filter((_, idx) => idx !== i));

  const load = async () => {
    setLoading(true);
    const [{ data }, { data: ws }] = await Promise.all([
      supabase
        .from("workshop_questions")
        .select("*")
        .eq("workshop_id", workshopId)
        .order("position"),
      supabase.from("workshops").select("course_id").eq("id", workshopId).maybeSingle(),
    ]);
    setQuestions((data ?? []) as WorkshopQuestion[]);
    setWorkshopCourseId((ws as { course_id?: string } | null)?.course_id ?? null);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, [workshopId]);

  const submitManual = async () => {
    if (!qContent.trim()) {
      toast.error("Escribe el enunciado");
      return;
    }
    if (qType === "cerrada_multi") {
      if (qCorrectIndices.length === 0) {
        toast.error("Marca al menos una opción correcta en opción múltiple");
        return;
      }
      const minN = typeof qMinSelections === "number" ? qMinSelections : 0;
      const maxN = typeof qMaxSelections === "number" ? qMaxSelections : 0;
      if (minN && maxN && minN > maxN) {
        toast.error("Mínimo de marcadas no puede ser mayor al máximo");
        return;
      }
    }
    const options =
      qType === "cerrada"
        ? { choices: qChoices.filter((c) => c.trim()), correct_index: qCorrect }
        : qType === "cerrada_multi"
          ? {
              choices: qChoices.filter((c) => c.trim()),
              correct_indices: qCorrectIndices,
              ...(typeof qMinSelections === "number" ? { min_selections: qMinSelections } : {}),
              ...(typeof qMaxSelections === "number" ? { max_selections: qMaxSelections } : {}),
            }
          : null;
    const language = qType === "codigo" ? qLanguage : qType === "java_gui" ? "java" : null;

    if (editingId) {
      // UPDATE: no tocamos position ni starter_code para no clobberar lo que
      // el alumno o el docente puedan haber personalizado.
      const { error } = await supabase
        .from("workshop_questions")
        .update({
          type: qType,
          content: qContent,
          expected_rubric: qRubric || null,
          options,
          points: qPoints,
          language,
        })
        .eq("id", editingId);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success("Pregunta actualizada");
    } else {
      const { error } = await supabase.from("workshop_questions").insert({
        workshop_id: workshopId,
        type: qType,
        content: qContent,
        expected_rubric: qRubric || null,
        options,
        points: qPoints,
        position: questions.length,
        language,
        starter_code:
          qType === "java_gui"
            ? JAVA_GUI_STARTER
            : qType === "codigo" && language === "java"
              ? JAVA_STARTER
              : null,
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success("Pregunta agregada — puedes continuar añadiendo");
    }
    resetForm();
    load();
  };

  // Swap de positions con vecino. Usamos -1 como temporal para no chocar
  // con un eventual unique(workshop_id, position).
  const moveQ = async (id: string, direction: "up" | "down") => {
    const sorted = [...questions].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((q) => q.id === id);
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || target < 0 || target >= sorted.length) return;
    const a = sorted[idx];
    const b = sorted[target];
    const { error: e1 } = await supabase
      .from("workshop_questions")
      .update({ position: -1 })
      .eq("id", a.id);
    if (e1) return toast.error(friendlyError(e1));
    const { error: e2 } = await supabase
      .from("workshop_questions")
      .update({ position: a.position })
      .eq("id", b.id);
    if (e2) return toast.error(friendlyError(e2));
    const { error: e3 } = await supabase
      .from("workshop_questions")
      .update({ position: b.position })
      .eq("id", a.id);
    if (e3) return toast.error(friendlyError(e3));
    load();
  };

  const removeQ = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar pregunta",
      description: "Se eliminará la pregunta del taller. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("workshop_questions").delete().eq("id", id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Pregunta eliminada");
    load();
  };

  const generateWithAI = async () => {
    if (!aiTopics.trim()) {
      toast.error("Indica los temas");
      return;
    }
    const validRows = aiRows.filter((r) => r.count > 0);
    if (!validRows.length) return toast.error("Configura al menos un tipo con cantidad > 0");
    const decision = await aiGate.ensureAuthorized();
    if (decision === "cancel") return;
    setAiLoading(true);
    let totalInserted = 0;
    try {
      for (const row of validRows) {
        const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
          body: {
            topics: aiTopics,
            type: row.type,
            count: row.count,
            examId: workshopId,
            language: row.type === "codigo" ? row.language : undefined,
            courseLanguage,
            targetTable: "workshop_questions",
          },
        });
        if (error || data?.error) {
          const detail = await extractEdgeError(error, data);
          toast.error(`Error en ${row.type}: ${detail || "Error desconocido"}`);
        } else {
          totalInserted += data?.inserted?.length ?? 0;
        }
      }
      if (totalInserted > 0) {
        toast.success(`${totalInserted} pregunta${totalInserted !== 1 ? "s" : ""} generadas`);
        setAiTopics("");
        void logEvent({
          action: "ai_questions.generated",
          category: "grading",
          severity: "info",
          entityType: "workshop",
          entityId: workshopId,
          metadata: { total: totalInserted, types: validRows.map((r) => r.type) },
        });
      }
      load();
    } catch (e: any) {
      toast.error(friendlyError(e, "Error IA"));
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList>
          <TabsTrigger value="list">Preguntas ({questions.length})</TabsTrigger>
          <TabsTrigger value="manual">
            {editingId ? "Editar pregunta" : "Agregar manual"}
          </TabsTrigger>
          <TabsTrigger value="ai">Generar con IA</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-2">
          {loading && (
            <p className="text-sm text-muted-foreground">
              <Spinner size="xs" inline className="mr-1" /> Cargando…
            </p>
          )}
          {!loading && questions.length === 0 && (
            <p className="text-sm text-muted-foreground">Aún no hay preguntas.</p>
          )}
          {questions.map((q, idx) => (
            <Card key={q.id}>
              <CardContent className="p-3 flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="outline" className="text-[10px]">
                      {idx + 1}
                    </Badge>
                    <Badge variant="secondary" className="text-[10px] capitalize">
                      {q.type}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{q.points} pts</span>
                  </div>
                  <div className="text-sm">
                    <MarkdownInline>{q.content}</MarkdownInline>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <RowAction
                    label="Subir"
                    icon={ChevronUp}
                    disabled={idx === 0}
                    onClick={() => moveQ(q.id, "up")}
                  />
                  <RowAction
                    label="Bajar"
                    icon={ChevronDown}
                    disabled={idx === questions.length - 1}
                    onClick={() => moveQ(q.id, "down")}
                  />
                  <RowAction
                    label="Editar pregunta"
                    icon={Pencil}
                    onClick={() => loadIntoForm(q)}
                  />
                  <RowAction
                    label="Eliminar pregunta"
                    icon={Trash2}
                    tone="destructive"
                    onClick={() => removeQ(q.id)}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="manual" className="space-y-3">
          {questions.length > 0 && (
            <div className="rounded-md border bg-muted/30 px-3 py-2">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-muted-foreground font-medium">
                  {questions.length} pregunta{questions.length !== 1 ? "s" : ""} guardadas ·{" "}
                  {questions.reduce((s, q) => s + (q.points ?? 0), 0)} pts totales
                </span>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => setActiveTab("list")}
                >
                  Ver lista
                </button>
              </div>
              <div className="flex flex-wrap gap-1">
                {questions.slice(0, 9).map((q, i) => (
                  <span
                    key={q.id}
                    className={`inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[10px] tabular-nums${editingId === q.id ? " border-primary bg-primary/5 font-medium" : ""}`}
                  >
                    <span className="text-muted-foreground">#{i + 1}</span>
                    <span className="capitalize">{q.type}</span>
                    <span className="text-muted-foreground">{q.points}pt</span>
                  </span>
                ))}
                {questions.length > 9 && (
                  <span className="inline-flex items-center rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    +{questions.length - 9} más
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label required>Tipo</Label>
              <Select value={qType} onValueChange={(v) => setQType(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="abierta">Abierta</SelectItem>
                  <SelectItem value="cerrada">Selección única</SelectItem>
                  <SelectItem value="cerrada_multi">Opción múltiple</SelectItem>
                  <SelectItem value="codigo">Código</SelectItem>
                  <SelectItem value="diagrama">Diagrama (Mermaid)</SelectItem>
                  <SelectItem value="java_gui">Java GUI (Swing/AWT)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label required>Puntos</Label>
              <Input
                type="number"
                min={0}
                value={qPoints || ""}
                onChange={(e) => setQPoints(e.target.value === "" ? 0 : Number(e.target.value))}
              />
            </div>
          </div>
          <div>
            <Label required>Enunciado</Label>
            <Textarea
              value={qContent}
              onChange={(e) => setQContent(e.target.value)}
              rows={3}
              placeholder="Describe la pregunta…"
            />
          </div>
          {qType === "cerrada" && (
            <div className="space-y-2">
              <Label required>Opciones (marca la correcta)</Label>
              {qChoices.map((c, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="correct"
                    checked={qCorrect === i}
                    onChange={() => setQCorrect(i)}
                  />
                  <Input
                    value={c}
                    onChange={(e) =>
                      setQChoices(qChoices.map((cc, j) => (j === i ? e.target.value : cc)))
                    }
                    placeholder={`Opción ${String.fromCharCode(65 + i)}`}
                  />
                </div>
              ))}
            </div>
          )}
          {qType === "cerrada_multi" && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label required>Opciones (marca las correctas)</Label>
                <p className="text-xs text-muted-foreground">
                  El estudiante recibe puntaje proporcional según cuántas correctas marque, sin
                  penalización por incorrectas.
                </p>
                {qChoices.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={qCorrectIndices.includes(i)}
                      onChange={(e) => {
                        setQCorrectIndices((prev) =>
                          e.target.checked
                            ? Array.from(new Set([...prev, i])).sort((a, b) => a - b)
                            : prev.filter((idx) => idx !== i),
                        );
                      }}
                    />
                    <Input
                      value={c}
                      onChange={(e) =>
                        setQChoices(qChoices.map((cc, j) => (j === i ? e.target.value : cc)))
                      }
                      placeholder={`Opción ${String.fromCharCode(65 + i)}`}
                    />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Mínimo de marcadas</Label>
                  <Input
                    type="number"
                    min={0}
                    value={qMinSelections === "" ? "" : qMinSelections}
                    onChange={(e) =>
                      setQMinSelections(e.target.value === "" ? "" : Number(e.target.value))
                    }
                    placeholder="sin mínimo"
                  />
                </div>
                <div>
                  <Label>Máximo de marcadas</Label>
                  <Input
                    type="number"
                    min={1}
                    value={qMaxSelections === "" ? "" : qMaxSelections}
                    onChange={(e) =>
                      setQMaxSelections(e.target.value === "" ? "" : Number(e.target.value))
                    }
                    placeholder="sin máximo"
                  />
                </div>
              </div>
            </div>
          )}
          {qType === "codigo" && (
            <div>
              <Label required>Lenguaje</Label>
              <Select value={qLanguage} onValueChange={setQLanguage}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="java">Java</SelectItem>
                  <SelectItem value="python">Python</SelectItem>
                  <SelectItem value="javascript">JavaScript</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label required>Rúbrica esperada (para IA)</Label>
            <Textarea
              value={qRubric}
              onChange={(e) => setQRubric(e.target.value)}
              rows={2}
              placeholder="¿Qué debe contener una buena respuesta?"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={submitManual}>
              {editingId ? (
                <>
                  <Save className="h-4 w-4 mr-1" /> Guardar cambios
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-1" /> Agregar pregunta
                </>
              )}
            </Button>
            {!editingId && workshopCourseId && (
              <Button variant="outline" onClick={() => setBankDialogOpen(true)}>
                <Library className="h-4 w-4 mr-1" /> Importar del banco
              </Button>
            )}
            {editingId && (
              <Button
                variant="outline"
                onClick={() => {
                  resetForm();
                  setActiveTab("list");
                }}
              >
                <X className="h-4 w-4 mr-1" /> Cancelar edición
              </Button>
            )}
          </div>
        </TabsContent>

        <TabsContent value="ai" className="space-y-4">
          <div>
            <Label required>Temas</Label>
            <Textarea
              value={aiTopics}
              onChange={(e) => setAiTopics(e.target.value)}
              rows={3}
              placeholder="Listas enlazadas, recursión, complejidad…"
            />
          </div>
          <div className="space-y-2">
            <Label>Tipos de preguntas a generar</Label>
            {aiRows.map((row, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="flex-1 min-w-0">
                  <Select
                    value={row.type}
                    onValueChange={(v) => updateAiRow(i, { type: v as any })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="abierta">Abierta</SelectItem>
                      <SelectItem value="cerrada">Opción múltiple</SelectItem>
                      <SelectItem value="codigo">Código</SelectItem>
                      <SelectItem value="diagrama">Diagrama</SelectItem>
                      <SelectItem value="java_gui">Java GUI</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {row.type === "codigo" && (
                  <div className="w-28 shrink-0">
                    <Select
                      value={row.language}
                      onValueChange={(v) => updateAiRow(i, { language: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="java">Java</SelectItem>
                        <SelectItem value="python">Python</SelectItem>
                        <SelectItem value="javascript">JavaScript</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="w-16 shrink-0">
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={row.count || ""}
                    onChange={(e) =>
                      updateAiRow(i, {
                        count: e.target.value === "" ? 0 : Number(e.target.value),
                      })
                    }
                    className="text-center"
                  />
                </div>
                {aiRows.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeAiRow(i)}
                    className="shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={addAiRow}>
              <Plus className="h-4 w-4 mr-1" /> Agregar tipo
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Total: {aiRows.reduce((s, r) => s + (r.count || 0), 0)} preguntas
            </span>
            <Button onClick={generateWithAI} disabled={aiLoading}>
              {aiLoading ? (
                <Spinner size="md" className="mr-1" />
              ) : (
                <Sparkles className="h-4 w-4 mr-1" />
              )}
              Generar con IA
            </Button>
          </div>
        </TabsContent>
      </Tabs>

      <QuestionBankImportDialog
        open={bankDialogOpen}
        onOpenChange={setBankDialogOpen}
        courseId={workshopCourseId}
        target="workshop"
        targetId={workshopId}
        onImported={() => void load()}
      />
      <aiGate.GateDialog />
    </div>
  );
}

/* =========================================================================
   STUDENT: Take a workshop with question-based answers + immediate AI grading
   ========================================================================= */
export function StudentWorkshopTaker({
  workshopId,
  maxScore,
  courseLanguage = "es",
  groupId,
  onGraded,
}: {
  workshopId: string;
  maxScore: number;
  courseLanguage?: "es" | "en";
  /** Si el taller es grupal, ID del grupo del estudiante. La submission
   *  se filtra/crea con este group_id en lugar de user_id. */
  groupId?: string | null;
  onGraded?: (finalGrade: number) => void;
}) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [questions, setQuestions] = useState<WorkshopQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [graded, setGraded] = useState<{ grade: number; breakdown: any[] } | null>(null);
  // Track which workshopId we have already loaded so that auth refresh
  // events (TOKEN_REFRESHED on tab refocus) don't re-fetch and visually
  // "reload" the modal while the student is mid-submission.
  const loadedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user) return;
    // Gate: solo cargar una vez por (workshopId + userId). Esto evita que
    // un TOKEN_REFRESHED en focus dispare un refetch y "recargue" el modal,
    // pero permite que el primer render con user=null no nos deje colgados:
    // cuando user llega, el effect re-corre y sí carga.
    const key = `${workshopId}::${user.id}`;
    if (loadedForRef.current === key) return;
    loadedForRef.current = key;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: qs } = await supabase
        .from("workshop_questions")
        .select("*")
        .eq("workshop_id", workshopId)
        .order("position");
      if (cancelled) return;
      setQuestions((qs ?? []) as WorkshopQuestion[]);

      // Load existing submission/answers. Si hay grupo, la submission
      // pertenece al grupo (cualquier miembro puede ver/editar).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny = supabase as any;
      const subQuery = dbAny
        .from("workshop_submissions")
        .select("id, final_grade, status")
        .eq("workshop_id", workshopId);
      const { data: sub } = await (groupId
        ? subQuery.eq("group_id", groupId).maybeSingle()
        : subQuery.eq("user_id", user.id).maybeSingle());
      if (sub?.id) {
        const { data: ans } = await supabase
          .from("workshop_submission_answers")
          .select("*")
          .eq("submission_id", sub.id);
        const map: Record<string, any> = {};
        const questionsById = new Map((qs ?? []).map((q: any) => [q.id, q]));
        (ans ?? []).forEach((a: any) => {
          const q = questionsById.get(a.question_id) as any;
          // cerrada_multi guarda array como JSON string en answer_text
          if (q?.type === "cerrada_multi" && typeof a.answer_text === "string") {
            try {
              const parsed = JSON.parse(a.answer_text);
              map[a.question_id] = Array.isArray(parsed) ? parsed : [];
              return;
            } catch {
              map[a.question_id] = [];
              return;
            }
          }
          map[a.question_id] =
            a.code_content ?? a.diagram_code ?? a.selected_option ?? a.answer_text ?? "";
        });
        if (cancelled) return;
        setAnswers(map);
        if (sub.status === "calificado" && sub.final_grade != null) {
          setGraded({ grade: Number(sub.final_grade), breakdown: [] });
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [workshopId, user?.id]);

  const updateAnswer = (qid: string, value: any) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
  };

  /**
   * Devuelve los números de pregunta (1-indexed) cuyas respuestas están
   * vacías. Para "cerrada" cuenta como vacía si no se eligió opción;
   * para el resto cuenta como vacía si el contenido (string) trim es "".
   */
  const getUnansweredNumbers = (): number[] => {
    const empty: number[] = [];
    questions.forEach((q, idx) => {
      const a = answers[q.id];
      let isBlank: boolean;
      if (q.type === "cerrada") {
        isBlank = a === undefined || a === null || a === "";
      } else if (q.type === "cerrada_multi") {
        if (!Array.isArray(a) || a.length === 0) {
          isBlank = true;
        } else {
          const minS = (q.options as any)?.min_selections;
          isBlank = typeof minS === "number" && minS > 0 && a.length < minS;
        }
      } else {
        isBlank = !String(a ?? "").trim();
      }
      if (isBlank) empty.push(idx + 1);
    });
    return empty;
  };

  const submit = async () => {
    if (!user) return;
    if (!questions.length) {
      toast.error("Este taller no tiene preguntas");
      return;
    }
    // Si el alumno deja preguntas sin responder, pedimos confirmación
    // explícita usando el ConfirmDialog del design system. Las preguntas
    // vacías reciben 0 puntos (ya lo manejaba el bucle de abajo); el
    // modal evita que el alumno entregue sin darse cuenta.
    const unanswered = getUnansweredNumbers();
    if (unanswered.length > 0) {
      const ok = await confirm({
        title: `${unanswered.length} pregunta${unanswered.length === 1 ? "" : "s"} sin responder`,
        description: (
          <div className="space-y-1">
            <p>
              Sin respuesta:{" "}
              <span className="font-medium text-foreground">
                {unanswered.map((n) => `#${n}`).join(", ")}
              </span>
              .
            </p>
            <p>Esas preguntas recibirán 0 puntos. ¿Quieres entregar el taller de todas formas?</p>
          </div>
        ),
        confirmLabel: "Entregar de todas formas",
        cancelLabel: "Seguir respondiendo",
        tone: "warning",
      });
      if (!ok) return;
    }
    setSubmitting(true);
    try {
      // Upsert submission. Si es grupal, filtramos/insertamos por
      // group_id para que cualquier miembro toque la misma fila.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny2 = supabase as any;
      let submissionId: string;
      const existingQuery = dbAny2
        .from("workshop_submissions")
        .select("id")
        .eq("workshop_id", workshopId);
      const { data: existing } = await (groupId
        ? existingQuery.eq("group_id", groupId).maybeSingle()
        : existingQuery.eq("user_id", user.id).maybeSingle());
      if (existing?.id) {
        submissionId = existing.id;
        await dbAny2
          .from("workshop_submissions")
          .update({
            status: "entregado",
            submitted_at: new Date().toISOString(),
            user_id: user.id, // último editor (auditoría)
          })
          .eq("id", submissionId);
      } else {
        const { data: created, error } = await dbAny2
          .from("workshop_submissions")
          .insert({
            workshop_id: workshopId,
            user_id: user.id,
            group_id: groupId ?? null,
            status: "entregado",
            submitted_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (error || !created) {
          toast.error(friendlyError(error, "No se pudo crear la entrega"));
          setSubmitting(false);
          return;
        }
        submissionId = created.id;
      }

      // ── Calificación en dos fases ──
      // Fase 1: scorea localmente las cerradas y empty; bucketea las
      //   abiertas (codigo/diagrama/abierta/java_gui con respuesta) para
      //   la llamada batch.
      // Fase 2: UNA sola llamada a IA con todas las abiertas. Antes era
      //   una llamada por pregunta abierta. Ganancia: latencia ~Nx menor,
      //   menos overhead de tokens, menos rate limits.
      let totalEarned = 0;
      let totalPoints = 0;
      const breakdown: any[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payloadsByQid: Record<string, any> = {};
      const batchItems: Array<{
        qid: string;
        type: string;
        content: string;
        rubric: string;
        userAnswer: string;
        maxPoints: number;
        language?: string | null;
      }> = [];

      for (const q of questions) {
        const raw = answers[q.id] ?? "";
        totalPoints += Number(q.points) || 0;

        const payload: any = {
          submission_id: submissionId,
          question_id: q.id,
        };
        if (q.type === "codigo" || q.type === "java_gui") payload.code_content = String(raw);
        else if (q.type === "diagrama") payload.diagram_code = String(raw);
        else if (q.type === "cerrada") payload.selected_option = String(raw);
        else if (q.type === "cerrada_multi") {
          payload.answer_text = JSON.stringify(Array.isArray(raw) ? raw : []);
        } else payload.answer_text = String(raw);

        if (q.type === "cerrada") {
          const correctIdx = q.options?.correct_index;
          const got = String(raw) === String(correctIdx) ? Number(q.points) : 0;
          payload.ai_grade = got;
          payload.ai_feedback = got > 0 ? "Respuesta correcta" : "Respuesta incorrecta";
          totalEarned += got;
          breakdown.push({
            qid: q.id,
            type: q.type,
            points: q.points,
            earned: got,
            feedback: payload.ai_feedback,
          });
        } else if (q.type === "cerrada_multi") {
          const selectedArr = Array.isArray(raw) ? (raw as number[]) : [];
          const result = scoreCerradaMulti({
            selected: selectedArr,
            correctIndices: ((q.options as any)?.correct_indices ?? []) as number[],
            totalPoints: Number(q.points) || 0,
            minSelections: (q.options as any)?.min_selections,
            maxSelections: (q.options as any)?.max_selections,
          });
          payload.ai_grade = result.earned;
          payload.ai_feedback = result.exceededMax
            ? `Marcaste más opciones de las permitidas (${(q.options as any)?.max_selections}).`
            : result.belowMin
              ? `Faltó marcar al menos ${(q.options as any)?.min_selections} opciones.`
              : selectedArr.length === 0
                ? "Sin respuesta"
                : `${result.earned} / ${q.points} pts`;
          totalEarned += result.earned;
          breakdown.push({
            qid: q.id,
            type: q.type,
            points: q.points,
            earned: result.earned,
            feedback: payload.ai_feedback,
          });
        } else {
          // Detecta "sin respuesta":
          //   1. String vacío / whitespace.
          //   2. Código idéntico al starter_code del docente — el alumno
          //      abrió la pregunta y no escribió nada propio. Sin esta
          //      comparación la IA recibe el template y gasta tokens
          //      calificando lo que el docente mismo escribió.
          const trimmedAnswer = String(raw).trim();
          const trimmedStarter = String(q.starter_code ?? "").trim();
          const isEmpty =
            !trimmedAnswer || (trimmedStarter !== "" && trimmedAnswer === trimmedStarter);
          if (isEmpty) {
            payload.ai_grade = 0;
            payload.ai_feedback = "Sin respuesta";
            breakdown.push({
              qid: q.id,
              type: q.type,
              points: q.points,
              earned: 0,
              feedback: "Sin respuesta",
            });
          } else {
            // Abierta con respuesta → bucket para batch. NO empujamos a
            // breakdown todavía; se completa después con el resultado IA.
            batchItems.push({
              qid: q.id,
              type: q.type === "java_gui" ? "codigo" : q.type,
              content: String(q.content ?? ""),
              rubric: String(q.expected_rubric ?? ""),
              userAnswer: String(raw),
              maxPoints: Number(q.points) || 0,
              language: q.type === "java_gui" ? "java" : q.language,
            });
          }
        }
        payloadsByQid[q.id] = payload;
      }

      // Detectar modo IA antes de la Fase 2. En `async` sin override
      // diferimos la calificación de las abiertas: marcamos cada
      // respuesta con `ai_feedback = Pendiente IA…` y encolamos UN job
      // por pregunta (kind="workshop_question") después del upsert.
      // El worker drena la cola más tarde y persiste la nota real. El
      // estudiante ve un toast informativo + el banner cuando vuelva
      // a entrar al taller.
      const aiMode = await getProcessingMode();
      const aiOverrideActive = !!readOverrideExpiry();
      const useAsyncAi = aiMode === "async" && !aiOverrideActive;

      // ── Fase 2: UNA llamada batch para todas las abiertas (SOLO sync) ──
      if (batchItems.length > 0 && !useAsyncAi) {
        const { data: bData, error: bErr } = await supabase.functions.invoke(
          "ai-grade-submission",
          {
            body: {
              batchGrading: true,
              items: batchItems,
              courseLanguage,
              useCase: "workshop_question",
            },
          },
        );
        const batchFailed = !!(bErr || bData?.error);
        const batchResults =
          !batchFailed && bData?.results && typeof bData.results === "object"
            ? (bData.results as Record<
                string,
                { score: number; feedback: string; ai_likelihood?: number; ai_reasons?: string }
              >)
            : {};
        const errMsg = batchFailed
          ? `Error IA: ${bErr?.message ?? bData?.error ?? "Desconocido"}`
          : null;

        for (const it of batchItems) {
          const r = batchResults[it.qid];
          const payload = payloadsByQid[it.qid];
          if (r) {
            const earned = Math.max(0, Math.min(it.maxPoints, Number(r.score) || 0));
            payload.ai_grade = earned;
            payload.ai_feedback = r.feedback || "Sin retroalimentación";
            totalEarned += earned;
            breakdown.push({
              qid: it.qid,
              type: it.type,
              points: it.maxPoints,
              earned,
              feedback: payload.ai_feedback,
            });
          } else {
            // Falló el batch o el modelo omitió esta pregunta.
            payload.ai_grade = 0;
            payload.ai_feedback = errMsg ?? "El modelo no incluyó esta pregunta en su respuesta.";
            breakdown.push({
              qid: it.qid,
              type: it.type,
              points: it.maxPoints,
              earned: 0,
              feedback: payload.ai_feedback,
            });
          }
        }
      } else if (batchItems.length > 0 && useAsyncAi) {
        // Modo async: pre-marcar cada abierta como pendiente. La nota
        // real llegará cuando el worker drene la cola. NO contamos
        // hacia totalEarned — la nota final también queda pendiente.
        for (const it of batchItems) {
          const payload = payloadsByQid[it.qid];
          payload.ai_grade = null;
          payload.ai_feedback = PENDING_AI_FEEDBACK;
          breakdown.push({
            qid: it.qid,
            type: it.type,
            points: it.maxPoints,
            earned: 0,
            feedback: PENDING_AI_FEEDBACK,
          });
        }
      }

      // ── Persistencia: upsert por qid ──
      for (const qid of Object.keys(payloadsByQid)) {
        await supabase
          .from("workshop_submission_answers")
          .upsert(payloadsByQid[qid], { onConflict: "submission_id,question_id" });
      }

      // ── Encolado IA (solo modo async, después del upsert) ──
      // Encolamos un job por pregunta abierta. El target row del job es
      // el `workshop_submission_answers.id` recién upserteado. Por
      // simplicidad encolamos N jobs (no UN batch) — más caro en
      // llamadas Gemini pero coherente con el modelo per-row del worker.
      if (useAsyncAi && batchItems.length > 0) {
        // Fetch el course_id del workshop para el RLS del docente
        // (mismo motivo que en examen + proyecto).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbForCourse = supabase as any;
        const { data: wsRow } = await dbForCourse
          .from("workshops")
          .select("course_id")
          .eq("id", workshopId)
          .maybeSingle();
        const courseIdForJob = (wsRow as { course_id?: string } | null)?.course_id ?? null;

        for (const it of batchItems) {
          // ID del answer recién upserteado.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: row } = await (supabase as any)
            .from("workshop_submission_answers")
            .select("id")
            .eq("submission_id", submissionId)
            .eq("question_id", it.qid)
            .maybeSingle();
          if (!row?.id) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase as any).rpc("enqueue_ai_grading", {
            _kind: "workshop_question",
            _invoke_target: "ai-grade-submission",
            _body: {
              workshopQuestionGrading: true,
              questionType: it.type,
              questionContent: it.content,
              expectedRubric: it.rubric,
              maxPoints: it.maxPoints,
              studentAnswer: it.userAnswer,
              language: it.language,
              courseLanguage,
            },
            _target_table: "workshop_submission_answers",
            _target_row_id: row.id,
            _field_grade: "ai_grade",
            _field_feedback: "ai_feedback",
            _field_likelihood: "ai_likelihood",
            _field_reasons: "ai_reasons",
            _course_id: courseIdForJob,
          });
        }
      }

      if (useAsyncAi && batchItems.length > 0) {
        // En async dejamos la submission como `entregado` (no
        // `calificado`) porque la nota real todavía no se calculó.
        // ai_grade queda null y ai_feedback con el placeholder.
        await supabase
          .from("workshop_submissions")
          .update({
            ai_grade: null,
            final_grade: null,
            ai_feedback: PENDING_AI_FEEDBACK,
            status: "entregado",
          })
          .eq("id", submissionId);
        setGraded({ grade: 0, breakdown });
        toast.info(QUEUED_STUDENT_TITLE, { description: QUEUED_STUDENT_BODY, duration: 8000 });
      } else {
        const finalGrade =
          totalPoints > 0 ? Number(((totalEarned / totalPoints) * Number(maxScore)).toFixed(2)) : 0;

        await supabase
          .from("workshop_submissions")
          .update({
            ai_grade: finalGrade,
            final_grade: finalGrade,
            ai_feedback: `Calificación automática inmediata sobre ${maxScore} pts.`,
            status: "calificado",
          })
          .eq("id", submissionId);

        setGraded({ grade: finalGrade, breakdown });
        onGraded?.(finalGrade);
        toast.success(`Calificación: ${finalGrade} / ${maxScore}`);
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">
        <Spinner size="xs" inline className="mr-1" /> Cargando preguntas…
      </p>
    );
  }

  if (!questions.length) {
    return <p className="text-sm text-muted-foreground">Este taller aún no tiene preguntas.</p>;
  }

  if (graded) {
    return (
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-base">Resultado del taller</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">
            {graded.grade} / {maxScore}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{t("workshop.aiGradedNotice")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {questions.map((q, idx) => (
        <Card key={q.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">
                {idx + 1}
              </Badge>
              <Badge variant="secondary" className="text-[10px] capitalize">
                {q.type}
              </Badge>
              <span className="text-xs text-muted-foreground">{q.points} pts</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <MarkdownInline>{q.content}</MarkdownInline>
            {q.type === "abierta" && (
              <Textarea
                rows={4}
                value={answers[q.id] ?? ""}
                onChange={(e) => updateAnswer(q.id, e.target.value)}
                placeholder="Escribe tu respuesta…"
              />
            )}
            {q.type === "cerrada" && q.options?.choices && (
              <div className="space-y-1.5">
                {q.options.choices.map((c: string, i: number) => (
                  <label key={i} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name={`q-${q.id}`}
                      checked={String(answers[q.id]) === String(i)}
                      onChange={() => updateAnswer(q.id, i)}
                    />
                    {c}
                  </label>
                ))}
              </div>
            )}
            {q.type === "cerrada_multi" && q.options?.choices && (
              <div className="space-y-1.5">
                {(() => {
                  const sel = Array.isArray(answers[q.id]) ? (answers[q.id] as number[]) : [];
                  const minS = (q.options as any)?.min_selections;
                  const maxS = (q.options as any)?.max_selections;
                  const hint =
                    typeof minS === "number" && typeof maxS === "number"
                      ? `Marca entre ${minS} y ${maxS} opciones`
                      : typeof minS === "number"
                        ? `Marca al menos ${minS}`
                        : typeof maxS === "number"
                          ? `Marca máximo ${maxS}`
                          : "Marca todas las correctas";
                  return (
                    <>
                      <p className="text-xs text-muted-foreground">{hint}</p>
                      {q.options.choices.map((c: string, i: number) => {
                        const checked = sel.includes(i);
                        return (
                          <label key={i} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(e) => {
                                const next = e.target.checked
                                  ? Array.from(new Set([...sel, i])).sort((a, b) => a - b)
                                  : sel.filter((x) => x !== i);
                                updateAnswer(q.id, next);
                              }}
                            />
                            {c}
                          </label>
                        );
                      })}
                      {typeof maxS === "number" && sel.length > maxS && (
                        <p className="text-xs text-destructive">
                          Has marcado más de las permitidas ({maxS}).
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
            {q.type === "codigo" && (
              <CodeEditor
                value={
                  answers[q.id] ?? q.starter_code ?? (q.language === "java" ? JAVA_STARTER : "")
                }
                onChange={(v) => updateAnswer(q.id, v ?? "")}
                language={(q.language as any) ?? "java"}
                showLanguageSelector={false}
                showRunButton={false}
                height="280px"
              />
            )}
            {q.type === "diagrama" && (
              <DiagramEditor value={answers[q.id] ?? ""} onChange={(v) => updateAnswer(q.id, v)} />
            )}
            {q.type === "java_gui" && (
              <JavaGuiRunner
                value={answers[q.id] ?? q.starter_code ?? JAVA_GUI_STARTER}
                onChange={(v) => updateAnswer(q.id, v)}
                height="280px"
              />
            )}
          </CardContent>
        </Card>
      ))}
      <div className="sticky bottom-2 z-10 bg-background/80 backdrop-blur p-2 rounded-lg border">
        <Button onClick={submit} disabled={submitting} className="w-full">
          {submitting ? (
            <>
              <Spinner size="md" className="mr-1" />
              {t("workshop.submitting")}
            </>
          ) : (
            <>
              <Send className="h-4 w-4 mr-1" />
              {t("workshop.submit")}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
