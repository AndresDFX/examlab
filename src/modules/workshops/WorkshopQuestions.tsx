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
import { Switch } from "@/components/ui/switch";
import { HelpHint } from "@/components/ui/help-hint";
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
import { CodeEditor, getStarterCode } from "@/modules/code/CodeEditor";
import { DiagramEditor } from "@/modules/code/DiagramEditor";
import { JavaGuiRunner, JAVA_GUI_STARTER, JAVAFX_STARTER } from "@/modules/code/JavaGuiRunner";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { IntroVideoGate, type IntroVideo } from "@/shared/components/IntroVideoGate";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { formatFileSize, formatFileSizeShort } from "@/shared/lib/format";
import {
  LANG_TO_EXT,
  MAX_CODE_FILES_TOTAL_BYTES,
  MAX_CODE_FILES_COUNT,
  isFileAllowed,
  preValidateZipInBrowser,
} from "@/shared/lib/code-upload";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import {
  getProcessingMode,
  readOverrideExpiry,
  PENDING_AI_FEEDBACK,
  QUEUED_STUDENT_TITLE,
} from "@/modules/ai/ai-grading";

export type WorkshopQuestion = {
  id: string;
  workshop_id: string;
  type: "abierta" | "cerrada" | "cerrada_multi" | "codigo" | "diagrama" | "java_gui" | "codigo_zip";
  content: string;
  options: any;
  position: number;
  points: number;
  expected_rubric: string | null;
  starter_code: string | null;
  language: string | null;
  /** Solo aplica a `codigo_zip`: si true, el estudiante sube UN .zip
   *  (modo scaffolding sin minify). Si false, sube N archivos
   *  individuales filtrados por extensión del lenguaje. */
  zip_single?: boolean;
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
  // Solo aplica a `codigo_zip`: toggle scaffolding "modo ZIP único" vs
  // multi-archivo. La columna `workshop_questions.zip_single` se agrega
  // en la migración 20260607010000.
  const [qZipSingle, setQZipSingle] = useState(false);
  // Framework GUI para preguntas `java_gui`. Se persiste en
  // `options.java_framework`. Default "swing" para retro-compat.
  const [qJavaFramework, setQJavaFramework] = useState<"swing" | "javafx">("swing");

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
    setQZipSingle(false);
    setQJavaFramework("swing");
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
    setQZipSingle(!!q.zip_single);
    const fw = (q.options as { java_framework?: string } | null)?.java_framework;
    setQJavaFramework(fw === "javafx" ? "javafx" : "swing");
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
          : qType === "java_gui"
            ? { java_framework: qJavaFramework }
            : null;
    const language =
      qType === "codigo" || qType === "codigo_zip"
        ? qLanguage
        : qType === "java_gui"
          ? "java"
          : null;

    // Cast a any para `zip_single` — la columna se agrega en la migración
    // 20260607010000 y types.ts se regenera en el próximo publish de Lovable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = supabase as any;
    if (editingId) {
      // UPDATE: no tocamos position ni starter_code para no clobberar lo que
      // el docente haya personalizado. EXCEPCIÓN: si el tipo es java_gui y
      // el starter_code persistido coincide EXACTO con el default del otro
      // framework, asumimos "template sin tocar" y lo refrescamos al
      // default del framework actual. Sin esto, cambiar la pregunta de
      // Swing→JavaFX dejaba el `extends JFrame` con framework=javafx, y
      // el alumno veía código incongruente con el runner.
      const existing = questions.find((q) => q.id === editingId);
      const starterUpdate =
        qType === "java_gui" && existing
          ? (() => {
              const desired = qJavaFramework === "javafx" ? JAVAFX_STARTER : JAVA_GUI_STARTER;
              const other = qJavaFramework === "javafx" ? JAVA_GUI_STARTER : JAVAFX_STARTER;
              if (existing.starter_code === other) return { starter_code: desired };
              return null; // preservar (custom o ya alineado).
            })()
          : null;
      const { error } = await dbAny
        .from("workshop_questions")
        .update({
          type: qType,
          content: qContent,
          expected_rubric: qRubric || null,
          options,
          points: qPoints,
          language,
          zip_single: qType === "codigo_zip" ? qZipSingle : false,
          ...(starterUpdate ?? {}),
        })
        .eq("id", editingId);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success("Pregunta actualizada");
    } else {
      const { error } = await dbAny.from("workshop_questions").insert({
        workshop_id: workshopId,
        type: qType,
        content: qContent,
        expected_rubric: qRubric || null,
        options,
        points: qPoints,
        position: questions.length,
        language,
        zip_single: qType === "codigo_zip" ? qZipSingle : false,
        starter_code:
          qType === "java_gui"
            ? qJavaFramework === "javafx"
              ? JAVAFX_STARTER
              : JAVA_GUI_STARTER
            : qType === "codigo"
              ? getStarterCode(language) || null
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
    // La generación de preguntas con IA NO tiene worker async (a
    // diferencia de la calificación, que usa `ai_grading_queue`). El gate
    // se llama con `allowQueue: false` para que el dialog solo ofrezca
    // "Activar IA inmediata" o "Cancelar". El caso `proceed-async` no
    // debería ocurrir, pero lo trato defensivamente: antes el código
    // ignoraba el valor del decision y llamaba al edge igual, lo que
    // hacía que en modo batch el docente "encolara" pero la IA se
    // disparara igual (sin código de activación).
    const decision = await aiGate.ensureAuthorized({ allowQueue: false });
    if (decision === "cancel") return;
    if (decision === "proceed-async") {
      toast.error(
        "La generación con IA no soporta modo cola. Activá un código de IA inmediata para continuar.",
      );
      return;
    }
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
                  <SelectItem value="codigo_zip">Código (ZIP / multi-archivo)</SelectItem>
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
          {qType === "java_gui" && (
            <div>
              <Label className="flex items-center gap-1.5">
                Framework
                <HelpHint>
                  <span>
                    <strong>Swing/AWT</strong>: framework built-in del JDK, soportado por CheerpJ
                    (navegador) y AWS Lambda. Default histórico.
                  </span>
                  <br />
                  <span>
                    <strong>JavaFX</strong>: requiere OpenJFX 21 (instalado en el runner Lambda). NO
                    funciona con CheerpJ. La clase del alumno debe <code>extends Application</code>;
                    el wrapper server-side llama <code>Application.launch()</code> automáticamente.
                  </span>
                </HelpHint>
              </Label>
              <Select
                value={qJavaFramework}
                onValueChange={(v) => setQJavaFramework(v as "swing" | "javafx")}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="swing">Swing / AWT</SelectItem>
                  <SelectItem value="javafx">JavaFX</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                {qJavaFramework === "javafx"
                  ? "Requiere modo runner AWS Lambda — CheerpJ no incluye OpenJFX."
                  : "Compatible con ambos runners (CheerpJ + AWS Lambda)."}
              </p>
            </div>
          )}
          {qType === "codigo_zip" && (
            <div className="space-y-3">
              <div>
                <Label required className="flex items-center gap-1.5">
                  Lenguaje
                  <HelpHint>
                    Whitelist de extensiones aceptadas — Java solo .java, Python solo .py. Lo que
                    quede fuera (PDFs, README, configs) se rechaza antes de subir.
                  </HelpHint>
                </Label>
                <Select value={qLanguage} onValueChange={setQLanguage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="java">Java (.java)</SelectItem>
                    <SelectItem value="python">Python (.py)</SelectItem>
                    <SelectItem value="javascript">JavaScript (.js, .mjs, .cjs)</SelectItem>
                    <SelectItem value="typescript">TypeScript (.ts, .tsx)</SelectItem>
                    <SelectItem value="c">C (.c, .h)</SelectItem>
                    <SelectItem value="cpp">C++ (.cpp, .cc, .h, .hpp)</SelectItem>
                    <SelectItem value="csharp">C# (.cs)</SelectItem>
                    <SelectItem value="go">Go (.go)</SelectItem>
                    <SelectItem value="rust">Rust (.rs)</SelectItem>
                    <SelectItem value="php">PHP (.php)</SelectItem>
                    <SelectItem value="ruby">Ruby (.rb)</SelectItem>
                    <SelectItem value="kotlin">Kotlin (.kt, .kts)</SelectItem>
                    <SelectItem value="swift">Swift (.swift)</SelectItem>
                    <SelectItem value="sql">SQL (.sql)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-md border bg-card p-3">
                <div className="space-y-0.5">
                  <Label className="flex items-center gap-1.5">
                    Modo ZIP único (scaffolding)
                    <HelpHint>
                      <strong>OFF (default):</strong> el alumno sube N archivos individuales del
                      lenguaje. Se filtran por extensión y se minifican antes de IA.
                      <br />
                      <strong>ON:</strong> el alumno sube UN archivo .zip con todo su proyecto. El
                      backend descomprime y la IA recibe archivos crudos sin minify ni truncar —
                      ideal para entregas chicas donde quieres que la IA "vea" todo el código.
                    </HelpHint>
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    {qZipSingle
                      ? "El alumno sube UN .zip — el servidor lo descomprime y califica todo junto."
                      : "El alumno sube archivos individuales — solo los del lenguaje seleccionado."}
                  </p>
                </div>
                <Switch checked={qZipSingle} onCheckedChange={setQZipSingle} />
              </div>
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
  // Gate de videos introductorios obligatorios del taller (lista N en
  // orden estricto). A diferencia de proyectos —donde el gate solo
  // aplica si hay pregunta tipo `codigo_zip`—, en talleres aplica a
  // CUALQUIER entrega: el alumno debe ver TODOS los videos antes de
  // poder entregar. `watchedVideoIds` se hidrata desde
  // `workshop_submission_video_views` al cargar — sesiones reanudadas
  // conservan el progreso.
  const [introVideos, setIntroVideos] = useState<IntroVideo[]>([]);
  const [watchedVideoIds, setWatchedVideoIds] = useState<Set<string>>(() => new Set());
  const allVideosWatched = introVideos.every((v) => watchedVideoIds.has(v.id));
  const videoGateBlocking = introVideos.length > 0 && !allVideosWatched;
  // Enforcement de max_attempts (paralelo a proyectos). `attemptCount`
  // viene de la submission existente (0 si nunca entregó).
  // `effectiveMaxAttempts` = override del taller o el default global.
  const [attemptCount, setAttemptCount] = useState<number>(0);
  const [effectiveMaxAttempts, setEffectiveMaxAttempts] = useState<number>(1);
  const attemptsExhausted = attemptCount >= effectiveMaxAttempts;
  const attemptsRemaining = Math.max(0, effectiveMaxAttempts - attemptCount);
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny = supabase as any;
      const [{ data: qs }, { data: videosData }, { data: wsRow }, { data: settingsRow }] =
        await Promise.all([
          supabase
            .from("workshop_questions")
            .select("*")
            .eq("workshop_id", workshopId)
            .order("position"),
          dbAny
            .from("workshop_intro_videos")
            .select("id, url, title, position")
            .eq("workshop_id", workshopId)
            .order("position"),
          dbAny.from("workshops").select("max_attempts").eq("id", workshopId).maybeSingle(),
          dbAny.from("app_settings").select("default_workshop_max_attempts").limit(1).maybeSingle(),
        ]);
      if (cancelled) return;
      setQuestions((qs ?? []) as WorkshopQuestion[]);
      setIntroVideos(
        (videosData as Array<{
          id: string;
          url: string;
          title: string | null;
          position: number;
        }> | null) ?? [],
      );
      const wsMax = (wsRow as { max_attempts?: number | null } | null)?.max_attempts;
      const globalMax = (settingsRow as { default_workshop_max_attempts?: number | null } | null)
        ?.default_workshop_max_attempts;
      setEffectiveMaxAttempts(Number(wsMax ?? globalMax ?? 1));

      // Load existing submission/answers. Si hay grupo, la submission
      // pertenece al grupo (cualquier miembro puede ver/editar).
      const subQuery = dbAny
        .from("workshop_submissions")
        .select("id, final_grade, status, attempt_count")
        .eq("workshop_id", workshopId);
      const { data: sub } = await (groupId
        ? subQuery.eq("group_id", groupId).maybeSingle()
        : subQuery.eq("user_id", user.id).maybeSingle());
      setAttemptCount(Number((sub as { attempt_count?: number } | null)?.attempt_count ?? 0));
      if (sub?.id) {
        // Hidratar el set de videos ya vistos desde
        // `workshop_submission_video_views`. Si la submission no existe
        // todavía (primer abrir del taller), el set queda vacío y el
        // estudiante debe ver todos los videos.
        const { data: viewsData } = await supabase
          .from("workshop_submission_video_views")
          .select("video_id")
          .eq("submission_id", sub.id);
        if (!cancelled) {
          const ids = ((viewsData as Array<{ video_id: string }> | null) ?? []).map(
            (v) => v.video_id,
          );
          setWatchedVideoIds(new Set(ids));
        }
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
   * vacías. Reglas por tipo:
   *   - cerrada: no se eligió opción.
   *   - cerrada_multi: array vacío, o menos selecciones que `min_selections`.
   *   - codigo_zip: sin archivo / archivo vacío.
   *   - codigo: contenido vacío O idéntico al starter_code (el alumno
   *     abrió la pregunta y NO escribió código propio — la IA igual
   *     graduaría como 0 con feedback "Sin respuesta", ver lógica de
   *     calificación más abajo; advertimos al entregar para evitar
   *     entregas accidentales).
   *   - resto (abierta/diagrama/etc.): string trim() vacío.
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
      } else if (q.type === "codigo_zip") {
        // Para codigo_zip la respuesta es File (zip_single) o File[] (multi).
        if (a instanceof File) isBlank = a.size === 0;
        else if (Array.isArray(a)) isBlank = a.length === 0;
        else isBlank = true;
      } else if (q.type === "codigo") {
        // Misma lógica de "Sin respuesta" que aplica la calificación
        // (ver línea ~1475): vacío O igual al starter_code → cuenta
        // como no respondida. Sin esta detección, un alumno que pulsa
        // Entregar sin tocar el editor pasaba el check (starter_code
        // truthy) y entregaba con 0 puntos sin advertencia.
        const trimmedAnswer = String(a ?? "").trim();
        const trimmedStarter = String(q.starter_code ?? "").trim();
        isBlank = !trimmedAnswer || (trimmedStarter !== "" && trimmedAnswer === trimmedStarter);
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
    if (videoGateBlocking) {
      toast.error("Debes ver todos los videos introductorios antes de entregar.");
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
      // Traemos `attempt_count`, `status` y `final_grade` para aplicar
      // la regla "el intento solo cuenta cuando la entrega previa ya
      // tiene nota". Si el alumno está re-editando una entrega que aún
      // no fue calificada, mantenemos el mismo conteo — no gasta un
      // intento nuevo. Idéntico patrón al de proyectos.
      const existingQuery = dbAny2
        .from("workshop_submissions")
        .select("id, attempt_count, status, final_grade")
        .eq("workshop_id", workshopId);
      const { data: existing } = await (groupId
        ? existingQuery.eq("group_id", groupId).maybeSingle()
        : existingQuery.eq("user_id", user.id).maybeSingle());
      const existingRow = existing as {
        id?: string;
        attempt_count?: number;
        status?: string;
        final_grade?: number | null;
      } | null;
      const previousCount = Number(existingRow?.attempt_count ?? 0);
      const previousWasGraded =
        existingRow != null &&
        (existingRow.status === "calificado" || existingRow.final_grade != null);
      const incrementAttempt = !existingRow || previousWasGraded;
      const nextAttemptCount = incrementAttempt ? previousCount + 1 : previousCount;
      if (nextAttemptCount > effectiveMaxAttempts) {
        toast.error(
          `Ya consumiste tus ${effectiveMaxAttempts} intento${effectiveMaxAttempts === 1 ? "" : "s"} de entrega. Recarga para ver la entrega actual.`,
        );
        setSubmitting(false);
        return;
      }
      if (existingRow?.id) {
        submissionId = existingRow.id;
        await dbAny2
          .from("workshop_submissions")
          .update({
            status: "entregado",
            submitted_at: new Date().toISOString(),
            user_id: user.id, // último editor (auditoría)
            attempt_count: nextAttemptCount,
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
            attempt_count: nextAttemptCount,
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
      // Sync local state — afecta el botón "entregar" que se deshabilita
      // si el conteo alcanza el cap (mismo patrón que proyectos).
      setAttemptCount(nextAttemptCount);

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
      // Encolas async pendientes de `codigo_zip` — se procesan después
      // del upsert porque necesitamos el row id del answer.
      const pendingZipEnqueues: Array<{
        qid: string;
        body: Record<string, unknown>;
      }> = [];

      // Detectamos el modo IA arriba (no después del loop) para que la
      // ruta de `codigo_zip` —que sube archivos y llama al edge inline o
      // encola un job— pueda ramificar sync/async desde el inicio.
      const aiModeEarly = await getProcessingMode();
      const aiOverrideActiveEarly = !!readOverrideExpiry();
      const useAsyncAiEarly = aiModeEarly === "async" && !aiOverrideActiveEarly;
      const rootFolder = groupId ?? user.id;

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
        } else if (q.type === "codigo_zip") {
          // `answer_text` queda vacío — la "respuesta" son los archivos
          // subidos a Storage; los paths se persisten en `zip_path` /
          // `code_paths` más abajo.
          payload.answer_text = "";
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
        } else if (q.type === "codigo_zip") {
          // ── codigo_zip: subimos archivos a `workshop-files` y, según
          // modo IA, calificamos inline (sync) o encolamos (async). Mismo
          // patrón que proyectos pero apuntando al bucket de talleres y
          // pasando `workshopCodeZipGrading: true` al edge.
          const langKey = (q.language ?? "").toLowerCase().trim();
          const allowedExts = LANG_TO_EXT[langKey] ?? null;
          if (q.zip_single) {
            const zipFile = raw instanceof File ? raw : null;
            if (!zipFile) {
              payload.ai_grade = 0;
              payload.ai_feedback = "Sin archivo ZIP entregado";
              breakdown.push({
                qid: q.id,
                type: q.type,
                points: q.points,
                earned: 0,
                feedback: payload.ai_feedback,
              });
            } else if (zipFile.size > MAX_CODE_FILES_TOTAL_BYTES) {
              payload.ai_grade = 0;
              payload.ai_feedback = `El ZIP pesa ${formatFileSize(zipFile.size)} y supera el tope de 50 MB.`;
              toast.error(payload.ai_feedback, { duration: 8000 });
              breakdown.push({
                qid: q.id,
                type: q.type,
                points: q.points,
                earned: 0,
                feedback: payload.ai_feedback,
              });
            } else {
              const preCheck = await preValidateZipInBrowser(zipFile, allowedExts);
              if (!preCheck.ok) {
                payload.ai_grade = 0;
                payload.ai_feedback = preCheck.error;
                toast.error(preCheck.error, { duration: 10000 });
                breakdown.push({
                  qid: q.id,
                  type: q.type,
                  points: q.points,
                  earned: 0,
                  feedback: preCheck.error,
                });
              } else {
                const zipPath = `${rootFolder}/${submissionId}/${q.id}.zip`;
                const { error: upErr } = await supabase.storage
                  .from("workshop-files")
                  .upload(zipPath, zipFile, { upsert: true, contentType: "application/zip" });
                if (upErr) {
                  payload.ai_grade = 0;
                  payload.ai_feedback = `Error al subir el ZIP: ${upErr.message}`;
                  toast.error(payload.ai_feedback, { duration: 8000 });
                  breakdown.push({
                    qid: q.id,
                    type: q.type,
                    points: q.points,
                    earned: 0,
                    feedback: payload.ai_feedback,
                  });
                } else {
                  payload.zip_path = zipPath;
                  const aiBody: Record<string, unknown> = {
                    workshopCodeZipGrading: true,
                    zipPath,
                    noMinify: true,
                    fileTitle: q.content,
                    expectedRubric: q.expected_rubric,
                    maxPoints: q.points,
                    courseLanguage,
                  };
                  if (useAsyncAiEarly) {
                    payload.ai_grade = null;
                    payload.ai_feedback = PENDING_AI_FEEDBACK;
                    pendingZipEnqueues.push({ qid: q.id, body: aiBody });
                    breakdown.push({
                      qid: q.id,
                      type: q.type,
                      points: q.points,
                      earned: 0,
                      feedback: PENDING_AI_FEEDBACK,
                    });
                  } else {
                    const { data: aiData, error: aiErr } = await supabase.functions.invoke(
                      "ai-grade-submission",
                      { body: aiBody },
                    );
                    if (aiErr || (aiData as any)?.error) {
                      const detail = await extractEdgeError(aiErr, aiData);
                      payload.ai_grade = 0;
                      payload.ai_feedback = detail || "Error IA al calificar el ZIP";
                      toast.error(payload.ai_feedback, { duration: 8000 });
                      breakdown.push({
                        qid: q.id,
                        type: q.type,
                        points: q.points,
                        earned: 0,
                        feedback: payload.ai_feedback,
                      });
                    } else {
                      const earned = Math.max(
                        0,
                        Math.min(Number(q.points) || 0, Number((aiData as any)?.grade) || 0),
                      );
                      const fb = (aiData as any)?.feedback ?? "Sin retroalimentación";
                      payload.ai_grade = earned;
                      payload.ai_feedback = fb;
                      payload.ai_likelihood =
                        typeof (aiData as any)?.ai_likelihood === "number"
                          ? (aiData as any).ai_likelihood
                          : null;
                      payload.ai_reasons = (aiData as any)?.ai_reasons ?? null;
                      if (typeof (aiData as any)?.zip_truncated === "boolean") {
                        payload.zip_truncated = (aiData as any).zip_truncated;
                      }
                      if (typeof (aiData as any)?.zip_chars_used === "number") {
                        payload.zip_chars_used = (aiData as any).zip_chars_used;
                      }
                      totalEarned += earned;
                      breakdown.push({
                        qid: q.id,
                        type: q.type,
                        points: q.points,
                        earned,
                        feedback: fb,
                      });
                    }
                  }
                }
              }
            }
          } else {
            // Multi-archivo
            const filesArr: File[] = Array.isArray(raw)
              ? (raw.filter((f) => f instanceof File) as File[])
              : raw instanceof File
                ? [raw]
                : [];
            if (filesArr.length === 0) {
              payload.ai_grade = 0;
              payload.ai_feedback = "Sin archivos de código entregados";
              breakdown.push({
                qid: q.id,
                type: q.type,
                points: q.points,
                earned: 0,
                feedback: payload.ai_feedback,
              });
            } else {
              const violations = allowedExts
                ? filesArr.filter((f) => !isFileAllowed(f.name, allowedExts))
                : [];
              const totalBytes = filesArr.reduce((acc, f) => acc + f.size, 0);
              if (violations.length > 0) {
                const sample = violations
                  .slice(0, 5)
                  .map((f) => f.name)
                  .join(", ");
                const more = violations.length > 5 ? ` (+${violations.length - 5} más)` : "";
                const allowedLabel = (allowedExts ?? []).map((e) => `.${e}`).join(", ");
                payload.ai_grade = 0;
                payload.ai_feedback = `Archivos no permitidos: ${sample}${more}. Solo se aceptan ${allowedLabel}.`;
                toast.error(payload.ai_feedback, { duration: 8000 });
                breakdown.push({
                  qid: q.id,
                  type: q.type,
                  points: q.points,
                  earned: 0,
                  feedback: payload.ai_feedback,
                });
              } else if (totalBytes > MAX_CODE_FILES_TOTAL_BYTES) {
                payload.ai_grade = 0;
                payload.ai_feedback = `El total supera el tope de 50 MB (${formatFileSize(totalBytes)}).`;
                toast.error(payload.ai_feedback, { duration: 8000 });
                breakdown.push({
                  qid: q.id,
                  type: q.type,
                  points: q.points,
                  earned: 0,
                  feedback: payload.ai_feedback,
                });
              } else if (filesArr.length > MAX_CODE_FILES_COUNT) {
                payload.ai_grade = 0;
                payload.ai_feedback = `Demasiados archivos (${filesArr.length}). Máximo: ${MAX_CODE_FILES_COUNT}.`;
                toast.error(payload.ai_feedback, { duration: 8000 });
                breakdown.push({
                  qid: q.id,
                  type: q.type,
                  points: q.points,
                  earned: 0,
                  feedback: payload.ai_feedback,
                });
              } else {
                const usedNames = new Set<string>();
                const uploads = await Promise.all(
                  filesArr.map(async (f, idx) => {
                    let safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
                    if (usedNames.has(safeName)) safeName = `${idx}_${safeName}`;
                    usedNames.add(safeName);
                    const path = `${rootFolder}/${submissionId}/${q.id}/${safeName}`;
                    const { error: upErr } = await supabase.storage
                      .from("workshop-files")
                      .upload(path, f, { upsert: true, contentType: f.type || "text/plain" });
                    return { path, error: upErr };
                  }),
                );
                const upFailed = uploads.filter((u) => u.error);
                if (upFailed.length > 0) {
                  payload.ai_grade = 0;
                  payload.ai_feedback = `Error al subir ${upFailed.length} archivo(s): ${upFailed[0].error?.message ?? ""}`;
                  toast.error(payload.ai_feedback, { duration: 8000 });
                  breakdown.push({
                    qid: q.id,
                    type: q.type,
                    points: q.points,
                    earned: 0,
                    feedback: payload.ai_feedback,
                  });
                } else {
                  const uploadedPaths = uploads.map((u) => u.path);
                  payload.code_paths = uploadedPaths;
                  const aiBody: Record<string, unknown> = {
                    workshopCodeZipGrading: true,
                    codePaths: uploadedPaths,
                    fileTitle: q.content,
                    expectedRubric: q.expected_rubric,
                    maxPoints: q.points,
                    courseLanguage,
                    ...(allowedExts ? { allowedExtensions: allowedExts } : {}),
                  };
                  if (useAsyncAiEarly) {
                    payload.ai_grade = null;
                    payload.ai_feedback = PENDING_AI_FEEDBACK;
                    pendingZipEnqueues.push({ qid: q.id, body: aiBody });
                    breakdown.push({
                      qid: q.id,
                      type: q.type,
                      points: q.points,
                      earned: 0,
                      feedback: PENDING_AI_FEEDBACK,
                    });
                  } else {
                    const { data: aiData, error: aiErr } = await supabase.functions.invoke(
                      "ai-grade-submission",
                      { body: aiBody },
                    );
                    if (aiErr || (aiData as any)?.error) {
                      const detail = await extractEdgeError(aiErr, aiData);
                      payload.ai_grade = 0;
                      payload.ai_feedback = detail || "Error IA al calificar los archivos";
                      toast.error(payload.ai_feedback, { duration: 8000 });
                      breakdown.push({
                        qid: q.id,
                        type: q.type,
                        points: q.points,
                        earned: 0,
                        feedback: payload.ai_feedback,
                      });
                    } else {
                      const earned = Math.max(
                        0,
                        Math.min(Number(q.points) || 0, Number((aiData as any)?.grade) || 0),
                      );
                      const fb = (aiData as any)?.feedback ?? "Sin retroalimentación";
                      payload.ai_grade = earned;
                      payload.ai_feedback = fb;
                      payload.ai_likelihood =
                        typeof (aiData as any)?.ai_likelihood === "number"
                          ? (aiData as any).ai_likelihood
                          : null;
                      payload.ai_reasons = (aiData as any)?.ai_reasons ?? null;
                      totalEarned += earned;
                      breakdown.push({
                        qid: q.id,
                        type: q.type,
                        points: q.points,
                        earned,
                        feedback: fb,
                      });
                    }
                  }
                }
              }
            }
          }
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

      // Reutilizamos la detección hecha arriba para que el comportamiento
      // sea consistente entre `codigo_zip` (loop) y `batchItems` (Fase 2).
      const useAsyncAi = useAsyncAiEarly;

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
      // UN solo job batch que cubre TODAS las preguntas abiertas de esta
      // entrega. El edge function `ai-grade-submission` con
      // `workshopFullGrading: true` reusa `gradeOpenAnswersInBatch` (la
      // misma helper que ya usaba el path sync) y persiste cada
      // resultado en workshop_submission_answers internamente.
      //
      // Antes: N enqueues con `workshop_question` (1 por pregunta) → N
      // llamadas a Gemini. Para un taller de 8 preguntas × 30 estudiantes
      // = 240 llamadas. Ahora son 30 (una por estudiante). ~8× menos
      // costo por concepto y menos rate-limiting.
      //
      // El target_row del job ahora es el workshop_submissions.id (la
      // entrega completa), no el workshop_submission_answers.id de cada
      // pregunta. El worker no escribe nada (persistedInternally=true);
      // el target sirve para que el panel Cola resuelva el taller y el
      // estudiante en su enrichment.
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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (supabase as any).rpc("enqueue_ai_grading", {
          _kind: "workshop_full",
          _invoke_target: "ai-grade-submission",
          _body: {
            workshopFullGrading: true,
            submissionId,
            items: batchItems.map((it) => ({
              qid: it.qid,
              content: it.content,
              rubric: it.rubric,
              userAnswer: it.userAnswer,
              maxPoints: it.maxPoints,
            })),
            courseLanguage,
            courseId: courseIdForJob,
          },
          _target_table: "workshop_submissions",
          _target_row_id: submissionId,
          // field_grade / field_feedback no se usan (persistedInternally
          // hace que el worker NO escriba), pero la RPC los requiere.
          // Defaults ai_grade/ai_feedback están bien.
          _course_id: courseIdForJob,
        });
      }

      // ── Encolado IA de `codigo_zip` (async) ──
      if (useAsyncAi && pendingZipEnqueues.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dbForCourse2 = supabase as any;
        const { data: wsRow2 } = await dbForCourse2
          .from("workshops")
          .select("course_id")
          .eq("id", workshopId)
          .maybeSingle();
        const courseIdForZip = (wsRow2 as { course_id?: string } | null)?.course_id ?? null;
        for (const it of pendingZipEnqueues) {
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
            _kind: "workshop_codigo_zip",
            _invoke_target: "ai-grade-submission",
            _body: it.body,
            _target_table: "workshop_submission_answers",
            _target_row_id: row.id,
            _field_grade: "ai_grade",
            _field_feedback: "ai_feedback",
            _field_likelihood: "ai_likelihood",
            _field_reasons: "ai_reasons",
            _course_id: courseIdForZip,
          });
        }
      }

      if (useAsyncAi && (batchItems.length > 0 || pendingZipEnqueues.length > 0)) {
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
        // Mensaje minimal: solo "Por calificar". Antes incluíamos un
        // body largo con detalle de la cola → ruido en cada submit.
        toast.info(QUEUED_STUDENT_TITLE, { duration: 6000 });
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
      {/* Gate de videos introductorios del taller (lista N en orden
          estricto). Solo se renderiza si el taller tiene videos en
          `workshop_intro_videos`. A diferencia de proyectos, aplica a
          CUALQUIER entrega de taller. */}
      {introVideos.length > 0 && (
        <IntroVideoGate
          videos={introVideos}
          watchedIds={watchedVideoIds}
          onVideoWatched={async (videoId) => {
            // Optimistic: state local primero para desbloquear el
            // siguiente video al instante. Si el RPC falla, el siguiente
            // reload re-pide la view perdida.
            setWatchedVideoIds((prev) => {
              const next = new Set(prev);
              next.add(videoId);
              return next;
            });
            try {
              if (!user) return;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const dbAny = supabase as any;
              const subQuery = dbAny
                .from("workshop_submissions")
                .select("id")
                .eq("workshop_id", workshopId);
              const { data: subRow } = await (groupId
                ? subQuery.eq("group_id", groupId).maybeSingle()
                : subQuery.eq("user_id", user.id).maybeSingle());
              if (subRow?.id) {
                await supabase.rpc("mark_workshop_video_watched", {
                  _submission_id: subRow.id,
                  _video_id: videoId,
                });
              }
              // Sin submission aún: progreso solo en state local. El
              // submit creará la submission y los siguientes "watched"
              // sí persistirán. Si el alumno cierra el modal entre que
              // ve el primer video y entrega, perderá ese progreso (caso
              // raro — la mayoría ve videos y entrega en la misma sesión).
            } catch {
              /* silencioso */
            }
          }}
        />
      )}

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
                value={answers[q.id] ?? q.starter_code ?? getStarterCode(q.language)}
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
            {q.type === "java_gui" &&
              (() => {
                // Default por framework: si no hay starter persistido,
                // mostrar el template que coincide con el runner.
                const fw =
                  (q.options as { java_framework?: "swing" | "javafx" } | null)?.java_framework ??
                  "swing";
                const defaultStarter = fw === "javafx" ? JAVAFX_STARTER : JAVA_GUI_STARTER;
                return (
                  <JavaGuiRunner
                    value={answers[q.id] ?? q.starter_code ?? defaultStarter}
                    onChange={(v) => updateAnswer(q.id, v)}
                    height="280px"
                    framework={fw}
                  />
                );
              })()}
            {q.type === "codigo_zip" &&
              q.zip_single &&
              (() => {
                const currentZip: File | null =
                  answers[q.id] instanceof File ? (answers[q.id] as File) : null;
                return (
                  <div className="space-y-2">
                    <div className="rounded-md border border-amber-400/40 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                      <strong>Modo ZIP único:</strong> sube un archivo <code>.zip</code> con todo tu
                      proyecto. El servidor lo descomprime y la IA califica todos los archivos
                      juntos.
                    </div>
                    <input
                      type="file"
                      accept=".zip,application/zip,application/x-zip-compressed"
                      onChange={(e) => {
                        const picked = e.target.files?.[0];
                        if (!picked) return;
                        if (picked.size === 0) {
                          toast.error("El archivo está vacío.");
                          e.target.value = "";
                          return;
                        }
                        if (picked.size > MAX_CODE_FILES_TOTAL_BYTES) {
                          toast.error(
                            `El ZIP pesa ${formatFileSize(picked.size)} y supera el tope de 50 MB.`,
                          );
                          e.target.value = "";
                          return;
                        }
                        if (!picked.name.toLowerCase().endsWith(".zip")) {
                          toast.error("Solo se acepta un archivo .zip.");
                          e.target.value = "";
                          return;
                        }
                        e.target.value = "";
                        updateAnswer(q.id, picked);
                      }}
                      className="block w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer hover:file:bg-primary/90"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Comprimí tu carpeta de proyecto en un único{" "}
                      <span className="font-mono">.zip</span>. Tope: 50 MB.
                    </p>
                    {currentZip && (
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <Badge variant="secondary" className="text-[10px] gap-1 pr-1">
                          <span className="truncate max-w-[16rem]">{currentZip.name}</span>
                          <span className="text-muted-foreground">
                            · {formatFileSizeShort(currentZip.size)}
                          </span>
                          <button
                            type="button"
                            aria-label={`Quitar ${currentZip.name}`}
                            className="ml-0.5 rounded hover:bg-muted-foreground/20 p-0.5"
                            onClick={() => updateAnswer(q.id, null)}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      </div>
                    )}
                  </div>
                );
              })()}
            {q.type === "codigo_zip" &&
              !q.zip_single &&
              (() => {
                const langKey = (q.language ?? "").toLowerCase().trim();
                const allowedExts = LANG_TO_EXT[langKey] ?? null;
                const acceptAttr = allowedExts
                  ? allowedExts.map((e) => `.${e}`).join(",")
                  : undefined;
                const allowedLabel = allowedExts
                  ? allowedExts.map((e) => `.${e}`).join(", ")
                  : "archivos de código fuente";
                const current: File[] = Array.isArray(answers[q.id])
                  ? (answers[q.id] as File[])
                  : answers[q.id] instanceof File
                    ? [answers[q.id] as File]
                    : [];
                return (
                  <div className="space-y-2">
                    <input
                      type="file"
                      multiple
                      accept={acceptAttr}
                      onChange={(e) => {
                        const picked = Array.from(e.target.files ?? []);
                        if (picked.length === 0) return;
                        if (allowedExts) {
                          const bad = picked.filter((f) => !isFileAllowed(f.name, allowedExts));
                          if (bad.length > 0) {
                            const sample = bad
                              .slice(0, 5)
                              .map((f) => f.name)
                              .join(", ");
                            const more = bad.length > 5 ? ` (+${bad.length - 5} más)` : "";
                            toast.error(
                              `Archivos no permitidos: ${sample}${more}. Solo se aceptan ${allowedLabel}.`,
                              { duration: 8000 },
                            );
                            e.target.value = "";
                            return;
                          }
                        }
                        const merged: File[] = [...current];
                        for (const f of picked) {
                          const idx = merged.findIndex(
                            (m) => m.name === f.name && m.size === f.size,
                          );
                          if (idx >= 0) merged[idx] = f;
                          else merged.push(f);
                        }
                        const totalBytes = merged.reduce((a, f) => a + f.size, 0);
                        if (totalBytes > MAX_CODE_FILES_TOTAL_BYTES) {
                          toast.error(
                            `Los archivos suman ${formatFileSize(totalBytes)} y superan el tope de 50 MB.`,
                          );
                          e.target.value = "";
                          return;
                        }
                        if (merged.length > MAX_CODE_FILES_COUNT) {
                          toast.error(
                            `Seleccionaste ${merged.length} archivos. Máximo permitido: ${MAX_CODE_FILES_COUNT}.`,
                          );
                          e.target.value = "";
                          return;
                        }
                        if (picked.some((f) => f.size === 0)) {
                          toast.error("Hay archivos vacíos en la selección.");
                          e.target.value = "";
                          return;
                        }
                        e.target.value = "";
                        updateAnswer(q.id, merged);
                      }}
                      className="block w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer hover:file:bg-primary/90"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Sube uno o varios archivos de código fuente — sin comprimir. Extensiones
                      aceptadas: <span className="font-mono">{allowedLabel}</span>. Tope: 50 MB
                      total y hasta {MAX_CODE_FILES_COUNT} archivos.
                    </p>
                    {current.length > 0 && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span>
                            {current.length} archivo{current.length === 1 ? "" : "s"} ·{" "}
                            {formatFileSize(current.reduce((a, f) => a + f.size, 0))}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateAnswer(q.id, [])}
                            className="text-destructive hover:underline"
                          >
                            Quitar todos
                          </button>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {current.map((f, i) => (
                            <Badge
                              key={`${f.name}-${f.size}-${i}`}
                              variant="secondary"
                              className="text-[10px] gap-1 pr-1"
                            >
                              <span className="truncate max-w-[12rem]">{f.name}</span>
                              <span className="text-muted-foreground">
                                · {formatFileSizeShort(f.size)}
                              </span>
                              <button
                                type="button"
                                aria-label={`Quitar ${f.name}`}
                                className="ml-0.5 rounded hover:bg-muted-foreground/20 p-0.5"
                                onClick={() =>
                                  updateAnswer(
                                    q.id,
                                    current.filter((_, j) => j !== i),
                                  )
                                }
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
          </CardContent>
        </Card>
      ))}
      <div className="sticky bottom-2 z-10 bg-background/80 backdrop-blur p-2 rounded-lg border">
        {videoGateBlocking && (
          <p className="text-[11px] text-amber-700 dark:text-amber-300 mb-1.5 text-center">
            Termina de ver los videos introductorios para habilitar la entrega.
          </p>
        )}
        <Button onClick={submit} disabled={submitting || videoGateBlocking} className="w-full">
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
