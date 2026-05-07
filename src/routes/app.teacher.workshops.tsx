import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { DecimalInput } from "@/components/ui/decimal-input";
import { RowAction } from "@/components/ui/row-action";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableEmpty } from "@/components/ui/empty-state";
import { ExternalGradesEditor } from "@/components/ExternalGradesEditor";
import { WorkshopGroupsEditor } from "@/components/WorkshopGroupsEditor";
import { toast } from "sonner";
import {
  Plus,
  Pencil,
  Trash2,
  ExternalLink,
  Users,
  CheckCircle2,
  FileIcon,
  Download,
  CheckSquare,
  XSquare,
  Sparkles,
  ThumbsUp,
  ThumbsDown,
  HelpCircle,
  Copy,
  ListChecks,
  Hammer,
  UsersRound,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { formatDate } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { ImportExportMenu } from "@/components/ImportExportMenu";
import { toCSV } from "@/lib/csv";
import { TeacherWorkshopQuestionsEditor } from "@/components/WorkshopQuestions";
import { MarkdownInline } from "@/components/MarkdownInline";
import { FeedbackThread } from "@/components/FeedbackThread";
import { FraudPanel } from "@/components/FraudPanel";
import { DateTimePicker } from "@/components/ui/date-picker";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const WORKSHOPS_TEMPLATE = `course_name,title,description,instructions,external_link,due_date,max_score,status
Programación I,Taller de listas,Práctica de listas enlazadas,Implementa las funciones del enunciado,https://github.com/repo,2025-09-15T23:59,100,published
Programación I,Taller de árboles,,Resuelve los ejercicios 1-5,,2025-09-30T23:59,100,draft`;

export const Route = createFileRoute("/app/teacher/workshops")({ component: TeacherWorkshops });

type Course = {
  id: string;
  name: string;
  period: string | null;
  grade_scale_min: number;
  grade_scale_max: number;
  passing_grade: number;
};
type Workshop = {
  id: string;
  course_id: string;
  cut_id: string | null;
  title: string;
  description: string | null;
  instructions: string | null;
  external_link: string | null;
  ai_generated: boolean;
  due_date: string | null;
  rubric: any;
  max_score: number;
  status: string;
  group_mode?: "individual" | "teacher_assigned" | "self_signup";
  course?: { name: string; period: string | null };
};
type Cut = {
  id: string;
  course_id: string;
  name: string;
  weight: number;
  workshop_weight: number;
  exam_weight: number;
  project_weight: number;
  attendance_weight: number;
};
type Student = { id: string; full_name: string; institutional_email: string };
type WsSub = {
  id: string;
  workshop_id: string;
  user_id: string;
  content: string | null;
  external_link: string | null;
  file_url: string | null;
  ai_grade: number | null;
  ai_feedback: string | null;
  final_grade: number | null;
  teacher_feedback: string | null;
  status: string;
  submitted_at: string | null;
  profile?: { full_name: string; institutional_email: string };
};

type WsQuestion = {
  id: string;
  workshop_id: string;
  type: "abierta" | "cerrada" | "codigo" | "diagrama";
  content: string;
  options: { choices?: string[]; correct_index?: number } | null;
  position: number;
  points: number;
  expected_rubric: string | null;
  language: string | null;
};
type WsAnswer = {
  id: string;
  submission_id: string;
  question_id: string;
  answer_text: string | null;
  selected_option: string | null;
  code_content: string | null;
  diagram_code: string | null;
  ai_grade: number | null;
  ai_feedback: string | null;
};

function TeacherWorkshops() {
  const { user, roles } = useAuth();
  const confirm = useConfirm();
  const [courses, setCourses] = useState<Course[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const sel = useMultiSelect(workshops);

  const handleBulkDelete = async (ids: string[]) => {
    const { error } = await supabase.from("workshops").delete().in("id", ids);
    if (error) throw new Error(error.message);
    toast.success(`${ids.length} taller(es) eliminado(s) correctamente`);
    sel.clear();
    load();
  };

  const selectedWorkshopItems = useMemo(
    () => workshops.filter((w) => sel.isSelected(w.id)).map((w) => ({ id: w.id, label: w.title })),
    [workshops, sel],
  );
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Workshop>>({});

  /**
   * Cap dinámico del peso: cuando cambia el corte seleccionado o la
   * lista de talleres del mismo corte (alguien creó/editó otro),
   * recalcula `disponibleEnBucket = workshop_weight - sum(otros)` y
   * ajusta `form.weight` a ese máximo si lo excede. Así el campo
   * "Peso del taller dentro del corte" siempre refleja el límite real,
   * incluso si el docente seleccionó un corte distinto al inicial.
   */
  const workshopWeightMax = useMemo(() => {
    if (!form.cut_id) return null;
    const cut = cuts.find((c) => c.id === form.cut_id);
    if (!cut) return null;
    const bucket = Number(cut.workshop_weight ?? 0);
    const editingId = (form as any).id as string | undefined;
    const sumOthers = workshops
      .filter((w) => (w as any).cut_id === form.cut_id && w.id !== editingId)
      .reduce((s, w) => s + Number((w as any).weight ?? 0), 0);
    return Math.max(0, bucket - sumOthers);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.cut_id, (form as any).id, cuts, workshops]);

  useEffect(() => {
    if (workshopWeightMax == null) return;
    const current = Number((form as any).weight ?? 0);
    if (current > workshopWeightMax) {
      setForm((prev) => ({ ...prev, weight: workshopWeightMax }) as Partial<Workshop>);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workshopWeightMax]);
  const workshopDirty = useDirtyDialog(open, form);

  // Grading view
  const [gradingWs, setGradingWs] = useState<Workshop | null>(null);
  const [wsSubs, setWsSubs] = useState<WsSub[]>([]);
  const [gradingOpen, setGradingOpen] = useState(false);
  // Per-question grading: questions of the workshop, and answers grouped
  // by submission. Edits live in `answersBySub` until the teacher saves a
  // single question or recomputes the global grade.
  const [wsQuestions, setWsQuestions] = useState<WsQuestion[]>([]);
  const [answersBySub, setAnswersBySub] = useState<Record<string, WsAnswer[]>>({});
  const [savingAnswerId, setSavingAnswerId] = useState<string | null>(null);
  const [aiGradingAnswerId, setAiGradingAnswerId] = useState<string | null>(null);

  // Assignment
  const [assignWs, setAssignWs] = useState<Workshop | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
  const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set());

  // Questions editor
  const [questionsWs, setQuestionsWs] = useState<Workshop | null>(null);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupsWs, setGroupsWs] = useState<Workshop | null>(null);

  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  /** Auto-assign a workshop to all students enrolled in the course */
  const autoAssignWorkshop = async (workshopId: string, courseId: string) => {
    const { data: enr } = await supabase
      .from("course_enrollments")
      .select("user_id")
      .eq("course_id", courseId);
    if (!enr?.length) return;
    // Get existing assignments to avoid duplicates
    const { data: existing } = await supabase
      .from("workshop_assignments")
      .select("user_id")
      .eq("workshop_id", workshopId);
    const existingSet = new Set((existing ?? []).map((e: any) => e.user_id));
    const toAdd = enr.filter((e: any) => !existingSet.has(e.user_id));
    if (toAdd.length) {
      await supabase
        .from("workshop_assignments")
        .insert(toAdd.map((e: any) => ({ workshop_id: workshopId, user_id: e.user_id })));
    }
  };

  const load = async () => {
    const [{ data: cs }, { data: ws }, { data: cuts }] = await Promise.all([
      supabase
        .from("courses")
        .select("id, name, period, grade_scale_min, grade_scale_max, passing_grade")
        .order("name"),
      supabase
        .from("workshops")
        .select("*, course:courses(name, period)")
        .order("created_at", { ascending: false }),
      (supabase as any)
        .from("grade_cuts")
        .select(
          "id, course_id, name, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
        )
        .order("position"),
    ]);
    setCourses((cs ?? []) as Course[]);
    setWorkshops((ws ?? []) as any);
    setCuts((cuts ?? []) as Cut[]);
  };
  useEffect(() => {
    load();
  }, []);

  // Deep-link desde notificación. Acepta:
  //   ?workshop=WS_ID&submission=SUB_ID  (notificaciones nuevas)
  //   ?id=WS_ID                          (legacy)
  // Si el taller ya no existe (eliminado o sin permiso), toast claro y
  // limpia la URL.
  const [autoOpenedFromUrl, setAutoOpenedFromUrl] = useState(false);
  useEffect(() => {
    if (autoOpenedFromUrl || workshops.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const wsParam = params.get("workshop") ?? params.get("id");
    if (wsParam) {
      const ws = workshops.find((w) => w.id === wsParam);
      if (ws) {
        void openGrading(ws as Workshop);
      } else {
        toast.info(
          "El taller referenciado en la notificación ya no existe o no tienes acceso a él.",
        );
      }
      const url = new URL(window.location.href);
      url.searchParams.delete("workshop");
      url.searchParams.delete("submission");
      url.searchParams.delete("id");
      window.history.replaceState({}, "", url.toString());
    }
    setAutoOpenedFromUrl(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workshops, autoOpenedFromUrl]);

  const openNew = () => {
    const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    setForm({
      title: "",
      course_id: courses[0]?.id,
      cut_id: null,
      description: "",
      instructions: "",
      external_link: "",
      due_date: toLocal(due),
      max_score: 100,
      status: "draft",
      rubric: null,
    });
    setSelectedCourseIds(new Set(courses[0] ? [courses[0].id] : []));
    setOpen(true);
  };

  const toggleCourse = (id: string) => {
    setSelectedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const first = [...next][0];
      if (first) setForm((f) => ({ ...f, course_id: first }));
      return next;
    });
  };

  const save = async () => {
    if (!form.title || !user) {
      toast.error("Completa los campos");
      return;
    }
    // If editing, use single course
    const courseIds = form.id ? [form.course_id!] : [...selectedCourseIds];
    if (courseIds.length === 0) {
      toast.error("Selecciona al menos un curso");
      return;
    }

    const isExternal = !!(form as any).is_external;
    const groupMode: string = isExternal
      ? "individual"
      : ((form as any).group_mode ?? "individual");
    const basePayload: Record<string, any> = {
      title: form.title,
      description: form.description ?? null,
      instructions: form.instructions ?? null,
      external_link: form.external_link || null,
      start_date: (form as any).start_date
        ? new Date((form as any).start_date).toISOString()
        : null,
      due_date: form.due_date ? new Date(form.due_date).toISOString() : null,
      max_score: Number(form.max_score) || 100,
      status: isExternal ? "closed" : (form.status ?? "draft"),
      rubric: form.rubric ?? null,
      created_by: user.id,
      cut_id: form.cut_id || null,
      is_external: isExternal,
      group_mode: groupMode,
    };
    // weight solo tiene sentido cuando hay corte; lo enviamos solo si
    // el form lo incluye. Cap server-side: como el browser solo respeta
    // `max=` como hint, también capeamos aquí antes de persistir contra
    // el bucket disponible (workshop_weight - sum(otros del corte)).
    if (form.cut_id && (form as any).weight != null) {
      const requested = Number((form as any).weight);
      const cap = workshopWeightMax;
      basePayload.weight = cap != null ? Math.max(0, Math.min(requested, cap)) : requested;
    }

    if (form.id) {
      const { error } = await supabase
        .from("workshops")
        .update({ ...basePayload, course_id: form.course_id! })
        .eq("id", form.id);
      if (error) return toast.error(error.message);
      // Auto-assign all enrolled students when published
      if (form.status === "published") {
        await autoAssignWorkshop(form.id, form.course_id!);
        await supabase.rpc("notify_course_students", {
          _course_id: form.course_id!,
          _title: "Taller actualizado",
          _body: `Se actualizó el taller "${form.title}"`,
          _kind: "workshop",
          _link: "/app/student/workshops",
        });
      }
      toast.success("Taller actualizado correctamente");
    } else {
      for (const cid of courseIds) {
        const { data: newWs, error } = await supabase
          .from("workshops")
          .insert({ ...basePayload, course_id: cid } as any)
          .select()
          .single();
        if (error) {
          toast.error(error.message);
          return;
        }
        // Auto-asignar a todos los estudiantes matriculados al crear
        if (newWs) {
          await autoAssignWorkshop(newWs.id, cid);
          if (form.status === "published") {
            await supabase.rpc("notify_course_students", {
              _course_id: cid,
              _title: "Nuevo taller disponible",
              _body: `Se ha publicado el taller "${form.title}"`,
              _kind: "workshop",
              _link: "/app/student/workshops",
            });
          }
        }
      }
      toast.success(
        courseIds.length > 1
          ? `Taller creado en ${courseIds.length} cursos correctamente`
          : "Taller creado correctamente",
      );
    }
    setOpen(false);
    load();
  };

  const duplicateWorkshop = async (ws: Workshop) => {
    if (!user) return;
    const { course, id: _id, ...rest } = ws as any;
    const { data: newWs, error } = await supabase
      .from("workshops")
      .insert({
        ...rest,
        title: `Copia de ${ws.title}`,
        status: "draft",
        created_by: user.id,
      })
      .select()
      .single();
    if (error) return toast.error(error.message);
    const { data: qs } = await supabase
      .from("workshop_questions")
      .select("*")
      .eq("workshop_id", ws.id)
      .order("position");
    if (qs?.length) {
      const rows = (qs as any[]).map(({ id, workshop_id, created_at, ...q }) => ({
        ...q,
        workshop_id: newWs.id,
      }));
      await supabase.from("workshop_questions").insert(rows);
    }
    toast.success("Taller duplicado correctamente");
    load();
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar taller",
      description:
        "Se eliminarán las asignaciones y entregas asociadas al taller. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar taller",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("workshops").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Taller eliminado correctamente");
    load();
  };

  const openAssign = async (ws: Workshop) => {
    setAssignWs(ws);
    const [{ data: enr }, { data: asg }] = await Promise.all([
      supabase.from("course_enrollments").select("user_id").eq("course_id", ws.course_id),
      supabase.from("workshop_assignments").select("user_id").eq("workshop_id", ws.id),
    ]);
    const userIds = (enr ?? []).map((r: any) => r.user_id);
    if (userIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds);
      setStudents((profs ?? []) as Student[]);
    } else {
      setStudents([]);
    }
    setAssignedIds(new Set((asg ?? []).map((a: any) => a.user_id)));
    setAssignOpen(true);
  };

  const toggleAssign = async (uid: string, checked: boolean) => {
    if (!assignWs) return;
    if (checked) {
      const { error } = await supabase
        .from("workshop_assignments")
        .insert({ workshop_id: assignWs.id, user_id: uid });
      if (error) return toast.error(error.message);
      setAssignedIds(new Set([...assignedIds, uid]));
      toast.success("Estudiante asignado correctamente");
    } else {
      const { error } = await supabase
        .from("workshop_assignments")
        .delete()
        .eq("workshop_id", assignWs.id)
        .eq("user_id", uid);
      if (error) return toast.error(error.message);
      const ns = new Set(assignedIds);
      ns.delete(uid);
      setAssignedIds(ns);
      toast.success("Asignación removida correctamente");
    }
  };

  const assignAll = async () => {
    if (!assignWs) return;
    const toAdd = students.filter((s) => !assignedIds.has(s.id));
    if (!toAdd.length) return;
    const { error } = await supabase
      .from("workshop_assignments")
      .insert(toAdd.map((s) => ({ workshop_id: assignWs.id, user_id: s.id })));
    if (error) return toast.error(error.message);
    setAssignedIds(new Set(students.map((s) => s.id)));
    toast.success(`${toAdd.length} estudiante(s) asignados correctamente`);
  };

  const unassignAll = async () => {
    if (!assignWs) return;
    const toRemove = students.filter((s) => assignedIds.has(s.id));
    if (!toRemove.length) return;
    for (const s of toRemove) {
      await supabase
        .from("workshop_assignments")
        .delete()
        .eq("workshop_id", assignWs.id)
        .eq("user_id", s.id);
    }
    setAssignedIds(new Set());
    toast.success(`${toRemove.length} asignación(es) removidas correctamente`);
  };

  const openGrading = async (ws: Workshop) => {
    setGradingWs(ws);
    setWsQuestions([]);
    setAnswersBySub({});
    const [{ data: subs }, { data: qs }] = await Promise.all([
      supabase.from("workshop_submissions").select("*").eq("workshop_id", ws.id),
      supabase
        .from("workshop_questions")
        .select(
          "id, workshop_id, type, content, options, position, points, expected_rubric, language",
        )
        .eq("workshop_id", ws.id)
        .order("position"),
    ]);
    setWsQuestions((qs ?? []) as WsQuestion[]);

    if (subs?.length) {
      const userIds = subs.map((s: any) => s.user_id);
      const subIds = subs.map((s: any) => s.id);
      const [{ data: profiles }, { data: ans }] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, institutional_email")
          .in("id", userIds),
        supabase
          .from("workshop_submission_answers")
          .select(
            "id, submission_id, question_id, answer_text, selected_option, code_content, diagram_code, ai_grade, ai_feedback",
          )
          .in("submission_id", subIds),
      ]);
      const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      const grouped: Record<string, WsAnswer[]> = {};
      for (const a of (ans ?? []) as WsAnswer[]) {
        (grouped[a.submission_id] ||= []).push(a);
      }
      setAnswersBySub(grouped);
      setWsSubs(subs.map((s: any) => ({ ...s, profile: profileMap.get(s.user_id) })));
    } else {
      setWsSubs([]);
    }
    setGradingOpen(true);
  };

  /** Recompute the global grade of a submission from its per-question ai_grade
   *  values (capped at each question's `points`) and scale it to max_score. */
  const recomputeFinalGrade = (subId: string) => {
    const answers = answersBySub[subId] ?? [];
    const totalPoints = wsQuestions.reduce((s, q) => s + Number(q.points || 0), 0);
    if (totalPoints <= 0 || !gradingWs) return 0;
    const earned = wsQuestions.reduce((s, q) => {
      const a = answers.find((x) => x.question_id === q.id);
      const g = Math.min(Number(a?.ai_grade ?? 0) || 0, Number(q.points) || 0);
      return s + g;
    }, 0);
    return Number(((earned / totalPoints) * Number(gradingWs.max_score)).toFixed(2));
  };

  /** Update a single answer's grade/feedback in local state. */
  const patchAnswer = (subId: string, questionId: string, patch: Partial<WsAnswer>) => {
    setAnswersBySub((prev) => {
      const list = (prev[subId] ?? []).slice();
      const idx = list.findIndex((a) => a.question_id === questionId);
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...patch };
      } else {
        list.push({
          id: "",
          submission_id: subId,
          question_id: questionId,
          answer_text: null,
          selected_option: null,
          code_content: null,
          diagram_code: null,
          ai_grade: null,
          ai_feedback: null,
          ...patch,
        });
      }
      return { ...prev, [subId]: list };
    });
  };

  /** Persist the per-question grade and refresh the submission's final grade. */
  const saveAnswerGrade = async (subId: string, questionId: string) => {
    const answer = (answersBySub[subId] ?? []).find((a) => a.question_id === questionId);
    if (!answer || !answer.id) {
      toast.error("Esta entrega aún no tiene respuesta para la pregunta.");
      return;
    }
    setSavingAnswerId(answer.id);
    try {
      const { error } = await supabase
        .from("workshop_submission_answers")
        .update({
          ai_grade: answer.ai_grade,
          ai_feedback: answer.ai_feedback,
        })
        .eq("id", answer.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      const newFinal = recomputeFinalGrade(subId);
      const { error: subErr } = await supabase
        .from("workshop_submissions")
        .update({ final_grade: newFinal, status: "calificado" })
        .eq("id", subId);
      if (subErr) {
        toast.error(`Calificación guardada, pero falló recalcular calificación global: ${subErr.message}`);
      } else {
        setWsSubs((prev) =>
          prev.map((s) =>
            s.id === subId ? { ...s, final_grade: newFinal, status: "calificado" } : s,
          ),
        );
        toast.success(`Pregunta guardada · calificación global: ${newFinal}/${gradingWs?.max_score ?? 100}`);
      }
    } finally {
      setSavingAnswerId(null);
    }
  };

  /** Recalificar una sola respuesta con IA. Reusa la edge function. */
  const aiRegradeAnswer = async (
    subId: string,
    question: WsQuestion,
    answer: WsAnswer | undefined,
  ) => {
    if (!answer || !answer.id) {
      toast.error("Sin respuesta para recalificar.");
      return;
    }
    const raw =
      answer.code_content ?? answer.diagram_code ?? answer.selected_option ?? answer.answer_text ?? "";
    setAiGradingAnswerId(answer.id);
    try {
      const courseLanguage =
        (courses.find((c) => c.id === gradingWs?.course_id) as any)?.language === "en"
          ? "en"
          : "es";
      const { data, error } = await supabase.functions.invoke("ai-grade-submission", {
        body: {
          workshopQuestionGrading: true,
          questionType: question.type,
          questionContent: question.content,
          expectedRubric: question.expected_rubric,
          maxPoints: question.points,
          studentAnswer: String(raw),
          language: question.language,
          courseLanguage,
        },
      });
      if (error || data?.error) {
        toast.error(`Error IA: ${error?.message ?? data?.error}`);
        return;
      }
      const newGrade = Number(data?.grade ?? 0);
      const newFeedback = String(data?.feedback ?? "");
      patchAnswer(subId, question.id, { ai_grade: newGrade, ai_feedback: newFeedback });
      // Persist immediately so the recalc is consistent.
      await supabase
        .from("workshop_submission_answers")
        .update({ ai_grade: newGrade, ai_feedback: newFeedback })
        .eq("id", answer.id);
      toast.success("Pregunta recalificada con IA");
    } finally {
      setAiGradingAnswerId(null);
    }
  };


  const [aiGradingId, setAiGradingId] = useState<string | null>(null);
  const [aiGradingAll, setAiGradingAll] = useState(false);

  const gradeOneWithAI = async (sub: WsSub): Promise<boolean> => {
    if (!gradingWs) return false;
    setAiGradingId(sub.id);
    try {
      // Build the prompt for AI grading
      const rubricText = gradingWs.rubric
        ? JSON.stringify(gradingWs.rubric)
        : "Evalúa la calidad, completitud y corrección de la respuesta.";

      const studentAnswer =
        [
          sub.content ? `Contenido: ${sub.content}` : "",
          sub.external_link ? `Link: ${sub.external_link}` : "",
        ]
          .filter(Boolean)
          .join("\n") || "Sin respuesta";

      // Call AI via edge function with a generic approach
      const { data: aiData, error: aiErr } = await supabase.functions.invoke(
        "ai-grade-submission",
        {
          body: {
            workshopGrading: true,
            workshopTitle: gradingWs.title,
            workshopInstructions: gradingWs.instructions ?? "",
            rubric: rubricText,
            maxScore: gradingWs.max_score,
            studentAnswer,
          },
        },
      );

      let aiGrade: number | null = null;
      let aiFeedback = "Sin retroalimentación de IA";

      if (aiErr || aiData?.error) {
        // Fallback: if edge function doesn't support workshop mode, do a simple scoring
        toast.error(
          "La calificación IA requiere actualizar la edge function. Usa calificación manual.",
        );
        return false;
      } else {
        aiGrade = aiData?.grade ?? null;
        aiFeedback = aiData?.feedback ?? "Sin retroalimentación de IA";
      }

      // Save to DB
      const { error: updateErr } = await supabase
        .from("workshop_submissions")
        .update({
          ai_grade: aiGrade,
          ai_feedback: aiFeedback,
          status: "ai_revisado",
        })
        .eq("id", sub.id);

      if (updateErr) {
        toast.error(`Error guardando: ${updateErr.message}`);
        return false;
      }

      setWsSubs((prev) =>
        prev.map((s) =>
          s.id === sub.id
            ? { ...s, ai_grade: aiGrade, ai_feedback: aiFeedback, status: "ai_revisado" }
            : s,
        ),
      );
      return true;
    } catch (e: any) {
      toast.error(`Error IA: ${e.message ?? "Error desconocido"}`);
      return false;
    } finally {
      setAiGradingId(null);
    }
  };

  const gradeAllWithAI = async () => {
    if (!gradingWs) return;
    const pending = wsSubs.filter(
      (s) => s.status === "entregado" || s.status === "calificado" || s.status === "ai_revisado",
    );
    if (!pending.length) {
      toast.info("No hay entregas para calificar");
      return;
    }
    setAiGradingAll(true);
    let graded = 0;
    for (const sub of pending) {
      const ok = await gradeOneWithAI(sub);
      if (ok) graded++;
    }
    setAiGradingAll(false);
    if (graded > 0) toast.success(`${graded} entrega(s) calificadas con IA correctamente`);
  };

  const approveAIGrade = async (subId: string) => {
    const sub = wsSubs.find((s) => s.id === subId);
    if (!sub) return;
    const { error } = await supabase
      .from("workshop_submissions")
      .update({
        final_grade: sub.ai_grade,
        teacher_feedback: sub.ai_feedback,
        status: "calificado",
      })
      .eq("id", subId);
    if (error) return toast.error(error.message);
    setWsSubs((prev) =>
      prev.map((s) =>
        s.id === subId
          ? {
              ...s,
              final_grade: sub.ai_grade,
              teacher_feedback: sub.ai_feedback,
              status: "calificado",
            }
          : s,
      ),
    );
    toast.success("Calificación IA aprobada");
  };

  const rejectAIGrade = async (subId: string) => {
    await supabase
      .from("workshop_submissions")
      .update({
        ai_grade: null,
        ai_feedback: null,
        status: "entregado",
      })
      .eq("id", subId);
    setWsSubs((prev) =>
      prev.map((s) =>
        s.id === subId ? { ...s, ai_grade: null, ai_feedback: null, status: "entregado" } : s,
      ),
    );
    toast.success("Calificación IA rechazada — puede calificar manualmente");
  };

  const saveGrade = async (subId: string, grade: number, feedback: string) => {
    const { data, error } = await supabase
      .from("workshop_submissions")
      .update({
        final_grade: grade,
        teacher_feedback: feedback,
        status: "calificado",
      })
      .eq("id", subId)
      .select()
      .maybeSingle();

    if (error) {
      toast.error(`Error: ${error.message}`);
      return;
    }
    if (!data) {
      toast.error("No se pudo actualizar. Verifica los permisos.");
      return;
    }
    toast.success("Calificación guardada correctamente");
    setWsSubs((prev) =>
      prev.map((s) =>
        s.id === subId
          ? { ...s, final_grade: grade, teacher_feedback: feedback, status: "calificado" }
          : s,
      ),
    );

    // Notificar al estudiante (o a todos los miembros del grupo si la
    // entrega es grupal). El RPC notify_course_students no aplica acá
    // porque va a TODOS los del curso; insertamos directo en
    // notifications con RLS de Docente/Admin.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subData = data as any;
    const wsTitle = gradingWs?.title ?? "el taller";
    let recipients: string[] = [];
    if (subData.group_id) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny = supabase as any;
      const { data: ms } = await dbAny
        .from("workshop_group_members")
        .select("user_id")
        .eq("group_id", subData.group_id);
      recipients = ((ms ?? []) as { user_id: string }[]).map((m) => m.user_id);
    } else if (subData.user_id) {
      recipients = [subData.user_id];
    }
    if (recipients.length > 0) {
      await supabase.from("notifications").insert(
        recipients.map((uid) => ({
          user_id: uid,
          title: "Taller calificado",
          body: `Tu taller "${wsTitle}" ya tiene calificación: ${grade}`,
          kind: "grade",
          link: "/app/student/workshops",
        })),
      );
    }
  };

  const deleteSubmission = async (subId: string, studentName: string) => {
    const ok = await confirm({
      title: `Eliminar entrega de ${studentName}`,
      description: "Se eliminará la entrega del estudiante de forma permanente.",
      confirmLabel: "Eliminar entrega",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("workshop_submissions").delete().eq("id", subId);
    if (error) return toast.error(error.message);
    setWsSubs((prev) => prev.filter((s) => s.id !== subId));
    toast.success("Entrega eliminada correctamente");
  };

  if (!isTeacher) return <p className="text-muted-foreground">Necesitas rol Docente.</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Talleres</h1>
          <p className="text-sm text-muted-foreground">{workshops.length} talleres creados</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ImportExportMenu
            label="Talleres"
            resourceName="talleres"
            templateCsv={WORKSHOPS_TEMPLATE}
            onExport={() => {
              if (!workshops.length) return "";
              return toCSV(
                workshops.map((w) => ({
                  course_name: w.course?.name ?? "",
                  title: w.title,
                  description: w.description ?? "",
                  instructions: w.instructions ?? "",
                  external_link: w.external_link ?? "",
                  due_date: w.due_date ?? "",
                  max_score: w.max_score,
                  status: w.status,
                })),
              );
            }}
            onImport={async (rows) => {
              if (!user) throw new Error("Sesión no válida");
              const courseByName = new Map(courses.map((c) => [c.name.toLowerCase().trim(), c.id]));
              let created = 0,
                skipped = 0;
              for (const r of rows) {
                const cid = courseByName.get((r.course_name || "").toLowerCase().trim());
                if (!cid || !r.title) {
                  skipped++;
                  continue;
                }
                const { error } = await supabase.from("workshops").insert({
                  course_id: cid,
                  title: r.title,
                  description: r.description || null,
                  instructions: r.instructions || null,
                  external_link: r.external_link || null,
                  due_date: r.due_date ? new Date(r.due_date).toISOString() : null,
                  max_score: Number(r.max_score) || 100,
                  status: r.status || "draft",
                  created_by: user.id,
                });
                if (error) skipped++;
                else created++;
              }
              await load();
              return `${created} talleres creados · ${skipped} omitidos`;
            }}
          />
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-1" />
            Nuevo taller
          </Button>
        </div>
      </div>

      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular="taller"
        entityNamePlural="talleres"
      />

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <MultiSelectHeaderCheckbox state={sel} />
                </TableHead>
                <TableHead>Título</TableHead>
                <TableHead>Curso</TableHead>
                <TableHead>Fecha límite</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workshops.length === 0 && (
                <TableEmpty
                  colSpan={6}
                  icon={Hammer}
                  text="Aún no has creado ningún taller."
                  hint="Crea tu primer taller — puedes asignarlo a varios cursos a la vez."
                  action={
                    <Button size="sm" onClick={openNew}>
                      <Plus className="h-4 w-4 mr-1" />
                      Crear primer taller
                    </Button>
                  }
                />
              )}
              {workshops.map((ws) => (
                <TableRow key={ws.id} data-state={sel.isSelected(ws.id) ? "selected" : undefined}>
                  <TableCell className="w-10">
                    <MultiSelectCheckbox id={ws.id} state={sel} />
                  </TableCell>
                  <TableCell className="font-medium">
                    {ws.title}
                    {ws.external_link && (
                      <ExternalLink className="inline h-3 w-3 ml-1 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{ws.course?.name}</TableCell>
                  <TableCell className="text-sm tabular-nums">{formatDate(ws.due_date)}</TableCell>
                  <TableCell>
                    <StatusBadge status={ws.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <RowAction
                        label="Asignación / excluir estudiantes"
                        icon={Users}
                        onClick={() => openAssign(ws)}
                      />
                      {(ws as any).group_mode &&
                        (ws as any).group_mode !== "individual" && (
                          <RowAction
                            label="Grupos"
                            icon={UsersRound}
                            onClick={() => {
                              setGroupsWs(ws);
                              setGroupsOpen(true);
                            }}
                          />
                        )}
                      <RowAction
                        label="Preguntas del taller"
                        icon={ListChecks}
                        onClick={() => {
                          setQuestionsWs(ws);
                          setQuestionsOpen(true);
                        }}
                      />
                      <RowAction
                        label="Calificar"
                        icon={CheckCircle2}
                        onClick={() => openGrading(ws)}
                      />
                      <RowAction
                        label="Editar"
                        icon={Pencil}
                        onClick={() => {
                          setForm({
                            ...ws,
                            due_date: ws.due_date ? toLocalDatetime(ws.due_date) : "",
                            start_date: (ws as any).start_date
                              ? toLocalDatetime((ws as any).start_date)
                              : "",
                          } as any);
                          setOpen(true);
                        }}
                      />
                      <RowAction
                        label="Duplicar"
                        icon={Copy}
                        onClick={() => duplicateWorkshop(ws)}
                      />
                      <RowAction
                        label="Eliminar"
                        icon={Trash2}
                        tone="destructive"
                        onClick={() => remove(ws.id)}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={open} onOpenChange={workshopDirty.guardOpenChange(setOpen)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar" : "Nuevo"} taller</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2.5">
              <div className="space-y-0.5">
                <Label htmlFor="ws-is-external" className="text-sm">
                  Actividad externa
                </Label>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  Un taller que ocurrió fuera de la plataforma — presencial o
                  hecho en otra herramienta. Solo registras notas para el
                  cálculo del corte.
                </p>
              </div>
              <Switch
                id="ws-is-external"
                checked={!!(form as any).is_external}
                onCheckedChange={(v) =>
                  setForm({ ...form, is_external: v } as any)
                }
              />
            </div>
            {/*
             * Toggle "Trabajo en grupo": cuando está activo, los
             * estudiantes entregan en grupo. La asignación de grupos se
             * configura desde el botón "Grupos" en el grid del taller
             * (sólo modo teacher_assigned por ahora).
             */}
            {!(form as any).is_external && (
              <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2.5">
                <div className="space-y-0.5">
                  <Label htmlFor="ws-group-mode" className="text-sm">
                    Trabajo en grupo
                  </Label>
                  <p className="text-[11px] text-muted-foreground leading-tight">
                    La entrega es del grupo: todos los miembros editan la misma entrega y
                    reciben la misma nota. Después de guardar, configura los grupos desde el
                    botón <strong>Grupos</strong> del taller.
                  </p>
                </div>
                <Switch
                  id="ws-group-mode"
                  checked={((form as any).group_mode ?? "individual") !== "individual"}
                  onCheckedChange={(v) =>
                    setForm({
                      ...form,
                      group_mode: v ? "teacher_assigned" : "individual",
                    } as any)
                  }
                />
              </div>
            )}
            <div>
              <Label required>Título</Label>
              <Input
                value={form.title ?? ""}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div>
              <Label required>
                Cursos{" "}
                <span className="text-xs text-muted-foreground font-normal">
                  {form.id ? "" : "(selecciona uno o más)"}
                </span>
              </Label>
              {form.id ? (
                <Select
                  value={form.course_id}
                  onValueChange={(v) => setForm({ ...form, course_id: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Curso" />
                  </SelectTrigger>
                  <SelectContent>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                        {c.period ? ` (${c.period})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="mt-1.5 max-h-36 overflow-y-auto rounded-md border p-2 space-y-1">
                  {courses.map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer"
                    >
                      <Checkbox
                        checked={selectedCourseIds.has(c.id)}
                        onCheckedChange={() => toggleCourse(c.id)}
                      />
                      <span className="flex-1">{c.name}</span>
                      {c.period && (
                        <Badge variant="outline" className="text-[9px]">
                          {c.period}
                        </Badge>
                      )}
                    </label>
                  ))}
                </div>
              )}
              {!form.id && selectedCourseIds.size > 1 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Se creará una copia del taller en cada curso seleccionado.
                </p>
              )}
            </div>
            <div>
              <Label>
                Corte de evaluación{" "}
                <span className="text-xs text-muted-foreground font-normal">(opcional)</span>
              </Label>
              {(() => {
                const targetCourseIds = form.id
                  ? form.course_id
                    ? [form.course_id]
                    : []
                  : [...selectedCourseIds];
                const availableCuts = cuts.filter((c) => targetCourseIds.includes(c.course_id));
                const showCuts =
                  form.id || selectedCourseIds.size === 1 ? availableCuts : [];
                return (
                  <Select
                    value={form.cut_id ?? "__none__"}
                    onValueChange={(v) =>
                      setForm({ ...form, cut_id: v === "__none__" ? null : v })
                    }
                    disabled={!form.id && selectedCourseIds.size !== 1}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="Sin corte asignado" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">Sin corte asignado</SelectItem>
                      {showCuts.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                );
              })()}
              {!form.id && selectedCourseIds.size > 1 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Selecciona un único curso para asignar un corte.
                </p>
              )}
              {(form.id || selectedCourseIds.size === 1) &&
                cuts.filter((c) =>
                  form.id
                    ? c.course_id === form.course_id
                    : selectedCourseIds.has(c.course_id),
                ).length === 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Este curso aún no tiene cortes definidos.
                  </p>
                )}
            </div>
            {/*
             * Peso del taller dentro del bucket de talleres del corte.
             * Cap = cut.workshop_weight - sum(otros talleres del corte).
             */}
            <div>
              {(() => {
                const selectedCut = form.cut_id ? cuts.find((c) => c.id === form.cut_id) : null;
                const wsBucket = Number(selectedCut?.workshop_weight ?? 0);
                const editingId = (form as any).id as string | undefined;
                const otherWorkshopsSum = workshops
                  .filter((w) => (w as any).cut_id === form.cut_id && w.id !== editingId)
                  .reduce((s, w) => s + Number((w as any).weight ?? 0), 0);
                // Reusa el max ya calculado en el useMemo de arriba; el
                // useEffect garantiza que form.weight nunca lo exceda.
                const wsMax = workshopWeightMax ?? 0;
                const currentWeight = Number((form as any).weight ?? 1) || 0;
                const bucketFull = wsMax === 0 && wsBucket > 0;
                return (
                  <>
                    <Label>Peso del taller (% del bucket de talleres del corte)</Label>
                    <div className="relative mt-1 w-32">
                      <Input
                        type="number"
                        min={0}
                        max={wsMax || undefined}
                        step="0.1"
                        placeholder="1"
                        className="pr-7"
                        disabled={!selectedCut || bucketFull}
                        value={(form as any).weight ?? 1}
                        onChange={(e) => {
                          const raw = e.target.value === "" ? 1 : Number(e.target.value);
                          const capped = wsMax > 0 ? Math.min(raw, wsMax) : raw;
                          setForm({ ...form, weight: capped } as any);
                        }}
                      />
                      <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                        %
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      {selectedCut ? (
                        <>
                          Bucket talleres del corte{" "}
                          <span className="font-medium">{selectedCut.name}</span>: {wsBucket}%.
                          Otros talleres del corte suman {otherWorkshopsSum.toFixed(1)}%, te queda{" "}
                          <strong>{wsMax.toFixed(1)}%</strong> disponible
                          {currentWeight > 0 && wsMax > 0 && (
                            <> (peso actual: {currentWeight.toFixed(1)}%)</>
                          )}
                          .
                          {bucketFull && (
                            <span className="block text-destructive mt-1">
                              El bucket de talleres está lleno. Aumenta workshop_weight del corte o
                              reduce el peso de otros talleres.
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
            </div>
            <div>
              <Label>Descripción</Label>
              <Textarea
                value={form.description ?? ""}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div>
              <Label>Instrucciones</Label>
              <Textarea
                rows={4}
                value={form.instructions ?? ""}
                onChange={(e) => setForm({ ...form, instructions: e.target.value })}
              />
            </div>
            <div>
              <Label>Link externo (opcional)</Label>
              <Input
                placeholder="https://..."
                value={form.external_link ?? ""}
                onChange={(e) => setForm({ ...form, external_link: e.target.value })}
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Fechas</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Visible desde</Label>
                  <DateTimePicker
                    value={(form as any).start_date ?? ""}
                    onChange={(v) => setForm({ ...form, start_date: v } as any)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Fecha límite</Label>
                  <DateTimePicker
                    value={(form.due_date as any) ?? ""}
                    onChange={(v) => setForm({ ...form, due_date: v })}
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label required>Puntaje máximo</Label>
                <Input
                  type="number"
                  value={form.max_score || ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      max_score: e.target.value === "" ? 0 : Number(e.target.value),
                    })
                  }
                  className="mt-1"
                />
              </div>
              <div>
                <Label>Estado</Label>
                <Select
                  value={form.status ?? "draft"}
                  onValueChange={(v) => setForm({ ...form, status: v })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">Borrador</SelectItem>
                    <SelectItem value="published">Publicado</SelectItem>
                    <SelectItem value="closed">Cerrado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-1">
                <Label>Rúbrica de calificación IA</Label>
                <span className="text-xs text-muted-foreground">(JSON, opcional)</span>
                <Dialog>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
                    asChild
                  >
                    <span>
                      <HelpCircle className="h-3.5 w-3.5" />
                    </span>
                  </Button>
                </Dialog>
              </div>
              <div className="rounded-md border bg-muted/30 p-3 mb-2 text-xs text-muted-foreground space-y-1.5">
                <p className="font-medium text-foreground text-xs">¿Cómo funciona?</p>
                <p>
                  Define los criterios que la IA usará para calificar las entregas. Escribe un array
                  JSON donde cada objeto tenga:
                </p>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  <li>
                    <code className="bg-muted px-1 rounded">criterio</code>: nombre del criterio
                    (ej: "Claridad")
                  </li>
                  <li>
                    <code className="bg-muted px-1 rounded">peso</code>: porcentaje del puntaje
                    total (deben sumar 100)
                  </li>
                </ul>
                <p className="font-medium mt-1">Ejemplo:</p>
                <pre className="bg-muted p-2 rounded text-[11px] overflow-x-auto">{`[
  { "criterio": "Claridad y redacción", "peso": 25 },
  { "criterio": "Completitud del contenido", "peso": 40 },
  { "criterio": "Uso correcto de conceptos", "peso": 35 }
]`}</pre>
              </div>
              <Textarea
                rows={3}
                placeholder='[{"criterio": "Claridad", "peso": 30}, {"criterio": "Completitud", "peso": 70}]'
                value={form.rubric ? JSON.stringify(form.rubric, null, 2) : ""}
                onChange={(e) => {
                  try {
                    setForm({ ...form, rubric: JSON.parse(e.target.value) });
                  } catch {
                    /* allow typing */
                  }
                }}
                className="font-mono text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save}>{form.id ? "Guardar" : "Crear"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assignment / Exclusion Dialog (course-level workshop) */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Asignación del taller — {assignWs?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {/* Course selector (read-only — workshops belong to one course) */}
            <div>
              <Label className="text-xs">Curso al que se asigna</Label>
              <Select value={assignWs?.course_id ?? undefined} disabled>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Curso" />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.period ? ` (${c.period})` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Los talleres se asignan a nivel de curso. Para moverlo a otro curso, edita el
                taller.
              </p>
            </div>

            <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
              Por defecto el taller se asigna a <strong>todos</strong> los estudiantes matriculados.
              Desmarca abajo para <strong>excluir</strong> a quienes no deban recibirlo.
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {assignedIds.size} asignados · {students.length - assignedIds.size} excluidos
              </span>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  onClick={assignAll}
                >
                  <CheckSquare className="h-3 w-3" /> Incluir a todos
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  onClick={unassignAll}
                >
                  <XSquare className="h-3 w-3" /> Excluir a todos
                </Button>
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto space-y-0.5 rounded-md border p-1">
              {students.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No hay estudiantes matriculados en este curso.
                </p>
              )}
              {students.map((s) => {
                const included = assignedIds.has(s.id);
                return (
                  <label
                    key={s.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer"
                  >
                    <Checkbox
                      checked={included}
                      onCheckedChange={(v) => toggleAssign(s.id, !!v)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{s.full_name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {s.institutional_email}
                      </div>
                    </div>
                    {included ? (
                      <Badge variant="secondary" className="text-[9px] shrink-0">
                        Incluido
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className="text-[9px] shrink-0 border-destructive/40 text-destructive"
                      >
                        Excluido
                      </Badge>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Grading Dialog */}
      <Dialog open={gradingOpen} onOpenChange={setGradingOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Calificaciones — {gradingWs?.title}</DialogTitle>
          </DialogHeader>
          {/* Course scale info */}
          {(() => {
            const course = courses.find((c) => c.id === gradingWs?.course_id);
            return course ? (
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground rounded-md border p-2 bg-muted/30">
                <span>
                  Escala del curso:{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {course.grade_scale_min}–{course.grade_scale_max}
                  </span>
                </span>
                <span>
                  Aprobar ≥{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {course.passing_grade}
                  </span>
                </span>
                <span>
                  Puntaje taller:{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    0–{gradingWs?.max_score ?? 100}
                  </span>
                </span>
                <span className="font-medium">Decimales con coma (ej. 4,5).</span>
              </div>
            ) : null;
          })()}
          {gradingWs && (gradingWs as any).is_external && (
            <ExternalGradesEditor
              kind="workshop"
              refId={gradingWs.id}
              courseId={gradingWs.course_id}
              maxScore={Number(gradingWs.max_score) || 100}
            />
          )}
          {gradingWs && !(gradingWs as any).is_external && (
            <FraudPanel
              kind="workshop"
              refId={gradingWs.id}
              userNames={Object.fromEntries(
                wsSubs.map((s) => [s.user_id, (s as any).profile?.full_name ?? "—"]),
              )}
            />
          )}
          {/* Bulk AI action */}
          {!(gradingWs as any)?.is_external && wsSubs.length > 0 && (
            <div className="flex items-center justify-between p-3 rounded-md border bg-muted/30">
              <div>
                <p className="text-sm font-medium">Calificar con IA</p>
                <p className="text-xs text-muted-foreground">
                  Califica (o recalifica) todas las entregas con IA. Quedarán en revisión para tu
                  aprobación.
                </p>
              </div>
              <Button size="sm" onClick={gradeAllWithAI} disabled={aiGradingAll}>
                {aiGradingAll ? (
                  <Spinner size="md" className="mr-1" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-1" />
                )}
                Calificar todo con IA
              </Button>
            </div>
          )}
          <div className="space-y-3">
            {!(gradingWs as any)?.is_external && wsSubs.length === 0 && (
              <p className="text-sm text-muted-foreground">No hay entregas aún.</p>
            )}
            {!(gradingWs as any)?.is_external &&
              wsSubs.map((sub) => (
              <Card
                key={sub.id}
                className={
                  sub.status === "ai_revisado" ? "border-amber-400/50 dark:border-amber-500/30" : ""
                }
              >
                <CardContent className="p-4 space-y-3">
                  {/* Header */}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-sm">{sub.profile?.full_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {sub.profile?.institutional_email}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <StatusBadge status={sub.status || "pendiente"} />
                      <RowAction
                        label="Eliminar entrega"
                        icon={Trash2}
                        tone="destructive"
                        onClick={() =>
                          deleteSubmission(sub.id, sub.profile?.full_name ?? "este estudiante")
                        }
                      />
                    </div>
                  </div>

                  {/* Student content */}
                  {sub.content && (
                    <p className="text-sm bg-muted/50 p-2.5 rounded whitespace-pre-wrap">
                      {sub.content}
                    </p>
                  )}
                  {sub.file_url && (
                    <button
                      onClick={async () => {
                        const { data } = await supabase.storage
                          .from("workshop-files")
                          .createSignedUrl(sub.file_url!, 3600);
                        if (data?.signedUrl) window.open(data.signedUrl, "_blank");
                        else toast.error("No se pudo generar el enlace de descarga");
                      }}
                      className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                    >
                      <FileIcon className="h-3.5 w-3.5" />
                      <span className="truncate max-w-[200px]">
                        {sub.file_url.split("/").pop()}
                      </span>
                      <Download className="h-3 w-3 shrink-0" />
                    </button>
                  )}
                  {sub.external_link && (
                    <a
                      href={sub.external_link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-primary flex items-center gap-1"
                    >
                      <ExternalLink className="h-3 w-3" /> {sub.external_link}
                    </a>
                  )}

                  {/* AI Review pending approval */}
                  {sub.status === "ai_revisado" && sub.ai_grade != null && (
                    <div className="rounded-md border border-amber-400/50 bg-amber-50 dark:bg-amber-950/20 p-3 space-y-2">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4 text-amber-500" />
                        <span className="text-sm font-medium">
                          Calificación IA: {sub.ai_grade}/{gradingWs?.max_score ?? 100}
                        </span>
                      </div>
                      {sub.ai_feedback && (
                        <p className="text-sm text-muted-foreground">{sub.ai_feedback}</p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 border-emerald-500/50 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                          onClick={() => approveAIGrade(sub.id)}
                        >
                          <ThumbsUp className="h-3.5 w-3.5" /> Aprobar
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1 border-destructive/50 text-destructive hover:bg-destructive/5"
                          onClick={() => rejectAIGrade(sub.id)}
                        >
                          <ThumbsDown className="h-3.5 w-3.5" /> Rechazar
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Per-question review & grading (editable) */}
                  {wsQuestions.length > 0 && (
                    <Accordion type="single" collapsible className="w-full">
                      <AccordionItem value={`per-q-${sub.id}`} className="border rounded-md">
                        <AccordionTrigger className="px-3 py-2 text-sm">
                          Revisar respuestas por pregunta ({wsQuestions.length})
                        </AccordionTrigger>
                        <AccordionContent className="px-3 pb-3 space-y-3">
                          {wsQuestions.map((q, idx) => {
                            const ans = (answersBySub[sub.id] ?? []).find(
                              (a) => a.question_id === q.id,
                            );
                            const raw =
                              ans?.code_content ??
                              ans?.diagram_code ??
                              ans?.selected_option ??
                              ans?.answer_text ??
                              "";
                            return (
                              <div key={q.id} className="rounded-md border p-3 space-y-2 bg-muted/20">
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant="outline" className="text-[10px]">
                                    {idx + 1}
                                  </Badge>
                                  <Badge variant="secondary" className="text-[10px] capitalize">
                                    {q.type}
                                  </Badge>
                                  <span className="text-[11px] text-muted-foreground">
                                    máx {q.points} pts
                                  </span>
                                </div>
                                <div className="text-sm">
                                  <MarkdownInline>{q.content}</MarkdownInline>
                                </div>
                                <div>
                                  <Label className="text-[11px] text-muted-foreground">
                                    Respuesta del estudiante
                                  </Label>
                                  {q.type === "cerrada" ? (
                                    <div className="text-sm mt-1">
                                      {(() => {
                                        const i =
                                          ans?.selected_option != null
                                            ? Number(ans.selected_option)
                                            : -1;
                                        const choice = q.options?.choices?.[i];
                                        const correct = q.options?.correct_index;
                                        return choice != null ? (
                                          <span
                                            className={
                                              correct === i
                                                ? "text-emerald-600 dark:text-emerald-400"
                                                : "text-destructive"
                                            }
                                          >
                                            {String.fromCharCode(65 + i)}. {choice}
                                          </span>
                                        ) : (
                                          <span className="italic text-muted-foreground">
                                            Sin respuesta
                                          </span>
                                        );
                                      })()}
                                    </div>
                                  ) : raw ? (
                                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-background border p-2 text-xs whitespace-pre-wrap font-mono">
                                      {raw}
                                    </pre>
                                  ) : (
                                    <p className="text-xs italic text-muted-foreground mt-1">
                                      Sin respuesta
                                    </p>
                                  )}
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-[120px_1fr] gap-2">
                                  <div>
                                    <Label className="text-[11px]">Calificación IA</Label>
                                    <DecimalInput
                                      min={0}
                                      max={q.points}
                                      value={ans?.ai_grade ?? null}
                                      onChange={(v) =>
                                        patchAnswer(sub.id, q.id, { ai_grade: v })
                                      }
                                      className="h-8 text-sm mt-1"
                                    />
                                  </div>
                                  <div>
                                    <Label className="text-[11px]">Retroalimentación</Label>
                                    <Textarea
                                      rows={2}
                                      value={ans?.ai_feedback ?? ""}
                                      onChange={(e) =>
                                        patchAnswer(sub.id, q.id, { ai_feedback: e.target.value })
                                      }
                                      className="text-sm mt-1"
                                    />
                                  </div>
                                </div>
                                <div className="flex gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => saveAnswerGrade(sub.id, q.id)}
                                    disabled={savingAnswerId === ans?.id}
                                  >
                                    {savingAnswerId === ans?.id ? (
                                      <Spinner size="sm" className="mr-1" />
                                    ) : (
                                      <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                                    )}
                                    Guardar pregunta
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => aiRegradeAnswer(sub.id, q, ans)}
                                    disabled={aiGradingAnswerId === ans?.id}
                                  >
                                    {aiGradingAnswerId === ans?.id ? (
                                      <Spinner size="sm" className="mr-1" />
                                    ) : (
                                      <Sparkles className="h-3.5 w-3.5 mr-1" />
                                    )}
                                    Recalificar IA
                                  </Button>
                                </div>
                                <FeedbackThread
                                  parentKind="workshop"
                                  questionId={q.id}
                                  submissionId={sub.id}
                                  isTeacher
                                />
                              </div>
                            );
                          })}
                          <div className="flex justify-end">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                const newFinal = recomputeFinalGrade(sub.id);
                                setWsSubs((prev) =>
                                  prev.map((s) =>
                                    s.id === sub.id ? { ...s, final_grade: newFinal } : s,
                                  ),
                                );
                                toast.info(
                                  `Calificación global recalculada: ${newFinal}/${gradingWs?.max_score ?? 100}. Pulsa "Guardar calificación" para persistir.`,
                                );
                              }}
                            >
                              Recalcular calificación global
                            </Button>
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    </Accordion>
                  )}

                  {/* Manual grading / override */}
                  <div className="space-y-2">
                    <div>
                      <Label className="text-xs">Calificación final</Label>
                      <DecimalInput
                        min={0}
                        max={gradingWs?.max_score ?? 100}
                        value={sub.final_grade ?? null}
                        onChange={(v) => {
                          setWsSubs((prev) =>
                            prev.map((s) =>
                              s.id === sub.id ? { ...s, final_grade: v } : s,
                            ),
                          );
                        }}
                        className="h-8 text-sm mt-1"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Retroalimentación</Label>
                      <Textarea
                        rows={3}
                        value={sub.teacher_feedback ?? ""}
                        onChange={(e) => {
                          setWsSubs((prev) =>
                            prev.map((s) =>
                              s.id === sub.id ? { ...s, teacher_feedback: e.target.value } : s,
                            ),
                          );
                        }}
                        className="text-sm mt-1"
                        placeholder="Escribe tu retroalimentación detallada..."
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          saveGrade(sub.id, sub.final_grade ?? 0, sub.teacher_feedback ?? "")
                        }
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Guardar calificación
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => gradeOneWithAI(sub)}
                        disabled={aiGradingId === sub.id}
                      >
                        {aiGradingId === sub.id ? (
                          <Spinner size="sm" className="mr-1" />
                        ) : (
                          <Sparkles className="h-3.5 w-3.5 mr-1" />
                        )}
                        {sub.status === "calificado" || sub.status === "ai_revisado"
                          ? "Recalificar con IA"
                          : "Calificar con IA"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Workshop groups editor dialog */}
      <Dialog open={groupsOpen} onOpenChange={setGroupsOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Grupos del taller {groupsWs ? `— ${groupsWs.title}` : ""}
            </DialogTitle>
          </DialogHeader>
          {groupsWs && (
            <WorkshopGroupsEditor
              workshopId={groupsWs.id}
              courseId={groupsWs.course_id}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Workshop questions editor dialog */}
      <Dialog open={questionsOpen} onOpenChange={setQuestionsOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Preguntas del taller {questionsWs ? `— ${questionsWs.title}` : ""}
            </DialogTitle>
          </DialogHeader>
          {questionsWs && (
            <TeacherWorkshopQuestionsEditor
              workshopId={questionsWs.id}
              courseLanguage={
                (courses.find((c) => c.id === questionsWs.course_id) as any)?.language ?? "es"
              }
            />
          )}
        </DialogContent>
      </Dialog>

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={selectedWorkshopItems}
        entityNameSingular="taller"
        entityNamePlural="talleres"
        extraWarning="Se eliminarán también todas las preguntas, asignaciones y entregas de los talleres seleccionados."
        onConfirm={handleBulkDelete}
      />
    </div>
  );
}

function toLocal(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert an ISO date string to datetime-local input format */
function toLocalDatetime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}
