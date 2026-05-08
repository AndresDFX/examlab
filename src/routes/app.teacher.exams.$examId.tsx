import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { AssignSelector } from "@/components/AssignSelector";
import { DateTimePicker } from "@/components/ui/date-picker";
import { toast } from "sonner";
import {
  Plus,
  Sparkles,
  Trash2,
  CheckSquare,
  XSquare,
  FileText,
  Pencil,
  Save,
  X,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TeacherExamNotes } from "@/components/ExamNotesManager";
import { JAVA_GUI_STARTER } from "@/components/JavaGuiRunner";
import { JAVA_STARTER } from "@/components/CodeEditor";
import { DecimalInput } from "@/components/ui/decimal-input";
import { ExternalGradesEditor } from "@/components/ExternalGradesEditor";
import { RowAction } from "@/components/ui/row-action";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";

export const Route = createFileRoute("/app/teacher/exams/$examId")({ component: ExamEditor });

type Exam = any;
type Question = {
  id: string;
  exam_id: string;
  type: string;
  content: string;
  expected_rubric: string | null;
  options: any;
  points: number;
  position: number;
  language?: string | null;
};
type Student = { id: string; full_name: string; institutional_email: string };

function ExamEditor() {
  const { examId } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [exam, setExam] = useState<Exam | null>(null);
  const [cuts, setCuts] = useState<
    Array<{
      id: string;
      name: string;
      weight: number;
      exam_weight: number;
      workshop_weight: number;
      project_weight: number;
      attendance_weight: number;
    }>
  >([]);
  // Exámenes del MISMO curso para calcular el bucket "exam_weight"
  // disponible: sumamos los weights de los otros exámenes del corte.
  const [examsInCourse, setExamsInCourse] = useState<
    Array<{ id: string; title: string; cut_id: string | null; weight: number }>
  >([]);
  const [cutItems, setCutItems] = useState<
    Array<{
      id: string;
      cut_id: string;
      item_type: string;
      weight: number;
      exam_id: string | null;
      workshop_id: string | null;
      project_id: string | null;
      project_title: string | null;
    }>
  >([]);
  const [examTitlesById, setExamTitlesById] = useState<Record<string, string>>({});
  const [workshopTitlesById, setWorkshopTitlesById] = useState<Record<string, string>>({});
  const [projectTitlesById, setProjectTitlesById] = useState<Record<string, string>>({});
  const [questions, setQuestions] = useState<Question[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  // Lista de cursos a los que el docente puede mover el examen. Se llena
  // al montar el editor. RLS filtra a los cursos del docente; Admin ve
  // todos. Permite cambiar el curso de asignación post-creación.
  const [courses, setCourses] = useState<
    Array<{ id: string; name: string; period: string | null }>
  >([]);
  // Curso original cargado de DB. Si al guardar cambia, hay que limpiar
  // exam_assignments del curso anterior y re-auto-asignar los nuevos
  // matriculados (no se puede dejar enlazados a usuarios que ya no están
  // matriculados en el curso destino).
  const [originalCourseId, setOriginalCourseId] = useState<string | null>(null);

  // New question manual (sirve para crear y editar — UPDATE cuando editingId)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [qType, setQType] = useState("abierta");
  const [qContent, setQContent] = useState("");
  const [qRubric, setQRubric] = useState("");
  const [qChoices, setQChoices] = useState(["", "", "", ""]);
  const [qCorrect, setQCorrect] = useState(0);
  const [qPoints, setQPoints] = useState(1);
  const [qLanguage, setQLanguage] = useState("java");

  const resetQForm = () => {
    setEditingId(null);
    setQType("abierta");
    setQContent("");
    setQRubric("");
    setQChoices(["", "", "", ""]);
    setQCorrect(0);
    setQPoints(1);
    setQLanguage("java");
  };

  const loadQIntoForm = (q: Question) => {
    setEditingId(q.id);
    setQType(q.type);
    setQContent(q.content);
    setQRubric((q as any).expected_rubric ?? "");
    const choices = ((q as any).options?.choices ?? []) as string[];
    setQChoices([0, 1, 2, 3].map((i) => choices[i] ?? ""));
    setQCorrect(Number((q as any).options?.correct_index ?? 0));
    setQPoints(q.points ?? 1);
    setQLanguage((q as any).language ?? "java");
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  // AI
  const [aiTopics, setAiTopics] = useState("");
  const [aiCount, setAiCount] = useState(3);
  const [aiType, setAiType] = useState("abierta");
  const [aiLanguage, setAiLanguage] = useState("java");
  const [aiLoading, setAiLoading] = useState(false);

  // Evaluación de tiempo del examen con IA.
  const [timeEvalLoading, setTimeEvalLoading] = useState(false);
  const [timeEvalResult, setTimeEvalResult] = useState<{
    current_minutes: number;
    suggested_minutes: number;
    verdict: "HOLGADA" | "AJUSTADA" | "CORTA" | "INSUFICIENTE";
    explanation: string;
    question_count: number;
  } | null>(null);

  const evaluateTimeWithAI = async () => {
    if (!exam) return;
    if (!questions || questions.length === 0) {
      toast.error("Crea al menos una pregunta antes de evaluar el tiempo.");
      return;
    }
    setTimeEvalLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("evaluate-exam-time", {
        body: { examId },
      });
      if (error) throw error;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = data as any;
      if (!res?.ok) throw new Error(res?.error ?? "Sin respuesta");
      setTimeEvalResult({
        current_minutes: Number(res.current_minutes) || 0,
        suggested_minutes: Number(res.suggested_minutes) || 0,
        verdict: res.verdict,
        explanation: String(res.explanation ?? ""),
        question_count: Number(res.question_count) || 0,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al evaluar el tiempo");
    } finally {
      setTimeEvalLoading(false);
    }
  };

  const applyTimeSuggestion = () => {
    if (!exam || !timeEvalResult) return;
    setExam({ ...exam, time_limit_minutes: timeEvalResult.suggested_minutes });
    setTimeEvalResult(null);
    toast.success(
      `Duración actualizada a ${timeEvalResult.suggested_minutes} min. Recuerda guardar el examen.`,
    );
  };

  // Carga datos course-scoped (estudiantes, cuts, exams del curso, items
  // de los cuts). Se invoca al montar y cuando el docente cambia el curso
  // del examen desde el selector — así el panel de pesos refleja el bucket
  // del nuevo curso al instante, sin esperar al save.
  const loadCourseData = async (courseId: string) => {
    const { data: enr } = await supabase
      .from("course_enrollments")
      .select("user_id")
      .eq("course_id", courseId);
    const userIds = (enr ?? []).map((r: any) => r.user_id);
    let studs: Student[] = [];
    if (userIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds);
      studs = (profs ?? []) as Student[];
    }
    setStudents(studs);
    const { data: cs } = await (supabase as any)
      .from("grade_cuts")
      .select("id, name, weight, exam_weight, workshop_weight, project_weight, attendance_weight")
      .eq("course_id", courseId)
      .order("position");
    const cutsArr = (cs ?? []) as Array<{
      id: string;
      name: string;
      weight: number;
      exam_weight: number;
      workshop_weight: number;
      project_weight: number;
      attendance_weight: number;
    }>;
    setCuts(cutsArr);
    const { data: examsInCourseData } = await supabase
      .from("exams")
      .select("id, title, cut_id, weight, parent_exam_id")
      .eq("course_id", courseId);
    setExamsInCourse(
      ((examsInCourseData ?? []) as any[])
        .filter((x) => !x.parent_exam_id)
        .map((x) => ({
          id: x.id,
          title: x.title,
          cut_id: x.cut_id ?? null,
          weight: Number(x.weight ?? 0),
        })),
    );
    const cutIds = cutsArr.map((c) => c.id);
    if (cutIds.length) {
      const { data: items } = await (supabase as any)
        .from("grade_cut_items")
        .select("id, cut_id, item_type, weight, exam_id, workshop_id, project_id, project_title")
        .in("cut_id", cutIds);
      const itemsArr = (items ?? []) as typeof cutItems;
      setCutItems(itemsArr);
      const examIds = Array.from(new Set(itemsArr.filter((i) => i.exam_id).map((i) => i.exam_id!)));
      const wsIds = Array.from(
        new Set(itemsArr.filter((i) => i.workshop_id).map((i) => i.workshop_id!)),
      );
      const prIds = Array.from(
        new Set(itemsArr.filter((i) => i.project_id).map((i) => i.project_id!)),
      );
      if (examIds.length) {
        const { data: exs } = await supabase.from("exams").select("id, title").in("id", examIds);
        setExamTitlesById(Object.fromEntries((exs ?? []).map((x: any) => [x.id, x.title])));
      }
      if (wsIds.length) {
        const { data: wss } = await supabase.from("workshops").select("id, title").in("id", wsIds);
        setWorkshopTitlesById(Object.fromEntries((wss ?? []).map((x: any) => [x.id, x.title])));
      }
      if (prIds.length) {
        const { data: prs } = await (supabase as any)
          .from("projects")
          .select("id, title")
          .in("id", prIds);
        setProjectTitlesById(Object.fromEntries((prs ?? []).map((x: any) => [x.id, x.title])));
      }
    } else {
      setCutItems([]);
    }
  };

  const load = async () => {
    const { data: e } = await supabase
      .from("exams")
      .select("*, course:courses(max_exam_attempts, grade_scale_max)")
      .eq("id", examId)
      .single();
    setExam(e);
    setOriginalCourseId(e?.course_id ?? null);
    const { data: qs } = await supabase
      .from("questions")
      .select("*")
      .eq("exam_id", examId)
      .order("position");
    setQuestions(qs ?? []);
    // Cursos a los que el docente puede mover el examen. RLS de courses
    // ya filtra a sus cursos (o todos si es Admin); aquí solo ordenamos.
    const { data: cs } = await supabase
      .from("courses")
      .select("id, name, period")
      .order("period", { ascending: false, nullsFirst: false })
      .order("name");
    setCourses((cs ?? []) as Array<{ id: string; name: string; period: string | null }>);
    if (e?.course_id) {
      const { data: asg } = await supabase
        .from("exam_assignments")
        .select("user_id")
        .eq("exam_id", examId);
      setAssigned(new Set((asg ?? []).map((a: any) => a.user_id)));
      await loadCourseData(e.course_id);
    }
  };
  useEffect(() => {
    load(); /* eslint-disable-next-line */
  }, [examId]);

  const saveExam = async () => {
    const rawAttempts = (exam as any).max_attempts;
    const normalizedAttempts =
      rawAttempts === null || rawAttempts === "" || rawAttempts === undefined
        ? null
        : Math.max(1, Number(rawAttempts) || 1);
    const isExternal = !!(exam as any).is_external;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestedWeight = Math.max(0, Number((exam as any).weight ?? 1) || 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cutId = (exam as any).cut_id ?? null;
    // Validación dura del bucket: si el peso del examen supera lo
    // disponible en el bucket de exámenes del corte (exam_weight -
    // sum(otros exámenes del corte, sin contar supletorios)), no
    // dejamos guardar.
    if (cutId) {
      const selectedCut = cuts.find((c) => c.id === cutId);
      const examBucket = Number(selectedCut?.exam_weight ?? 0);
      const otherExamsSum = examsInCourse
        .filter((x) => x.id !== examId && x.cut_id === cutId)
        .reduce((s, x) => s + x.weight, 0);
      const available = Math.max(0, examBucket - otherExamsSum);
      // Tolerancia 0.01 para evitar falsos negativos por flotante.
      if (requestedWeight > available + 0.01) {
        toast.error(
          `El peso del examen (${requestedWeight}%) supera el bucket disponible del corte ` +
            `(${available.toFixed(2)}% restantes). Reduce el peso o ajusta los demás exámenes del corte.`,
        );
        return;
      }
    }
    // Para externos NO mandamos los campos de duración / navegación /
    // proctoring / reintentos: el alumno no toma este examen, no aplican.
    // Además, mandar columnas opcionales en cada update aumenta la
    // probabilidad de toparse con un schema-cache PostgREST stale tras
    // alguna migración reciente (ver bug 'Could not find max_warnings').
    const newCourseId: string | null = (exam as any).course_id ?? null;
    if (!newCourseId) {
      toast.error("Selecciona un curso para el examen");
      return;
    }
    const courseChanged = !!originalCourseId && newCourseId !== originalCourseId;
    if (courseChanged) {
      const ok = await confirm({
        title: "Cambiar curso del examen",
        description:
          "El examen se moverá al nuevo curso: las asignaciones actuales (estudiantes del curso anterior) se borran y se re-asignan automáticamente todos los matriculados del nuevo curso. Las entregas existentes se mantienen, pero solo los alumnos del nuevo curso podrán ver el examen.",
        confirmLabel: "Cambiar curso",
        tone: "warning",
      });
      if (!ok) return;
    }
    const payload: Record<string, any> = {
      title: exam.title,
      description: exam.description,
      course_id: newCourseId,
      start_time: new Date(exam.start_time).toISOString(),
      end_time: new Date(exam.end_time).toISOString(),
      max_attempts: normalizedAttempts,
      cut_id: cutId,
      weight: requestedWeight,
    };
    if (!isExternal) {
      payload.time_limit_minutes = Number(exam.time_limit_minutes);
      payload.navigation_type = exam.navigation_type;
      payload.shuffle_enabled = !!exam.shuffle_enabled;
      payload.max_warnings = Math.max(
        1,
        Math.min(50, Number((exam as any).max_warnings ?? 3) || 3),
      );
      payload.schedule_type = ((exam as any).schedule_type ?? "normal") as string;
      payload.retry_mode = ((exam as any).retry_mode ?? "last") as string;
    }
    const { error } = await supabase
      .from("exams")
      .update(payload as any)
      .eq("id", examId);
    if (error) return toast.error(error.message);
    if (courseChanged) {
      // Limpia asignaciones del curso anterior y re-asigna todos los
      // matriculados del nuevo curso. Idempotente: si vuelves a guardar
      // sin cambiar curso, no pasa nada (originalCourseId se actualiza
      // tras el reload).
      await supabase.from("exam_assignments").delete().eq("exam_id", examId);
      const { data: enr } = await supabase
        .from("course_enrollments")
        .select("user_id")
        .eq("course_id", newCourseId);
      const rows = (enr ?? []).map((r: any) => ({ exam_id: examId, user_id: r.user_id }));
      if (rows.length) await supabase.from("exam_assignments").insert(rows);
    }
    // Notificar a los estudiantes del curso (nuevo). Para externos no aplica.
    if (!isExternal) {
      await supabase.rpc("notify_course_students", {
        _course_id: newCourseId,
        _title: courseChanged ? "Examen movido a este curso" : "Examen actualizado",
        _body: `Se actualizó el examen "${exam.title}"`,
        _kind: "exam",
        _link: "/app/student/exams",
      });
    }
    toast.success("Examen actualizado correctamente");
    navigate({ to: "/app/teacher/exams" });
  };

  const submitQuestion = async () => {
    if (!qContent.trim()) return toast.error("Contenido requerido");
    if (
      (qType === "abierta" || qType === "codigo" || qType === "diagrama" || qType === "java_gui") &&
      !qRubric.trim()
    )
      return toast.error("Rúbrica requerida para preguntas abiertas/código/diagrama/Java GUI");
    const options = qType === "cerrada" ? { choices: qChoices, correct_index: qCorrect } : null;
    const language = qType === "codigo" ? qLanguage : qType === "java_gui" ? "java" : null;

    if (editingId) {
      // UPDATE: no tocamos position ni starter_code para no clobberar lo que
      // se haya personalizado.
      const { error } = await supabase
        .from("questions")
        .update({
          type: qType,
          content: qContent,
          expected_rubric: qRubric || null,
          options,
          points: qPoints,
          language,
        })
        .eq("id", editingId);
      if (error) return toast.error(error.message);
      toast.success("Pregunta actualizada correctamente");
    } else {
      const pos = (questions[questions.length - 1]?.position ?? -1) + 1;
      const { error } = await supabase.from("questions").insert({
        exam_id: examId,
        type: qType,
        content: qContent,
        expected_rubric: qRubric || null,
        options,
        points: qPoints,
        position: pos,
        language,
        starter_code:
          qType === "java_gui"
            ? JAVA_GUI_STARTER
            : qType === "codigo" && language === "java"
              ? JAVA_STARTER
              : null,
      });
      if (error) return toast.error(error.message);
      toast.success("Pregunta agregada correctamente");
    }
    resetQForm();
    load();
  };

  const moveQuestion = async (id: string, direction: "up" | "down") => {
    const sorted = [...questions].sort((a, b) => a.position - b.position);
    const idx = sorted.findIndex((q) => q.id === id);
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (idx < 0 || target < 0 || target >= sorted.length) return;
    const a = sorted[idx];
    const b = sorted[target];
    const { error: e1 } = await supabase.from("questions").update({ position: -1 }).eq("id", a.id);
    if (e1) return toast.error(e1.message);
    const { error: e2 } = await supabase
      .from("questions")
      .update({ position: a.position })
      .eq("id", b.id);
    if (e2) return toast.error(e2.message);
    const { error: e3 } = await supabase
      .from("questions")
      .update({ position: b.position })
      .eq("id", a.id);
    if (e3) return toast.error(e3.message);
    load();
  };

  const removeQuestion = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar pregunta",
      description: "Esta pregunta se eliminará permanentemente del examen.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("questions").delete().eq("id", id);
    if (error) return toast.error(error.message);
    load();
  };

  const generateAI = async () => {
    if (!aiTopics.trim()) return toast.error("Ingresa los temas");
    setAiLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
        body: {
          examId,
          topics: aiTopics,
          type: aiType,
          count: aiCount,
          language: aiType === "codigo" ? aiLanguage : undefined,
        },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      toast.success(`${data.inserted?.length ?? 0} preguntas generadas`);
      setAiTopics("");
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Error generando preguntas");
    } finally {
      setAiLoading(false);
    }
  };

  const toggleAssign = async (uid: string, checked: boolean) => {
    if (checked) {
      const { error } = await supabase
        .from("exam_assignments")
        .insert({ exam_id: examId, user_id: uid });
      if (error) return toast.error(error.message);
      await supabase.from("notifications").insert({
        user_id: uid,
        title: "Examen asignado",
        body: `Se te ha asignado el examen "${exam.title}"`,
        kind: "exam",
        link: "/app/student/exams",
      });
      setAssigned(new Set([...assigned, uid]));
      toast.success("Estudiante asignado correctamente");
    } else {
      const { error } = await supabase
        .from("exam_assignments")
        .delete()
        .eq("exam_id", examId)
        .eq("user_id", uid);
      if (error) return toast.error(error.message);
      const ns = new Set(assigned);
      ns.delete(uid);
      setAssigned(ns);
      toast.success("Asignación removida correctamente");
    }
  };

  const assignMany = async (visibleIds: string[]) => {
    const toAdd = visibleIds.filter((id) => !assigned.has(id));
    if (!toAdd.length) return;
    const { error } = await supabase
      .from("exam_assignments")
      .insert(toAdd.map((id) => ({ exam_id: examId, user_id: id })));
    if (error) return toast.error(error.message);
    for (const id of toAdd) {
      await supabase.from("notifications").insert({
        user_id: id,
        title: "Examen asignado",
        body: `Se te ha asignado el examen "${exam.title}"`,
        kind: "exam",
        link: "/app/student/exams",
      });
    }
    setAssigned((prev) => new Set([...prev, ...toAdd]));
    toast.success(`${toAdd.length} estudiante(s) asignados correctamente`);
  };

  const unassignMany = async (visibleIds: string[]) => {
    const toRemove = visibleIds.filter((id) => assigned.has(id));
    if (!toRemove.length) return;
    for (const id of toRemove) {
      await supabase.from("exam_assignments").delete().eq("exam_id", examId).eq("user_id", id);
    }
    setAssigned((prev) => {
      const next = new Set(prev);
      toRemove.forEach((id) => next.delete(id));
      return next;
    });
    toast.success(`${toRemove.length} asignación(es) removidas correctamente`);
  };

  if (!exam) return <p className="text-muted-foreground">Cargando…</p>;

  return (
    <div className="space-y-5">
      <PageHeader backTo="/app/teacher/exams" title={exam.title} />

      <Tabs defaultValue={(exam as any).is_external ? "external-grades" : "config"}>
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="config">Configuración</TabsTrigger>
          {!(exam as any).is_external && (
            <TabsTrigger value="questions">Preguntas ({questions.length})</TabsTrigger>
          )}
          <TabsTrigger value="assignments">
            Asignaciones ({assigned.size}/{students.length})
          </TabsTrigger>
          {(exam as any).is_external && (
            <TabsTrigger value="external-grades">Notas externas</TabsTrigger>
          )}
          {!(exam as any).is_external && (
            <TabsTrigger value="notes" className="gap-1">
              <FileText className="h-3.5 w-3.5" />
              Notas de apoyo
            </TabsTrigger>
          )}
        </TabsList>

        {(exam as any).is_external && (
          <TabsContent value="external-grades">
            <ExternalGradesEditor
              kind="exam"
              refId={exam.id}
              courseId={exam.course_id}
              maxScore={Number((exam as any).course?.grade_scale_max ?? 5) || 5}
            />
          </TabsContent>
        )}

        <TabsContent value="config">
          <Card>
            <CardContent className="p-5 space-y-3">
              <div>
                <Label required>Título</Label>
                <Input
                  value={exam.title}
                  onChange={(e) => setExam({ ...exam, title: e.target.value })}
                />
              </div>
              <div>
                <Label>Descripción</Label>
                <Textarea
                  value={exam.description ?? ""}
                  onChange={(e) => setExam({ ...exam, description: e.target.value })}
                />
              </div>
              <div>
                <Label required>Curso</Label>
                <Select
                  value={(exam as any).course_id ?? undefined}
                  onValueChange={async (v) => {
                    if (v === (exam as any).course_id) return;
                    // Al cambiar el curso reseteamos cut_id (los cuts son
                    // course-scoped) y refrescamos los datos del nuevo
                    // curso para que el panel de pesos/bucket sea preciso.
                    setExam({ ...exam, course_id: v, cut_id: null } as any);
                    await loadCourseData(v);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecciona un curso" />
                  </SelectTrigger>
                  <SelectContent>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                        {c.period ? (
                          <span className="text-muted-foreground"> · {c.period}</span>
                        ) : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {originalCourseId && (exam as any).course_id !== originalCourseId && (
                  <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                    Al guardar, el examen se moverá al nuevo curso: se borran las asignaciones
                    actuales y se re-asignan los matriculados del nuevo curso.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label required>
                    {(exam as any).is_external ? "Fecha del parcial" : "Inicio"}
                  </Label>
                  <DateTimePicker
                    value={toLocal(exam.start_time)}
                    onChange={(start) => {
                      const startMs = new Date(start).getTime();
                      const currentEnd = exam.end_time ? new Date(exam.end_time).getTime() : 0;
                      const autoEnd =
                        currentEnd > startMs
                          ? exam.end_time
                          : toLocal(new Date(startMs + 60 * 60 * 1000).toISOString());
                      const diffMin = Math.max(
                        1,
                        Math.round((new Date(autoEnd).getTime() - startMs) / 60000),
                      );
                      setExam({
                        ...exam,
                        start_time: start,
                        // Para externos forzamos end_time = start_time
                        // (ventana 0s) para que el examen no se pueda
                        // tomar — solo se cargan notas manualmente.
                        end_time: (exam as any).is_external ? start : autoEnd,
                        time_limit_minutes: diffMin,
                      });
                    }}
                  />
                </div>
                {!(exam as any).is_external && (
                  <div>
                    <Label required>Fin</Label>
                    <DateTimePicker
                      value={toLocal(exam.end_time)}
                      onChange={(end) => {
                        const diffMin = exam.start_time
                          ? Math.max(
                              1,
                              Math.round(
                                (new Date(end).getTime() - new Date(exam.start_time).getTime()) /
                                  60000,
                              ),
                            )
                          : exam.time_limit_minutes;
                        setExam({ ...exam, end_time: end, time_limit_minutes: diffMin });
                      }}
                    />
                  </div>
                )}
              </div>
              {/*
               * Bloque "solo plataforma": duración, navegación, proctoring,
               * intentos y reintentos. Para externos toda esta sección
               * desaparece — solo se carga la nota manualmente. Igual al
               * patrón usado en el dialog de creación (app.teacher.exams.index).
               */}
              {!(exam as any).is_external && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <Label className="m-0">Duración (min)</Label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={evaluateTimeWithAI}
                          disabled={timeEvalLoading || (questions?.length ?? 0) === 0}
                          title={
                            (questions?.length ?? 0) === 0
                              ? "Crea preguntas primero para poder evaluar el tiempo"
                              : "Pide a la IA una sugerencia de duración basada en las preguntas"
                          }
                        >
                          {timeEvalLoading ? (
                            <Spinner size="xs" className="mr-1" />
                          ) : (
                            <Sparkles className="h-3 w-3 mr-1" />
                          )}
                          Evaluar tiempo con IA
                        </Button>
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        Se calcula automáticamente, pero puedes editarla.
                      </p>
                      <Input
                        type="number"
                        min={1}
                        value={exam.time_limit_minutes || ""}
                        onChange={(e) =>
                          setExam({
                            ...exam,
                            time_limit_minutes:
                              e.target.value === "" ? 0 : Math.max(1, Number(e.target.value)),
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label>Navegación</Label>
                      <Select
                        value={exam.navigation_type}
                        onValueChange={(v) => setExam({ ...exam, navigation_type: v })}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="libre">Libre</SelectItem>
                          <SelectItem value="secuencial">Secuencial</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label>
                        Advertencias máximas{" "}
                        <span className="text-xs text-muted-foreground font-normal">
                          (cambiar pestaña, copiar/pegar, salir de pantalla completa, etc.)
                        </span>
                      </Label>
                      <Input
                        type="number"
                        min={1}
                        max={50}
                        value={(exam as any).max_warnings ?? 3}
                        onChange={(e) =>
                          setExam({
                            ...exam,
                            max_warnings:
                              e.target.value === ""
                                ? 3
                                : Math.max(1, Math.min(50, Number(e.target.value))),
                          } as any)
                        }
                      />
                    </div>
                  </div>
                  <div>
                    <Label>
                      Tipo de programación{" "}
                      <span className="text-xs text-muted-foreground font-normal">
                        (Normal: temporizador absoluto hasta la fecha de fin. Relativo: cada
                        estudiante tiene la duración indicada desde que abre el examen, dentro de la
                        ventana.)
                      </span>
                    </Label>
                    <Select
                      value={(exam as any).schedule_type ?? "normal"}
                      onValueChange={(v) => setExam({ ...exam, schedule_type: v } as any)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="normal">Normal (sincrónico)</SelectItem>
                        <SelectItem value="relativo">Relativo (por estudiante)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="rounded-md border p-3 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <Label className="text-sm">Intentos máximos (override)</Label>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Vacío = hereda del curso
                          {exam.course?.max_exam_attempts != null && (
                            <>
                              {" "}
                              (<strong>{exam.course.max_exam_attempts}</strong> intento
                              {exam.course.max_exam_attempts === 1 ? "" : "s"})
                            </>
                          )}
                          . Si el estudiante supera el límite, el último intento se marca como
                          suspendido.
                        </p>
                      </div>
                      <Input
                        type="number"
                        min={1}
                        step={1}
                        placeholder="Heredar"
                        className="w-24 text-right"
                        value={exam.max_attempts ?? ""}
                        onChange={(e) =>
                          setExam({
                            ...exam,
                            max_attempts: e.target.value === "" ? null : Number(e.target.value),
                          })
                        }
                      />
                    </div>
                  </div>
                  <div>
                    <Label>
                      Modo de calificación con reintentos{" "}
                      <span className="text-xs text-muted-foreground font-normal">
                        (Solo aplica si hay más de un intento permitido. Define cómo se calcula la
                        calificación final del examen cuando el estudiante presenta varios
                        intentos.)
                      </span>
                    </Label>
                    <Select
                      value={(exam as any).retry_mode ?? "last"}
                      onValueChange={(v) => setExam({ ...exam, retry_mode: v } as any)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="last">
                          Último intento (toma la calificación más reciente)
                        </SelectItem>
                        <SelectItem value="average">Promedio de todos los intentos</SelectItem>
                        <SelectItem value="highest">
                          Más alto (mejor calificación entre los intentos)
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
              <div>
                <Label>Corte de evaluación (opcional)</Label>
                <Select
                  value={(exam as any).cut_id ?? "__none__"}
                  onValueChange={(v) =>
                    setExam({ ...exam, cut_id: v === "__none__" ? null : v } as any)
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Sin corte asignado" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Sin corte asignado</SelectItem>
                    {cuts.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {cuts.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Este curso aún no tiene cortes definidos.
                  </p>
                )}
              </div>
              <div>
                {(() => {
                  const cutId = (exam as any).cut_id as string | null | undefined;
                  const selectedCut = cutId ? cuts.find((c) => c.id === cutId) : null;
                  // Bucket de exámenes en el corte. Suma actual del bucket =
                  // pesos de los OTROS exámenes del corte (no el actual).
                  const examBucket = Number(selectedCut?.exam_weight ?? 0);
                  const otherExamsSum = examsInCourse
                    .filter((x) => x.id !== examId && x.cut_id === cutId)
                    .reduce((s, x) => s + x.weight, 0);
                  const examMax = Math.max(0, examBucket - otherExamsSum);
                  const currentWeight = Number((exam as any).weight ?? 1) || 0;
                  const overBucket = currentWeight > examMax + 0.01;
                  return (
                    <>
                      <Label>Peso del examen (% del bucket de exámenes del corte)</Label>
                      <div className="relative w-32">
                        <DecimalInput
                          min={0}
                          max={examMax || undefined}
                          placeholder="1,0"
                          className="pr-7"
                          disabled={!selectedCut}
                          value={(exam as any).weight ?? 1}
                          onChange={(v) => {
                            const raw = v == null ? 1 : v;
                            // Cap al remanente del bucket de exámenes del corte
                            // (no del cut.weight global).
                            const capped = examMax > 0 ? Math.min(raw, examMax) : raw;
                            setExam({ ...exam, weight: capped } as any);
                          }}
                        />
                        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                          %
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {selectedCut ? (
                          <>
                            Cuánto pesa este examen en la <strong>nota final del curso</strong>.
                            Bucket exámenes del corte{" "}
                            <span className="font-medium">{selectedCut.name}</span>: {examBucket}%.
                            Otros exámenes del corte suman {otherExamsSum.toFixed(1)}%, te queda{" "}
                            <strong>{examMax.toFixed(1)}%</strong> disponible.
                            {overBucket && (
                              <span className="block text-destructive mt-1">
                                El peso actual ({currentWeight.toFixed(1)}%) excede el bucket.
                                Reduce este o ajusta el bucket en el editor de cortes.
                              </span>
                            )}
                          </>
                        ) : (
                          "Asigna primero un corte de evaluación arriba para poder configurar el peso."
                        )}
                      </p>
                    </>
                  );
                })()}
                {(() => {
                  const cutId = (exam as any).cut_id as string | null | undefined;
                  if (!cutId) return null;
                  const cutName = cuts.find((c) => c.id === cutId)?.name ?? "";
                  const itemsInCut = cutItems.filter((i) => i.cut_id === cutId);
                  const otherItems = itemsInCut.filter((i) => i.exam_id !== examId);
                  const currentExamItem = itemsInCut.find((i) => i.exam_id === examId);
                  const currentWeight = Math.max(0, Number((exam as any).weight ?? 1) || 0);
                  const sumOthers = otherItems.reduce((s, i) => s + (Number(i.weight) || 0), 0);
                  const total = sumOthers + currentWeight;
                  const remaining = 100 - total;
                  const over = total > 100;
                  return (
                    <div className="mt-3 rounded-md border bg-muted/30 p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="text-sm font-medium">Pesos del corte "{cutName}"</div>
                        <Badge
                          variant={over ? "destructive" : remaining === 0 ? "default" : "secondary"}
                        >
                          {total.toFixed(1)}% / 100%
                          {over
                            ? ` (excede ${(total - 100).toFixed(1)}%)`
                            : remaining > 0
                              ? ` (faltan ${remaining.toFixed(1)}%)`
                              : ""}
                        </Badge>
                      </div>
                      {itemsInCut.length === 0 && !currentExamItem ? (
                        <p className="text-xs text-muted-foreground">
                          Este corte aún no tiene items. Al guardar, este examen se agregará con
                          peso {currentWeight}%.
                        </p>
                      ) : (
                        <ul className="text-xs space-y-1">
                          {otherItems.map((i) => {
                            const label =
                              i.item_type === "exam"
                                ? `Examen: ${examTitlesById[i.exam_id ?? ""] ?? "(sin título)"}`
                                : i.item_type === "workshop"
                                  ? `Taller: ${workshopTitlesById[i.workshop_id ?? ""] ?? "(sin título)"}`
                                  : i.item_type === "project"
                                    ? `Proyecto: ${
                                        projectTitlesById[i.project_id ?? ""] ??
                                        i.project_title ??
                                        "(sin título)"
                                      }`
                                    : i.item_type;
                            return (
                              <li key={i.id} className="flex justify-between">
                                <span className="text-muted-foreground">{label}</span>
                                <span className="font-mono">{Number(i.weight).toFixed(1)}%</span>
                              </li>
                            );
                          })}
                          <li className="flex justify-between border-t pt-1">
                            <span className="font-medium">
                              Este examen ({exam.title || "sin título"})
                            </span>
                            <span className="font-mono font-medium">
                              {currentWeight.toFixed(1)}%
                            </span>
                          </li>
                        </ul>
                      )}
                      {over && (
                        <p className="text-xs text-destructive">
                          La suma supera 100%. Reduce este peso o ajusta otros items del corte.
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
              <Button onClick={saveExam}>Guardar cambios</Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="questions" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Generar con IA
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label required>Temas</Label>
                <Textarea
                  placeholder="Ej: arrays, recursividad, complejidad..."
                  value={aiTopics}
                  onChange={(e) => setAiTopics(e.target.value)}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label required>Cantidad</Label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={aiCount || ""}
                    onChange={(e) => setAiCount(e.target.value === "" ? 0 : Number(e.target.value))}
                  />
                </div>
                <div>
                  <Label required>Tipo</Label>
                  <Select value={aiType} onValueChange={setAiType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="abierta">Abierta</SelectItem>
                      <SelectItem value="cerrada">Opción múltiple</SelectItem>
                      <SelectItem value="codigo">Código</SelectItem>
                      <SelectItem value="diagrama">Diagrama</SelectItem>
                      <SelectItem value="java_gui">Java GUI (Swing/AWT)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {aiType === "codigo" && (
                <div>
                  <Label required>Lenguaje</Label>
                  <Select value={aiLanguage} onValueChange={setAiLanguage}>
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
              <Button onClick={generateAI} disabled={aiLoading}>
                {aiLoading ? (
                  <Spinner size="md" className="mr-1" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-1" />
                )}
                Generar preguntas
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {editingId ? "Editar pregunta" : "Agregar manualmente"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label required>Tipo</Label>
                  <Select value={qType} onValueChange={setQType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="abierta">Abierta</SelectItem>
                      <SelectItem value="cerrada">Opción múltiple</SelectItem>
                      <SelectItem value="codigo">Código</SelectItem>
                      <SelectItem value="diagrama">Diagrama</SelectItem>
                      <SelectItem value="java_gui">Java GUI (Swing/AWT)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label required>Puntos</Label>
                  <Input
                    type="number"
                    value={qPoints || ""}
                    onChange={(e) => setQPoints(e.target.value === "" ? 0 : Number(e.target.value))}
                  />
                </div>
              </div>
              <div>
                <Label required>Enunciado</Label>
                <Textarea value={qContent} onChange={(e) => setQContent(e.target.value)} />
              </div>
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
              {qType !== "cerrada" && (
                <div>
                  <Label required>Rúbrica esperada</Label>
                  <Textarea
                    placeholder="Criterios para una respuesta correcta…"
                    value={qRubric}
                    onChange={(e) => setQRubric(e.target.value)}
                  />
                </div>
              )}
              {qType === "cerrada" && (
                <div className="space-y-2">
                  <Label required>Opciones (marca la correcta)</Label>
                  {qChoices.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="radio"
                        checked={qCorrect === i}
                        onChange={() => setQCorrect(i)}
                      />
                      <Input
                        value={c}
                        placeholder={`Opción ${String.fromCharCode(65 + i)}`}
                        onChange={(e) => {
                          const nc = [...qChoices];
                          nc[i] = e.target.value;
                          setQChoices(nc);
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={submitQuestion}>
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
                  <Button variant="outline" onClick={resetQForm}>
                    <X className="h-4 w-4 mr-1" /> Cancelar edición
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="space-y-2">
            {questions.map((q, i) => (
              <Card key={q.id}>
                <CardContent className="p-4 flex justify-between items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-[10px]">
                        #{i + 1}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {q.type}
                      </Badge>
                      {q.type === "codigo" && q.language && (
                        <Badge variant="outline" className="text-[10px]">
                          {q.language}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">{q.points} pt</span>
                    </div>
                    <p className="text-sm">{q.content}</p>
                    {q.expected_rubric && (
                      <p className="text-xs text-muted-foreground mt-1 italic">
                        Rúbrica: {q.expected_rubric}
                      </p>
                    )}
                    {q.options?.choices && (
                      <ul className="text-xs text-muted-foreground mt-2 space-y-0.5">
                        {q.options.choices.map((c: string, idx: number) => (
                          <li
                            key={idx}
                            className={
                              idx === q.options.correct_index ? "text-success font-medium" : ""
                            }
                          >
                            {String.fromCharCode(65 + idx)}. {c}{" "}
                            {idx === q.options.correct_index && "✓"}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <RowAction
                      label="Subir"
                      icon={ChevronUp}
                      disabled={i === 0}
                      onClick={() => moveQuestion(q.id, "up")}
                    />
                    <RowAction
                      label="Bajar"
                      icon={ChevronDown}
                      disabled={i === questions.length - 1}
                      onClick={() => moveQuestion(q.id, "down")}
                    />
                    <RowAction
                      label="Editar pregunta"
                      icon={Pencil}
                      onClick={() => loadQIntoForm(q)}
                    />
                    <RowAction
                      label="Eliminar pregunta"
                      icon={Trash2}
                      tone="destructive"
                      onClick={() => removeQuestion(q.id)}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="assignments">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Estudiantes matriculados</CardTitle>
            </CardHeader>
            <CardContent>
              <AssignSelector
                items={students}
                selectedIds={assigned}
                onToggle={toggleAssign}
                onSelectAll={assignMany}
                onDeselectAll={unassignMany}
                emptyText="No hay estudiantes matriculados en este curso."
                countNoun="asignados"
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="notes">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4 text-primary" />
                Notas de apoyo de los estudiantes
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Aprueba o rechaza el material de apoyo que cada estudiante quiere tener disponible
                durante este examen. Si rechazas, el estudiante podrá ajustarlo y reenviarlo.
              </p>
            </CardHeader>
            <CardContent>
              <TeacherExamNotes examId={examId} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Resultado de evaluación de tiempo con IA. */}
      <Dialog open={!!timeEvalResult} onOpenChange={(o) => !o && setTimeEvalResult(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              Sugerencia de duración
            </DialogTitle>
          </DialogHeader>
          {timeEvalResult && (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="rounded-md border p-2">
                  <div className="text-[10px] uppercase text-muted-foreground">Actual</div>
                  <div className="text-2xl font-semibold tabular-nums">
                    {timeEvalResult.current_minutes}
                  </div>
                  <div className="text-[10px] text-muted-foreground">min</div>
                </div>
                <div className="rounded-md border border-primary/40 bg-primary/5 p-2">
                  <div className="text-[10px] uppercase text-muted-foreground">Sugerido</div>
                  <div className="text-2xl font-semibold tabular-nums text-primary">
                    {timeEvalResult.suggested_minutes}
                  </div>
                  <div className="text-[10px] text-muted-foreground">min</div>
                </div>
                <div className="rounded-md border p-2">
                  <div className="text-[10px] uppercase text-muted-foreground">Veredicto</div>
                  <Badge
                    variant={
                      timeEvalResult.verdict === "AJUSTADA"
                        ? "default"
                        : timeEvalResult.verdict === "HOLGADA"
                          ? "secondary"
                          : "destructive"
                    }
                    className="mt-2 text-[10px]"
                  >
                    {timeEvalResult.verdict}
                  </Badge>
                </div>
              </div>
              <p className="text-xs text-muted-foreground whitespace-pre-wrap rounded-md bg-muted/40 p-2">
                {timeEvalResult.explanation || "Sin explicación."}
              </p>
              <p className="text-[11px] text-muted-foreground italic">
                Basado en {timeEvalResult.question_count} pregunta(s).
              </p>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setTimeEvalResult(null)}>
              Mantener {timeEvalResult?.current_minutes ?? 0} min
            </Button>
            <Button onClick={applyTimeSuggestion} disabled={!timeEvalResult}>
              Usar {timeEvalResult?.suggested_minutes ?? 0} min
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toLocal(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
