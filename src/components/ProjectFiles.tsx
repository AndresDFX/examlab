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
import { useAuth } from "@/hooks/use-auth";
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
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { CodeEditor } from "@/components/CodeEditor";
import { DiagramEditor } from "@/components/DiagramEditor";
import { JavaGuiRunner, JAVA_GUI_STARTER } from "@/components/JavaGuiRunner";
import { useConfirm } from "@/components/ConfirmDialog";
import { MarkdownInline } from "@/components/MarkdownInline";

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
  type: "abierta" | "cerrada" | "codigo" | "diagrama" | "java_gui" | "codigo_zip";
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
  const [questions, setQuestions] = useState<ProjectFile[]>([]);
  const [loading, setLoading] = useState(true);

  // manual form (sirve para crear y para editar — UPDATE cuando editingId)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>("list");
  const [qType, setQType] = useState<ProjectFile["type"]>("abierta");
  const [qContent, setQContent] = useState("");
  const [qRubric, setQRubric] = useState("");
  const [qChoices, setQChoices] = useState(["", "", "", ""]);
  const [qCorrect, setQCorrect] = useState(0);
  const [qPoints, setQPoints] = useState(1);
  const [qLanguage, setQLanguage] = useState("java");

  const resetForm = () => {
    setEditingId(null);
    setQType("abierta");
    setQContent("");
    setQRubric("");
    setQChoices(["", "", "", ""]);
    setQCorrect(0);
    setQPoints(1);
    setQLanguage("java");
  };

  const loadIntoForm = (q: ProjectFile) => {
    setEditingId(q.id);
    setQType(q.type);
    setQContent(q.title);
    setQRubric(q.expected_rubric ?? "");
    const choices = (q.options?.choices ?? []) as string[];
    setQChoices([0, 1, 2, 3].map((i) => choices[i] ?? ""));
    setQCorrect(Number(q.options?.correct_index ?? 0));
    setQPoints(q.points);
    setQLanguage(q.language ?? "java");
    setActiveTab("manual");
  };

  // AI form
  const [aiTopics, setAiTopics] = useState("");
  const [aiCount, setAiCount] = useState(3);
  const [aiType, setAiType] = useState<ProjectFile["type"]>("abierta");
  const [aiLanguage, setAiLanguage] = useState("java");
  const [aiLoading, setAiLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data } = await db
      .from("project_files")
      .select("*")
      .eq("project_id", projectId)
      .order("position");
    setQuestions((data ?? []) as ProjectFile[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const submitManual = async () => {
    if (!qContent.trim()) {
      toast.error("Escribe el enunciado");
      return;
    }
    const options =
      qType === "cerrada"
        ? { choices: qChoices.filter((c) => c.trim()), correct_index: qCorrect }
        : null;
    const language = qType === "codigo" ? qLanguage : qType === "java_gui" ? "java" : null;

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
        })
        .eq("id", editingId);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Pregunta actualizada");
    } else {
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
        starter_code: qType === "java_gui" ? JAVA_GUI_STARTER : null,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Pregunta agregada");
    }
    resetForm();
    setActiveTab("list");
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
    if (e1) return toast.error(e1.message);
    const { error: e2 } = await db
      .from("project_files")
      .update({ position: a.position })
      .eq("id", b.id);
    if (e2) return toast.error(e2.message);
    const { error: e3 } = await db
      .from("project_files")
      .update({ position: b.position })
      .eq("id", a.id);
    if (e3) return toast.error(e3.message);
    void load();
  };

  const removeQ = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar pregunta",
      description:
        "Se eliminará la pregunta del proyecto. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("project_files").delete().eq("id", id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Pregunta eliminada");
    void load();
  };

  const generateWithAI = async () => {
    if (!aiTopics.trim()) {
      toast.error("Indica los temas");
      return;
    }
    setAiLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
        body: {
          topics: aiTopics,
          type: aiType,
          count: aiCount,
          examId: projectId, // legacy field reused as targetId
          language: aiLanguage,
          courseLanguage,
          targetTable: "project_files",
        },
      });
      if (error) toast.error(error.message ?? "Error generando con IA");
      else if (data?.error) toast.error(data.error);
      else if (data?.inserted) toast.success(`${data.inserted.length} pregunta(s) generadas con IA`);
      setAiTopics("");
      void load();
    } catch (e: any) {
      toast.error(e.message ?? "Error IA");
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList>
          <TabsTrigger value="list">Preguntas ({questions.length})</TabsTrigger>
          <TabsTrigger value="manual">{editingId ? "Editar pregunta" : "Agregar manual"}</TabsTrigger>
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
                    <Badge variant="outline" className="text-[10px]">{idx + 1}</Badge>
                    <Badge variant="secondary" className="text-[10px] capitalize">{q.type}</Badge>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label required>Tipo</Label>
              <Select value={qType} onValueChange={(v) => setQType(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="abierta">Abierta</SelectItem>
                  <SelectItem value="cerrada">Cerrada (opción múltiple)</SelectItem>
                  <SelectItem value="codigo">Código (un archivo en textarea)</SelectItem>
                  <SelectItem value="codigo_zip">Código completo (ZIP)</SelectItem>
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
          {qType === "codigo" && (
            <div>
              <Label required>Lenguaje</Label>
              <Select value={qLanguage} onValueChange={setQLanguage}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="java">Java</SelectItem>
                  <SelectItem value="python">Python</SelectItem>
                  <SelectItem value="javascript">JavaScript</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {qType === "codigo_zip" && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
              El estudiante subirá un <strong>archivo .zip</strong> con todo su código fuente. La
              IA descomprime y evalúa los archivos de código (.java, .py, .js, .ts, .cpp, etc) en
              conjunto. Diagramas y documentos van en preguntas separadas (tipo Abierta o
              Diagrama).
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

        <TabsContent value="ai" className="space-y-3">
          <div>
            <Label required>Temas</Label>
            <Textarea
              value={aiTopics}
              onChange={(e) => setAiTopics(e.target.value)}
              rows={3}
              placeholder="Listas enlazadas, recursión, complejidad…"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label required>Tipo</Label>
              <Select value={aiType} onValueChange={(v) => setAiType(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="abierta">Abierta</SelectItem>
                  <SelectItem value="cerrada">Cerrada</SelectItem>
                  <SelectItem value="codigo">Código</SelectItem>
                  <SelectItem value="diagrama">Diagrama</SelectItem>
                  <SelectItem value="java_gui">Java GUI (Swing/AWT)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label required>Cantidad</Label>
              <Input
                type="number"
                min={1}
                max={10}
                value={aiCount}
                onChange={(e) => setAiCount(Number(e.target.value) || 3)}
              />
            </div>
            {aiType === "codigo" && (
              <div>
                <Label required>Lenguaje</Label>
                <Select value={aiLanguage} onValueChange={setAiLanguage}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="java">Java</SelectItem>
                    <SelectItem value="python">Python</SelectItem>
                    <SelectItem value="javascript">JavaScript</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <Button onClick={generateWithAI} disabled={aiLoading}>
            {aiLoading ? (
              <Spinner size="md" className="mr-1" />
            ) : (
              <Sparkles className="h-4 w-4 mr-1" />
            )}
            Generar con IA
          </Button>
        </TabsContent>
      </Tabs>
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
  onGraded,
}: {
  projectId: string;
  projectTitle: string;
  maxScore: number;
  courseLanguage?: "es" | "en";
  onGraded?: (finalGrade: number) => void;
}) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [questions, setQuestions] = useState<ProjectFile[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [graded, setGraded] = useState<{ grade: number } | null>(null);
  const loadedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user) return;
    const key = `${projectId}::${user.id}`;
    if (loadedForRef.current === key) return;
    loadedForRef.current = key;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: qs } = await db
        .from("project_files")
        .select("*")
        .eq("project_id", projectId)
        .order("position");
      if (cancelled) return;
      setQuestions((qs ?? []) as ProjectFile[]);

      const { data: sub } = await db
        .from("project_submissions")
        .select("id, final_grade, status")
        .eq("project_id", projectId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (sub?.id) {
        const { data: ans } = await db
          .from("project_submission_files")
          .select("file_id, content, selected_option")
          .eq("submission_id", sub.id);
        const map: Record<string, any> = {};
        for (const a of (ans ?? []) as any[]) {
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
   * vacías. Para "cerrada" cuenta como vacía si no se eligió opción;
   * para el resto cuenta como vacía si el contenido (string) trim es "".
   */
  const getUnansweredNumbers = (): number[] => {
    const empty: number[] = [];
    questions.forEach((q, idx) => {
      const a = answers[q.id];
      const isCerrada = q.type === "cerrada";
      const isCodeZip = q.type === "codigo_zip";
      const isBlank = isCerrada
        ? a === undefined || a === null || a === ""
        : isCodeZip
          ? !(a instanceof File)
          : !String(a ?? "").trim();
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
            <p>
              Esas preguntas recibirán 0 puntos. ¿Quieres entregar el proyecto
              de todas formas?
            </p>
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
      const { data: existing } = await db
        .from("project_submissions")
        .select("id")
        .eq("project_id", projectId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (existing?.id) {
        submissionId = existing.id;
        await db
          .from("project_submissions")
          .update({ status: "entregado", submitted_at: new Date().toISOString() })
          .eq("id", submissionId);
      } else {
        const { data: created, error } = await db
          .from("project_submissions")
          .insert({
            project_id: projectId,
            user_id: user.id,
            status: "entregado",
            submitted_at: new Date().toISOString(),
          })
          .select("id")
          .single();
        if (error || !created) {
          toast.error(error?.message ?? "No se pudo crear la entrega");
          setSubmitting(false);
          return;
        }
        submissionId = created.id;
      }

      let totalEarned = 0;
      let totalPoints = 0;

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
        } else if (q.type === "codigo_zip") {
          // raw debería ser un File. Si no hay file, marca 0.
          const file = raw instanceof File ? raw : null;
          if (!file) {
            payload.content = "";
            payload.ai_grade = 0;
            payload.ai_feedback = "Sin archivo ZIP";
          } else {
            // Upload a Storage en <user_id>/<submission_id>/<file_id>.zip
            const path = `${user.id}/${submissionId}/${q.id}.zip`;
            const { error: upErr } = await supabase.storage
              .from("project-files")
              .upload(path, file, { upsert: true, contentType: "application/zip" });
            if (upErr) {
              payload.ai_grade = 0;
              payload.ai_feedback = `Error al subir ZIP: ${upErr.message}`;
            } else {
              payload.zip_path = path;
              const { data: aiData, error: aiErr } = await supabase.functions.invoke(
                "ai-grade-submission",
                {
                  body: {
                    projectCodeZipGrading: true,
                    zipPath: path,
                    fileTitle: q.title,
                    fileDescription: q.description,
                    expectedRubric: q.expected_rubric,
                    maxPoints: q.points,
                    courseLanguage,
                    courseId: undefined,
                  },
                },
              );
              if (aiErr || aiData?.error) {
                payload.ai_grade = 0;
                payload.ai_feedback = `Error IA: ${aiErr?.message ?? aiData?.error ?? "Desconocido"}`;
              } else {
                earned = Number(aiData?.grade) || 0;
                feedback = aiData?.feedback ?? feedback;
                payload.ai_grade = earned;
                payload.ai_feedback = feedback;
                payload.ai_likelihood =
                  typeof aiData?.ai_likelihood === "number" ? aiData.ai_likelihood : null;
                payload.ai_reasons = aiData?.ai_reasons ?? null;
              }
            }
          }
        } else if (!String(raw).trim()) {
          payload.content = "";
          payload.ai_grade = 0;
          payload.ai_feedback = "Sin respuesta";
        } else {
          payload.content = String(raw);
          const { data: aiData, error: aiErr } = await supabase.functions.invoke(
            "ai-grade-submission",
            {
              body: {
                workshopQuestionGrading: true,
                questionType: q.type === "java_gui" ? "codigo" : q.type,
                questionContent: q.title,
                expectedRubric: q.expected_rubric,
                maxPoints: q.points,
                studentAnswer: String(raw),
                language: q.type === "java_gui" ? "java" : q.language,
                courseLanguage,
              },
            },
          );
          if (aiErr || aiData?.error) {
            payload.ai_grade = 0;
            payload.ai_feedback = `Error IA: ${aiErr?.message ?? aiData?.error ?? "Desconocido"}`;
          } else {
            earned = Number(aiData?.grade) || 0;
            feedback = aiData?.feedback ?? feedback;
            payload.ai_grade = earned;
            payload.ai_feedback = feedback;
            payload.ai_likelihood =
              typeof aiData?.ai_likelihood === "number" ? aiData.ai_likelihood : null;
            payload.ai_reasons = aiData?.ai_reasons ?? null;
          }
        }

        await db
          .from("project_submission_files")
          .upsert(payload, { onConflict: "submission_id,file_id" });

        totalEarned += earned;
      }

      const finalGrade =
        totalPoints > 0
          ? Number(((totalEarned / totalPoints) * Number(maxScore)).toFixed(2))
          : 0;

      await db
        .from("project_submissions")
        .update({
          ai_grade: finalGrade,
          final_grade: finalGrade,
          ai_feedback: `Calificación automática inmediata sobre ${maxScore} pts.`,
          status: "calificado",
        })
        .eq("id", submissionId);

      setGraded({ grade: finalGrade });
      onGraded?.(finalGrade);
      toast.success(`Calificación: ${finalGrade} / ${maxScore}`);
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
          <CardTitle className="text-base">Resultado del proyecto</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-semibold tabular-nums">
            {graded.grade} / {maxScore}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            La calificación fue generada automáticamente por IA al enviar el proyecto.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">{projectTitle}</h3>
      {questions.map((q, idx) => (
        <Card key={q.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Badge variant="outline" className="text-[10px]">{idx + 1}</Badge>
              <Badge variant="secondary" className="text-[10px] capitalize">{q.type}</Badge>
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
              <DiagramEditor
                value={answers[q.id] ?? ""}
                onChange={(v) => updateAnswer(q.id, v)}
              />
            )}
            {q.type === "java_gui" && (
              <JavaGuiRunner
                value={answers[q.id] ?? q.starter_code ?? JAVA_GUI_STARTER}
                onChange={(v) => updateAnswer(q.id, v)}
                height="280px"
              />
            )}
            {q.type === "codigo_zip" && (
              <div className="space-y-2">
                <input
                  type="file"
                  accept=".zip,application/zip,application/x-zip-compressed"
                  onChange={(e) => updateAnswer(q.id, e.target.files?.[0] ?? null)}
                  className="block w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer hover:file:bg-primary/90"
                />
                <p className="text-[11px] text-muted-foreground">
                  Sube un archivo .zip con todo el código fuente del proyecto. Máximo 100MB. La
                  IA descomprime y evalúa los archivos de código (.java, .py, .js, .ts, .cpp,
                  etc.) en conjunto.
                </p>
                {answers[q.id] instanceof File && (
                  <Badge variant="secondary" className="text-[10px]">
                    {(answers[q.id] as File).name} ·{" "}
                    {Math.round(((answers[q.id] as File).size / 1024 / 1024) * 10) / 10} MB
                  </Badge>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      ))}
      <div className="sticky bottom-2 z-10 bg-background/80 backdrop-blur p-2 rounded-lg border">
        <Button onClick={submit} disabled={submitting} className="w-full">
          {submitting ? (
            <Spinner size="md" className="mr-1" />
          ) : (
            <Send className="h-4 w-4 mr-1" />
          )}
          Enviar proyecto y calificar con IA
        </Button>
      </div>
    </div>
  );
}
