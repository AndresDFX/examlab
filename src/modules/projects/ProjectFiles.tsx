/**
 * Project module — espejo EXACTO de Talleres pero persistido en
 * `project_files` / `project_submission_files`.
 *
 * Cada "archivo" del proyecto es realmente una pregunta (abierta, cerrada,
 * código, diagrama o Java GUI), con la misma UX y rúbrica IA que el módulo
 * de talleres. La calificación final consolidada cae sobre el peso de PROYECTOS del
 * curso (no sobre talleres).
 */
import { useEffect, useRef, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
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
import { CodeEditor } from "@/modules/code/CodeEditor";
import { DiagramEditor } from "@/modules/code/DiagramEditor";
import { JavaGuiRunner, JAVA_GUI_STARTER, JAVAFX_STARTER } from "@/modules/code/JavaGuiRunner";
import { ProjectIntroVideoGate } from "@/modules/projects/ProjectIntroVideoGate";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { HelpHint } from "@/components/ui/help-hint";
import { formatFileSize, formatFileSizeShort } from "@/shared/lib/format";
import {
  getProcessingMode,
  readOverrideExpiry,
  PENDING_AI_FEEDBACK,
  QUEUED_STUDENT_TITLE,
} from "@/modules/ai/ai-grading";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  LANG_TO_EXT,
  LANG_OPTIONS,
  MAX_CODE_FILES_TOTAL_BYTES,
  MAX_CODE_FILES_COUNT,
  isFileAllowed,
  preValidateZipInBrowser,
} from "@/shared/lib/code-upload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type ProjectFile = {
  id: string;
  project_id: string;
  position: number;
  title: string; // enunciado
  description: string | null;
  expected_rubric: string | null;
  language: string | null;
  starter_code: string | null;
  points: number;
  type: "abierta" | "cerrada" | "cerrada_multi" | "codigo" | "diagrama" | "java_gui" | "codigo_zip";
  /** Scaffolding flujo ZIP único: cuando true (y type=codigo_zip), el
   *  estudiante sube UN .zip en vez de varios archivos sueltos, y la
   *  IA califica sin minificar. Default false (multi-file). */
  zip_single?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
};

/* =========================================================================
   TEACHER: Editor de preguntas del proyecto (manual + IA)
   ========================================================================= */
export function TeacherProjectFilesEditor({
  projectId,
  courseLanguage = "es",
}: {
  projectId: string;
  courseLanguage?: "es" | "en";
}) {
  const confirm = useConfirm();
  // Gate IA: en modo async sin override pedimos confirmación antes de
  // gastar cuota en generación de preguntas (auto + manual).
  const aiGate = useAiAuthorizationGate();
  const [questions, setQuestions] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectCourseId, setProjectCourseId] = useState<string | null>(null);
  const [bankDialogOpen, setBankDialogOpen] = useState(false);

  // manual form (sirve para crear y para editar — UPDATE cuando editingId)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("list");
  const [qType, setQType] = useState<ProjectFile["type"]>("abierta");
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
  // Scaffolding flujo ZIP único — toggle por slot (solo aplica a codigo_zip).
  const [qZipSingle, setQZipSingle] = useState(false);
  // Framework GUI para preguntas java_gui. Default swing; persiste
  // en options.java_framework. Misma semántica que WorkshopQuestions.
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

  const loadIntoForm = (q: ProjectFile) => {
    setEditingId(q.id);
    setQType(q.type);
    setQContent(q.title);
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
    setQZipSingle(Boolean(q.zip_single));
    const fw = (q.options as { java_framework?: string } | null)?.java_framework;
    setQJavaFramework(fw === "javafx" ? "javafx" : "swing");
    setActiveTab("manual");
  };

  // AI form
  const [aiTopics, setAiTopics] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  type AiRow = { type: ProjectFile["type"]; count: number; language: string };
  const [aiRows, setAiRows] = useState<AiRow[]>([{ type: "abierta", count: 3, language: "java" }]);
  const updateAiRow = (i: number, patch: Partial<AiRow>) =>
    setAiRows((rows) => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addAiRow = () =>
    setAiRows((rows) => [...rows, { type: "abierta", count: 1, language: "java" }]);
  const removeAiRow = (i: number) => setAiRows((rows) => rows.filter((_, idx) => idx !== i));
  // Modo auto: la IA decide el set completo a partir de la descripción del
  // proyecto. SIEMPRE incluye 1 pregunta tipo `codigo_zip` + 2-5 adicionales
  // de tipo abierta/diagrama/cerrada.
  const [autoDescription, setAutoDescription] = useState<string>("");
  const [autoCourseId, setAutoCourseId] = useState<string | null>(null);
  const [autoLoading, setAutoLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const [{ data }, { data: pr }] = await Promise.all([
      db.from("project_files").select("*").eq("project_id", projectId).order("position"),
      db.from("projects").select("course_id").eq("id", projectId).maybeSingle(),
    ]);
    setQuestions((data ?? []) as ProjectFile[]);
    setProjectCourseId((pr as { course_id?: string } | null)?.course_id ?? null);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Carga descripción y course_id del proyecto para alimentar el modo
  // "auto-generar set completo desde la descripción".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await db
        .from("projects")
        .select("description, course_id")
        .eq("id", projectId)
        .maybeSingle();
      if (cancelled) return;
      const row = (data ?? null) as {
        description?: string | null;
        course_id?: string | null;
      } | null;
      setAutoDescription(row?.description ?? "");
      setAutoCourseId(row?.course_id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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
    // Para proyectos: el tipo 'codigo' implica entrega ZIP (codigo_zip).
    // Solo persistimos 'language' si la pregunta es realmente código —
    // el ZIP no fija un lenguaje porque puede traer múltiples archivos.
    const language = qType === "codigo_zip" ? qLanguage : null;
    // zip_single solo aplica a codigo_zip. Para los demás tipos lo
    // forzamos a false para que no quede true colgado si el docente
    // cambia el tipo de la pregunta.
    const zipSingle = qType === "codigo_zip" ? qZipSingle : false;

    if (editingId) {
      // UPDATE: no tocamos position ni starter_code para no clobberar lo que
      // alumnos o docentes hayan personalizado.
      const { error } = await db
        .from("project_files")
        .update({
          type: qType,
          title: qContent.slice(0, 200),
          expected_rubric: qRubric || null,
          options,
          points: qPoints,
          language,
          zip_single: zipSingle,
        })
        .eq("id", editingId);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success("Pregunta actualizada");
    } else {
      // Proyectos no usan starter_code (no es un IDE inline). El ZIP
      // trae los archivos del estudiante sin plantilla del docente.
      const { error } = await db.from("project_files").insert({
        project_id: projectId,
        type: qType,
        title: qContent.slice(0, 200),
        description: null,
        expected_rubric: qRubric || null,
        options,
        points: qPoints,
        position: questions.length,
        language,
        starter_code: null,
        zip_single: zipSingle,
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success("Pregunta agregada — puedes continuar añadiendo");
    }
    resetForm();
    void load();
  };

  // Swap de positions con vecino. Usamos -1 como temporal para no chocar
  // con un eventual unique(project_id, position).
  const moveQ = async (id: string, direction: "up" | "down") => {
    const sorted = [...questions].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((q) => q.id === id);
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || target < 0 || target >= sorted.length) return;
    const a = sorted[idx];
    const b = sorted[target];
    const { error: e1 } = await db.from("project_files").update({ position: -1 }).eq("id", a.id);
    if (e1) return toast.error(friendlyError(e1));
    const { error: e2 } = await db
      .from("project_files")
      .update({ position: a.position })
      .eq("id", b.id);
    if (e2) return toast.error(friendlyError(e2));
    const { error: e3 } = await db
      .from("project_files")
      .update({ position: b.position })
      .eq("id", a.id);
    if (e3) return toast.error(friendlyError(e3));
    void load();
  };

  const removeQ = async (id: string) => {
    // Antes de borrar, contar cuántas entregas YA tienen respuesta para
    // esta pregunta. Si hay, advertir explícitamente: el DELETE CASCADE
    // borra `project_submission_files` y los ZIPs entregados quedan
    // huérfanos en storage. El alumno ve "Aún no has subido tu archivo".
    const { count: linkedCount } = await db
      .from("project_submission_files")
      .select("submission_id", { count: "exact", head: true })
      .eq("file_id", id);
    const hasSubmissions = (linkedCount ?? 0) > 0;
    const ok = await confirm({
      title: hasSubmissions
        ? `Eliminar pregunta (${linkedCount} entrega${linkedCount === 1 ? "" : "s"} afectada${linkedCount === 1 ? "" : "s"})`
        : "Eliminar pregunta",
      description: hasSubmissions
        ? `Esta pregunta ya tiene ${linkedCount} entrega${linkedCount === 1 ? "" : "s"} de estudiantes. Al eliminarla, sus respuestas y archivos de código se perderán y verán "Aún no has subido tu archivo" en la retroalimentación. Esta acción no se puede deshacer.`
        : "Se eliminará la pregunta del proyecto. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("project_files").delete().eq("id", id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Pregunta eliminada");
    void load();
  };

  // Modo auto: la IA decide el set completo de preguntas a partir de la
  // descripción del proyecto, respetando la regla "1 codigo_zip + 2-5
  // adicionales". Sin inputs adicionales — el prompt vive en
  // ai_prompts(use_case='project_questions').
  const generateFromDescription = async () => {
    if (!autoDescription.trim()) {
      toast.error(
        "El proyecto no tiene descripción todavía. Escríbela o genérala con IA antes de continuar.",
      );
      return;
    }
    // Generación de preguntas con IA — NO tiene worker async. Pasamos
    // `allowQueue: false` para que el dialog del gate solo ofrezca
    // "Activar IA inmediata" o "Cancelar". Antes en modo batch el
    // docente "encolaba" y el código llamaba al edge igual sin código.
    const decision = await aiGate.ensureAuthorized({ allowQueue: false });
    if (decision === "cancel") return;
    if (decision === "proceed-async") {
      toast.error(
        "La generación con IA no soporta modo cola. Activá un código de IA inmediata para continuar.",
      );
      return;
    }
    setAutoLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
        body: {
          projectQuestionsAutoGeneration: true,
          projectId,
          description: autoDescription,
          courseId: autoCourseId,
          courseLanguage,
        },
      });
      if (error) {
        toast.error(friendlyError(error, "Error generando con IA"));
      } else if (data?.error) {
        toast.error(data.error);
      } else if (data?.inserted) {
        toast.success(
          `${data.inserted.length} pregunta(s) generadas — incluye 1 entrega de código (archivos)`,
        );
        void logEvent({
          action: "ai_questions.generated",
          category: "grading",
          severity: "info",
          entityType: "project",
          entityId: projectId,
          metadata: { total: data.inserted.length, mode: "auto" },
        });
      }
      void load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error IA";
      toast.error(msg);
    } finally {
      setAutoLoading(false);
    }
  };

  const generateWithAI = async () => {
    if (!aiTopics.trim()) {
      toast.error("Indica los temas");
      return;
    }
    const validRows = aiRows.filter((r) => r.count > 0);
    if (!validRows.length) return toast.error("Configura al menos un tipo con cantidad > 0");
    // Generación de preguntas con IA — NO tiene worker async. Ver
    // comentario en generateFromDescription arriba.
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
      const { data: proj } = await db
        .from("projects")
        .select("description")
        .eq("id", projectId)
        .maybeSingle();
      const projectDescription =
        (proj as { description?: string | null } | null)?.description ?? null;

      for (const row of validRows) {
        const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
          body: {
            topics: aiTopics,
            type: row.type,
            count: row.count,
            examId: projectId,
            language: row.type === "codigo_zip" ? row.language : undefined,
            courseLanguage,
            targetTable: "project_files",
            projectDescription,
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
          entityType: "project",
          entityId: projectId,
          metadata: { total: totalInserted, types: validRows.map((r) => r.type), mode: "manual" },
        });
      }
      void load();
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
                    <MarkdownInline>{q.title}</MarkdownInline>
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
              <Label required>
                Tipo{" "}
                <HelpHint>
                  En proyectos, <strong>Código</strong> significa que el estudiante selecciona
                  varios archivos de código fuente directo (sin comprimir). La IA recibe todos los
                  archivos minificados en un solo prompt y los califica con la rúbrica y los puntos
                  de esta pregunta. Diagramas y documentos van en preguntas separadas.
                </HelpHint>
              </Label>
              <Select value={qType} onValueChange={(v) => setQType(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="abierta">Abierta</SelectItem>
                  <SelectItem value="cerrada">Selección única</SelectItem>
                  <SelectItem value="cerrada_multi">Opción múltiple</SelectItem>
                  <SelectItem value="diagrama">Diagrama (Mermaid)</SelectItem>
                  <SelectItem value="codigo_zip">Código fuente (archivos)</SelectItem>
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
                  Puntaje proporcional según cuántas correctas marque, sin penalización por
                  incorrectas.
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
          {qType === "java_gui" && (
            <div>
              <Label className="flex items-center gap-1.5">
                Framework
                <HelpHint>
                  <span>
                    <strong>Swing/AWT</strong>: framework built-in del JDK, soportado por CheerpJ
                    (navegador) y AWS Lambda.
                  </span>
                  <br />
                  <span>
                    <strong>JavaFX</strong>: requiere OpenJFX 21 (runner Lambda). NO funciona con
                    CheerpJ. La clase del alumno debe <code>extends Application</code>; el wrapper
                    server-side llama <code>Application.launch()</code>.
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
            <>
              <div>
                <Label required>
                  Lenguaje principal{" "}
                  <HelpHint>
                    El lenguaje fija qué extensiones aceptará el selector de archivos del
                    estudiante. Java → .java, Python → .py, etc. Cualquier archivo con otra
                    extensión queda bloqueado antes de subir.
                  </HelpHint>
                </Label>
                <Select value={qLanguage} onValueChange={setQLanguage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANG_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                {qZipSingle ? (
                  <>
                    <strong>Modo ZIP único (scaffolding):</strong> el estudiante sube UN archivo{" "}
                    <code>.zip</code> con su proyecto. El servidor lo descomprime y la IA recibe
                    cada archivo <strong>íntegro</strong> (sin minificar, sin truncar por archivo)
                    en un solo prompt — hasta el tope global de ~200K caracteres. Útil para que la
                    IA "vea" todo el código tal cual lo escribió el alumno, incluidos comentarios.
                  </>
                ) : (
                  <>
                    El estudiante seleccionará <strong>varios archivos de código fuente</strong>{" "}
                    directo (sin comprimir). Solo se aceptan archivos cuya extensión coincida con el
                    lenguaje principal; cualquier otro archivo bloquea la entrega antes de subir. La
                    IA recibe todos los archivos minificados en un solo prompt y califica el
                    proyecto como conjunto según la rúbrica y los puntos. Diagramas y documentos van
                    en preguntas separadas (tipo Abierta o Diagrama).
                  </>
                )}
              </div>
              <div className="flex items-start justify-between gap-3 rounded-md border border-amber-400/40 bg-amber-500/5 p-3">
                <div className="space-y-0.5 min-w-0">
                  <Label htmlFor="qZipSingle" className="text-sm">
                    Modo ZIP único{" "}
                    <HelpHint>
                      Scaffolding del flujo ZIP. ON: el estudiante sube un único .zip; el servidor
                      lo descomprime y la IA recibe todos los archivos íntegros (sin minify, sin
                      truncar por archivo). OFF: flujo actual de varios archivos sueltos con
                      minificación.
                    </HelpHint>
                  </Label>
                  <p className="text-[11px] text-muted-foreground leading-tight">
                    POC para probar grading con código sin minificar.
                  </p>
                </div>
                <Switch id="qZipSingle" checked={qZipSingle} onCheckedChange={setQZipSingle} />
              </div>
            </>
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
            {!editingId && projectCourseId && (
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
          {/* Modo auto: a partir de la descripción ya escrita en el
              proyecto, la IA decide el set entero de preguntas. Siempre
              incluye 1 codigo_zip + 2-5 adicionales (abierta/diagrama/
              cerrada). El prompt es editable desde Admin/Docente en
              /app/{admin|teacher}/ai-prompts → use_case
              `project_questions`. */}
          <Card className="border-primary/40 bg-primary/5">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Auto-generar preguntas desde la descripción{" "}
                <HelpHint>
                  La IA lee la descripción del proyecto y propone el set completo de preguntas.
                  Siempre genera <strong>1 pregunta de código (archivos)</strong> y entre 2 y 5
                  preguntas adicionales (abierta, diagrama o cerrada) para evaluar análisis y diseño
                  por separado. El prompt se edita en Prompts (use_case{" "}
                  <code>project_questions</code>).
                </HelpHint>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {autoDescription.trim() ? (
                <div className="text-xs text-muted-foreground bg-background/60 rounded p-2 border max-h-32 overflow-y-auto whitespace-pre-wrap">
                  {autoDescription}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  Este proyecto aún no tiene descripción. Escríbela en el editor del proyecto (o
                  genérala con IA) antes de usar este modo.
                </p>
              )}
              <Button
                onClick={generateFromDescription}
                disabled={autoLoading || !autoDescription.trim()}
              >
                {autoLoading ? (
                  <Spinner size="md" className="mr-1" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-1" />
                )}
                Generar preguntas con IA
              </Button>
            </CardContent>
          </Card>

          <div className="flex items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-wide">
            <span className="h-px flex-1 bg-border" />o por temas y tipos específicos
            <span className="h-px flex-1 bg-border" />
          </div>

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
                      <SelectItem value="cerrada">Selección única</SelectItem>
                      <SelectItem value="cerrada_multi">Opción múltiple</SelectItem>
                      <SelectItem value="diagrama">Diagrama</SelectItem>
                      <SelectItem value="codigo_zip">Código (archivos)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {row.type === "codigo_zip" && (
                  <div className="w-40 shrink-0">
                    <Select
                      value={row.language}
                      onValueChange={(v) => updateAiRow(i, { language: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LANG_OPTIONS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
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
        courseId={projectCourseId}
        target="project"
        targetId={projectId}
        onImported={() => void load()}
      />
      <aiGate.GateDialog />
    </div>
  );
}

/* =========================================================================
   STUDENT: Toma del proyecto pregunta a pregunta + calificación IA inmediata
   ========================================================================= */
export function StudentProjectTaker({
  projectId,
  projectTitle,
  maxScore,
  courseLanguage = "es",
  groupId = null,
  onGraded,
}: {
  projectId: string;
  projectTitle: string;
  maxScore: number;
  courseLanguage?: "es" | "en";
  /** Si el proyecto es grupal, ID del grupo del estudiante. La submission
   *  se filtra/crea con este group_id en lugar de user_id. */
  groupId?: string | null;
  onGraded?: (finalGrade: number) => void;
}) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [questions, setQuestions] = useState<ProjectFile[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [graded, setGraded] = useState<{ grade: number } | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState<string>("");
  // projects.description — contexto global que viaja a la edge function
  // de calificación junto con cada pregunta (workshopQuestionGrading +
  // projectCodeZipGrading) para que la IA evalúe con el alcance del
  // proyecto en mente, no solo la pregunta aislada.
  const [projectDescription, setProjectDescription] = useState<string>("");
  // course_id del proyecto. Se usa al encolar jobs IA async para que el
  // dashboard del docente filtre por curso. NULL si el proyecto no tiene
  // course_id (proyectos legacy con vinculación solo vía project_courses).
  const [projectCourseId, setProjectCourseId] = useState<string | null>(null);
  // Gate de videos introductorios para entregas de código. Cuando el
  // proyecto tiene N videos en `project_intro_videos`, el alumno debe
  // verlos TODOS en orden estricto antes de poder entregar. El componente
  // `ProjectIntroVideoGate` maneja el orden y el seek-lock.
  // `watchedVideoIds` se hidrata desde `project_submission_video_views`
  // al cargar la submission existente — sesiones reanudadas conservan
  // el progreso.
  const [introVideos, setIntroVideos] = useState<
    Array<{ id: string; url: string; title: string | null; position: number }>
  >([]);
  const [watchedVideoIds, setWatchedVideoIds] = useState<Set<string>>(() => new Set());
  // Enforcement de max_attempts. `attemptCount` viene de la submission
  // existente (0 si nunca entregó). `effectiveMaxAttempts` = override
  // del proyecto, o el default global de `app_settings`. Cuando
  // `attemptCount >= effectiveMaxAttempts` Y la entrega previa ya fue
  // calificada, bloqueamos el botón de entregar. Si la entrega previa
  // está `entregado` SIN nota, el alumno todavía puede editar y
  // re-entregar — el contador no aumenta hasta que se califique
  // (mismo principio que en el submit).
  const [attemptCount, setAttemptCount] = useState<number>(0);
  const [effectiveMaxAttempts, setEffectiveMaxAttempts] = useState<number>(1);
  // `lastSubmissionGraded` = la entrega previa tiene nota final o status
  // 'calificado'. Es el predicado que distingue "ya gastaste tu intento"
  // (graded) de "todavía estás en el mismo intento" (no graded).
  const [lastSubmissionGraded, setLastSubmissionGraded] = useState<boolean>(false);
  const loadedForRef = useRef<string | null>(null);

  // ¿La entrega tiene archivos de código (codigo_zip)? Si no, el gate
  // de video no aplica para esta pantalla — los proyectos sin componente
  // de código no necesitan el video.
  const hasCodeQuestion = questions.some((q) => q.type === "codigo_zip");
  const allVideosWatched = introVideos.every((v) => watchedVideoIds.has(v.id));
  const videoGateBlocking = introVideos.length > 0 && hasCodeQuestion && !allVideosWatched;
  // Intento agotado SOLO cuando ya alcanzó el cap Y la entrega anterior
  // tiene nota. Si attempt_count=1, max=1 y status='entregado' sin nota,
  // el alumno está corrigiendo su intento — NO bloqueamos. El cap real
  // se aplica vía `nextAttemptCount > max` dentro del submit().
  const attemptsExhausted = attemptCount >= effectiveMaxAttempts && lastSubmissionGraded;

  useEffect(() => {
    if (!user) return;
    const key = `${projectId}::${user.id}::${groupId ?? "indiv"}`;
    if (loadedForRef.current === key) return;
    loadedForRef.current = key;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: qs }, { data: proj }, { data: videosData }, { data: settingsRow }] =
        await Promise.all([
          db.from("project_files").select("*").eq("project_id", projectId).order("position"),
          // Incluimos `max_attempts` (override por proyecto). NULL → fall
          // back al default global de `app_settings`.
          db
            .from("projects")
            .select("description, course_id, max_attempts")
            .eq("id", projectId)
            .maybeSingle(),
          db
            .from("project_intro_videos")
            .select("id, url, title, position")
            .eq("project_id", projectId)
            .order("position"),
          // Default global de intentos para proyectos. Singleton, columna
          // agregada en la migración 20260602300000.
          db.from("app_settings").select("default_project_max_attempts").limit(1).maybeSingle(),
        ]);
      if (cancelled) return;
      setQuestions((qs ?? []) as ProjectFile[]);
      setProjectDescription((proj as { description?: string | null } | null)?.description ?? "");
      setProjectCourseId((proj as { course_id?: string | null } | null)?.course_id ?? null);
      const projMax = (proj as { max_attempts?: number | null } | null)?.max_attempts;
      const globalMax = (settingsRow as { default_project_max_attempts?: number | null } | null)
        ?.default_project_max_attempts;
      setEffectiveMaxAttempts(Number(projMax ?? globalMax ?? 1));
      const loadedVideos =
        (videosData as Array<{
          id: string;
          url: string;
          title: string | null;
          position: number;
        }> | null) ?? [];
      setIntroVideos(loadedVideos);

      // Si hay grupo, la submission pertenece al grupo (cualquier
      // miembro la ve y edita). Si no, comportamiento individual normal.
      // Incluimos `attempt_count` (col agregada en 20260607000000) para
      // hidratar el enforcement de max_attempts. Cast a any porque
      // `types.ts` se regenera en el próximo publish de Lovable.
      const subQuery = db
        .from("project_submissions")
        .select("id, final_grade, status, repository_url, attempt_count")
        .eq("project_id", projectId);
      const { data: sub } = await (groupId
        ? subQuery.eq("group_id", groupId).maybeSingle()
        : subQuery.eq("user_id", user.id).maybeSingle());
      if (sub?.repository_url) setRepositoryUrl(sub.repository_url);
      const subRow = sub as {
        id?: string;
        attempt_count?: number;
        status?: string;
        final_grade?: number | null;
        repository_url?: string;
      } | null;
      setAttemptCount(Number(subRow?.attempt_count ?? 0));
      // "Calificada" = status calificado o final_grade asignado. Si
      // alguna de las dos condiciones se cumple, el intento ya se gastó
      // y el alumno no puede re-entregar (consistente con la regla
      // del submit). ai_grade=0 NO cuenta como "calificada" porque
      // el docente todavía no puso final_grade.
      setLastSubmissionGraded(
        subRow != null && (subRow.status === "calificado" || subRow.final_grade != null),
      );
      // Hidratar el set de videos ya vistos desde
      // `project_submission_video_views`. Si la submission no existe
      // todavía (primer abrir del proyecto), el set queda vacío y el
      // estudiante debe ver todos los videos.
      if (sub?.id) {
        const { data: viewsData } = await db
          .from("project_submission_video_views")
          .select("video_id")
          .eq("submission_id", sub.id);
        const ids = ((viewsData as Array<{ video_id: string }> | null) ?? []).map(
          (v) => v.video_id,
        );
        setWatchedVideoIds(new Set(ids));
      }
      if (sub?.id) {
        const { data: ans } = await db
          .from("project_submission_files")
          .select("file_id, content, selected_option")
          .eq("submission_id", sub.id);
        const map: Record<string, any> = {};
        const filesById = new Map((qs ?? []).map((q: any) => [q.id, q]));
        for (const a of (ans ?? []) as any[]) {
          const q = filesById.get(a.file_id) as any;
          if (q?.type === "cerrada_multi" && typeof a.content === "string") {
            try {
              const parsed = JSON.parse(a.content);
              map[a.file_id] = Array.isArray(parsed) ? parsed : [];
              continue;
            } catch {
              map[a.file_id] = [];
              continue;
            }
          }
          map[a.file_id] = a.selected_option ?? a.content ?? "";
        }
        if (cancelled) return;
        setAnswers(map);
        if (sub.status === "calificado" && sub.final_grade != null) {
          setGraded({ grade: Number(sub.final_grade) });
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, user?.id]);

  const updateAnswer = (qid: string, value: any) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
  };

  /**
   * Devuelve los números de pregunta (1-indexed) cuyas respuestas están
   * vacías. Reglas por tipo:
   *   - cerrada: no se eligió opción.
   *   - cerrada_multi: array vacío, o menos selecciones que `min_selections`.
   *   - codigo_zip: sin archivo (acepta File[] o File legacy).
   *   - codigo: vacío O idéntico al `starter_code` del slot. La
   *     calificación cuenta este caso como "Sin respuesta" (ver línea
   *     ~1737); advertimos al entregar para evitar entregas accidentales
   *     donde el alumno abrió la pregunta y no escribió código propio.
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
        // Acepta File[] (nuevo flujo multi-archivo) o File suelto (legacy).
        isBlank = !((Array.isArray(a) && a.length > 0) || a instanceof File);
      } else if (q.type === "codigo") {
        // Misma lógica que aplica la calificación (línea ~1737): vacío
        // O igual al starter_code → cuenta como no respondida.
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
      toast.error("Este proyecto no tiene preguntas");
      return;
    }
    // Enforcement de max_attempts: si el estudiante/grupo ya consumió
    // todos los intentos, no permitimos otro submit. Esto cubre los
    // dos casos: max_attempts=1 (típico) → solo 1 entrega total;
    // max_attempts=N → hasta N reintentos.
    if (attemptsExhausted) {
      toast.error(
        `Ya consumiste tus ${effectiveMaxAttempts} intento${effectiveMaxAttempts === 1 ? "" : "s"} de entrega. No puedes volver a entregar este proyecto.`,
      );
      return;
    }
    // Link al repositorio: obligatorio. Validamos URL razonable
    // (cualquier http/https) — el filtro fino (GitHub vs Drive vs otra)
    // queda al docente al revisar manualmente.
    const url = repositoryUrl.trim();
    if (!url) {
      toast.error("El link al repositorio (GitHub o Drive) es obligatorio");
      return;
    }
    if (!/^https?:\/\/\S+\.\S+/i.test(url)) {
      toast.error("Ingresa una URL válida (debe empezar con http:// o https://)");
      return;
    }
    // ── Pre-validación de archivos/ZIPs ANTES de crear la submission ──
    // Issues reportados:
    //   1) Multi-file: archivos con extensión no permitida no rechazaban
    //      el submit — la entrega se guardaba con grade=0 + feedback de
    //      error en vez de abortar para que el alumno corrigiera.
    //   2) ZIP único: misma historia — un ZIP con archivos no permitidos
    //      se grababa con grade=0 en lugar de bloquear el envío.
    // Solución: una pasada de validación sobre TODAS las preguntas
    // codigo_zip al inicio del submit. Si alguna falla, toast → return.
    // Sin side effects (no se crea fila en project_submissions, no se
    // sube nada a Storage, no se llama a la IA).
    const codeQuestionErrors: Array<{ qNumber: number; message: string }> = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (q.type !== "codigo_zip") continue;
      const raw = answers[q.id];
      const langKey = (q.language ?? "").toLowerCase().trim();
      const allowedExts = LANG_TO_EXT[langKey] ?? null;
      if (q.zip_single) {
        const zipFile = raw instanceof File ? raw : null;
        if (!zipFile) continue;
        if (!zipFile.name.toLowerCase().endsWith(".zip")) {
          codeQuestionErrors.push({
            qNumber: i + 1,
            message: `Pregunta #${i + 1}: el archivo entregado no es un .zip.`,
          });
          continue;
        }
        if (zipFile.size > MAX_CODE_FILES_TOTAL_BYTES) {
          codeQuestionErrors.push({
            qNumber: i + 1,
            message: `Pregunta #${i + 1}: el ZIP pesa ${formatFileSize(zipFile.size)} y supera el tope de 50 MB.`,
          });
          continue;
        }
        const preCheck = await preValidateZipInBrowser(zipFile, allowedExts);
        if (!preCheck.ok) {
          codeQuestionErrors.push({
            qNumber: i + 1,
            message: `Pregunta #${i + 1}: ${preCheck.error}`,
          });
        }
      } else {
        const filesArr: File[] = Array.isArray(raw)
          ? (raw.filter((f) => f instanceof File) as File[])
          : raw instanceof File
            ? [raw]
            : [];
        if (filesArr.length === 0) continue;
        if (allowedExts) {
          const violations = filesArr.filter((f) => !isFileAllowed(f.name, allowedExts));
          if (violations.length > 0) {
            const sample = violations
              .slice(0, 5)
              .map((f) => f.name)
              .join(", ");
            const more = violations.length > 5 ? ` (+${violations.length - 5} más)` : "";
            const allowedLabel = allowedExts.map((e) => `.${e}`).join(", ");
            codeQuestionErrors.push({
              qNumber: i + 1,
              message: `Pregunta #${i + 1}: archivos no permitidos: ${sample}${more}. Solo se aceptan ${allowedLabel}.`,
            });
            continue;
          }
        }
        const totalBytes = filesArr.reduce((acc, f) => acc + f.size, 0);
        if (totalBytes > MAX_CODE_FILES_TOTAL_BYTES) {
          codeQuestionErrors.push({
            qNumber: i + 1,
            message: `Pregunta #${i + 1}: los archivos suman ${formatFileSize(totalBytes)} y superan el tope de 50 MB.`,
          });
        } else if (filesArr.length > MAX_CODE_FILES_COUNT) {
          codeQuestionErrors.push({
            qNumber: i + 1,
            message: `Pregunta #${i + 1}: demasiados archivos (${filesArr.length}). Máximo permitido: ${MAX_CODE_FILES_COUNT}.`,
          });
        }
      }
    }
    if (codeQuestionErrors.length > 0) {
      // Un toast por error — duración generosa para que el alumno alcance
      // a leer cada uno. Abortamos sin crear la submission ni subir nada.
      for (const err of codeQuestionErrors) {
        toast.error(err.message, { duration: 10000 });
      }
      toast.error(
        "Corrige los archivos señalados y vuelve a entregar — no se guardó nada todavía.",
        { duration: 10000 },
      );
      return;
    }
    // Confirmación del design system antes de entregar con respuestas
    // vacías. Las preguntas en blanco reciben 0 puntos por la lógica
    // de calificación; el modal evita entregas accidentales.
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
            <p>Esas preguntas recibirán 0 puntos. ¿Quieres entregar el proyecto de todas formas?</p>
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
      let submissionId: string;
      // Si hay grupo: filtramos/insertamos por group_id para que cualquier
      // miembro toque la misma fila. user_id se mantiene como "último
      // editor" para auditoría.
      // Incluimos `attempt_count`, `status` y `final_grade` para:
      //  (a) re-check anti-race: si entre la carga inicial y este submit
      //      otro miembro del grupo ya entregó, detectamos el nuevo conteo.
      //  (b) decidir si este submit consume un intento o solo re-edita el
      //      mismo: el contador NO sube si la entrega previa aún no tiene
      //      nota — el estudiante está corrigiendo antes de feedback, no
      //      gastando un intento nuevo.
      const existingQuery = db
        .from("project_submissions")
        .select("id, attempt_count, status, final_grade")
        .eq("project_id", projectId);
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
      // "Calificada" = status calificado o ya tiene nota final. Una
      // entrega que aún está en `entregado` con final_grade=null sigue
      // editable y el re-submit no cuenta como intento nuevo.
      const previousWasGraded =
        existingRow != null &&
        (existingRow.status === "calificado" || existingRow.final_grade != null);
      // Incrementamos solo cuando: es la primera entrega (no existe), o
      // la previa ya fue calificada (es un intento nuevo de verdad).
      const incrementAttempt = !existingRow || previousWasGraded;
      const nextAttemptCount = incrementAttempt ? previousCount + 1 : previousCount;
      // Defense-in-depth contra concurrencia (grupos) o tabs abiertas:
      // el state local `attemptCount` puede estar desactualizado. Sólo
      // bloqueamos cuando el nuevo conteo excedería el cap — re-editar
      // sin gastar intento siempre se permite.
      if (nextAttemptCount > effectiveMaxAttempts) {
        toast.error(
          `Ya consumiste tus ${effectiveMaxAttempts} intento${effectiveMaxAttempts === 1 ? "" : "s"} de entrega. Recarga para ver la entrega actual.`,
        );
        setSubmitting(false);
        return;
      }
      if (existing?.id) {
        submissionId = existing.id;
        await db
          .from("project_submissions")
          .update({
            status: "entregado",
            submitted_at: new Date().toISOString(),
            repository_url: url,
            user_id: user.id,
            attempt_count: nextAttemptCount,
          })
          .eq("id", submissionId);
      } else {
        const { data: created, error } = await db
          .from("project_submissions")
          .insert({
            project_id: projectId,
            user_id: user.id,
            group_id: groupId ?? null,
            status: "entregado",
            submitted_at: new Date().toISOString(),
            repository_url: url,
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
      // Actualizar state local — el botón ya se deshabilita si quedó
      // exhausto. Si todavía hay intentos disponibles, el alumno puede
      // re-entregar (aunque la mayoría usa max_attempts=1).
      setAttemptCount(nextAttemptCount);

      // ── Resolución del modo IA ──
      // `processing_mode = async` (default) + sin override = encolar las
      // llamadas IA en `ai_grading_queue`. La fila destino se inserta con
      // ai_grade=null y ai_feedback="Pendiente IA…"; el worker hourly
      // las drena y actualiza los rows. `processing_mode = sync` o tener
      // un código override activo en localStorage → llamada IA inmediata
      // (comportamiento legacy).
      const aiMode = await getProcessingMode();
      const aiOverrideActive = !!readOverrideExpiry();
      const useAsyncAi = aiMode === "async" && !aiOverrideActive;

      // ── Calificación en dos fases (igual que WorkshopQuestions) ──
      // 1) Loop: locales (cerrada/multi/empty) + codigo_zip (upload + IA
      //    individual con su zipPath) + bucketea abiertas para batch.
      // 2) UNA llamada batch para todas las abiertas.
      // 3) Upsert por qid.
      let totalEarned = 0;
      let totalPoints = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payloadsByQid: Record<string, any> = {};
      // En modo async, después del upsert principal vamos a encolar los
      // jobs IA — guardamos {qid, kind, body} acá y enrolamos al final.
      const pendingEnqueues: Array<{
        qid: string;
        kind: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        body: Record<string, any>;
      }> = [];
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
          file_id: q.id,
          content: null,
          selected_option: null,
        };

        let earned = 0;
        let feedback = "Sin retroalimentación";

        if (q.type === "cerrada") {
          const correctIdx = q.options?.correct_index;
          const got = String(raw) === String(correctIdx) ? Number(q.points) : 0;
          earned = got;
          feedback = got > 0 ? "Respuesta correcta" : "Respuesta incorrecta";
          payload.selected_option = String(raw);
          // Guardar también el texto elegido en `content` para revisión
          const choices = q.options?.choices ?? [];
          payload.content = choices[Number(raw)] ?? String(raw);
          payload.ai_grade = earned;
          payload.ai_feedback = feedback;
        } else if (q.type === "cerrada_multi") {
          // Grading local: proporcional positivo (helper compartido).
          const selectedArr = Array.isArray(raw) ? (raw as number[]) : [];
          const result = scoreCerradaMulti({
            selected: selectedArr,
            correctIndices: ((q.options as any)?.correct_indices ?? []) as number[],
            totalPoints: Number(q.points) || 0,
            minSelections: (q.options as any)?.min_selections,
            maxSelections: (q.options as any)?.max_selections,
          });
          earned = result.earned;
          feedback = result.exceededMax
            ? `Marcaste más opciones de las permitidas (${(q.options as any)?.max_selections}).`
            : result.belowMin
              ? `Faltó marcar al menos ${(q.options as any)?.min_selections} opciones.`
              : selectedArr.length === 0
                ? "Sin respuesta"
                : `${earned} / ${q.points} pts`;
          // Guardamos array como JSON en content (selected_option es text de 1 valor)
          payload.content = JSON.stringify(selectedArr);
          payload.ai_grade = earned;
          payload.ai_feedback = feedback;
        } else if (q.type === "codigo_zip" && q.zip_single) {
          // ── Modo ZIP único (scaffolding) ──
          // El estudiante sube UN .zip. Subimos a Storage como path único
          // (`zip_path`, mismo campo legacy), invocamos el edge con
          // `zipPath` + `noMinify: true` — la IA recibe archivos crudos
          // (sin minificar, sin truncar per-file), solo respeta cap global.
          const zipFile = raw instanceof File ? raw : null;
          if (!zipFile) {
            payload.content = "";
            payload.ai_grade = 0;
            payload.ai_feedback = "Sin archivo ZIP entregado";
          } else if (!user?.id) {
            payload.ai_grade = 0;
            payload.ai_feedback =
              "Sesión no autenticada — recarga la página e inicia sesión de nuevo.";
          } else if (zipFile.size > MAX_CODE_FILES_TOTAL_BYTES) {
            payload.ai_grade = 0;
            payload.ai_feedback = `El ZIP pesa ${formatFileSize(zipFile.size)} y supera el tope de 50 MB.`;
            toast.error(payload.ai_feedback, { duration: 8000 });
          } else if (!zipFile.name.toLowerCase().endsWith(".zip")) {
            payload.ai_grade = 0;
            payload.ai_feedback = "El archivo entregado no es un .zip.";
            toast.error(payload.ai_feedback, { duration: 8000 });
          } else {
            // Pre-validación cliente-side: descomprimir el ZIP en el
            // navegador y verificar que TODOS los archivos adentro sean
            // de extensión permitida. Si hay UN PDF (o cualquier otro
            // no-código) → rechazo inmediato sin gastar Storage ni IA.
            // El server tiene la misma validación como red final.
            const zipLangKey = (q.language ?? "").toLowerCase().trim();
            const zipAllowed = LANG_TO_EXT[zipLangKey] ?? null;
            const preCheck = await preValidateZipInBrowser(zipFile, zipAllowed);
            if (!preCheck.ok) {
              payload.ai_grade = 0;
              payload.ai_feedback = preCheck.error;
              toast.error(preCheck.error, { duration: 10000 });
              payloadsByQid[q.id] = payload;
              continue;
            }
            const rootFolder = groupId ?? user.id;
            // Path único (sin subcarpeta del questionId — el ZIP es atómico).
            const zipPath = `${rootFolder}/${submissionId}/${q.id}.zip`;
            const { error: upErr } = await supabase.storage
              .from("project-files")
              .upload(zipPath, zipFile, {
                upsert: true,
                contentType: "application/zip",
              });
            if (upErr) {
              payload.ai_grade = 0;
              payload.ai_feedback = `Error al subir el ZIP: ${upErr.message}`;
              toast.error(payload.ai_feedback, { duration: 8000 });
            } else {
              payload.zip_path = zipPath;
              const aiBody = {
                projectCodeZipGrading: true,
                zipPath,
                // Flag scaffolding: backend salta minify + truncado per-file.
                noMinify: true,
                fileTitle: q.title,
                fileDescription: q.description,
                expectedRubric: q.expected_rubric,
                maxPoints: q.points,
                courseLanguage,
                courseId: undefined,
                projectDescription,
              };
              if (useAsyncAi) {
                payload.ai_grade = null;
                payload.ai_feedback = PENDING_AI_FEEDBACK;
                pendingEnqueues.push({
                  qid: q.id,
                  kind: "project_codigo_zip",
                  body: aiBody,
                });
                payloadsByQid[q.id] = payload;
                continue;
              }
              const { data: aiData, error: aiErr } = await supabase.functions.invoke(
                "ai-grade-submission",
                { body: aiBody },
              );
              if (aiErr || aiData?.error) {
                const detail = await extractEdgeError(aiErr, aiData);
                payload.ai_grade = 0;
                payload.ai_feedback = detail || "Error IA al calificar el ZIP";
                toast.error(payload.ai_feedback, { duration: 8000 });
              } else {
                earned = Number(aiData?.grade) || 0;
                feedback = aiData?.feedback ?? feedback;
                payload.ai_grade = earned;
                payload.ai_feedback = feedback;
                payload.ai_likelihood =
                  typeof aiData?.ai_likelihood === "number" ? aiData.ai_likelihood : null;
                payload.ai_reasons = aiData?.ai_reasons ?? null;
                if (typeof aiData?.zip_truncated === "boolean") {
                  payload.zip_truncated = aiData.zip_truncated;
                }
                if (typeof aiData?.zip_chars_used === "number") {
                  payload.zip_chars_used = aiData.zip_chars_used;
                }
              }
            }
          }
        } else if (q.type === "codigo_zip") {
          // Multi-file: `raw` ahora es `File[]` (legacy: un único File).
          // Normalizamos a array para soportar ambos casos sin ramas.
          const filesArr: File[] = Array.isArray(raw)
            ? (raw.filter((f) => f instanceof File) as File[])
            : raw instanceof File
              ? [raw]
              : [];
          const langKey = (q.language ?? "").toLowerCase().trim();
          const allowedExtensions = LANG_TO_EXT[langKey] ?? null;
          if (filesArr.length === 0) {
            payload.content = "";
            payload.ai_grade = 0;
            payload.ai_feedback = "Sin archivos de código entregados";
          } else if (!user?.id) {
            // Sin sesión auth válida el path sería "undefined/...", que
            // viola la RLS de storage. Mejor un error claro que un
            // "new row violates row-level security policy" críptico.
            payload.ai_grade = 0;
            payload.ai_feedback =
              "Sesión no autenticada — recarga la página e inicia sesión de nuevo.";
          } else {
            // Validación cliente-side defense-in-depth (el picker ya
            // filtra al elegir, pero un estado React stale podría colar
            // archivos viejos). Whitelist puro: anything no permitido
            // por extensión rechaza, incluye `.gitignore`/`.env`/etc.
            if (allowedExtensions) {
              const violations = filesArr.filter((f) => !isFileAllowed(f.name, allowedExtensions));
              if (violations.length > 0) {
                const sample = violations
                  .slice(0, 5)
                  .map((f) => f.name)
                  .join(", ");
                const more = violations.length > 5 ? ` (+${violations.length - 5} más)` : "";
                const allowedLabel = allowedExtensions.map((e) => `.${e}`).join(", ");
                payload.ai_grade = 0;
                payload.ai_feedback = `Archivos no permitidos: ${sample}${more}. Solo se aceptan ${allowedLabel}.`;
                toast.error(payload.ai_feedback, { duration: 8000 });
              }
            }
          }
          // Validación de tamaño total (defense in depth — el input ya
          // chequea per-archivo pero el usuario puede modificar atributos
          // del input).
          if (!payload.ai_feedback) {
            const totalBytes = filesArr.reduce((acc, f) => acc + f.size, 0);
            if (totalBytes > MAX_CODE_FILES_TOTAL_BYTES) {
              payload.ai_grade = 0;
              payload.ai_feedback = `El total de archivos supera el tope de 50 MB (${formatFileSize(totalBytes)}). Reduce el contenido.`;
              toast.error(payload.ai_feedback, { duration: 8000 });
            } else if (filesArr.length > MAX_CODE_FILES_COUNT) {
              payload.ai_grade = 0;
              payload.ai_feedback = `Demasiados archivos (${filesArr.length}). Máximo permitido: ${MAX_CODE_FILES_COUNT}.`;
              toast.error(payload.ai_feedback, { duration: 8000 });
            }
          }
          if (filesArr.length > 0 && user?.id && !payload.ai_feedback) {
            // Carpeta raíz del path:
            //  - groupId si el proyecto es grupal (todos los miembros
            //    suben a la misma carpeta del grupo; la RLS lo permite
            //    si el caller es miembro — ver migración 20260530100000).
            //  - user.id si es individual.
            const rootFolder = groupId ?? user.id;
            // Subimos en paralelo. Cada archivo va a:
            //   <root>/<submissionId>/<questionId>/<safeName>
            // Si dos archivos comparten nombre (raro pero posible) el
            // segundo prefija un índice para no pisarse en Storage.
            const usedNames = new Set<string>();
            const uploads = await Promise.all(
              filesArr.map(async (f, idx) => {
                let safeName = f.name.replace(/[^a-zA-Z0-9._-]/g, "_");
                if (usedNames.has(safeName)) safeName = `${idx}_${safeName}`;
                usedNames.add(safeName);
                const path = `${rootFolder}/${submissionId}/${q.id}/${safeName}`;
                const { error: upErr } = await supabase.storage
                  .from("project-files")
                  .upload(path, f, { upsert: true, contentType: f.type || "text/plain" });
                return { path, error: upErr };
              }),
            );
            const upFailed = uploads.filter((u) => u.error);
            if (upFailed.length > 0) {
              payload.ai_grade = 0;
              payload.ai_feedback = `Error al subir ${upFailed.length} archivo(s): ${upFailed[0].error?.message ?? ""}`;
              toast.error(payload.ai_feedback, { duration: 8000 });
            } else {
              const uploadedPaths = uploads.map((u) => u.path);
              payload.code_paths = uploadedPaths;
              const aiBody = {
                projectCodeZipGrading: true,
                codePaths: uploadedPaths,
                fileTitle: q.title,
                fileDescription: q.description,
                expectedRubric: q.expected_rubric,
                maxPoints: q.points,
                courseLanguage,
                courseId: undefined,
                projectDescription,
                // Si el docente NO fijó language (langKey vacío), omitimos
                // el filtro — comportamiento histórico.
                ...(allowedExtensions ? { allowedExtensions } : {}),
              };
              if (useAsyncAi) {
                // Modo async: marcamos placeholder, encolamos al final
                // del submit (necesitamos el row id de la upsert).
                payload.ai_grade = null;
                payload.ai_feedback = PENDING_AI_FEEDBACK;
                pendingEnqueues.push({
                  qid: q.id,
                  kind: "project_codigo_zip",
                  body: aiBody,
                });
                // Saltamos el resto del bloque (que era el inline AI call).
                payloadsByQid[q.id] = payload;
                continue;
              }
              const { data: aiData, error: aiErr } = await supabase.functions.invoke(
                "ai-grade-submission",
                { body: aiBody },
              );
              if (aiErr || aiData?.error) {
                // El edge function devuelve el detalle real en
                // `data.error` cuando es rechazo de validación
                // (extension_mismatch, etc.). Sin extractEdgeError caía
                // al wrapper genérico "Edge Function returned non-2xx"
                // y el estudiante no entendía por qué su entrega tuvo 0.
                const detail = await extractEdgeError(aiErr, aiData);
                payload.ai_grade = 0;
                payload.ai_feedback = detail || "Error IA al calificar los archivos";
                toast.error(payload.ai_feedback, { duration: 8000 });
              } else {
                earned = Number(aiData?.grade) || 0;
                feedback = aiData?.feedback ?? feedback;
                payload.ai_grade = earned;
                payload.ai_feedback = feedback;
                payload.ai_likelihood =
                  typeof aiData?.ai_likelihood === "number" ? aiData.ai_likelihood : null;
                payload.ai_reasons = aiData?.ai_reasons ?? null;
                // Persistir flags de truncado del ZIP — el monitor del docente
                // los lee para mostrar badge "ZIP truncado" en la calificación.
                if (typeof aiData?.zip_truncated === "boolean") {
                  payload.zip_truncated = aiData.zip_truncated;
                }
                if (typeof aiData?.zip_chars_used === "number") {
                  payload.zip_chars_used = aiData.zip_chars_used;
                }
              }
            }
          }
        } else {
          // Detecta "sin respuesta":
          //   1. String vacío / whitespace.
          //   2. Código idéntico al starter_code del slot — el alumno
          //      no escribió nada propio. Sin esta comparación la IA
          //      recibe el template y gasta tokens calificando lo que
          //      el docente mismo escribió.
          const trimmedAnswer = String(raw).trim();
          const trimmedStarter = String(q.starter_code ?? "").trim();
          const isEmpty =
            !trimmedAnswer || (trimmedStarter !== "" && trimmedAnswer === trimmedStarter);
          if (isEmpty) {
            payload.content = "";
            payload.ai_grade = 0;
            payload.ai_feedback = "Sin respuesta";
          } else {
            // Pregunta abierta con respuesta — bucketea para el batch.
            payload.content = String(raw);
            batchItems.push({
              qid: q.id,
              type: q.type === "java_gui" ? "codigo" : q.type,
              content: String(q.title ?? ""),
              rubric: String(q.expected_rubric ?? ""),
              userAnswer: String(raw),
              maxPoints: Number(q.points) || 0,
              language: q.type === "java_gui" ? "java" : q.language,
            });
          }
        }
        totalEarned += earned;
        payloadsByQid[q.id] = payload;
      }

      // ── Fase 2: calificación de preguntas no-código (abierta, codigo,
      // diagrama, java_gui) ──
      //
      // BUG FIX: este bloque antes corría SIEMPRE — incluso con el modo IA
      // en `async`/cola, las preguntas de texto/diagrama/código se mandaban
      // al instante en una llamada batch. Solo las `codigo_zip` respetaban
      // el modo async (ver branch arriba con `if (useAsyncAi)`).
      //
      // Comportamiento correcto (mismo que talleres, ver
      // [WorkshopQuestions.tsx](src/modules/workshops/WorkshopQuestions.tsx)):
      //   - sync  → UNA llamada batch a `ai-grade-submission` con todas las
      //             abiertas, esperamos el resultado y lo persistimos.
      //   - async → marcamos cada item como `PENDING_AI_FEEDBACK` y
      //             encolamos UN job por pregunta. El worker hourly los
      //             drena y actualiza los rows. El estudiante ve la nota
      //             "Por calificar" inmediatamente y la real cuando vuelva.
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
                {
                  score: number;
                  feedback: string;
                  ai_likelihood?: number;
                  ai_reasons?: string;
                }
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
            payload.ai_likelihood = typeof r.ai_likelihood === "number" ? r.ai_likelihood : null;
            payload.ai_reasons = r.ai_reasons ?? null;
            totalEarned += earned;
          } else {
            payload.ai_grade = 0;
            payload.ai_feedback = errMsg ?? "El modelo no incluyó esta pregunta en su respuesta.";
          }
        }
      } else if (batchItems.length > 0 && useAsyncAi) {
        // Modo async: pre-marcamos cada respuesta como pendiente. La
        // encolada va DESPUÉS del upsert como UN solo job batch
        // (kind=project_full) que cubre TODAS las preguntas no-ZIP.
        // Antes encolábamos N jobs (uno por pregunta con
        // `projectFileGrading: true`) → N llamadas a Gemini. Ahora 1
        // call sirve para todo el lote por estudiante. ~Nx menos costo.
        for (const it of batchItems) {
          const payload = payloadsByQid[it.qid];
          payload.ai_grade = null;
          payload.ai_feedback = PENDING_AI_FEEDBACK;
        }
      }

      // ── Persistencia: upsert por qid ──
      // Antes hacíamos await sin chequear el error — si la migración de
      // `code_paths` no estaba aplicada (PostgREST returns "column ...
      // does not exist") la fila no se insertaba y la pregunta quedaba
      // sin ai_feedback ni código para descargar. Ahora:
      //   1. Si el primer upsert falla con PGRST204 (columna no existe),
      //      reintentamos sin los campos opcionales nuevos (`code_paths`,
      //      `zip_truncated`, `zip_chars_used`) para garantizar al menos
      //      la nota y el feedback.
      //   2. Cualquier error final se reporta por toast — el docente
      //      verá un mensaje útil en lugar de silencio.
      const OPTIONAL_COLS = ["code_paths", "zip_truncated", "zip_chars_used"];
      for (const qid of Object.keys(payloadsByQid)) {
        const payload = payloadsByQid[qid];

        const { error } = await (db
          .from("project_submission_files")
          .upsert(payload, { onConflict: "submission_id,file_id" }) as any);
        if (error) {
          const isSchemaErr = /column.*does not exist|PGRST204|schema cache/i.test(
            error.message ?? "",
          );
          if (isSchemaErr) {
            // Retry sin columnas nuevas. Si una migración aún no se aplicó,
            // mejor persistir la nota que perder toda la entrega.
            const slim: Record<string, unknown> = { ...payload };
            for (const c of OPTIONAL_COLS) delete slim[c];

            const { error: retryErr } = await (db
              .from("project_submission_files")
              .upsert(slim, { onConflict: "submission_id,file_id" }) as any);
            if (retryErr) {
              console.error("[project-submit] upsert retry failed", qid, retryErr);
              toast.error(
                `No se pudo guardar la calificación de una sección: ${retryErr.message}`,
                { duration: 10000 },
              );
            } else {
              console.warn(
                "[project-submit] columnas nuevas (code_paths/zip_truncated/zip_chars_used) no disponibles — guardada nota sin esos campos. Aplica las migraciones pendientes.",
              );
            }
          } else {
            console.error("[project-submit] upsert failed", qid, error);
            toast.error(
              `No se pudo guardar la calificación de una sección: ${friendlyError(error)}`,
              {
                duration: 10000,
              },
            );
          }
        }
      }

      // ── Encolado IA async (post-upsert para tener los row ids) ──
      // En modo `processing_mode = async`, las IA calls quedaron diferidas.
      //
      // Dos caminos según el tipo de job:
      //   - codigo_zip: 1 job POR archivo ZIP. Cada uno descomprime y lee
      //     archivos en el worker — son trabajos pesados que NO se baten.
      //   - resto (abierta/codigo/diagrama no-ZIP): UN solo job batch
      //     `project_full` que cubre todas las preguntas en una llamada
      //     a Gemini. Reduce N a 1 por entrega.
      if (pendingEnqueues.length > 0) {
        for (const job of pendingEnqueues) {
          const { data: row } = await db
            .from("project_submission_files")
            .select("id")
            .eq("submission_id", submissionId)
            .eq("file_id", job.qid)
            .maybeSingle();
          if (!row?.id) continue;
          await db.rpc("enqueue_ai_grading", {
            _kind: job.kind,
            _invoke_target: "ai-grade-submission",
            _body: job.body,
            _target_table: "project_submission_files",
            _target_row_id: row.id,
            _field_grade: "ai_grade",
            _field_feedback: "ai_feedback",
            _field_likelihood: "ai_likelihood",
            _field_reasons: "ai_reasons",
            _course_id: projectCourseId ?? null,
          });
        }
      }

      // Batch enqueue: UN job para todas las preguntas no-ZIP. El edge
      // function `ai-grade-submission` (rama projectFullGrading) reusa
      // gradeOpenAnswersInBatch y persiste cada resultado en
      // project_submission_files con `persistedInternally: true`, así el
      // worker NO escribe nada (la UI ya tiene placeholder "Pendiente IA").
      if (useAsyncAi && batchItems.length > 0) {
        await db.rpc("enqueue_ai_grading", {
          _kind: "project_full",
          _invoke_target: "ai-grade-submission",
          _body: {
            projectFullGrading: true,
            submissionId,
            items: batchItems.map((it) => ({
              qid: it.qid,
              content: it.content,
              rubric: it.rubric,
              userAnswer: it.userAnswer,
              maxPoints: it.maxPoints,
            })),
            courseLanguage,
            courseId: projectCourseId ?? undefined,
            projectDescription,
          },
          _target_table: "project_submissions",
          _target_row_id: submissionId,
          // field_grade / field_feedback no se usan (persistedInternally
          // hace que el worker NO escriba), pero la RPC los requiere.
          _course_id: projectCourseId ?? null,
        });
      }

      // Notif "Por calificar" cuando hay AL MENOS un enqueue (ZIP o batch).
      const totalQueued =
        pendingEnqueues.length + (useAsyncAi && batchItems.length > 0 ? batchItems.length : 0);
      if (totalQueued > 0) {
        toast.info(QUEUED_STUDENT_TITLE, {
          description: `${totalQueued} respuesta(s)`,
          duration: 6000,
        });
      }

      const submissionScore =
        totalPoints > 0 ? Number(((totalEarned / totalPoints) * Number(maxScore)).toFixed(2)) : 0;

      // submission_grade = nota de la entrega. final_grade queda null
      // hasta que el docente registre la sustentación (defense_factor).
      // Status pasa a 'entregado' (no 'calificado') porque falta sustentar.
      await db
        .from("project_submissions")
        .update({
          ai_grade: submissionScore,
          submission_grade: submissionScore,
          final_grade: null,
          ai_feedback: `Calificación automática de la entrega sobre ${maxScore} pts. Falta sustentación.`,
          status: "entregado",
        })
        .eq("id", submissionId);

      setGraded({ grade: submissionScore });
      onGraded?.(submissionScore);
      toast.success(
        `Entrega calificada: ${submissionScore} / ${maxScore}. La nota final se calcula tras la sustentación.`,
      );
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
    return <p className="text-sm text-muted-foreground">Este proyecto aún no tiene preguntas.</p>;
  }

  if (graded) {
    return (
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-base">Calificación de la entrega</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">
            {graded.grade} / {maxScore}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Esta es la nota de la entrega calculada por IA. La{" "}
            <strong>nota final del proyecto</strong> se calcula como{" "}
            <code>entrega × factor de sustentación</code> y se publica cuando el docente registre tu
            sustentación.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">{projectTitle}</h3>

      {/* Gate de videos introductorios obligatorios. Solo se renderiza
          si el proyecto tiene videos en `project_intro_videos` Y hay
          al menos una pregunta tipo codigo_zip. Orden estricto: el
          siguiente video se desbloquea cuando el anterior está visto. */}
      {introVideos.length > 0 && hasCodeQuestion && (
        <ProjectIntroVideoGate
          videos={introVideos}
          watchedIds={watchedVideoIds}
          onVideoWatched={async (videoId) => {
            // Optimistic: actualiza state local primero para que la UI
            // desbloquee el siguiente video al instante. Si el RPC falla
            // (red caída, RLS rara), el siguiente reload va a re-pedir
            // la view perdida — peor caso el alumno ve un video dos veces.
            setWatchedVideoIds((prev) => {
              const next = new Set(prev);
              next.add(videoId);
              return next;
            });
            try {
              if (!user) return;
              const subQuery = db
                .from("project_submissions")
                .select("id")
                .eq("project_id", projectId);
              const { data: subRow } = await (groupId
                ? subQuery.eq("group_id", groupId).maybeSingle()
                : subQuery.eq("user_id", user.id).maybeSingle());
              if (subRow?.id) {
                await db.rpc("mark_project_video_watched", {
                  _submission_id: subRow.id,
                  _video_id: videoId,
                });
              }
              // Si no hay submission aún, el progreso vive solo en
              // state local. Al hacer el primer submit, el flow de
              // creación de submission debería re-persistir el set.
              // (Edge case raro: la mayoría de los alumnos miran video
              // DESPUÉS de entrar a "Entregar" donde ya hay submission.)
            } catch {
              /* silencioso — state local sobrevive la sesión */
            }
          }}
        />
      )}

      {/* Link al repositorio: obligatorio. Permite al docente verificar
          fechas de modificación contra la fecha de entrega. */}
      <Card className="border-amber-500/40 bg-amber-500/5 dark:bg-amber-500/10">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Link al repositorio (GitHub o Drive) <span className="text-destructive">*</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            type="url"
            placeholder="https://github.com/usuario/proyecto  o  https://drive.google.com/..."
            value={repositoryUrl}
            onChange={(e) => setRepositoryUrl(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            <strong>Obligatorio</strong>. El docente verificará que la fecha de modificación de los
            archivos sea igual o anterior a la fecha de entrega — no edites el repositorio después
            de entregar.
          </p>
        </CardContent>
      </Card>

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
            <MarkdownInline>{q.title}</MarkdownInline>
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
                value={answers[q.id] ?? q.starter_code ?? ""}
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
                // El starter por defecto depende del framework: si la
                // pregunta es JavaFX (extends Application + start), no
                // tiene sentido mostrar el Swing starter (JFrame). Sin
                // este branch el alumno tendría que borrar el snippet de
                // Swing manualmente — y proyectos no guardan
                // q.starter_code (se inserta como null), así que el
                // fallback es siempre el del framework correcto.
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
                // Modo ZIP único (scaffolding): un solo .zip → backend
                // descomprime → IA recibe archivos crudos en un prompt
                // sin minificar (flag noMinify del edge).
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
                        const lowerName = picked.name.toLowerCase();
                        if (!lowerName.endsWith(".zip")) {
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
                        if (picked.length === 0) {
                          // El usuario abrió el picker y canceló — no
                          // pisamos la selección actual.
                          return;
                        }
                        // 1) Whitelist estricta por extensión. Cualquier
                        // archivo cuya extensión no esté en `allowedExts`
                        // (Java → ["java"]) queda rechazado. Esto incluye
                        // hidden/config (.gitignore, .env, .DS_Store) y
                        // archivos sin extensión, sin necesidad de
                        // mantener una blacklist aparte.
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
                        // 2) Mezcla con la selección actual — el estudiante
                        // puede agregar más archivos sin perder los previos.
                        // Si pica el mismo nombre dos veces, el nuevo
                        // reemplaza al viejo (key = nombre + tamaño).
                        const merged: File[] = [...current];
                        for (const f of picked) {
                          const idx = merged.findIndex(
                            (m) => m.name === f.name && m.size === f.size,
                          );
                          if (idx >= 0) merged[idx] = f;
                          else merged.push(f);
                        }
                        // 3) Validación de tamaño total + cuenta sobre el
                        // resultado merged.
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
                          toast.error(
                            "Hay archivos vacíos en la selección. Verifica que no estés subiendo archivos rotos.",
                          );
                          e.target.value = "";
                          return;
                        }
                        // Limpiamos el input para que volver a seleccionar
                        // el mismo archivo dispare onChange (algunos
                        // browsers no lo hacen si value es igual).
                        e.target.value = "";
                        updateAnswer(q.id, merged);
                      }}
                      className="block w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer hover:file:bg-primary/90"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Selecciona uno o varios archivos de código fuente directamente desde tu equipo
                      — sin comprimir. Extensiones aceptadas:{" "}
                      <span className="font-mono">{allowedLabel}</span>. Tope: 50 MB en total y
                      hasta {MAX_CODE_FILES_COUNT} archivos. Puedes quitar archivos antes de enviar.
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
                          {current.map((f, i) => {
                            const sizeStr = formatFileSizeShort(f.size);
                            return (
                              <Badge
                                key={`${f.name}-${f.size}-${i}`}
                                variant="secondary"
                                className="text-[10px] gap-1 pr-1"
                              >
                                <span className="truncate max-w-[12rem]">{f.name}</span>
                                <span className="text-muted-foreground">· {sizeStr}</span>
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
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}
          </CardContent>
        </Card>
      ))}
      <div className="sticky bottom-2 z-10 bg-background/80 backdrop-blur p-2 rounded-lg border space-y-1.5">
        {/* Contador de intentos restantes. Foco en lo que LE QUEDA al
            alumno (no en lo que ya consumió). Color escala con urgencia:
            normal → ámbar (1 restante) → rojo (0 restantes). */}
        {(() => {
          const remaining = Math.max(0, effectiveMaxAttempts - attemptCount);
          const isLast = remaining === 1;
          return (
            <div className="flex items-center justify-center gap-1.5 text-[11px]">
              <span className="text-muted-foreground">Intentos restantes:</span>
              <span
                className={`tabular-nums font-medium ${
                  attemptsExhausted
                    ? "text-destructive"
                    : isLast
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-foreground"
                }`}
              >
                {remaining} / {effectiveMaxAttempts}
              </span>
            </div>
          );
        })()}
        {attemptsExhausted ? (
          <p className="text-[11px] text-destructive text-center">
            Ya consumiste todos tus intentos. No puedes volver a entregar.
          </p>
        ) : effectiveMaxAttempts - attemptCount === 1 ? (
          <p className="text-[11px] text-amber-700 dark:text-amber-300 text-center font-medium">
            {effectiveMaxAttempts === 1
              ? "Aviso: este proyecto admite UNA sola entrega — revisa todo antes de enviar."
              : "Aviso: te queda 1 intento — revisa todo antes de enviar."}
          </p>
        ) : null}
        {videoGateBlocking && !attemptsExhausted && (
          <p className="text-[11px] text-amber-700 dark:text-amber-300 text-center">
            Termina de ver el video introductorio para habilitar la entrega.
          </p>
        )}
        <Button
          onClick={submit}
          disabled={submitting || videoGateBlocking || attemptsExhausted}
          className="w-full"
        >
          {submitting ? <Spinner size="md" className="mr-1" /> : <Send className="h-4 w-4 mr-1" />}
          Entregar
        </Button>
      </div>
    </div>
  );
}
