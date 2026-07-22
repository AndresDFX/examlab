import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
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
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { QuestionBankImportDialog } from "@/modules/code/QuestionBankImportDialog";
import { CodeEditor, getStarterCode, type CodeLanguage } from "@/modules/code/CodeEditor";
import { CodeRunnerPicker, type CodeRunnerProvider } from "@/modules/code/CodeRunnerPicker";
import { runJavaInBrowser, CANCELLED_SENTINEL } from "@/modules/code/run-java";
import { DiagramEditor } from "@/modules/code/DiagramEditor";
import { JavaGuiRunner, JAVA_GUI_STARTER, JAVAFX_STARTER } from "@/modules/code/JavaGuiRunner";
import { PythonGuiRunner, PYTHON_GUI_STARTER } from "@/modules/code/PythonGuiRunner";
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
import { NetworkConsole } from "@/modules/network/NetworkConsole";
import { NetworkTopologyEditor } from "@/modules/network/NetworkTopologyEditor";
import {
  type NetworkScenario,
  defaultScenario,
  generateNetworkQuestions,
  parseNetworkAnswer,
  parseScenario,
} from "@/modules/network/scenario";
import { gradeNetwork } from "@/modules/network/grading";
import { V86Console } from "@/modules/serverconsole/V86Console";
import { isV86AnswerBlank } from "@/modules/serverconsole/v86-answer";

export type WorkshopQuestion = {
  id: string;
  workshop_id: string;
  type:
    | "abierta"
    | "cerrada"
    | "cerrada_multi"
    | "codigo"
    | "diagrama"
    | "java_gui"
    | "python_gui"
    | "codigo_zip"
    | "red_consola"
    | "red_gui"
    | "so_consola";
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
  const { t } = useTranslation();
  const confirm = useConfirm();
  // Necesitamos el course_id del taller para encolar generaciones (la
  // cola lo guarda para que el admin sepa de qué curso es). Lo
  // resolvemos una sola vez con un mini-fetch — el dialog raramente
  // monta sin contexto del workshop.
  const [courseId, setCourseId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("workshops")
        .select("course_id")
        .eq("id", workshopId)
        .maybeSingle();
      if (cancelled) return;
      setCourseId((data as { course_id?: string } | null)?.course_id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [workshopId]);
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
  // Escenario JSON para preguntas `red_consola` (topología + target +
  // aserciones). Se persiste en `options.network`. Se edita como JSON con una
  // plantilla runnable por defecto.
  const [qNetworkScenario, setQNetworkScenario] = useState<string>(() =>
    JSON.stringify(defaultScenario(), null, 2),
  );

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
    setQNetworkScenario(JSON.stringify(defaultScenario(), null, 2));
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
    const net = (q.options as { network?: unknown } | null)?.network;
    setQNetworkScenario(
      net ? JSON.stringify(net, null, 2) : JSON.stringify(defaultScenario(), null, 2),
    );
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
      toast.error(
        i18n.t("toast.modules_workshops_WorkshopQuestions.writeStatement", {
          defaultValue: "Escribe el enunciado",
        }),
      );
      return;
    }
    if (qType === "cerrada_multi") {
      if (qCorrectIndices.length === 0) {
        toast.error(
          i18n.t("toast.modules_workshops_WorkshopQuestions.markAtLeastOneCorrect", {
            defaultValue: "Marca al menos una opción correcta en opción múltiple",
          }),
        );
        return;
      }
      const minN = typeof qMinSelections === "number" ? qMinSelections : 0;
      const maxN = typeof qMaxSelections === "number" ? qMaxSelections : 0;
      if (minN && maxN && minN > maxN) {
        toast.error(
          i18n.t("toast.modules_workshops_WorkshopQuestions.minMaxInverted", {
            defaultValue: "Mínimo de marcadas no puede ser mayor al máximo",
          }),
        );
        return;
      }
    }
    // red_consola: valida el escenario JSON (topología + target + aserciones)
    // antes de armar el payload. Si no parsea, aborta con toast amigable.
    let networkOptions: { network: unknown } | null = null;
    if (qType === "red_consola" || qType === "red_gui") {
      let scenarioObj: unknown = null;
      try {
        scenarioObj = JSON.parse(qNetworkScenario);
      } catch {
        scenarioObj = null;
      }
      const parsed = parseScenario({ network: scenarioObj });
      if (!parsed) {
        toast.error(
          i18n.t("toast.modules_workshops_WorkshopQuestions.invalidNetworkScenario", {
            defaultValue:
              "El escenario de red no es válido. Revisa el JSON: devices, links, targetDeviceId y assertions.",
          }),
        );
        return;
      }
      networkOptions = { network: parsed };
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
            : qType === "red_consola" || qType === "red_gui"
              ? networkOptions
              : null;
    const language =
      qType === "codigo" || qType === "codigo_zip"
        ? qLanguage
        : qType === "java_gui"
          ? "java"
          : qType === "python_gui"
            ? "python"
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
      toast.success(
        i18n.t("toast.modules_workshops_WorkshopQuestions.questionUpdated", {
          defaultValue: "Pregunta actualizada",
        }),
      );
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
            : qType === "python_gui"
              ? PYTHON_GUI_STARTER
              : qType === "codigo"
                ? getStarterCode(language) || null
                : null,
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(
        i18n.t("toast.modules_workshops_WorkshopQuestions.questionAdded", {
          defaultValue: "Pregunta agregada — puedes continuar añadiendo",
        }),
      );
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
      title: t("hc_modulesWorkshopsWorkshopQuestions.deleteQuestionTitle"),
      description: t("hc_modulesWorkshopsWorkshopQuestions.deleteQuestionDescription"),
      confirmLabel: t("hc_modulesWorkshopsWorkshopQuestions.deleteConfirmLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("workshop_questions").delete().eq("id", id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.modules_workshops_WorkshopQuestions.questionDeleted", {
        defaultValue: "Pregunta eliminada",
      }),
    );
    load();
  };

  const generateWithAI = async () => {
    if (!aiTopics.trim()) {
      toast.error(
        i18n.t("toast.modules_workshops_WorkshopQuestions.indicateTopics", {
          defaultValue: "Indica los temas",
        }),
      );
      return;
    }
    const validRows = aiRows.filter((r) => r.count > 0);
    if (!validRows.length)
      return toast.error(
        i18n.t("toast.modules_workshops_WorkshopQuestions.configureAtLeastOneType", {
          defaultValue: "Configura al menos un tipo con cantidad > 0",
        }),
      );

    // ── red_consola: generación LOCAL determinista (sin IA) ──
    // Estas preguntas se arman client-side con plantillas de escenario
    // (topología + aserciones auto-calificables); NO llaman al modelo ni pasan
    // por el gate/cola de IA. Se insertan directo. El resto de tipos sigue el
    // flujo normal por el edge / cola.
    const networkRows = validRows.filter((r) => r.type === "red_consola" || r.type === "red_gui");
    const aiTargetRows = validRows.filter((r) => r.type !== "red_consola" && r.type !== "red_gui");
    if (networkRows.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbNet = supabase as any;
      let pos = questions.length;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toInsert: any[] = [];
      for (const row of networkRows) {
        for (const gen of generateNetworkQuestions(aiTopics, row.count)) {
          toInsert.push({
            workshop_id: workshopId,
            type: row.type,
            content: gen.content,
            expected_rubric: gen.expected_rubric,
            options: gen.options,
            points: gen.points,
            position: pos++,
            language: null,
          });
        }
      }
      const { error: netErr } = await dbNet.from("workshop_questions").insert(toInsert);
      if (netErr) {
        toast.error(friendlyError(netErr, t("hc_modulesWorkshopsWorkshopQuestions.couldNotQueueGeneration")));
      } else {
        toast.success(
          i18n.t("toast.modules_workshops_WorkshopQuestions.networkQuestionsGenerated", {
            defaultValue: "{{count}} pregunta(s) de Red (consola) generadas",
            count: toInsert.length,
          }),
        );
      }
    }
    // Refresca ya las preguntas de red insertadas — aunque el flujo de IA para
    // el resto se cancele o vaya a cola, las de red YA están creadas y deben verse.
    if (networkRows.length) load();
    // Si SOLO había filas red_consola/red_gui, ya terminamos (sin tocar la IA).
    if (aiTargetRows.length === 0) {
      setAiTopics("");
      return;
    }

    // El gate evalúa: modo sync / código de IA inmediata activo / async.
    // allowQueue=true → si el docente está en async sin código, en lugar
    // de bloquear, el gate retorna 'proceed-async' y nosotros encolamos
    // a `ai_generation_queue` (mig 20260603070000). El docente puede
    // procesarlos después desde el panel de Cola IA cuando tenga
    // código activo, o un admin los puede ejecutar por él.
    const decision = await aiGate.ensureAuthorized({ allowQueue: true });
    if (decision === "cancel") return;
    if (decision === "proceed-async") {
      // Encolar todas las filas de generación pendientes. UNA fila de
      // cola por cada tipo solicitado (codigo java, abierta x5, etc).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny3 = supabase as any;
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) {
        toast.error(
          i18n.t("toast.modules_workshops_WorkshopQuestions.notAuthenticated", {
            defaultValue: "No autenticado",
          }),
        );
        return;
      }
      const rows = aiTargetRows.map((row) => ({
        kind: "workshop_questions",
        invoke_target: "ai-generate-questions",
        source_table: "workshops",
        source_id: workshopId,
        course_id: courseId ?? null,
        created_by: user.user!.id,
        body: {
          topics: aiTopics,
          type: row.type,
          count: row.count,
          examId: workshopId,
          language: row.type === "codigo" ? row.language : undefined,
          courseLanguage,
          targetTable: "workshop_questions",
        },
      }));
      const { error: enqErr } = await dbAny3.from("ai_generation_queue").insert(rows);
      if (enqErr) {
        toast.error(
          friendlyError(enqErr, t("hc_modulesWorkshopsWorkshopQuestions.couldNotQueueGeneration")),
        );
        return;
      }
      toast.success(
        i18n.t("toast.modules_workshops_WorkshopQuestions.generationJobsQueued", {
          defaultValue:
            "{{count}} job{{plural}} de generación encolados. Cuando tengas un código de IA inmediata o un administrador los procese, las preguntas aparecerán automáticamente. Puedes verlos en el panel de Cola IA.",
          count: rows.length,
          plural: rows.length === 1 ? "" : "s",
        }),
      );
      setAiTopics("");
      return;
    }
    setAiLoading(true);
    let totalInserted = 0;
    try {
      for (const row of aiTargetRows) {
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
          toast.error(
            i18n.t("toast.modules_workshops_WorkshopQuestions.errorInType", {
              defaultValue: "Error en {{type}}: {{detail}}",
              type: row.type,
              detail:
                detail ||
                i18n.t("toast.modules_workshops_WorkshopQuestions.unknownError", {
                  defaultValue: "Error desconocido",
                }),
            }),
          );
        } else {
          totalInserted += data?.inserted?.length ?? 0;
        }
      }
      if (totalInserted > 0) {
        toast.success(
          i18n.t("toast.modules_workshops_WorkshopQuestions.questionsGenerated", {
            defaultValue: "{{count}} pregunta{{plural}} generadas",
            count: totalInserted,
            plural: totalInserted !== 1 ? "s" : "",
          }),
        );
        setAiTopics("");
        void logEvent({
          action: "ai_questions.generated",
          category: "grading",
          severity: "info",
          entityType: "workshop",
          entityId: workshopId,
          metadata: { total: totalInserted, types: aiTargetRows.map((r) => r.type) },
        });
      }
      load();
    } catch (e: any) {
      toast.error(friendlyError(e, t("hc_modulesWorkshopsWorkshopQuestions.aiError")));
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {aiLoading && (
        <LoadingOverlay
          title={t("workshopQuestions.aiLoadingTitle")}
          subtitle={t("workshopQuestions.aiLoadingSubtitle")}
        />
      )}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList>
          <TabsTrigger value="list">{t("workshopQuestions.tabList", { count: questions.length })}</TabsTrigger>
          <TabsTrigger value="manual">
            {editingId ? t("workshopQuestions.tabEditQuestion") : t("workshopQuestions.tabManual")}
          </TabsTrigger>
          <TabsTrigger value="ai">{t("workshopQuestions.tabAi")}</TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="space-y-2">
          {loading && (
            <p className="text-sm text-muted-foreground">
              <Spinner size="xs" inline className="mr-1" /> {t("workshopQuestions.loadingQuestions")}
            </p>
          )}
          {!loading && questions.length === 0 && (
            <p className="text-sm text-muted-foreground">{t("workshopQuestions.noQuestions")}</p>
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
                    label={t("workshopQuestions.rowActionMoveUp")}
                    icon={ChevronUp}
                    disabled={idx === 0}
                    onClick={() => moveQ(q.id, "up")}
                  />
                  <RowAction
                    label={t("workshopQuestions.rowActionMoveDown")}
                    icon={ChevronDown}
                    disabled={idx === questions.length - 1}
                    onClick={() => moveQ(q.id, "down")}
                  />
                  <RowAction
                    label={t("workshopQuestions.rowActionEdit")}
                    icon={Pencil}
                    onClick={() => loadIntoForm(q)}
                  />
                  <RowAction
                    label={t("workshopQuestions.rowActionDelete")}
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
                  {t("hc_modulesWorkshopsWorkshopQuestions.savedQuestionsSummary", {
                    count: questions.length,
                    plural: questions.length !== 1 ? "s" : "",
                    points: questions.reduce((s, q) => s + (q.points ?? 0), 0),
                  })}
                </span>
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => setActiveTab("list")}
                >
                  {t("hc_modulesWorkshopsWorkshopQuestions.viewList")}
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
                    {t("workshopQuestions.moreItems", { n: questions.length - 9 })}
                  </span>
                )}
              </div>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label required>{t("workshopQuestions.labelType")}</Label>
              <Select value={qType} onValueChange={(v) => setQType(v as any)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="abierta">{t("workshopQuestions.typeOpen")}</SelectItem>
                  <SelectItem value="cerrada">{t("workshopQuestions.typeClosedSingle")}</SelectItem>
                  <SelectItem value="cerrada_multi">{t("workshopQuestions.typeClosedSingle")}</SelectItem>
                  <SelectItem value="codigo">{t("workshopQuestions.typeCode")}</SelectItem>
                  <SelectItem value="diagrama">{t("workshopQuestions.typeDiagramMermaid")}</SelectItem>
                  <SelectItem value="java_gui">{t("workshopQuestions.typeJavaGui")}</SelectItem>
                  <SelectItem value="python_gui">{t("workshopQuestions.typePythonGui")}</SelectItem>
                  <SelectItem value="codigo_zip">{t("workshopQuestions.typeCodeZip")}</SelectItem>
                  <SelectItem value="red_consola">
                    {t("workshopQuestions.typeNetworkConsole", { defaultValue: "Red (consola)" })}
                  </SelectItem>
                  <SelectItem value="red_gui">
                    {t("workshopQuestions.typeNetworkGui", { defaultValue: "Red (diagrama)" })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label required>{t("workshopQuestions.labelPoints")}</Label>
              <Input
                type="number"
                min={0}
                value={qPoints || ""}
                onChange={(e) => setQPoints(e.target.value === "" ? 0 : Number(e.target.value))}
              />
            </div>
          </div>
          <div>
            <Label required>{t("workshopQuestions.labelStatement")}</Label>
            <Textarea
              value={qContent}
              onChange={(e) => setQContent(e.target.value)}
              rows={3}
              placeholder={t("workshopQuestions.placeholderStatement")}
            />
          </div>
          {qType === "cerrada" && (
            <div className="space-y-2">
              <Label required>{t("workshopQuestions.labelOptions")}</Label>
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
                    placeholder={t("hc_modulesWorkshopsWorkshopQuestions.optionPlaceholder", {
                      letter: String.fromCharCode(65 + i),
                    })}
                  />
                </div>
              ))}
            </div>
          )}
          {qType === "cerrada_multi" && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label required>{t("workshopQuestions.labelOptionsMulti")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("workshopQuestions.proportionalScore")}
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
                      placeholder={t("hc_modulesWorkshopsWorkshopQuestions.optionPlaceholder", {
                        letter: String.fromCharCode(65 + i),
                      })}
                    />
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>{t("workshopQuestions.labelMinSelected")}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={qMinSelections === "" ? "" : qMinSelections}
                    onChange={(e) =>
                      setQMinSelections(e.target.value === "" ? "" : Number(e.target.value))
                    }
                    placeholder={t("workshopQuestions.placeholderNoMin")}
                  />
                </div>
                <div>
                  <Label>{t("workshopQuestions.labelMaxSelected")}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={qMaxSelections === "" ? "" : qMaxSelections}
                    onChange={(e) =>
                      setQMaxSelections(e.target.value === "" ? "" : Number(e.target.value))
                    }
                    placeholder={t("workshopQuestions.placeholderNoMax")}
                  />
                </div>
              </div>
            </div>
          )}
          {qType === "codigo" && (
            <div>
              <Label required>{t("workshopQuestions.labelLanguage")}</Label>
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
                {t("workshopQuestions.labelFramework")}
                <HelpHint><span dangerouslySetInnerHTML={{ __html: t("help.workshopJavaFrameworkHelp") }} /></HelpHint>
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
                  ? t("workshopQuestions.javaFxWarning")
                  : t("workshopQuestions.swingCompat")}
              </p>
            </div>
          )}
          {qType === "codigo_zip" && (
            <div className="space-y-3">
              <div>
                <Label required className="flex items-center gap-1.5">
                  {t("hc_modulesWorkshopsWorkshopQuestions.languageLabel")}
                  <HelpHint>{t("help.codigoZipLanguageWhitelist")}</HelpHint>
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
                    {t("workshopQuestions.labelZipSingleMode")}
                    <HelpHint><span dangerouslySetInnerHTML={{ __html: t("help.codigoZipSingleModeToggle") }} /></HelpHint>
                  </Label>
                  <p className="text-[11px] text-muted-foreground">
                    {qZipSingle
                      ? t("workshopQuestions.zipSingleOn")
                      : t("workshopQuestions.zipSingleOff")}
                  </p>
                </div>
                <Switch checked={qZipSingle} onCheckedChange={setQZipSingle} />
              </div>
            </div>
          )}
          {(qType === "red_consola" || qType === "red_gui") && (
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                {t("workshopQuestions.networkScenarioLabel", { defaultValue: "Escenario de red (JSON)" })}
                <HelpHint>
                  {t("workshopQuestions.networkScenarioHint", {
                    defaultValue:
                      "Define la topología (devices/links), targetDeviceId (el dispositivo que configura el alumno) y assertions (rúbrica auto-calificada: hostname, interface_ip, interface_up, connectivity, command_used). El alumno resuelve desde una consola tipo IOS.",
                  })}
                </HelpHint>
              </Label>
              <Textarea
                value={qNetworkScenario}
                onChange={(e) => setQNetworkScenario(e.target.value)}
                rows={12}
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setQNetworkScenario(JSON.stringify(defaultScenario(), null, 2))}
              >
                {t("workshopQuestions.networkResetTemplate", { defaultValue: "Restablecer plantilla" })}
              </Button>
            </div>
          )}
          <div>
            <Label required>{t("workshopQuestions.labelRubric")}</Label>
            <Textarea
              value={qRubric}
              onChange={(e) => setQRubric(e.target.value)}
              rows={2}
              placeholder={t("workshopQuestions.placeholderRubric")}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={submitManual}>
              {editingId ? (
                <>
                  <Save className="h-4 w-4 mr-1" /> {t("workshopQuestions.btnSaveChanges")}
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-1" /> {t("workshopQuestions.btnAddQuestion")}
                </>
              )}
            </Button>
            {!editingId && workshopCourseId && (
              <Button variant="outline" onClick={() => setBankDialogOpen(true)}>
                <Library className="h-4 w-4 mr-1" /> {t("workshopQuestions.btnImportBank")}
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
                <X className="h-4 w-4 mr-1" /> {t("workshopQuestions.btnCancelEdit")}
              </Button>
            )}
          </div>
        </TabsContent>

        <TabsContent value="ai" className="space-y-4">
          <div>
            <Label required>{t("workshopQuestions.labelTopics")}</Label>
            <Textarea
              value={aiTopics}
              onChange={(e) => setAiTopics(e.target.value)}
              rows={3}
              placeholder={t("workshopQuestions.placeholderTopics")}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("workshopQuestions.labelQuestionTypes")}</Label>
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
                      <SelectItem value="abierta">{t("workshopQuestions.typeOpen")}</SelectItem>
                      <SelectItem value="cerrada">{t("workshopQuestions.typeClosedSingle")}</SelectItem>
                      <SelectItem value="codigo">{t("workshopQuestions.typeCode")}</SelectItem>
                      <SelectItem value="diagrama">{t("workshopQuestions.typeDiagram")}</SelectItem>
                      <SelectItem value="java_gui">{t("workshopQuestions.typeJavaGuiShort")}</SelectItem>
                      <SelectItem value="python_gui">{t("workshopQuestions.typePythonGui")}</SelectItem>
                      <SelectItem value="red_consola">
                        {t("workshopQuestions.typeNetworkConsole", { defaultValue: "Red (consola)" })}
                      </SelectItem>
                      <SelectItem value="red_gui">
                        {t("workshopQuestions.typeNetworkGui", { defaultValue: "Red (diagrama)" })}
                      </SelectItem>
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
              <Plus className="h-4 w-4 mr-1" /> {t("workshopQuestions.btnAddType")}
            </Button>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t("workshopQuestions.totalQuestions", { count: aiRows.reduce((s, r) => s + (r.count || 0), 0) })}
            </span>
            <Button onClick={generateWithAI} disabled={aiLoading}>
              {aiLoading ? (
                <Spinner size="md" className="mr-1" />
              ) : (
                <Sparkles className="h-4 w-4 mr-1" />
              )}
              {t("workshopQuestions.btnGenerateAi")}
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
  // `lastSubmissionGraded` distingue "intento gastado" (graded) de
  // "todavía editando el mismo intento" (no graded) — el submit solo
  // bloquea cuando el cap se alcanzó Y la entrega previa fue
  // calificada. ai_grade poblado sin final_grade NO cuenta como
  // calificada (la IA dio una sugerencia, no el docente la fijó).
  const [attemptCount, setAttemptCount] = useState<number>(0);
  const [effectiveMaxAttempts, setEffectiveMaxAttempts] = useState<number>(1);
  const [lastSubmissionGraded, setLastSubmissionGraded] = useState<boolean>(false);
  const attemptsExhausted = attemptCount >= effectiveMaxAttempts && lastSubmissionGraded;
  const attemptsRemaining = lastSubmissionGraded
    ? Math.max(0, effectiveMaxAttempts - attemptCount)
    : Math.max(1, effectiveMaxAttempts - attemptCount); // +1 reedit free
  // Track which workshopId we have already loaded so that auth refresh
  // events (TOKEN_REFRESHED on tab refocus) don't re-fetch and visually
  // "reload" the modal while the student is mid-submission.
  const loadedForRef = useRef<string | null>(null);

  // Ejecución de código en vivo para preguntas tipo `codigo` (paridad con
  // el exam taker). El estudiante corre el código contra el runner remoto
  // (edge `execute-code`) o CheerpJ para Java. Estado por pregunta.
  const [codeOutputs, setCodeOutputs] = useState<Record<string, string>>({});
  const [runningCode, setRunningCode] = useState<Record<string, boolean>>({});
  const [runnerOverride, setRunnerOverride] = useState<Record<string, string>>({});
  // Provider efectivo: en un ref para leerlo síncrono dentro de runCode sin
  // re-render; en state para que el picker muestre la etiqueta "(default)".
  const codeExecProviderRef = useRef<string>("onlinecompiler");
  const [defaultCodeProvider, setDefaultCodeProvider] = useState<string>("onlinecompiler");
  // AbortController por pregunta — cancelRun libera la UI sin esperar al
  // worker remoto (que sigue corriendo server-side).
  const runAbortersRef = useRef<Record<string, AbortController>>({});
  // ID de la submission actual (solo metadata de audit para execute-code).
  // null si el alumno nunca entregó — el edge lo ignora si falta.
  const submissionIdRef = useRef<string | null>(null);

  // Carga el provider global de ejecución de código (lo configura el Admin).
  // Fire-and-forget igual que el exam taker: solo setea state simple.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("code_execution_settings")
      .select("provider")
      .eq("is_active", true)
      .maybeSingle()
      .then(({ data }: { data: { provider: string } | null }) => {
        if (data?.provider) {
          codeExecProviderRef.current = data.provider;
          setDefaultCodeProvider(data.provider);
        }
      });
  }, []);

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
      const subRowHydrate = sub as {
        id?: string;
        attempt_count?: number;
        status?: string;
        final_grade?: number | null;
      } | null;
      setAttemptCount(Number(subRowHydrate?.attempt_count ?? 0));
      setLastSubmissionGraded(
        subRowHydrate != null &&
          (subRowHydrate.status === "calificado" || subRowHydrate.final_grade != null),
      );
      if (sub?.id) {
        // Metadata de audit para execute-code (no FK; el edge la ignora si falta).
        submissionIdRef.current = sub.id;
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

  // Escenarios de red parseados y ESTABLES (memoizados por questions) — pasar
  // un objeto nuevo en cada render reiniciaría la NetworkConsole (su init está
  // keyed por identidad del scenario).
  const networkScenarios = useMemo(() => {
    const map: Record<string, NetworkScenario> = {};
    for (const q of questions) {
      if (q.type === "red_consola" || q.type === "red_gui") {
        const s = parseScenario(q.options);
        if (s) map[q.id] = s;
      }
    }
    return map;
  }, [questions]);

  /** Cancela un run en curso para `questionId`. No mata el worker remoto
   *  (CheerpJ no expone API; el edge ya está corriendo server-side), pero
   *  libera el botón "Ejecutar" para que el estudiante pueda cambiar de
   *  compilador y reintentar sin esperar. */
  const cancelRun = (questionId: string) => {
    const controller = runAbortersRef.current[questionId];
    if (!controller) return;
    controller.abort();
    delete runAbortersRef.current[questionId];
    setRunningCode((prev) => ({ ...prev, [questionId]: false }));
    toast.info(
      i18n.t("toast.routes_app_student_take_examId.executionCancelled", {
        defaultValue: "Ejecución cancelada. Puedes cambiar de compilador y reintentar.",
      }),
    );
  };

  const runCode = async (questionId: string, language: CodeLanguage) => {
    const code = typeof answers[questionId] === "string" ? (answers[questionId] as string) : "";
    if (!code.trim()) {
      toast.error(
        i18n.t("toast.routes_app_student_take_examId.writeCodeBeforeRunning", {
          defaultValue: "Escribe código antes de ejecutar",
        }),
      );
      return;
    }
    // Provider efectivo = override del estudiante para esta pregunta, o el
    // default global. `cheerp` solo aplica a Java (corre client-side via
    // WebAssembly); para otros lenguajes con `cheerp` caemos al edge.
    const overrideForQuestion = runnerOverride[questionId];
    const provider = overrideForQuestion ?? codeExecProviderRef.current;

    // Cancela cualquier run previo de esta misma pregunta (defensive — el
    // doble click ya lo previene `disabled={isRunning}`, pero el cleanup es barato).
    runAbortersRef.current[questionId]?.abort();
    const controller = new AbortController();
    runAbortersRef.current[questionId] = controller;
    const { signal } = controller;

    setRunningCode((prev) => ({ ...prev, [questionId]: true }));
    // Limpia el output ANTES de ejecutar para que no se vea el resultado
    // del run anterior mientras espera el nuevo.
    setCodeOutputs((prev) => ({ ...prev, [questionId]: "" }));
    try {
      let stdout = "";
      let stderr = "";

      if (provider === "cheerp" && language === "java") {
        // CheerpJ: ejecuta Java directamente en el navegador (sin API externa ni cuota).
        const result = await runJavaInBrowser(code, signal);
        stdout = result.stdout;
        stderr = result.stderr;
      } else {
        // Carrera entre el invoke y un promise que rechaza al abortar. El
        // invoke sigue server-side hasta que el provider responda, pero la
        // UI ya quedó libre. Trade-off aceptable.
        const cancelPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error(CANCELLED_SENTINEL));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error(CANCELLED_SENTINEL)), {
            once: true,
          });
        });
        const invokePromise = supabase.functions.invoke("execute-code", {
          body: {
            sourceCode: code,
            language,
            questionId,
            submissionId: submissionIdRef.current,
            // Solo mandamos `provider` cuando el estudiante eligió un
            // override. Sin override, el edge usa el default del admin.
            ...(overrideForQuestion ? { provider: overrideForQuestion } : {}),
          },
        });
        const { data, error } = await (Promise.race([invokePromise, cancelPromise]) as Promise<
          Awaited<typeof invokePromise>
        >);
        if (error) {
          // Extraemos el mensaje REAL del response body, no el genérico
          // "Edge Function returned a non-2xx status code".
          const real = await extractEdgeError(error, data);
          throw new Error(real || t("hc_modulesWorkshopsWorkshopQuestions.errorRunningCode"));
        }
        stdout = data?.stdout ?? "";
        stderr = data?.stderr ?? "";
      }

      // Defense-in-depth: si el provider devolvió el mensaje opaco genérico
      // sin detalle útil, lo reemplazamos por una pista accionable (el edge
      // ya lo hace server-side; lo duplicamos por si no está redesplegado).
      const opaqueRe = /^\s*(internal\s+)?error:\s*code execution failed\.?\s*$/i;
      if (opaqueRe.test(stdout)) stdout = "";
      if (opaqueRe.test(stderr)) stderr = "";
      if (!stdout.trim() && !stderr.trim()) {
        stderr = t("hc_modulesWorkshopsWorkshopQuestions.remoteCompilerNoDetail");
      }

      // Combinar stdout + stderr en el orden natural de terminal.
      const parts: string[] = [];
      if (stdout.trimEnd()) parts.push(stdout.trimEnd());
      if (stderr.trimEnd()) parts.push(stderr.trimEnd());
      const output = parts.join("\n") || t("hc_modulesWorkshopsWorkshopQuestions.noOutput");
      setCodeOutputs((prev) => ({ ...prev, [questionId]: output }));
    } catch (e: unknown) {
      const msg =
        e instanceof Error ? e.message : t("hc_modulesWorkshopsWorkshopQuestions.errorRunning");
      // Cancelación por el usuario: NO mostramos error ni loggeamos. La UI
      // ya quedó libre por cancelRun; aquí solo silenciamos el catch.
      if (msg === CANCELLED_SENTINEL) {
        return;
      }
      setCodeOutputs((prev) => ({
        ...prev,
        [questionId]: t("hc_modulesWorkshopsWorkshopQuestions.errorPrefix", { msg }),
      }));
      void logEvent({
        action: "code_execution_error",
        category: "workshop",
        severity: "error",
        entityType: "submission",
        entityId: submissionIdRef.current ?? undefined,
        metadata: {
          workshopId,
          questionId,
          language,
          provider,
          default_provider: codeExecProviderRef.current,
          provider_overridden: !!overrideForQuestion,
          error: msg,
        },
      });
    } finally {
      // Solo limpiamos el aborter si sigue siendo el nuestro (cancelRun ya
      // lo borró, u otro run en paralelo sobrescribió el slot).
      if (runAbortersRef.current[questionId] === controller) {
        delete runAbortersRef.current[questionId];
      }
      setRunningCode((prev) => ({ ...prev, [questionId]: false }));
    }
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
      } else if (q.type === "red_consola" || q.type === "red_gui") {
        // Vacía si no hay respuesta parseable (sin comandos en consola / sin
        // topología editada en GUI).
        isBlank = !parseNetworkAnswer(a);
      } else if (q.type === "so_consola") {
        // Vacía si no interactuó con la consola Linux (sin comandos ni salida).
        isBlank = isV86AnswerBlank(a);
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
      toast.error(
        i18n.t("toast.modules_workshops_WorkshopQuestions.workshopHasNoQuestions", {
          defaultValue: "Este taller no tiene preguntas",
        }),
      );
      return;
    }
    if (videoGateBlocking) {
      toast.error(
        i18n.t("toast.modules_workshops_WorkshopQuestions.mustWatchIntroVideos", {
          defaultValue: "Debes ver todos los videos introductorios antes de entregar.",
        }),
      );
      return;
    }
    // Si el alumno deja preguntas sin responder, pedimos confirmación
    // explícita usando el ConfirmDialog del design system. Las preguntas
    // vacías reciben 0 puntos (ya lo manejaba el bucle de abajo); el
    // modal evita que el alumno entregue sin darse cuenta.
    const unanswered = getUnansweredNumbers();
    if (unanswered.length > 0) {
      const ok = await confirm({
        title: t("hc_modulesWorkshopsWorkshopQuestions.unansweredTitle", {
          count: unanswered.length,
          plural: unanswered.length === 1 ? "" : "s",
        }),
        description: (
          <div className="space-y-1">
            <p>
              {t("hc_modulesWorkshopsWorkshopQuestions.unansweredListLabel")}{" "}
              <span className="font-medium text-foreground">
                {unanswered.map((n) => `#${n}`).join(", ")}
              </span>
              .
            </p>
            <p>{t("hc_modulesWorkshopsWorkshopQuestions.unansweredZeroPoints")}</p>
          </div>
        ),
        confirmLabel: t("hc_modulesWorkshopsWorkshopQuestions.submitAnyway"),
        cancelLabel: t("hc_modulesWorkshopsWorkshopQuestions.keepAnswering"),
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
          i18n.t("toast.modules_workshops_WorkshopQuestions.attemptsExhausted", {
            defaultValue:
              "Ya consumiste tus {{count}} intento{{plural}} de entrega. Recarga para ver la entrega actual.",
            count: effectiveMaxAttempts,
            plural: effectiveMaxAttempts === 1 ? "" : "s",
          }),
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
          toast.error(
            friendlyError(
              error,
              t("hc_modulesWorkshopsWorkshopQuestions.couldNotCreateSubmission"),
            ),
          );
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
        /** Solo aplica a type='java_gui'. Determina la rúbrica esperada
         *  por la IA (Swing vs JavaFX). Persistido en q.options. */
        framework?: string | null;
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
        if (q.type === "codigo" || q.type === "java_gui" || q.type === "python_gui")
          payload.code_content = String(raw);
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
          payload.ai_feedback =
            got > 0
              ? t("hc_modulesWorkshopsWorkshopQuestions.feedbackCorrect")
              : t("hc_modulesWorkshopsWorkshopQuestions.feedbackIncorrect");
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
              payload.ai_feedback = t("hc_modulesWorkshopsWorkshopQuestions.noZipSubmitted");
              breakdown.push({
                qid: q.id,
                type: q.type,
                points: q.points,
                earned: 0,
                feedback: payload.ai_feedback,
              });
            } else if (zipFile.size > MAX_CODE_FILES_TOTAL_BYTES) {
              payload.ai_grade = 0;
              payload.ai_feedback = t("hc_modulesWorkshopsWorkshopQuestions.zipExceedsLimit", {
                size: formatFileSize(zipFile.size),
              });
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
                  payload.ai_feedback = t(
                    "hc_modulesWorkshopsWorkshopQuestions.errorUploadingZip",
                    { message: upErr.message },
                  );
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
                      payload.ai_feedback =
                        detail || t("hc_modulesWorkshopsWorkshopQuestions.aiErrorGradingZip");
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
                      const fb =
                        (aiData as any)?.feedback ??
                        t("hc_modulesWorkshopsWorkshopQuestions.noFeedback");
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
              payload.ai_feedback = t("hc_modulesWorkshopsWorkshopQuestions.noCodeFilesSubmitted");
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
                const more =
                  violations.length > 5
                    ? t("hc_modulesWorkshopsWorkshopQuestions.andMoreSuffix", {
                        n: violations.length - 5,
                      })
                    : "";
                const allowedLabel = (allowedExts ?? []).map((e) => `.${e}`).join(", ");
                payload.ai_grade = 0;
                payload.ai_feedback = t(
                  "hc_modulesWorkshopsWorkshopQuestions.filesNotAllowedFeedback",
                  { sample, more, allowed: allowedLabel },
                );
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
                payload.ai_feedback = t(
                  "hc_modulesWorkshopsWorkshopQuestions.totalExceedsLimit",
                  { size: formatFileSize(totalBytes) },
                );
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
                payload.ai_feedback = t(
                  "hc_modulesWorkshopsWorkshopQuestions.tooManyFilesFeedback",
                  { count: filesArr.length, max: MAX_CODE_FILES_COUNT },
                );
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
                  payload.ai_feedback = t(
                    "hc_modulesWorkshopsWorkshopQuestions.errorUploadingFiles",
                    { count: upFailed.length, message: upFailed[0].error?.message ?? "" },
                  );
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
                      payload.ai_feedback =
                        detail || t("hc_modulesWorkshopsWorkshopQuestions.aiErrorGradingFiles");
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
                      const fb =
                        (aiData as any)?.feedback ??
                        t("hc_modulesWorkshopsWorkshopQuestions.noFeedback");
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
            ? t("hc_modulesWorkshopsWorkshopQuestions.markedTooManyOptions", {
                max: (q.options as any)?.max_selections,
              })
            : result.belowMin
              ? t("hc_modulesWorkshopsWorkshopQuestions.markedTooFewOptions", {
                  min: (q.options as any)?.min_selections,
                })
              : selectedArr.length === 0
                ? t("hc_modulesWorkshopsWorkshopQuestions.noAnswer")
                : t("hc_modulesWorkshopsWorkshopQuestions.earnedOfPoints", {
                    earned: result.earned,
                    points: q.points,
                  });
          totalEarned += result.earned;
          breakdown.push({
            qid: q.id,
            type: q.type,
            points: q.points,
            earned: result.earned,
            feedback: payload.ai_feedback,
          });
        } else if (q.type === "red_consola" || q.type === "red_gui") {
          // Calificación DETERMINISTA (sin IA): parsea la topología final del
          // alumno + su historial y evalúa las aserciones del escenario del
          // docente (options.network). No entra al batch de IA. Igual para
          // consola (comandos) y GUI (topología editada) — ambas producen
          // el mismo modelo Topology.
          const scenario = parseScenario(q.options);
          const answer = parseNetworkAnswer(raw);
          const maxPoints = Number(q.points) || 0;
          if (!scenario || !answer) {
            payload.ai_grade = 0;
            payload.ai_feedback = t("hc_modulesWorkshopsWorkshopQuestions.noAnswer");
            breakdown.push({
              qid: q.id,
              type: q.type,
              points: q.points,
              earned: 0,
              feedback: t("hc_modulesWorkshopsWorkshopQuestions.noAnswer"),
            });
          } else {
            // Aislar: una respuesta de red malformada no debe romper la
            // calificación de toda la entrega.
            let earned = 0;
            let fb = i18n.t("toast.modules_workshops_WorkshopQuestions.networkGraded", {
              defaultValue: "Calificación de red",
            });
            try {
              const result = gradeNetwork(
                { topology: answer.topology, histories: answer.histories },
                scenario.assertions,
              );
              earned = Math.round(result.ratio * maxPoints * 100) / 100;
              fb =
                result.items
                  .map(
                    (it) =>
                      `${it.passed ? "✓" : "✗"} ${it.label}${it.detail ? ` — ${it.detail}` : ""}`,
                  )
                  .join("\n") || fb;
            } catch (netErr) {
              earned = 0;
              fb = `Error al evaluar la respuesta de red: ${netErr instanceof Error ? netErr.message : String(netErr)}`;
            }
            payload.ai_grade = earned;
            payload.ai_feedback = fb;
            totalEarned += earned;
            breakdown.push({ qid: q.id, type: q.type, points: q.points, earned, feedback: fb });
          }
        } else if (q.type === "so_consola") {
          // Consola Linux REAL (v86): NO se auto-califica por estado — un VM real
          // no se introspecciona como el simulador. Queda pendiente de revisión
          // del docente sobre el transcript de la sesión (guardado en answer_text).
          const pendingFb = t("hc_modulesWorkshopsWorkshopQuestions.serverConsoleManual", {
            defaultValue:
              "Consola Linux real — requiere revisión del docente sobre el transcript de la sesión.",
          });
          payload.ai_grade = 0;
          payload.ai_feedback = pendingFb;
          breakdown.push({ qid: q.id, type: q.type, points: q.points, earned: 0, feedback: pendingFb });
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
            payload.ai_feedback = t("hc_modulesWorkshopsWorkshopQuestions.noAnswer");
            breakdown.push({
              qid: q.id,
              type: q.type,
              points: q.points,
              earned: 0,
              feedback: t("hc_modulesWorkshopsWorkshopQuestions.noAnswer"),
            });
          } else {
            // Abierta con respuesta → bucket para batch. NO empujamos a
            // breakdown todavía; se completa después con el resultado IA.
            // Antes remapeábamos java_gui → "codigo" + language="java",
            // pero el batch grader perdía el contexto de framework
            // (Swing vs JavaFX) y calificaba como si fuera código de
            // consola. Ahora pasamos el type real + framework de
            // q.options para que la IA aplique la rúbrica correcta.
            const opts = (q.options as { java_framework?: string } | null) ?? null;
            batchItems.push({
              qid: q.id,
              type: q.type,
              content: String(q.content ?? ""),
              rubric: String(q.expected_rubric ?? ""),
              userAnswer: String(raw),
              maxPoints: Number(q.points) || 0,
              language:
                q.type === "java_gui" ? "java" : q.type === "python_gui" ? "python" : q.language,
              framework: q.type === "java_gui" ? (opts?.java_framework ?? "swing") : undefined,
            });
          }
        }
        payloadsByQid[q.id] = payload;
      }

      // Reutilizamos la detección hecha arriba para que el comportamiento
      // sea consistente entre `codigo_zip` (loop) y `batchItems` (Fase 2).
      const useAsyncAi = useAsyncAiEarly;
      // Si la IA SÍNCRONA falla (ej. 503 "modelo saturado"), NO le mostramos
      // el error al alumno por pregunta: caemos a la cola (pendiente + job) y
      // tratamos la entrega como async. El worker reintenta (auto-retry
      // transitorio) y al terminar el trigger recalcula la nota.
      let fellBackToQueue = false;

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
        if (batchFailed) {
          // Fallback a la cola: pre-marcar TODAS las abiertas como pendientes
          // (sin nota, sin mostrar el error de IA). Abajo `gradeAsync` encola
          // el job `workshop_full` y deja la entrega en 'entregado'.
          fellBackToQueue = true;
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
        } else {
          const batchResults =
            bData?.results && typeof bData.results === "object"
              ? (bData.results as Record<
                  string,
                  { score: number; feedback: string; ai_likelihood?: number; ai_reasons?: string }
                >)
              : {};
          for (const it of batchItems) {
            const r = batchResults[it.qid];
            const payload = payloadsByQid[it.qid];
            if (r) {
              const earned = Math.max(0, Math.min(it.maxPoints, Number(r.score) || 0));
              payload.ai_grade = earned;
              payload.ai_feedback =
                r.feedback || t("hc_modulesWorkshopsWorkshopQuestions.noFeedback");
              totalEarned += earned;
              breakdown.push({
                qid: it.qid,
                type: it.type,
                points: it.maxPoints,
                earned,
                feedback: payload.ai_feedback,
              });
            } else {
              // El batch respondió OK pero el modelo OMITIÓ esta pregunta.
              // No es un fallo de IA — queda en 0 con nota aclaratoria.
              payload.ai_grade = 0;
              payload.ai_feedback = t(
                "hc_modulesWorkshopsWorkshopQuestions.modelOmittedQuestion",
              );
              breakdown.push({
                qid: it.qid,
                type: it.type,
                points: it.maxPoints,
                earned: 0,
                feedback: payload.ai_feedback,
              });
            }
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

      // El modo "async efectivo" cubre tanto async configurado como el
      // fallback cuando el batch sync falló: en ambos encolamos + dejamos la
      // entrega pendiente.
      const gradeAsync = useAsyncAi || fellBackToQueue;

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
      if (gradeAsync && batchItems.length > 0) {
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
      if (gradeAsync && pendingZipEnqueues.length > 0) {
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

      if (gradeAsync && (batchItems.length > 0 || pendingZipEnqueues.length > 0)) {
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
            ai_feedback: t("hc_modulesWorkshopsWorkshopQuestions.immediateAutoGrade", {
              maxScore,
            }),
            status: "calificado",
          })
          .eq("id", submissionId);

        setGraded({ grade: finalGrade, breakdown });
        onGraded?.(finalGrade);
        toast.success(
          i18n.t("toast.modules_workshops_WorkshopQuestions.gradeResult", {
            defaultValue: "Calificación: {{grade}} / {{maxScore}}",
            grade: finalGrade,
            maxScore,
          }),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">
        <Spinner size="xs" inline className="mr-1" />{" "}
        {t("hc_modulesWorkshopsWorkshopQuestions.loadingQuestions")}
      </p>
    );
  }

  if (!questions.length) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("hc_modulesWorkshopsWorkshopQuestions.workshopNoQuestionsYet")}
      </p>
    );
  }

  if (graded) {
    return (
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-base">
            {t("hc_modulesWorkshopsWorkshopQuestions.workshopResultTitle")}
          </CardTitle>
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
                placeholder={t("hc_modulesWorkshopsWorkshopQuestions.writeYourAnswer")}
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
                      ? t("hc_modulesWorkshopsWorkshopQuestions.hintBetween", {
                          min: minS,
                          max: maxS,
                        })
                      : typeof minS === "number"
                        ? t("hc_modulesWorkshopsWorkshopQuestions.hintAtLeast", { min: minS })
                        : typeof maxS === "number"
                          ? t("hc_modulesWorkshopsWorkshopQuestions.hintAtMost", { max: maxS })
                          : t("hc_modulesWorkshopsWorkshopQuestions.hintAllCorrect");
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
                          {t("hc_modulesWorkshopsWorkshopQuestions.markedMoreThanAllowed", {
                            max: maxS,
                          })}
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
            {q.type === "codigo" &&
              (() => {
                const lang = (q.language ?? "java") as CodeLanguage;
                return (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-end">
                      <CodeRunnerPicker
                        language={lang}
                        defaultProvider={defaultCodeProvider}
                        value={runnerOverride[q.id] as CodeRunnerProvider | undefined}
                        disabled={runningCode[q.id] ?? false}
                        onChange={(next) =>
                          setRunnerOverride((prev) => {
                            const copy = { ...prev };
                            if (next === undefined) delete copy[q.id];
                            else copy[q.id] = next;
                            return copy;
                          })
                        }
                      />
                    </div>
                    <CodeEditor
                      value={answers[q.id] ?? q.starter_code ?? getStarterCode(lang)}
                      onChange={(v) => updateAnswer(q.id, v ?? "")}
                      language={lang}
                      onRun={() => runCode(q.id, lang)}
                      onCancel={() => cancelRun(q.id)}
                      output={codeOutputs[q.id]}
                      isRunning={runningCode[q.id] ?? false}
                      showLanguageSelector={false}
                      showRunButton={true}
                      height="280px"
                    />
                  </div>
                );
              })()}
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
            {q.type === "python_gui" && (
              <PythonGuiRunner
                value={answers[q.id] ?? q.starter_code ?? PYTHON_GUI_STARTER}
                onChange={(v) => updateAnswer(q.id, v)}
                height="280px"
              />
            )}
            {q.type === "red_consola" &&
              (networkScenarios[q.id] ? (
                <NetworkConsole
                  scenario={networkScenarios[q.id]}
                  value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : null}
                  onChange={(v) => updateAnswer(q.id, v)}
                />
              ) : (
                <p className="text-xs text-destructive">
                  {t("hc_modulesWorkshopsWorkshopQuestions.networkScenarioMissing", {
                    defaultValue: "Esta pregunta de red no tiene un escenario válido configurado.",
                  })}
                </p>
              ))}
            {q.type === "red_gui" &&
              (networkScenarios[q.id] ? (
                <NetworkTopologyEditor
                  scenario={networkScenarios[q.id]}
                  value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : null}
                  onChange={(v) => updateAnswer(q.id, v)}
                />
              ) : (
                <p className="text-xs text-destructive">
                  {t("hc_modulesWorkshopsWorkshopQuestions.networkScenarioMissing", {
                    defaultValue: "Esta pregunta de red no tiene un escenario válido configurado.",
                  })}
                </p>
              ))}
            {q.type === "so_consola" && (
              <V86Console
                value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : null}
                onChange={(v) => updateAnswer(q.id, v)}
              />
            )}
            {q.type === "codigo_zip" &&
              q.zip_single &&
              (() => {
                const currentZip: File | null =
                  answers[q.id] instanceof File ? (answers[q.id] as File) : null;
                return (
                  <div className="space-y-2">
                    <div className="rounded-md border border-amber-400/40 bg-amber-500/5 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                      <strong>{t("hc_modulesWorkshopsWorkshopQuestions.zipSingleModeLabel")}</strong>{" "}
                      {t("hc_modulesWorkshopsWorkshopQuestions.zipSingleModeNotice1")}{" "}
                      <code>.zip</code>{" "}
                      {t("hc_modulesWorkshopsWorkshopQuestions.zipSingleModeNotice2")}
                    </div>
                    <input
                      type="file"
                      accept=".zip,application/zip,application/x-zip-compressed"
                      onChange={(e) => {
                        const picked = e.target.files?.[0];
                        if (!picked) return;
                        if (picked.size === 0) {
                          toast.error(
                            i18n.t("toast.modules_workshops_WorkshopQuestions.fileEmpty", {
                              defaultValue: "El archivo está vacío.",
                            }),
                          );
                          e.target.value = "";
                          return;
                        }
                        if (picked.size > MAX_CODE_FILES_TOTAL_BYTES) {
                          toast.error(
                            i18n.t("toast.modules_workshops_WorkshopQuestions.zipTooLarge", {
                              defaultValue:
                                "El ZIP pesa {{size}} y supera el tope de 50 MB.",
                              size: formatFileSize(picked.size),
                            }),
                          );
                          e.target.value = "";
                          return;
                        }
                        if (!picked.name.toLowerCase().endsWith(".zip")) {
                          toast.error(
                            i18n.t("toast.modules_workshops_WorkshopQuestions.onlyZipAccepted", {
                              defaultValue: "Solo se acepta un archivo .zip.",
                            }),
                          );
                          e.target.value = "";
                          return;
                        }
                        e.target.value = "";
                        updateAnswer(q.id, picked);
                      }}
                      className="block w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer hover:file:bg-primary/90"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t("hc_modulesWorkshopsWorkshopQuestions.compressFolderInto")}{" "}
                      <span className="font-mono">.zip</span>.{" "}
                      {t("hc_modulesWorkshopsWorkshopQuestions.limit50Mb")}
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
                            aria-label={t("hc_modulesWorkshopsWorkshopQuestions.removeNamed", {
                              name: currentZip.name,
                            })}
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
                  : t("hc_modulesWorkshopsWorkshopQuestions.sourceCodeFiles");
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
                            const more =
                              bad.length > 5
                                ? t("hc_modulesWorkshopsWorkshopQuestions.andMoreSuffix", {
                                    n: bad.length - 5,
                                  })
                                : "";
                            toast.error(
                              i18n.t(
                                "toast.modules_workshops_WorkshopQuestions.filesNotAllowed",
                                {
                                  defaultValue:
                                    "Archivos no permitidos: {{sample}}{{more}}. Solo se aceptan {{allowed}}.",
                                  sample,
                                  more,
                                  allowed: allowedLabel,
                                },
                              ),
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
                            i18n.t(
                              "toast.modules_workshops_WorkshopQuestions.filesTotalTooLarge",
                              {
                                defaultValue:
                                  "Los archivos suman {{size}} y superan el tope de 50 MB.",
                                size: formatFileSize(totalBytes),
                              },
                            ),
                          );
                          e.target.value = "";
                          return;
                        }
                        if (merged.length > MAX_CODE_FILES_COUNT) {
                          toast.error(
                            i18n.t("toast.modules_workshops_WorkshopQuestions.tooManyFiles", {
                              defaultValue:
                                "Seleccionaste {{count}} archivos. Máximo permitido: {{max}}.",
                              count: merged.length,
                              max: MAX_CODE_FILES_COUNT,
                            }),
                          );
                          e.target.value = "";
                          return;
                        }
                        if (picked.some((f) => f.size === 0)) {
                          toast.error(
                            i18n.t(
                              "toast.modules_workshops_WorkshopQuestions.emptyFilesInSelection",
                              {
                                defaultValue: "Hay archivos vacíos en la selección.",
                              },
                            ),
                          );
                          e.target.value = "";
                          return;
                        }
                        e.target.value = "";
                        updateAnswer(q.id, merged);
                      }}
                      className="block w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-primary file:text-primary-foreground file:cursor-pointer hover:file:bg-primary/90"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t("hc_modulesWorkshopsWorkshopQuestions.uploadSourceFilesIntro")}{" "}
                      <span className="font-mono">{allowedLabel}</span>.{" "}
                      {t("hc_modulesWorkshopsWorkshopQuestions.uploadSourceFilesLimit", {
                        max: MAX_CODE_FILES_COUNT,
                      })}
                    </p>
                    {current.length > 0 && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                          <span>
                            {t("hc_modulesWorkshopsWorkshopQuestions.filesCountSummary", {
                              count: current.length,
                              plural: current.length === 1 ? "" : "s",
                              size: formatFileSize(current.reduce((a, f) => a + f.size, 0)),
                            })}
                          </span>
                          <button
                            type="button"
                            onClick={() => updateAnswer(q.id, [])}
                            className="text-destructive hover:underline"
                          >
                            {t("hc_modulesWorkshopsWorkshopQuestions.removeAll")}
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
                                aria-label={t("hc_modulesWorkshopsWorkshopQuestions.removeNamed", {
                                  name: f.name,
                                })}
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
            {t("hc_modulesWorkshopsWorkshopQuestions.finishWatchingVideos")}
          </p>
        )}
        {/* Intentos restantes color-coded (normal → ámbar 1 restante → rojo
            0 restantes) + aviso. Mismo patrón que el taker de proyectos
            (ProjectFiles): cuando no quedan intentos, el botón "Entregar" se
            deshabilita en vez de mostrarse habilitado y fallar al hacer clic. */}
        <div className="flex items-center justify-center gap-1.5 text-[11px] mb-1">
          <span className="text-muted-foreground">
            {t("hc_modulesWorkshopsWorkshopQuestions.attemptsRemaining")}
          </span>
          <span
            className={`tabular-nums font-medium ${
              attemptsExhausted
                ? "text-destructive"
                : attemptsRemaining === 1
                  ? "text-amber-600 dark:text-amber-400"
                  : "text-foreground"
            }`}
          >
            {attemptsRemaining} / {effectiveMaxAttempts}
          </span>
        </div>
        {attemptsExhausted ? (
          <p className="text-[11px] text-destructive text-center mb-1.5">
            {t("hc_modulesWorkshopsWorkshopQuestions.allAttemptsUsed")}
          </p>
        ) : attemptsRemaining === 1 ? (
          <p className="text-[11px] text-amber-700 dark:text-amber-300 text-center font-medium mb-1.5">
            {effectiveMaxAttempts === 1
              ? t("hc_modulesWorkshopsWorkshopQuestions.warningSingleAttempt")
              : t("hc_modulesWorkshopsWorkshopQuestions.warningOneAttemptLeft")}
          </p>
        ) : null}
        <Button
          onClick={submit}
          disabled={submitting || videoGateBlocking || attemptsExhausted}
          className="w-full"
        >
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
