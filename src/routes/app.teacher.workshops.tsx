import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { softDelete, softDeleteMany } from "@/modules/trash/soft-delete";
import { useAuth } from "@/hooks/use-auth";
import { isStaffRole } from "@/shared/lib/roles";
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
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { DuplicateAssessmentDialog } from "@/shared/components/DuplicateAssessmentDialog";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { DateCell } from "@/components/ui/date-cell";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import { ExternalGradesEditor } from "@/modules/grading/ExternalGradesEditor";
import { WorkshopGroupsEditor } from "@/modules/workshops/WorkshopGroupsEditor";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import { logEvent } from "@/shared/lib/audit";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import { friendlyError, friendlyUniqueViolation } from "@/shared/lib/db-errors";
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
  Copy,
  ListChecks,
  Hammer,
  UsersRound,
  AlertTriangle,
  Search,
  X,
  Bot,
  ChevronRight,
  ChevronLeft,
  ChevronUp,
  ChevronDown,
  Check,
  Eye,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { formatPercent } from "@/shared/lib/format";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { ListFilters } from "@/components/ui/list-filters";
import { CourseListCell } from "@/components/ui/course-list-cell";
import { StatCard } from "@/components/ui/stat-card";
import { Lock } from "lucide-react";
import { toCSV } from "@/shared/lib/csv";
import { TeacherWorkshopQuestionsEditor } from "@/modules/workshops/WorkshopQuestions";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { ConversationSection } from "@/modules/grading/ConversationSection";
// FraudPanel quitado: la detección de IA y copia ahora se muestra POR
// pregunta dentro del Accordion (mismo patrón del monitor de exámenes).
import { computeIntegritySuggestion } from "@/modules/exams/integrity";
import { computeWorkshopAlerts } from "@/modules/workshops/workshop-integrity-alerts";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DateTimePicker } from "@/components/ui/date-picker";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const WORKSHOPS_TEMPLATE = `course_name,title,description,instructions,external_link,due_date,status
Programación I,Taller de listas,Práctica de listas enlazadas,Implementa las funciones del enunciado,https://github.com/repo,2025-09-15T23:59,published
Programación I,Taller de árboles,,Resuelve los ejercicios 1-5,,2025-09-30T23:59,draft`;

export const Route = createFileRoute("/app/teacher/workshops")({
  component: TeacherWorkshops,
  validateSearch: (
    s: Record<string, unknown>,
  ): {
    workshop?: string;
    id?: string;
    submission?: string;
    question?: string;
    edit?: string;
  } => ({
    workshop: typeof s.workshop === "string" ? s.workshop : undefined,
    id: typeof s.id === "string" ? s.id : undefined,
    submission: typeof s.submission === "string" ? s.submission : undefined,
    question: typeof s.question === "string" ? s.question : undefined,
    // `edit=<id>` viene de Contenidos al crear un taller desde un
    // contenido generado: abre el dialog de edición en lugar del de
    // calificación.
    edit: typeof s.edit === "string" ? s.edit : undefined,
  }),
});

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
  start_date: string | null;
  rubric: any;
  max_score: number;
  status: string;
  is_external?: boolean | null;
  group_mode?: "individual" | "teacher_assigned" | "self_signup" | "group_required";
  /** Intentos máximos para este taller. NULL → usa el default global
   *  (app_settings.default_workshop_max_attempts). */
  max_attempts?: number | null;
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
  /** Señales de IA a nivel submission (fallback cuando la entrega es
   *  monolítica sin preguntas; para preguntas usamos ai_likelihood de
   *  workshop_submission_answers). */
  ai_detected?: boolean | null;
  ai_detected_score?: number | null;
  ai_detected_reasons?: string | null;
  profile?: { full_name: string; institutional_email: string };
};

/** Par de copia detectado entre dos estudiantes para UNA pregunta. */
type WsSimilarityPair = {
  id: string;
  question_id: string | null;
  user_a: string;
  user_b: string;
  score: number;
  reasons: string | null;
  reviewed_at: string | null;
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
  /** Probabilidad estimada (0..1) de que la respuesta sea generada por IA.
   *  Persistida por respuesta (migración 20260510190000) para que la
   *  sugerencia de penalización por integridad se calcule por pregunta. */
  ai_likelihood: number | null;
  ai_reasons: string | null;
  /** Cuándo el docente marcó esta sospecha de IA POR PREGUNTA como
   *  revisada. NULL = pendiente. Igual semántica que el `ai_review_at`
   *  del breakdown de exámenes. Migración 20260519100000. */
  ai_review_at: string | null;
};

function TeacherWorkshops() {
  const { t } = useTranslation();

  const { user, roles, loading: authLoading } = useAuth();
  const confirm = useConfirm();
  // Gate IA: cubre los tres handlers que invocan IA acá —
  // aiRegradeAnswer (re-grade pregunta), gradeOneWithAI (calificar
  // workshop completo) y runDetectCopies (detectar plagio).
  const aiGate = useAiAuthorizationGate();
  const [courses, setCourses] = useState<Course[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  /** Mapa workshop_id → courseIds[]. Poblado desde workshop_courses (M:N).
   *  Para talleres single-course tiene un único course_id; para multi
   *  trae varios. Usado por el grid (badges) y el edit dialog (set inicial). */
  const [workshopCourses, setWorkshopCourses] = useState<Map<string, string[]>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [aiErrorsByWorkshop, setAiErrorsByWorkshop] = useState<Record<string, number>>({});
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  const [cutFilter, setCutFilter] = useState<string | null>(null);
  // Filtra por título (ASCII case-insensitive), por course_id si hay
  // curso seleccionado, y por cut_id si hay corte. Se usa tanto para
  // el render de la tabla como para el multi-select (no queremos que
  // el "seleccionar todo" abarque filas ocultas por el filtro).
  const filteredWorkshops = useMemo(() => {
    const q = search.trim().toLowerCase();
    return workshops.filter((w) => {
      if (courseFilter) {
        // Multi-curso: el filtro matchea si CUALQUIER curso del taller
        // coincide (workshop_courses) — no solo el course_id primario.
        const wcIds = workshopCourses.get(w.id);
        const allCourseIds = wcIds && wcIds.length > 0 ? wcIds : [w.course_id];
        if (!allCourseIds.includes(courseFilter)) return false;
      }
      if (cutFilter && (w as any).cut_id !== cutFilter) return false;
      if (q && !w.title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [workshops, search, courseFilter, cutFilter, workshopCourses]);

  // Quick-stats estables del listado completo (no se mueven al filtrar).
  // Cuatro tiles: borradores, publicados, cerrados, externos. La idea
  // es darle al docente un pulso rápido del estado de sus talleres sin
  // tener que scrollear o filtrar.
  const workshopStats = useMemo(() => {
    let draft = 0,
      published = 0,
      closed = 0,
      external = 0;
    for (const w of workshops) {
      if ((w as any).is_external) external++;
      const s = w.status;
      if (s === "draft") draft++;
      else if (s === "published") published++;
      else if (s === "closed") closed++;
    }
    return { draft, published, closed, external };
  }, [workshops]);

  const sel = useMultiSelect(filteredWorkshops);

  // Paginación client-side sobre la lista filtrada. El multi-select
  // sigue trabajando sobre `filteredWorkshops` (todas las páginas) para
  // que "seleccionar todos" abarque coincidencias del filtro, no solo
  // los visibles. resetKey vuelve a la página 1 cuando cambian los
  // filtros activos.
  const pagination = usePagination(filteredWorkshops, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:teacher_workshops",
    resetKey: `${search}|${courseFilter ?? ""}|${cutFilter ?? ""}`,
  });

  const handleBulkDelete = async (ids: string[]) => {
    const { error } = await softDeleteMany("workshops", ids);
    if (error) throw new Error(error.message);
    toast.success(`${ids.length} taller(es) enviado(s) a papelera`);
    void logEvent({
      action: "workshop.deleted",
      category: "workshop",
      actorRole: roles[0],
      metadata: { count: ids.length, ids },
    });
    sel.clear();
    load();
  };

  const selectedWorkshopItems = useMemo(
    () =>
      filteredWorkshops
        .filter((w) => sel.isSelected(w.id))
        .map((w) => ({ id: w.id, label: w.title })),
    [filteredWorkshops, sel],
  );
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Workshop>>({});
  /** Lista N de videos introductorios del taller. Vive separada del
   *  `form` porque se persiste en otra tabla (`workshop_intro_videos`).
   *  Se hidrata vía useEffect cuando `form.id` cambia (apertura para
   *  editar) y se sincroniza después del UPSERT del workshop principal. */
  const [formIntroVideos, setFormIntroVideos] = useState<
    Array<{ library_id: string | null; url: string; title: string }>
  >([]);
  // Biblioteca de videos para el selector del form de taller. Carga
  // perezosa: solo cuando el dialog se abre.
  const [videoLibrary, setVideoLibrary] = useState<
    Array<{ id: string; title: string; provider: string; url: string }>
  >([]);
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const { data } = await supabase
        .from("videos")
        .select("id, title, provider, url")
        .eq("is_archived", false)
        .order("title");
      setVideoLibrary(
        (data ?? []) as Array<{ id: string; title: string; provider: string; url: string }>,
      );
    })();
  }, [open]);
  // Hidratar la lista de videos del taller al editar. Se dispara cuando
  // cambia `form.id` y el dialog está abierto. En create (form.id
  // ausente) se mantiene en [] gracias al reset de openNew.
  useEffect(() => {
    if (!open) return;
    const wsId = (form as any).id as string | undefined;
    if (!wsId) return;
    let cancelled = false;
    void (async () => {
      const { data: videos } = await supabase
        .from("workshop_intro_videos")
        .select("url, title, position")
        .eq("workshop_id", wsId)
        .order("position");
      if (cancelled) return;
      setFormIntroVideos(
        (
          (videos as Array<{ url: string; title: string | null; position: number }> | null) ?? []
        ).map((v) => ({
          library_id: null,
          url: v.url,
          title: v.title ?? "",
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, (form as any).id]);
  // Curso original al abrir el dialog de edición. Si al guardar el
  // docente cambió el curso, hay que limpiar workshop_assignments del
  // curso anterior y re-asignar matriculados del nuevo curso.
  const [originalCourseId, setOriginalCourseId] = useState<string | null>(null);

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
  /** Cuando está poblado, el modal cambia del GRID de estudiantes al
   *  DETALLE pregunta-por-pregunta de ese estudiante. Patrón análogo al
   *  monitor de exámenes (state `viewingId`/`viewingSub`). null = grid.
   *  Se resetea al abrir el modal de otro taller. */
  const [viewingSubId, setViewingSubId] = useState<string | null>(null);
  // Buscador dentro del modal de calificaciones — filtra entregas por
  // nombre / correo del estudiante. Se limpia al abrir el dialog para
  // que la próxima vez no muestre filtrado stale.
  const [gradingSearch, setGradingSearch] = useState("");
  // Submission a destacar/scrollear cuando el dialog abre desde un
  // deep-link (?submission=ID): se setea en el effect de la URL y el
  // effect de wsSubs lo consume.
  const [highlightSubId, setHighlightSubId] = useState<string | null>(null);
  // Pregunta a destacar dentro del accordion expandido cuando el
  // deep-link viene del modal de Conversaciones abiertas (?question=ID).
  const [highlightWsQuestionId, setHighlightWsQuestionId] = useState<string | null>(null);
  // Per-question grading: questions of the workshop, and answers grouped
  // by submission. Edits live in `answersBySub` until the teacher saves a
  // single question or recomputes the global grade.
  const [wsQuestions, setWsQuestions] = useState<WsQuestion[]>([]);
  const [answersBySub, setAnswersBySub] = useState<Record<string, WsAnswer[]>>({});
  const [savingAnswerId, setSavingAnswerId] = useState<string | null>(null);
  const [aiGradingAnswerId, setAiGradingAnswerId] = useState<string | null>(null);
  // Pares de copia detectados (similarity_pairs) para este taller —
  // cruzados por user_id para sugerir penalización por plagio en la
  // grilla de calificación. Se recargan junto con las submissions.
  const [wsSimilarityPairs, setWsSimilarityPairs] = useState<WsSimilarityPair[]>([]);
  // Resumen de "Conversación con el estudiante" por (submissionId,
  // questionId) — { count, pending }. Pending=true cuando el último
  // mensaje del thread lo escribió el alumno (espera respuesta del
  // docente). Se carga una sola vez en openGrading.
  const [wsThreadsByQ, setWsThreadsByQ] = useState<
    Record<string, { count: number; pending: boolean }>
  >({});

  // Assignment
  const [assignWs, setAssignWs] = useState<Workshop | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());
  const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set());
  // Per-course cut+weight used only during multi-course creation (not editing).
  const [courseCuts, setCourseCuts] = useState<
    Record<string, { cut_id: string | null; weight: number }>
  >({});

  // Questions editor
  const [questionsWs, setQuestionsWs] = useState<Workshop | null>(null);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupsWs, setGroupsWs] = useState<Workshop | null>(null);

  /**
   * Abre el editor de grupos del taller. Si el taller está en modo
   * `individual` (default histórico), lo cambia a `teacher_assigned`
   * primero — así el docente no tiene que entrar a editar el form solo
   * para activar el toggle. Los grupos creados aquí son utilizables
   * inmediatamente.
   */
  const openGroupsForWorkshop = async (ws: Workshop) => {
    const mode = (ws as any).group_mode ?? "individual";
    let updatedWs = ws;
    if (mode === "individual") {
      const { error } = await (supabase as any)
        .from("workshops")
        .update({ group_mode: "teacher_assigned" })
        .eq("id", ws.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      updatedWs = { ...ws, group_mode: "teacher_assigned" } as Workshop;
      setWorkshops((prev) => prev.map((w) => (w.id === ws.id ? updatedWs : w)));
      toast.success(t("workshop.groupActivated"));
    }
    setGroupsWs(updatedWs);
    setGroupsOpen(true);
  };

  // SA accede a pantallas Docente para soporte / diagnóstico — sin SA
  // en el set, recibía "Necesitas rol Docente" silencioso al entrar.
  const isTeacher = isStaffRole(roles);

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
    const [
      { data: cs, error: csErr },
      { data: ws, error: wsErr },
      { data: cuts },
      { data: aiErr },
      { data: wcRows },
    ] = await Promise.all([
      supabase
        .from("courses")
        .select("id, name, period, grade_scale_min, grade_scale_max, passing_grade")
        .order("name"),
      supabase
        .from("workshops")
        .select("*, course:courses(name, period)")
        // Ocultar talleres en papelera de la lista del docente.
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      (supabase as any)
        .from("grade_cuts")
        .select(
          "id, course_id, name, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
        )
        .order("position"),
      (supabase as any).rpc("count_ai_errors_per_workshop"),
      // workshop_courses: tabla M:N introducida en mig 20260704000000.
      // Mapeamos {workshop_id → course_id[]} para que la columna 'Curso'
      // del grid pueda mostrar N badges en talleres multi-curso.
      (supabase as any).from("workshop_courses").select("workshop_id, course_id"),
    ]);
    // Si las queries crítica fallan (courses, workshops), marcamos
    // loadError para mostrar ErrorState en vez de "0 talleres" silencioso.
    if (csErr || wsErr) {
      setLoadError(friendlyError(csErr ?? wsErr, "No pudimos cargar los talleres."));
      return;
    }
    setLoadError(null);
    setCourses((cs ?? []) as Course[]);
    setWorkshops((ws ?? []) as any);
    setCuts((cuts ?? []) as Cut[]);
    const errMap: Record<string, number> = {};
    for (const row of (aiErr ?? []) as Array<{ workshop_id: string; error_count: number }>) {
      errMap[row.workshop_id] = Number(row.error_count) || 0;
    }
    setAiErrorsByWorkshop(errMap);
    // Index workshop_courses → courseIds[] por workshop_id.
    const wcMap = new Map<string, string[]>();
    for (const r of (wcRows ?? []) as Array<{ workshop_id: string; course_id: string }>) {
      const arr = wcMap.get(r.workshop_id) ?? [];
      arr.push(r.course_id);
      wcMap.set(r.workshop_id, arr);
    }
    setWorkshopCourses(wcMap);
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Deep-link desde notificación o modal de Conversaciones abiertas:
  //   ?workshop=WS_ID&submission=SUB_ID&question=Q_ID  (vista profunda)
  //   ?id=WS_ID                                         (legacy)
  // Si el taller ya no existe (eliminado o sin permiso), toast claro y
  // limpia la URL.
  const [autoOpenedFromUrl, setAutoOpenedFromUrl] = useState(false);
  useEffect(() => {
    if (autoOpenedFromUrl || workshops.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const wsParam = params.get("workshop") ?? params.get("id");
    const subParam = params.get("submission");
    const qParam = params.get("question");
    // `?edit=<ID>` viene de Contenidos cuando el docente acaba de
    // crear un taller desde el contenido generado. Abre directamente
    // el dialog de edición en lugar del de calificación, para que
    // continúe ajustando título, fechas, peso, rúbrica y luego active
    // el botón "Generar preguntas con IA" del editor — sin tener que
    // buscar el taller recién creado en el grid.
    const editParam = params.get("edit");
    if (editParam) {
      const ws = workshops.find((w) => w.id === editParam);
      if (ws) {
        setForm({
          ...ws,
          due_date: ws.due_date ? toLocalDatetime(ws.due_date) : "",
          start_date: ws.start_date ? toLocalDatetime(ws.start_date) : "",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        setOriginalCourseId(ws.course_id ?? null);
        setOpen(true);
      } else {
        toast.info("El taller referenciado en la URL ya no existe o no tienes acceso a él.");
      }
      const url = new URL(window.location.href);
      url.searchParams.delete("edit");
      window.history.replaceState({}, "", url.toString());
      setAutoOpenedFromUrl(true);
      return;
    }
    if (wsParam) {
      const ws = workshops.find((w) => w.id === wsParam);
      if (ws) {
        if (subParam) setHighlightSubId(subParam);
        if (qParam) setHighlightWsQuestionId(qParam);
        void openGrading(ws as Workshop);
      } else {
        toast.info(
          "El taller referenciado en la notificación ya no existe o no tienes acceso a él.",
        );
      }
      const url = new URL(window.location.href);
      url.searchParams.delete("workshop");
      url.searchParams.delete("submission");
      url.searchParams.delete("question");
      url.searchParams.delete("id");
      window.history.replaceState({}, "", url.toString());
    }
    setAutoOpenedFromUrl(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workshops, autoOpenedFromUrl]);

  // Cuando el grading dialog tiene cargadas las submissions y hay un
  // highlightSubId pendiente, scrollea a esa Card y aplica un ring
  // temporal. Se limpia tras el efecto para no re-disparar.
  useEffect(() => {
    if (!gradingOpen || !highlightSubId || wsSubs.length === 0) return;
    const target = wsSubs.find((s) => s.id === highlightSubId);
    if (!target) {
      setHighlightSubId(null);
      return;
    }
    // Deep-link: si vienen `submission` o `question` en la URL, saltamos
    // directo al detalle de ese estudiante (en lugar de quedarse en el
    // grid y forzar al docente a clickear "Ver"). Patrón del monitor.
    setViewingSubId(highlightSubId);
    const t = setTimeout(() => {
      const el = document.getElementById(`ws-sub-${highlightSubId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    const clear = setTimeout(() => setHighlightSubId(null), 3500);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [gradingOpen, highlightSubId, wsSubs]);

  // Cuando hay highlightWsQuestionId pendiente y la submission destacada
  // ya está renderizada con sus answers cargadas, scrollea + ring a la
  // card de la pregunta dentro del accordion (que se auto-expande vía
  // openExpandedSubs). Se limpia tras el efecto.
  useEffect(() => {
    if (!gradingOpen || !highlightWsQuestionId || !highlightSubId) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`ws-q-${highlightSubId}-${highlightWsQuestionId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 250);
    const clear = setTimeout(() => setHighlightWsQuestionId(null), 3500);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [gradingOpen, highlightWsQuestionId, highlightSubId, wsSubs]);

  const openNew = () => {
    const now = new Date();
    const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const first = courses[0]?.id;
    setForm({
      title: "",
      course_id: first,
      cut_id: null,
      description: "",
      instructions: "",
      external_link: "",
      // "Visible desde" arranca AHORA — el docente típicamente quiere
      // que el taller se publique inmediato. Si necesita programar al
      // futuro, edita el campo. Antes quedaba vacío y obligaba a un
      // paso extra para escribir la fecha.
      start_date: toLocal(now),
      due_date: toLocal(due),
      max_score: 100,
      status: "draft",
      rubric: null,
    });
    setOriginalCourseId(null);
    setSelectedCourseIds(new Set(first ? [first] : []));
    setCourseCuts(first ? { [first]: { cut_id: null, weight: 1 } } : {});
    setFormIntroVideos([]);
    setOpen(true);
  };

  const toggleCourse = (id: string) => {
    setSelectedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const first = [...next][0];
      if (first) setForm((f) => ({ ...f, course_id: first }));
      setCourseCuts((prevCuts) => {
        const updated: Record<string, { cut_id: string | null; weight: number }> = {};
        for (const cid of next) {
          updated[cid] = prevCuts[cid] ?? { cut_id: null, weight: 1 };
        }
        return updated;
      });
      return next;
    });
  };

  /**
   * DELETE all + INSERT all de `workshop_intro_videos` para un taller.
   * Se invoca después de crear o actualizar el workshop. Acepta la
   * lista cruda del form (con `library_id` que no se persiste) y la
   * normaliza filtrando URLs vacías.
   */
  const syncWorkshopIntroVideos = async (
    workshopId: string,
    rows: Array<{ library_id: string | null; url: string; title: string }>,
  ) => {
    const cleaned = rows
      .map((v, idx) => ({ url: v.url.trim(), title: v.title.trim() || null, position: idx }))
      .filter((v) => v.url.length > 0);
    await supabase.from("workshop_intro_videos").delete().eq("workshop_id", workshopId);
    if (cleaned.length === 0) return;
    const insertRows = cleaned.map((v) => ({
      workshop_id: workshopId,
      url: v.url,
      title: v.title,
      position: v.position,
    }));
    const { error: vErr } = await supabase.from("workshop_intro_videos").insert(insertRows);
    if (vErr) {
      console.warn("[workshops] sync workshop_intro_videos failed", vErr);
      toast.error(`No se pudieron guardar los videos introductorios: ${friendlyError(vErr)}`);
    }
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
    const isMultiCourse = !form.id && courseIds.length > 1;
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
      // Override de intentos máximos. NULL → hereda app_settings.default_workshop_max_attempts.
      max_attempts:
        form.max_attempts != null && Number(form.max_attempts) > 0
          ? Number(form.max_attempts)
          : null,
      status: isExternal ? "closed" : (form.status ?? "draft"),
      rubric: form.rubric ?? null,
      created_by: user.id,
      // Multi-course: cut_id+weight are set per-course in the loop below.
      cut_id: isMultiCourse ? null : form.cut_id || null,
      is_external: isExternal,
      group_mode: groupMode,
    };
    if (!isMultiCourse && form.cut_id && (form as any).weight != null) {
      // Single course (create or edit): validate against the pre-computed cap.
      const requested = Math.max(0, Number((form as any).weight));
      const cap = workshopWeightMax ?? 0;
      if (requested > cap + 0.01) {
        toast.error(
          `El peso del taller (${requested}%) supera el bucket disponible del corte ` +
            `(${cap.toFixed(2)}% restantes). Reduce el peso o ajusta los demás talleres del corte.`,
        );
        return;
      }
      basePayload.weight = requested;
    }
    if (isMultiCourse) {
      // Validate bucket for each course independently.
      for (const cid of courseIds) {
        const cc = courseCuts[cid];
        if (!cc?.cut_id) continue;
        const requested = Math.max(0, Number(cc.weight ?? 1));
        const cut = cuts.find((c) => c.id === cc.cut_id);
        const bucket = Number(cut?.workshop_weight ?? 0);
        const sumOthers = workshops
          .filter((w) => (w as any).cut_id === cc.cut_id)
          .reduce((s, w) => s + Number((w as any).weight ?? 0), 0);
        const available = Math.max(0, bucket - sumOthers);
        if (requested > available + 0.01) {
          const cName = courses.find((c) => c.id === cid)?.name ?? cid;
          toast.error(
            `${cName}: El peso del taller (${requested}%) supera el bucket disponible del corte ` +
              `(${available.toFixed(2)}% restantes). Reduce el peso o ajusta los demás talleres del corte.`,
          );
          return;
        }
      }
    }

    if (form.id) {
      const courseChanged = !!originalCourseId && form.course_id !== originalCourseId;
      if (courseChanged) {
        // Mismo flujo que en exam editor: el cambio de curso reasigna a
        // los matriculados del nuevo curso. Las entregas existentes se
        // mantienen pero solo el nuevo curso ve el taller.
        const ok = await confirm({
          title: t("workshop.changeCourseTitle"),
          description: t("workshop.changeCourseBody"),
          confirmLabel: t("workshop.changeCourseConfirm"),
          tone: "warning",
        });
        if (!ok) return;
      }
      const { error } = await supabase
        .from("workshops")
        .update({ ...basePayload, course_id: form.course_id! })
        .eq("id", form.id);
      if (error) return toast.error(friendlyUniqueViolation(error) ?? friendlyError(error));
      // ── Sync workshop_courses (M:N) ──
      // El form en edit-mode permite gestionar TODOS los cursos del
      // taller. Estrategia DELETE + INSERT en batch — atómica por
      // workshop_id (la tabla tiene UNIQUE workshop_id,course_id que
      // previene races dentro del mismo workshop). Las entregas y
      // assignments siguen ligadas via workshop_id directo, no via
      // workshop_courses, así que no se borran.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny2 = supabase as any;
      const editedCourseIds = [...selectedCourseIds];
      // Si el set quedó vacío (edge case), forzamos al menos el primario.
      const finalCourseIds = editedCourseIds.length > 0 ? editedCourseIds : [form.course_id!];
      await dbAny2.from("workshop_courses").delete().eq("workshop_id", form.id);
      const wcEditRows = finalCourseIds.map((cid) => {
        const cc = courseCuts[cid];
        return {
          workshop_id: form.id,
          course_id: cid,
          cut_id: cc?.cut_id || (cid === form.course_id ? form.cut_id || null : null),
          weight:
            cc?.weight != null
              ? Math.max(0, Number(cc.weight))
              : cid === form.course_id && (form as any).weight != null
                ? Math.max(0, Number((form as any).weight))
                : null,
        };
      });
      await dbAny2.from("workshop_courses").insert(wcEditRows);
      // ── Sync `workshop_intro_videos` (lista N) ──
      // Estrategia idéntica a proyectos: DELETE all + INSERT all. El
      // CASCADE de `workshop_submission_video_views` resetea el progreso
      // de los estudiantes — esperado cuando el docente reedita la lista.
      await syncWorkshopIntroVideos(form.id, formIntroVideos);
      if (courseChanged) {
        await supabase.from("workshop_assignments").delete().eq("workshop_id", form.id);
      }
      // Auto-assign en TODOS los cursos del taller (no solo el primario).
      // Es idempotente — re-aplica matriculados sin duplicar assignments.
      if (form.status === "published" || courseChanged) {
        for (const cid of finalCourseIds) {
          await autoAssignWorkshop(form.id, cid);
        }
      }
      if (form.status === "published" || courseChanged) {
        await supabase.rpc("notify_course_students", {
          _course_id: form.course_id!,
          _title: courseChanged ? "Taller movido a este curso" : "Taller actualizado",
          _body: `Se actualizó el taller "${form.title}"`,
          _kind: "workshop",
          _link: "/app/student/workshops",
        });
      }
      toast.success(t("workshop.saved"));
      void logEvent({
        action: "workshop.updated",
        category: "workshop",
        actorRole: roles[0],
        entityType: "workshop",
        entityId: form.id,
        entityName: form.title,
        courseId: form.course_id ?? undefined,
        courseName: courses.find((c) => c.id === form.course_id)?.name,
      });
    } else {
      // M:N — 1 INSERT en workshops + N INSERTs en workshop_courses.
      // El curso "primario" (workshops.course_id) es el primero del set
      // por compat con queries legacy. workshops.weight / cut_id usan los
      // valores del PRIMER curso; los demás cursos viven en
      // workshop_courses.weight / cut_id que pueden diferir.
      const firstCid = courseIds[0];
      const firstCc = isMultiCourse ? courseCuts[firstCid] : undefined;
      const primaryPayload: Record<string, any> = {
        ...basePayload,
        course_id: firstCid,
      };
      if (isMultiCourse && firstCc?.cut_id) {
        primaryPayload.cut_id = firstCc.cut_id;
        if (firstCc.weight != null) {
          primaryPayload.weight = Math.max(0, Number(firstCc.weight));
        }
      }
      const { data: newWs, error } = await supabase
        .from("workshops")
        .insert(primaryPayload as any)
        .select()
        .single();
      if (error) {
        toast.error(friendlyUniqueViolation(error) ?? friendlyError(error));
        return;
      }
      if (!newWs) {
        toast.error("No se pudo crear el taller");
        return;
      }
      // Insertamos las N relaciones workshop_courses. La primera dup-checks
      // por UNIQUE pero ON CONFLICT no aplica acá; insertamos array de una.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const wcRows = courseIds.map((cid) => {
        const cc = isMultiCourse ? courseCuts[cid] : undefined;
        return {
          workshop_id: newWs.id,
          course_id: cid,
          cut_id: cc?.cut_id || (cid === firstCid ? form.cut_id || null : null),
          weight:
            cc?.weight != null
              ? Math.max(0, Number(cc.weight))
              : cid === firstCid && (form as any).weight != null
                ? Math.max(0, Number((form as any).weight))
                : null,
        };
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: wcErr } = await (supabase as any).from("workshop_courses").insert(wcRows);
      if (wcErr) {
        toast.error(friendlyUniqueViolation(wcErr) ?? friendlyError(wcErr));
        return;
      }
      await syncWorkshopIntroVideos(newWs.id, formIntroVideos);
      // Auto-assign + notify por cada curso. RLS de workshops sigue
      // filtrando por course_id legacy, así que para que el alumno del
      // segundo curso vea el taller, dependemos de la próxima fase del
      // refactor RLS. POR AHORA solo el primer curso del taller refleja
      // visibilidad estándar — los demás llegan al alumno via assignment.
      for (const cid of courseIds) {
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
      toast.success(
        courseIds.length > 1
          ? `Taller creado en ${courseIds.length} cursos (1 registro compartido).`
          : "Taller creado correctamente",
      );
      void logEvent({
        action: "workshop.created",
        category: "workshop",
        actorRole: roles[0],
        entityType: "workshop",
        entityId: newWs.id,
        entityName: form.title,
        courseId: firstCid,
        courseName: courses.find((c) => c.id === firstCid)?.name,
        metadata: { course_ids: courseIds, multi_course: isMultiCourse },
      });
    }
    setOpen(false);
    load();
  };

  // Estado del dialog de duplicar (reemplaza el inline INSERT por la
  // RPC clone_workshop que permite elegir curso destino y valida permisos).
  const [duplicateSource, setDuplicateSource] = useState<{
    id: string;
    title: string;
    courseId: string;
  } | null>(null);
  const duplicateWorkshop = (ws: Workshop) => {
    setDuplicateSource({ id: ws.id, title: ws.title, courseId: ws.course_id });
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: t("workshop.deleteTitle"),
      description: t("workshop.deleteBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const ws = workshops.find((w) => w.id === id);
    const { error } = await softDelete("workshops", id);
    if (error) return toast.error(friendlyError(error));
    toast.success(t("workshop.deletedToast"));
    void logEvent({
      action: "workshop.deleted",
      category: "workshop",
      actorRole: roles[0],
      entityType: "workshop",
      entityId: id,
      entityName: ws?.title,
      courseId: ws?.course_id,
      courseName: courses.find((c) => c.id === ws?.course_id)?.name,
    });
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
      if (error) return toast.error(friendlyError(error));
      setAssignedIds(new Set([...assignedIds, uid]));
      toast.success("Estudiante asignado correctamente");
    } else {
      const { error } = await supabase
        .from("workshop_assignments")
        .delete()
        .eq("workshop_id", assignWs.id)
        .eq("user_id", uid);
      if (error) return toast.error(friendlyError(error));
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
    if (error) return toast.error(friendlyError(error));
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
    setWsSimilarityPairs([]);
    setWsThreadsByQ({});
    const [{ data: subs }, { data: qs }, { data: pairs }] = await Promise.all([
      supabase.from("workshop_submissions").select("*").eq("workshop_id", ws.id),
      supabase
        .from("workshop_questions")
        .select(
          "id, workshop_id, type, content, options, position, points, expected_rubric, language",
        )
        .eq("workshop_id", ws.id)
        .order("position"),
      // similarity_pairs no está en types.ts auto-generado todavía
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supabase as any)
        .from("similarity_pairs")
        .select("id, question_id, user_a, user_b, score, reasons, reviewed_at")
        .eq("kind", "workshop")
        .eq("ref_id", ws.id),
    ]);
    setWsQuestions((qs ?? []) as WsQuestion[]);
    setWsSimilarityPairs((pairs ?? []) as WsSimilarityPair[]);

    if (subs?.length) {
      const userIds = subs.map((s: any) => s.user_id);
      const subIds = subs.map((s: any) => s.id);
      const [{ data: profiles }, { data: ans }, { data: threads }] = await Promise.all([
        supabase.from("profiles").select("id, full_name, institutional_email").in("id", userIds),
        supabase
          .from("workshop_submission_answers")
          .select(
            "id, submission_id, question_id, answer_text, selected_option, code_content, diagram_code, ai_grade, ai_feedback",
          )
          .in("submission_id", subIds),
        // feedback_threads + comments para calcular el resumen
        // "Conversación con el estudiante" por pregunta (count + pending).
        // Pending=true cuando el último comentario lo escribió el ALUMNO
        // — mismo criterio que usa el monitor de exámenes.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("feedback_threads")
          .select("id, submission_id, question_id")
          .eq("parent_kind", "workshop")
          .in("submission_id", subIds),
      ]);
      const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      const grouped: Record<string, WsAnswer[]> = {};
      for (const a of (ans ?? []) as WsAnswer[]) {
        // Las dos columnas nuevas se cargan abajo en una query separada
        // y defensiva — aquí solo aseguramos que el shape de WsAnswer
        // tenga ai_likelihood/ai_reasons/ai_review_at en null por defecto.
        (grouped[a.submission_id] ||= []).push({
          ...a,
          ai_likelihood: null,
          ai_reasons: null,
          ai_review_at: null,
        });
      }
      setAnswersBySub(grouped);

      // Carga AUXILIAR de ai_likelihood/ai_reasons/ai_review_at. La hacemos
      // en query separada y con try/catch para que si las migraciones
      // (20260510190000 y 20260519100000) todavía no se aplicaron, el
      // dialog NO se rompa — simplemente las features dependientes (badge
      // de IA, botón "Marcar revisada") no aparecen hasta el publish.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: aiAns, error: aiErr } = await (supabase as any)
          .from("workshop_submission_answers")
          .select("id, ai_likelihood, ai_reasons, ai_review_at")
          .in("submission_id", subIds);
        if (!aiErr && Array.isArray(aiAns) && aiAns.length > 0) {
          const byId = new Map(
            (
              aiAns as Array<{
                id: string;
                ai_likelihood: number | null;
                ai_reasons: string | null;
                ai_review_at: string | null;
              }>
            ).map((r) => [
              r.id,
              {
                ai_likelihood: r.ai_likelihood,
                ai_reasons: r.ai_reasons,
                ai_review_at: r.ai_review_at,
              },
            ]),
          );
          setAnswersBySub((prev) => {
            const next: Record<string, WsAnswer[]> = {};
            for (const [subId, list] of Object.entries(prev)) {
              next[subId] = list.map((a) => {
                const extra = byId.get(a.id);
                return extra ? { ...a, ...extra } : a;
              });
            }
            return next;
          });
        }
      } catch {
        // Migración pendiente — no es bloqueante.
      }
      setWsSubs(subs.map((s: any) => ({ ...s, profile: profileMap.get(s.user_id) })));

      // Agrupar threads por (submissionId, questionId) y calcular pending
      // mirando el último comment de cada thread.
      const threadsArr = (threads ?? []) as Array<{
        id: string;
        submission_id: string;
        question_id: string;
      }>;
      const subOwner = new Map<string, string>(
        (subs as Array<{ id: string; user_id: string }>).map((s) => [s.id, s.user_id]),
      );
      const threadOwner = new Map<string, string>();
      const threadsByQKey = new Map<string, string[]>();
      for (const th of threadsArr) {
        const uid = subOwner.get(th.submission_id);
        if (!uid) continue;
        threadOwner.set(th.id, uid);
        const key = `${th.submission_id}:${th.question_id}`;
        const arr = threadsByQKey.get(key) ?? [];
        arr.push(th.id);
        threadsByQKey.set(key, arr);
      }
      if (threadsArr.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: comments } = await (supabase as any)
          .from("feedback_comments")
          .select("thread_id, user_id, created_at")
          .in(
            "thread_id",
            threadsArr.map((t) => t.id),
          )
          .order("created_at", { ascending: false });
        const lastByThread = new Map<string, string>();
        for (const c of (comments ?? []) as Array<{
          thread_id: string;
          user_id: string;
        }>) {
          if (!lastByThread.has(c.thread_id)) lastByThread.set(c.thread_id, c.user_id);
        }
        const pendingByThread = new Set<string>();
        for (const [tid, ownerUid] of threadOwner.entries()) {
          if (lastByThread.get(tid) === ownerUid) pendingByThread.add(tid);
        }
        const byQ: Record<string, { count: number; pending: boolean }> = {};
        for (const [key, ids] of threadsByQKey.entries()) {
          byQ[key] = {
            count: ids.length,
            pending: ids.some((tid) => pendingByThread.has(tid)),
          };
        }
        setWsThreadsByQ(byQ);
      } else {
        setWsThreadsByQ({});
      }
    } else {
      setWsSubs([]);
    }
    setGradingSearch(""); // reset buscador al abrir
    setGradingOpen(true);
    // Al abrir desde la lista de talleres, empezamos siempre en el grid.
    // El deep-link (highlightSubId) lo maneja un effect aparte que abre
    // automáticamente el detalle de ese estudiante.
    setViewingSubId(null);
  };

  /** Mapa: submissionId → questionId → { answerId, score, reasons, reviewedAt }.
   *  `answerId` permite hacer UPDATE en el toggle de "revisada" sin re-
   *  buscar la fila. `reviewedAt` es el timestamp si el docente ya la
   *  inspeccionó. Mismo patrón del monitor de exámenes. */
  const wsAiSignalsBySubmissionQuestion = useMemo(() => {
    const map = new Map<
      string,
      Map<
        string,
        { answerId: string; score: number; reasons: string | null; reviewedAt: string | null }
      >
    >();
    for (const [subId, answers] of Object.entries(answersBySub)) {
      const inner = new Map<
        string,
        { answerId: string; score: number; reasons: string | null; reviewedAt: string | null }
      >();
      for (const a of answers) {
        const score = a.ai_likelihood != null ? Number(a.ai_likelihood) : 0;
        if (score > 0) {
          inner.set(a.question_id, {
            answerId: a.id,
            score,
            reasons: a.ai_reasons ?? null,
            reviewedAt: a.ai_review_at ?? null,
          });
        }
      }
      if (inner.size > 0) map.set(subId, inner);
    }
    return map;
  }, [answersBySub]);

  /** Mapa: userId → pares de copia donde ese estudiante aparece (en
   *  user_a o user_b). Incluye `id` del similarity_pair para poder
   *  marcarlo como revisado, y `reviewedAt` para mostrar el estado. */
  const wsCopyPairsByUser = useMemo(() => {
    const map = new Map<
      string,
      Array<{
        id: string;
        questionId: string | null;
        peerId: string;
        score: number;
        reviewedAt: string | null;
      }>
    >();
    for (const p of wsSimilarityPairs) {
      for (const [u, peer] of [
        [p.user_a, p.user_b],
        [p.user_b, p.user_a],
      ] as const) {
        const arr = map.get(u) ?? [];
        arr.push({
          id: p.id,
          questionId: p.question_id,
          peerId: peer,
          score: Number(p.score) || 0,
          reviewedAt: p.reviewed_at ?? null,
        });
        map.set(u, arr);
      }
    }
    return map;
  }, [wsSimilarityPairs]);

  /** Entregas filtradas por el buscador del modal de calificaciones.
   *  Matchea por nombre completo o email institucional del estudiante.
   *  Si el query está vacío devuelve todas. */
  const filteredWsSubs = useMemo(() => {
    const q = gradingSearch.trim().toLowerCase();
    if (!q) return wsSubs;
    return wsSubs.filter((s) => {
      const name = (
        (s as { profile?: { full_name?: string } }).profile?.full_name ?? ""
      ).toLowerCase();
      const email = (
        (s as { profile?: { institutional_email?: string } }).profile?.institutional_email ?? ""
      ).toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [wsSubs, gradingSearch]);

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
          ai_review_at: null,
          id: "",
          submission_id: subId,
          question_id: questionId,
          answer_text: null,
          selected_option: null,
          code_content: null,
          diagram_code: null,
          ai_grade: null,
          ai_feedback: null,
          ai_likelihood: null,
          ai_reasons: null,
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
        toast.error(friendlyError(error));
        return;
      }
      const newFinal = recomputeFinalGrade(subId);
      const { error: subErr } = await supabase
        .from("workshop_submissions")
        .update({ final_grade: newFinal, status: "calificado" })
        .eq("id", subId);
      if (subErr) {
        toast.error(
          `Calificación guardada, pero falló recalcular calificación global: ${subErr.message}`,
        );
      } else {
        setWsSubs((prev) =>
          prev.map((s) =>
            s.id === subId ? { ...s, final_grade: newFinal, status: "calificado" } : s,
          ),
        );
        toast.success(
          `Pregunta guardada · calificación global: ${newFinal}/${gradingWs?.max_score ?? 100}`,
        );
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
    const decision = await aiGate.ensureAuthorized();
    if (decision === "cancel") return;
    // Estrategia de fallback (en orden de preferencia):
    //   1) Hay row per-pregunta con contenido → la usamos.
    //   2) Hay row pero sin contenido → si la entrega tiene `content`,
    //      external_link o file_url, los usamos como respuesta global
    //      (sirve para talleres "monolíticos" donde el estudiante puso
    //      todo en el campo principal sin responder pregunta-por-pregunta).
    //   3) No hay row → idem, fallback a la entrega y NO persistimos
    //      (saveAnswerGrade exige id; el docente puede usar el botón
    //      "Calificar todo con IA" si quiere persistir a nivel submission).
    const sub = wsSubs.find((s) => s.id === subId);
    const perQuestionRaw =
      answer?.code_content ??
      answer?.diagram_code ??
      answer?.selected_option ??
      answer?.answer_text ??
      "";
    const submissionFallback = sub
      ? [
          sub.content ? `Contenido de la entrega: ${sub.content}` : "",
          sub.external_link ? `Link externo: ${sub.external_link}` : "",
          sub.file_url ? `Archivo entregado: ${sub.file_url.split("/").pop()}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "";
    const raw =
      perQuestionRaw && String(perQuestionRaw).trim() ? String(perQuestionRaw) : submissionFallback;

    if (!raw || !raw.trim()) {
      toast.error(
        "Esta entrega no tiene respuesta a esta pregunta ni contenido global. No hay nada para recalificar.",
      );
      return;
    }
    if (!answer?.id) {
      toast.message(
        "Recalificando con el contenido global de la entrega — esta pregunta no tiene respuesta específica.",
      );
    }
    setAiGradingAnswerId(answer?.id ?? `tmp-${subId}-${question.id}`);
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
        const detail = await extractEdgeError(error, data);
        toast.error(`Error IA: ${detail || "Desconocido"}`);
        return;
      }
      const newGrade = Number(data?.grade ?? 0);
      const newFeedback = String(data?.feedback ?? "");
      // ai_likelihood llega de la edge function (0..1). Lo persistimos
      // por respuesta para que la sugerencia de penalización pueda
      // calcularse PER pregunta, igual que en el monitor de exámenes.
      const aiLikelihood =
        data?.ai_likelihood != null ? Math.max(0, Math.min(1, Number(data.ai_likelihood))) : null;
      const aiReasons = data?.ai_reasons != null ? String(data.ai_reasons) : null;
      patchAnswer(subId, question.id, {
        ai_grade: newGrade,
        ai_feedback: newFeedback,
        ai_likelihood: aiLikelihood,
        ai_reasons: aiReasons,
      });
      // Persistir solo si hay row per-pregunta (answer.id). Intento 1:
      // con las 4 columnas (ai_grade/feedback + likelihood/reasons).
      // Si la migración 20260510190000 no se ha aplicado, ese UPDATE
      // falla por columnas inexistentes — fallback a las dos viejas.
      if (answer?.id) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: updErr } = await (supabase as any)
          .from("workshop_submission_answers")
          .update({
            ai_grade: newGrade,
            ai_feedback: newFeedback,
            ai_likelihood: aiLikelihood,
            ai_reasons: aiReasons,
          })
          .eq("id", answer.id);
        if (updErr) {
          // Probablemente migración pendiente — retry sin las dos nuevas.
          await supabase
            .from("workshop_submission_answers")
            .update({ ai_grade: newGrade, ai_feedback: newFeedback })
            .eq("id", answer.id);
        }
      }
      // Auditoría enriquecida: si el modelo no devolvió feedback (suele
      // pasar cuando el response de Gemini falla) lo dejamos visible.
      const aiErrored = !newFeedback || /error\s*ia/i.test(newFeedback);
      void logEvent({
        action: "ai_grading.completed",
        category: "grading",
        severity: aiErrored ? "warning" : "info",
        entityType: "workshop_submission",
        entityId: subId,
        metadata: {
          workshopId: gradingWs?.id ?? null,
          questionId: question.id,
          grade: newGrade,
          ai_feedback: newFeedback,
          ai_likelihood: aiLikelihood,
          ai_reasons: aiReasons,
          ai_errored: aiErrored,
        },
      });
      toast.success(t("workshop.regraded"));
    } finally {
      setAiGradingAnswerId(null);
    }
  };

  const [aiGradingId, setAiGradingId] = useState<string | null>(null);
  const [aiGradingAll, setAiGradingAll] = useState(false);

  /** Marca/desmarca una sospecha de IA POR PREGUNTA como revisada. Persiste
   *  `workshop_submission_answers.ai_review_at` (timestamp = revisada,
   *  null = pendiente). Mismo patrón del monitor de exámenes pero usando
   *  una tabla en vez del JSON __breakdown. */
  const toggleQuestionAiReviewed = async (
    answerId: string,
    submissionId: string,
    currentlyReviewed: boolean,
  ) => {
    const next = currentlyReviewed ? null : new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = supabase as any;
    const { error } = await dbAny
      .from("workshop_submission_answers")
      .update({ ai_review_at: next, ai_review_by: user?.id ?? null })
      .eq("id", answerId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setAnswersBySub((prev) => {
      const list = (prev[submissionId] ?? []).map((a) =>
        a.id === answerId ? { ...a, ai_review_at: next } : a,
      );
      return { ...prev, [submissionId]: list };
    });
    toast.success(currentlyReviewed ? "Marcada como pendiente" : "Marcada como revisada");
  };

  /** Marca/desmarca un par de copia (similarity_pairs) como revisado.
   *  Persiste `reviewed_at`. Tras toggle actualiza wsSimilarityPairs en
   *  memoria para que el badge "Revisada" se refleje sin recargar. */
  const togglePairReviewed = async (pairId: string, currentlyReviewed: boolean) => {
    const next = currentlyReviewed ? null : new Date().toISOString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = supabase as any;
    const { error } = await dbAny
      .from("similarity_pairs")
      .update({ reviewed_at: next })
      .eq("id", pairId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setWsSimilarityPairs((prev) =>
      prev.map((p) => (p.id === pairId ? { ...p, reviewed_at: next } : p)),
    );
    toast.success(currentlyReviewed ? "Marcada como pendiente" : "Marcada como revisada");
  };
  /** Estado del botón "Detectar copias" del modal de calificación. La
   *  edge function `detect-plagiarism` compara respuestas POR PREGUNTA
   *  entre todos los estudiantes y devuelve los pares con `question_id`
   *  poblado. Al terminar, recargamos `wsSimilarityPairs` para que los
   *  bloques de copia por pregunta se actualicen. */
  const [detectingCopies, setDetectingCopies] = useState(false);

  /** Invoca la edge function `detect-plagiarism` para comparar
   *  respuestas de TODOS los estudiantes de este taller y agrupa los
   *  resultados por pregunta. Al volver, recarga similarity_pairs +
   *  ai_likelihood (la edge también puede setear ai_detected_score por
   *  respuesta) para que los bloques de IA y copia por pregunta
   *  reflejen los nuevos datos sin recargar el modal. */
  const runDetectCopies = async () => {
    if (!gradingWs) return;
    const decision = await aiGate.ensureAuthorized();
    if (decision === "cancel") return;
    setDetectingCopies(true);
    try {
      const { data, error } = await supabase.functions.invoke("detect-plagiarism", {
        body: { kind: "workshop", refId: gradingWs.id },
      });
      if (error) throw error;
      const summary = data as { pairs?: unknown[]; message?: string };
      const found = Array.isArray(summary?.pairs) ? summary.pairs.length : 0;
      void logEvent({
        action: "ai_plagiarism.detected",
        category: "fraud",
        severity: found > 0 ? "warning" : "info",
        entityType: "workshop",
        entityId: gradingWs.id,
        metadata: { pairs_found: found },
      });
      if (found > 0) {
        toast.success(
          `Detección completada: ${found} par${found === 1 ? "" : "es"} sospechoso${found === 1 ? "" : "s"} encontrado${found === 1 ? "" : "s"}.`,
        );
      } else {
        toast.message("Detección completada", {
          description: summary?.message ?? "No se encontraron coincidencias relevantes.",
        });
      }
      // Recarga similarity_pairs y ai_likelihood por respuesta — ambos
      // los puede haber escrito la edge function. Usamos `any` puntual
      // porque similarity_pairs no está en los types generados.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny = supabase as any;
      const subIds = wsSubs.map((s) => s.id);
      const [{ data: pairs }, aiResp] = await Promise.all([
        dbAny
          .from("similarity_pairs")
          .select("id, question_id, user_a, user_b, score, reasons, reviewed_at")
          .eq("kind", "workshop")
          .eq("ref_id", gradingWs.id),
        subIds.length > 0
          ? dbAny
              .from("workshop_submission_answers")
              .select("id, ai_likelihood, ai_reasons, ai_review_at")
              .in("submission_id", subIds)
          : Promise.resolve({ data: [] }),
      ]);
      setWsSimilarityPairs((pairs ?? []) as WsSimilarityPair[]);
      if (Array.isArray(aiResp.data) && aiResp.data.length > 0) {
        const byId = new Map(
          (
            aiResp.data as Array<{
              id: string;
              ai_likelihood: number | null;
              ai_reasons: string | null;
              ai_review_at: string | null;
            }>
          ).map((r) => [r.id, r]),
        );
        setAnswersBySub((prev) => {
          const next: typeof prev = {};
          for (const [k, list] of Object.entries(prev)) {
            next[k] = list.map((a) => {
              const u = byId.get(a.id);
              return u
                ? {
                    ...a,
                    ai_likelihood: u.ai_likelihood,
                    ai_reasons: u.ai_reasons,
                    ai_review_at: u.ai_review_at,
                  }
                : a;
            });
          }
          return next;
        });
      }
    } catch (e) {
      toast.error(
        `No se pudo ejecutar la detección: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setDetectingCopies(false);
    }
  };

  const gradeOneWithAI = async (sub: WsSub): Promise<boolean> => {
    if (!gradingWs) return false;
    const decision = await aiGate.ensureAuthorized();
    if (decision === "cancel") return false;
    setAiGradingId(sub.id);
    try {
      // ── Modo moderno: taller con preguntas (workshop_questions).
      // El estudiante entrega respuestas por pregunta en
      // workshop_submission_answers. Para recalificar mandamos TODAS las
      // respuestas en UN solo prompt (batchGrading) — antes hacíamos
      // workshopGrading sobre sub.content (textarea legacy) y para los
      // talleres modernos sub.content era null → la IA respondía
      // "El estudiante no proporcionó ninguna respuesta para este taller".
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny = supabase as any;
      const [{ data: qs }, { data: ans }] = await Promise.all([
        dbAny
          .from("workshop_questions")
          .select("id, type, content, points, expected_rubric, language, starter_code")
          .eq("workshop_id", gradingWs.id)
          .order("position"),
        dbAny
          .from("workshop_submission_answers")
          .select("question_id, answer_text, selected_option, code_content, diagram_code")
          .eq("submission_id", sub.id),
      ]);
      const questions = (qs ?? []) as Array<{
        id: string;
        type: string;
        content: string;
        points: number;
        expected_rubric: string | null;
        language: string | null;
        starter_code: string | null;
      }>;
      const answersByQid = new Map(
        (
          (ans ?? []) as Array<{
            question_id: string;
            answer_text: string | null;
            selected_option: string | null;
            code_content: string | null;
            diagram_code: string | null;
          }>
        ).map((a) => [a.question_id, a]),
      );

      if (questions.length > 0) {
        // Construye batch items SOLO para preguntas abiertas/código/diagrama
        // con respuesta del alumno. Las cerradas se califican localmente
        // (correct_index match) y NO entran al prompt — economía de tokens.
        const batchItems: Array<{
          qid: string;
          type: string;
          content: string;
          rubric: string;
          userAnswer: string;
          maxPoints: number;
          language?: string | null;
        }> = [];
        const localScores = new Map<string, { earned: number; feedback: string }>();
        let totalPoints = 0;
        let totalEarned = 0;

        for (const q of questions) {
          totalPoints += Number(q.points) || 0;
          const a = answersByQid.get(q.id);
          if (q.type === "cerrada" || q.type === "cerrada_multi") {
            // Scoring local determinístico. La RPC no se ejecuta acá; se
            // limita a sumar al total.
            localScores.set(q.id, { earned: 0, feedback: "Pregunta cerrada (calificación local)" });
            continue;
          }
          const raw = a?.code_content ?? a?.diagram_code ?? a?.answer_text ?? "";
          const trimmed = String(raw).trim();
          const starter = String(q.starter_code ?? "").trim();
          const isEmpty = !trimmed || (starter !== "" && trimmed === starter);
          if (isEmpty) {
            localScores.set(q.id, { earned: 0, feedback: "Sin respuesta" });
            continue;
          }
          batchItems.push({
            qid: q.id,
            // Mantenemos los tipos GUI como tales — el AI grader sabe
            // distinguir java_gui/python_gui de 'codigo' y aplica la
            // rúbrica específica de framework. Remapearlos a 'codigo'
            // perdía ese contexto.
            type: q.type,
            content: q.content,
            rubric: q.expected_rubric ?? "",
            userAnswer: trimmed,
            maxPoints: Number(q.points) || 0,
            language:
              q.type === "java_gui" ? "java" : q.type === "python_gui" ? "python" : q.language,
          });
        }

        // Si no hay nada para mandar a IA (todas vacías o cerradas), no
        // gastamos el round-trip — solo persistimos los 0.
        if (batchItems.length > 0) {
          const { data: bData, error: bErr } = await supabase.functions.invoke(
            "ai-grade-submission",
            {
              body: {
                batchGrading: true,
                items: batchItems,
                useCase: "workshop_question",
                courseId: gradingWs.course_id,
              },
            },
          );
          if (bErr || bData?.error) {
            toast.error(`Error IA: ${bData?.error ?? bErr?.message ?? "desconocido"}`);
            return false;
          }
          const results = (bData?.results ?? {}) as Record<
            string,
            { score?: number; feedback?: string }
          >;
          for (const it of batchItems) {
            const r = results[it.qid];
            const earned = r ? Math.max(0, Math.min(it.maxPoints, Number(r.score) || 0)) : 0;
            localScores.set(it.qid, {
              earned,
              feedback: r?.feedback ?? "Sin retroalimentación",
            });
          }
        }

        // Persiste resultado per-pregunta + recalcula nota global.
        const upserts: Array<Record<string, unknown>> = [];
        for (const q of questions) {
          const s = localScores.get(q.id) ?? { earned: 0, feedback: "Sin respuesta" };
          totalEarned += s.earned;
          upserts.push({
            submission_id: sub.id,
            question_id: q.id,
            ai_grade: s.earned,
            ai_feedback: s.feedback,
          });
        }
        for (const u of upserts) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (supabase as any)
            .from("workshop_submission_answers")
            .upsert(u, { onConflict: "submission_id,question_id" });
        }
        const finalGrade =
          totalPoints > 0
            ? Number(((totalEarned / totalPoints) * Number(gradingWs.max_score)).toFixed(2))
            : 0;
        const summary = `Calificación recalculada en batch sobre ${batchItems.length} pregunta${batchItems.length === 1 ? "" : "s"} abierta${batchItems.length === 1 ? "" : "s"} (de ${questions.length} totales).`;
        const { error: updateErr } = await supabase
          .from("workshop_submissions")
          .update({ ai_grade: finalGrade, ai_feedback: summary, status: "ai_revisado" })
          .eq("id", sub.id);
        if (updateErr) {
          toast.error(`Error guardando: ${friendlyError(updateErr)}`);
          return false;
        }
        setWsSubs((prev) =>
          prev.map((s) =>
            s.id === sub.id
              ? { ...s, ai_grade: finalGrade, ai_feedback: summary, status: "ai_revisado" }
              : s,
          ),
        );
        return true;
      }

      // ── Modo legacy: taller sin preguntas (entrega monolítica en
      // sub.content / external_link). Mismo flow original.
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
            courseId: gradingWs.course_id,
          },
        },
      );

      let aiGrade: number | null = null;
      let aiFeedback = "Sin retroalimentación de IA";

      if (aiErr || aiData?.error) {
        toast.error(
          "La calificación IA requiere actualizar la edge function. Usa calificación manual.",
        );
        return false;
      } else {
        aiGrade = aiData?.grade ?? null;
        aiFeedback = aiData?.feedback ?? "Sin retroalimentación de IA";
      }

      const { error: updateErr } = await supabase
        .from("workshop_submissions")
        .update({
          ai_grade: aiGrade,
          ai_feedback: aiFeedback,
          status: "ai_revisado",
        })
        .eq("id", sub.id);

      if (updateErr) {
        toast.error(`Error guardando: ${friendlyError(updateErr)}`);
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
      toast.error(`Error IA: ${friendlyError(e, "Error desconocido")}`);
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
    if (error) return toast.error(friendlyError(error));
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
    toast.success(t("workshop.gradeApproved"));
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
    toast.success(t("workshop.gradeRejected"));
  };

  // Persiste la `final_grade` (que el caller ya recalculó desde las
  // notas por pregunta) + cambia status a 'calificado'. Antes recibía
  // también `feedback` global, pero ese textarea fue removido — la
  // retroalimentación vive pregunta-por-pregunta dentro de `answers`.
  /**
   * Reabre una entrega calificada para que el estudiante pueda volver a
   * enviarla. Estado vuelve a "entregado" (no "pendiente" para conservar
   * `submitted_at` como referencia), limpiamos `final_grade` y `ai_grade`
   * para que no se siga mostrando como calificado. La fila NO se borra
   * — las respuestas (`workshop_submission_answers`) siguen ahí, así el
   * estudiante las ve precargadas al volver a abrir el taller.
   */
  const reopenSubmission = async (sub: WsSub) => {
    const ok = await confirm({
      title: "¿Reabrir entrega del estudiante?",
      description:
        "El estudiante podrá volver a editar y reenviar sus respuestas. La calificación actual se borrará. Esta acción no se puede deshacer.",
      confirmLabel: "Reabrir",
      tone: "warning",
    });
    if (!ok) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbAny = supabase as any;
    const { error } = await dbAny
      .from("workshop_submissions")
      .update({
        status: "entregado",
        final_grade: null,
        ai_grade: null,
        ai_feedback: null,
        submitted_at: null,
      })
      .eq("id", sub.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    void logEvent({
      action: "workshop.submission_reopened",
      category: "grading",
      actorRole: roles[0],
      severity: "warning",
      entityType: "workshop_submission",
      entityId: sub.id,
      entityName: gradingWs?.title,
      courseId: gradingWs?.course_id,
      metadata: {
        previous_status: sub.status,
        previous_grade: sub.final_grade,
      },
    });
    toast.success("Entrega reabierta. El estudiante puede reenviar.");
    setWsSubs((prev) =>
      prev.map((s) =>
        s.id === sub.id ? { ...s, status: "entregado", final_grade: null, ai_grade: null } : s,
      ),
    );
  };

  const saveGrade = async (subId: string, grade: number) => {
    const { data, error } = await supabase
      .from("workshop_submissions")
      .update({
        final_grade: grade,
        status: "calificado",
      })
      .eq("id", subId)
      .select()
      .maybeSingle();

    if (error) {
      toast.error(`Error: ${friendlyError(error)}`);
      return;
    }
    if (!data) {
      toast.error("No se pudo actualizar. Verifica los permisos.");
      return;
    }
    toast.success(t("workshop.gradeSaved"));
    void logEvent({
      action: "grading.manual_save",
      category: "grading",
      actorRole: roles[0],
      entityType: "workshop_submission",
      entityId: subId,
      entityName: gradingWs?.title,
      courseId: gradingWs?.course_id,
      courseName: courses.find((c) => c.id === gradingWs?.course_id)?.name,
      metadata: { grade },
    });
    setWsSubs((prev) =>
      prev.map((s) => (s.id === subId ? { ...s, final_grade: grade, status: "calificado" } : s)),
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
      title: t("workshop.deleteSubmissionTitle", { name: studentName }),
      description: t("workshop.deleteSubmissionBody"),
      confirmLabel: t("workshop.deleteSubmissionConfirm"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("workshop_submissions").delete().eq("id", subId);
    if (error) return toast.error(friendlyError(error));
    setWsSubs((prev) => prev.filter((s) => s.id !== subId));
    toast.success(t("workshop.submissionDeleted"));
  };

  if (authLoading) return null;
  if (!isTeacher) return <p className="text-muted-foreground">Necesitas rol Docente.</p>;

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<Hammer className="h-6 w-6" />} title="Talleres" />
        <ErrorState
          message="No pudimos cargar los talleres"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Hammer className="h-6 w-6" />}
        title="Talleres"
        subtitle={
          filteredWorkshops.length === workshops.length
            ? `${workshops.length} talleres creados`
            : `${filteredWorkshops.length} de ${workshops.length} talleres`
        }
        actions={
          <>
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
                const courseByName = new Map(
                  courses.map((c) => [c.name.toLowerCase().trim(), c.id]),
                );
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
            <Button size="sm" onClick={openNew} data-tour-id="create-workshop">
              <Plus className="h-4 w-4 mr-1" />
              Nuevo taller
            </Button>
          </>
        }
      />

      {/* Stats 4-card — siempre visible. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Pencil} label="Borradores" value={workshopStats.draft} />
        <StatCard
          icon={CheckCircle2}
          label="Publicados"
          value={workshopStats.published}
          tone={workshopStats.published > 0 ? "success" : "default"}
        />
        <StatCard icon={Lock} label="Cerrados" value={workshopStats.closed} />
        <StatCard icon={ExternalLink} label="Externos" value={workshopStats.external} />
      </div>

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar taller por título…"
        courseId={courseFilter}
        onCourseChange={(v) => {
          setCourseFilter(v);
          // Resetear corte cuando cambia el curso: los cortes son
          // específicos del curso, así que conservar el corte anterior
          // dejaría un filtro inválido.
          setCutFilter(null);
        }}
        courses={courses}
        cuts={cuts}
        cutId={cutFilter}
        onCutChange={setCutFilter}
      />

      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular="taller"
        entityNamePlural="talleres"
      />

      {/* Resumen de pesos cuando se filtra por corte: muestra cuánto
          suman los talleres de ese corte vs el bucket workshop_weight.
          Tolerancia 0.01 para no marcar diff por errores de flotante. */}
      {cutFilter &&
        (() => {
          const cut = cuts.find((c) => c.id === cutFilter);
          if (!cut) return null;
          const sum = filteredWorkshops.reduce((s, w) => s + Number((w as any).weight ?? 0), 0);
          const bucket = Number(cut.workshop_weight ?? 0);
          const ok = Math.abs(sum - bucket) < 0.01;
          return (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                Suma de pesos en <span className="font-medium text-foreground">{cut.name}</span>:
              </span>
              <Badge
                variant={ok ? "secondary" : sum > bucket + 0.01 ? "destructive" : "default"}
                className="tabular-nums"
              >
                {formatPercent(sum)}% / {formatPercent(bucket)}%
              </Badge>
              {!ok && sum < bucket - 0.01 && (
                <span className="text-muted-foreground">
                  Quedan <strong>{formatPercent(bucket - sum)}%</strong> sin asignar.
                </span>
              )}
              {sum > bucket + 0.01 && (
                <span className="text-destructive">
                  Sobrepasa el bucket por <strong>{formatPercent(sum - bucket)}%</strong>.
                </span>
              )}
            </div>
          );
        })()}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {/* table-fixed: anchos por columna respetados; el título
              largo trunca en su cell. */}
          <Table fixed resizable>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <MultiSelectHeaderCheckbox state={sel} />
                </TableHead>
                <TableHead className="max-w-[320px]">{t("common.title")}</TableHead>
                <TableHead className="hidden sm:table-cell w-32">{t("common.course")}</TableHead>
                <TableHead className="hidden md:table-cell w-24">{t("exam.columns.cut")}</TableHead>
                <TableHead className="hidden lg:table-cell text-right w-16">
                  {t("common.weight")}
                </TableHead>
                <TableHead className="hidden md:table-cell w-28">{t("common.start")}</TableHead>
                <TableHead className="hidden sm:table-cell w-28">{t("common.end")}</TableHead>
                <TableHead className="w-24">{t("common.status")}</TableHead>
                <TableHead className="text-right w-20">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workshops.length === 0 ? (
                <TableEmpty
                  colSpan={10}
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
              ) : filteredWorkshops.length === 0 ? (
                <TableEmpty
                  colSpan={10}
                  icon={Hammer}
                  text="Sin resultados para los filtros actuales."
                  hint="Limpia el buscador o el curso para ver todos los talleres."
                />
              ) : null}
              {pagination.paginatedItems.map((ws) => (
                <TableRow key={ws.id} data-state={sel.isSelected(ws.id) ? "selected" : undefined}>
                  <TableCell className="w-10">
                    <MultiSelectCheckbox id={ws.id} state={sel} />
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex flex-col gap-0.5">
                      <span className="truncate max-w-[18rem]">
                        {ws.title}
                        {ws.external_link && (
                          <ExternalLink className="inline h-3 w-3 ml-1 text-muted-foreground" />
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground sm:hidden truncate">
                        {(() => {
                          const wcIds = workshopCourses.get(ws.id);
                          const ids =
                            wcIds && wcIds.length > 0 ? wcIds : ws.course_id ? [ws.course_id] : [];
                          const names = ids
                            .map((cid) => courses.find((c) => c.id === cid)?.name)
                            .filter(Boolean);
                          if (names.length === 0) return "—";
                          if (names.length === 1) return names[0];
                          return `${names[0]} +${names.length - 1}`;
                        })()}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden sm:table-cell">
                    {(() => {
                      // workshop_courses (M:N) es la fuente real de
                      // verdad de a qué cursos pertenece este taller.
                      // Si la tabla está poblada usamos los N courseIds;
                      // si no (talleres legacy sin backfill), fallback a
                      // workshops.course_id como antes.
                      const wcIds = workshopCourses.get(ws.id);
                      const ids =
                        wcIds && wcIds.length > 0 ? wcIds : ws.course_id ? [ws.course_id] : [];
                      const items = ids
                        .map((cid) => {
                          const c = courses.find((x) => x.id === cid);
                          if (!c) return null;
                          return { id: c.id, name: c.name, period: c.period };
                        })
                        .filter(
                          (x): x is { id: string; name: string; period: string | null } =>
                            x !== null,
                        );
                      if (items.length === 0) {
                        return <span className="text-xs text-muted-foreground">—</span>;
                      }
                      return <CourseListCell courses={items} />;
                    })()}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs hidden md:table-cell">
                    {cuts.find((c) => c.id === (ws as any).cut_id)?.name ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums text-right hidden lg:table-cell">
                    {(ws as any).cut_id != null && (ws as any).weight != null
                      ? `${formatPercent(Number((ws as any).weight))}%`
                      : "—"}
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <DateCell value={ws.start_date} variant="datetime" />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <DateCell value={ws.due_date} variant="datetime" />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={ws.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActionsMenu
                      actions={[
                        {
                          label: "Asignación / excluir estudiantes",
                          icon: Users,
                          onClick: () => openAssign(ws),
                        },
                        !ws.is_external && {
                          label: "Grupos",
                          icon: UsersRound,
                          onClick: () => openGroupsForWorkshop(ws),
                        },
                        {
                          label: "Preguntas del taller",
                          icon: ListChecks,
                          onClick: () => {
                            setQuestionsWs(ws);
                            setQuestionsOpen(true);
                          },
                        },
                        { label: "Calificar", icon: CheckCircle2, onClick: () => openGrading(ws) },
                        {
                          label: "Editar",
                          icon: Pencil,
                          onClick: () => {
                            setForm({
                              ...ws,
                              due_date: ws.due_date ? toLocalDatetime(ws.due_date) : "",
                              start_date: ws.start_date ? toLocalDatetime(ws.start_date) : "",
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            } as any);
                            setOriginalCourseId(ws.course_id ?? null);
                            // Hidratar el set de cursos asociados desde
                            // workshop_courses (M:N). Permite que el form
                            // de edit muestre TODOS los cursos del taller,
                            // no solo el primario.
                            const wcIds = workshopCourses.get(ws.id);
                            const allIds =
                              wcIds && wcIds.length > 0
                                ? wcIds
                                : ws.course_id
                                  ? [ws.course_id]
                                  : [];
                            setSelectedCourseIds(new Set(allIds));
                            // courseCuts per-curso: si no tenemos detalle
                            // de cuts por curso, dejamos los defaults; el
                            // save flow respeta el primary cut_id/weight
                            // del workshop para el curso primario.
                            const cutsByCourse: Record<
                              string,
                              { cut_id: string | null; weight: number }
                            > = {};
                            for (const cid of allIds) {
                              cutsByCourse[cid] = {
                                cut_id: cid === ws.course_id ? ((ws as any).cut_id ?? null) : null,
                                weight: cid === ws.course_id ? Number((ws as any).weight ?? 1) : 1,
                              };
                            }
                            setCourseCuts(cutsByCourse);
                            setOpen(true);
                          },
                        },
                        { label: "Duplicar", icon: Copy, onClick: () => duplicateWorkshop(ws) },
                        {
                          label: "Eliminar",
                          icon: Trash2,
                          tone: "destructive",
                          separatorBefore: true,
                          onClick: () => remove(ws.id),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataPagination state={pagination} entityNamePlural="talleres" />
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={open} onOpenChange={workshopDirty.guardOpenChange(setOpen)}>
        <DialogContent
          className="max-w-lg max-h-[90vh] overflow-y-auto"
          data-tour-id="dialog-workshop"
        >
          <DialogHeader>
            <DialogTitle>{form.id ? "Editar" : "Nuevo"} taller</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div
              className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2.5"
              data-tour-id="workshop-field-external"
            >
              <div className="space-y-0.5">
                <Label htmlFor="ws-is-external" className="text-sm">
                  Actividad externa
                </Label>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  Un taller que ocurrió fuera de la plataforma — presencial o hecho en otra
                  herramienta. Solo registras notas para el cálculo del corte.
                </p>
              </div>
              <Switch
                id="ws-is-external"
                checked={!!(form as any).is_external}
                onCheckedChange={(v) => setForm({ ...form, is_external: v } as any)}
              />
            </div>
            {/*
             * Toggle "Trabajo en grupo": cuando está activo, los
             * estudiantes entregan en grupo. La asignación de grupos se
             * configura desde el botón "Grupos" en el grid del taller
             * (sólo modo teacher_assigned por ahora).
             */}
            {/* Modo de trabajo del taller. NO aplica en externos. Tres
                opciones: 'individual' (cada estudiante entrega solo),
                'group_required' (todos deben estar en un grupo para
                entregar) y 'teacher_assigned' (Mixto: quien tenga grupo
                entrega en grupo, los demas individual). */}
            {!(form as any).is_external && (
              <div className="space-y-1" data-tour-id="workshop-field-group-mode">
                <Label>Modo de trabajo</Label>
                <Select
                  value={(form as any).group_mode ?? "individual"}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      group_mode: v as Workshop["group_mode"],
                    } as any)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="individual">
                      Individual — cada estudiante entrega por separado
                    </SelectItem>
                    <SelectItem value="group_required">
                      Grupal — todos deben estar en un grupo para entregar
                    </SelectItem>
                    <SelectItem value="teacher_assigned">
                      Mixto — quien tenga grupo entrega en grupo, los demás individual
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  En Grupal o Mixto administras los grupos desde el menú "Grupos".
                </p>
              </div>
            )}
            <div data-tour-id="workshop-field-title">
              <Label required>Título</Label>
              <Input
                value={form.title ?? ""}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div data-tour-id="workshop-field-courses">
              <Label required>
                Cursos{" "}
                <span className="text-xs text-muted-foreground font-normal">
                  (selecciona uno o más)
                </span>
              </Label>
              {/* Tanto en NEW como en EDIT usamos checkboxes M:N. El
                  taller es UN registro con N workshop_courses; el form
                  permite agregar/quitar cursos de un taller existente. */}
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
              {selectedCourseIds.size > 1 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {form.id
                    ? "El taller queda asociado a todos los cursos seleccionados (1 sólo registro)."
                    : "Se creará UN taller asociado a todos los cursos seleccionados."}
                </p>
              )}
              {form.id && selectedCourseIds.size === 0 && (
                <p className="text-xs text-destructive mt-1">
                  Debes mantener al menos 1 curso asociado.
                </p>
              )}
            </div>
            {/* Corte y peso: tabla per-curso cuando hay múltiples cursos en creación */}
            {!form.id && selectedCourseIds.size > 1 ? (
              <div className="space-y-2">
                <Label>
                  Corte y peso por curso{" "}
                  <HelpHint>{t("help.courseWeightBudgetValidation")}</HelpHint>
                </Label>
                {[...selectedCourseIds].map((cid) => {
                  const course = courses.find((c) => c.id === cid);
                  const cc = courseCuts[cid] ?? { cut_id: null, weight: 1 };
                  const cutsForCourse = cuts.filter((c) => c.course_id === cid);
                  const selectedCut = cc.cut_id ? cuts.find((c) => c.id === cc.cut_id) : null;
                  const wsBucket = Number(selectedCut?.workshop_weight ?? 0);
                  const sumOthers = workshops
                    .filter((w) => (w as any).cut_id === cc.cut_id)
                    .reduce((s, w) => s + Number((w as any).weight ?? 0), 0);
                  const wsMax = Math.max(0, wsBucket - sumOthers);
                  const overBucket = !!cc.cut_id && Number(cc.weight) > wsMax + 0.01;
                  return (
                    <div key={cid} className="rounded-md border bg-muted/30 p-3 space-y-2">
                      <p className="text-sm font-medium">{course?.name ?? cid}</p>
                      {/* Pair Corte/Peso dentro de Card con p-3 — el
                          ancho útil en mobile (~330px) dividido en 2
                          deja a cada Select en ~155px y los nombres de
                          corte se truncan. Stack en mobile. */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs text-muted-foreground">Corte</Label>
                          <Select
                            value={cc.cut_id ?? "__none__"}
                            onValueChange={(v) =>
                              setCourseCuts((prev) => ({
                                ...prev,
                                [cid]: {
                                  ...(prev[cid] ?? { weight: 1 }),
                                  cut_id: v === "__none__" ? null : v,
                                },
                              }))
                            }
                          >
                            <SelectTrigger className="mt-1 h-8 text-sm">
                              <SelectValue placeholder="Sin corte" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none__">Sin corte</SelectItem>
                              {cutsForCourse.map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {cutsForCourse.length === 0 && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Sin cortes definidos
                            </p>
                          )}
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">Peso (%)</Label>
                          <div className="relative mt-1">
                            <DecimalInput
                              min={0}
                              max={wsMax > 0 ? wsMax : undefined}
                              placeholder="1,0"
                              className="pr-7 h-8 text-sm"
                              disabled={!cc.cut_id}
                              value={cc.weight}
                              onChange={(v) =>
                                setCourseCuts((prev) => ({
                                  ...prev,
                                  [cid]: { ...(prev[cid] ?? { cut_id: null }), weight: v ?? 1 },
                                }))
                              }
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
                              %
                            </span>
                          </div>
                          {selectedCut && (
                            <p
                              className={`text-xs mt-1 ${overBucket ? "text-destructive" : "text-muted-foreground"}`}
                            >
                              Disponible: <strong>{wsMax.toFixed(1)}%</strong> (bucket {wsBucket}% −
                              otros {sumOthers.toFixed(1)}%)
                              {overBucket && (
                                <span className="block">Excede el bucket disponible.</span>
                              )}
                            </p>
                          )}
                          {!cc.cut_id && (
                            <p className="text-xs text-muted-foreground mt-1">
                              Asigna un corte para configurar el peso.
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <>
                <div>
                  <Label>
                    Corte de evaluación{" "}
                    <HelpHint>{t("help.cutAssignmentGradeCalculationWorkshop")}</HelpHint>
                  </Label>
                  {(() => {
                    const targetCourseIds = form.id
                      ? form.course_id
                        ? [form.course_id]
                        : []
                      : [...selectedCourseIds];
                    const availableCuts = cuts.filter((c) => targetCourseIds.includes(c.course_id));
                    return (
                      <Select
                        value={form.cut_id ?? "__none__"}
                        onValueChange={(v) =>
                          setForm({ ...form, cut_id: v === "__none__" ? null : v })
                        }
                      >
                        <SelectTrigger className="mt-1">
                          <SelectValue placeholder="Sin corte asignado" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Sin corte asignado</SelectItem>
                          {availableCuts.map((c) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    );
                  })()}
                  {(form.id || selectedCourseIds.size === 1) &&
                    cuts.filter((c) =>
                      form.id ? c.course_id === form.course_id : selectedCourseIds.has(c.course_id),
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
                    const wsMax = workshopWeightMax ?? 0;
                    const currentWeight = Number((form as any).weight ?? 1) || 0;
                    const bucketFull = wsMax === 0 && wsBucket > 0;
                    return (
                      <>
                        <Label>Peso del taller (% del bucket de talleres del corte)</Label>
                        <div className="relative mt-1 w-32">
                          <DecimalInput
                            min={0}
                            max={wsMax || undefined}
                            placeholder="1,0"
                            className="pr-7"
                            disabled={!selectedCut || bucketFull}
                            value={(form as any).weight ?? 1}
                            onChange={(v) => {
                              const raw = v == null ? 1 : v;
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
                              Otros talleres del corte suman {otherWorkshopsSum.toFixed(1)}%, te
                              queda <strong>{wsMax.toFixed(1)}%</strong> disponible
                              {currentWeight > 0 && wsMax > 0 && (
                                <> (peso actual: {currentWeight.toFixed(1)}%)</>
                              )}
                              .
                              {bucketFull && (
                                <span className="block text-destructive mt-1">
                                  El bucket de talleres está lleno. Aumenta workshop_weight del
                                  corte o reduce el peso de otros talleres.
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
              </>
            )}
            <div>
              <Label>Descripción</Label>
              <Textarea
                value={form.description ?? ""}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            {!(form as any).is_external && (
              <div>
                <Label>Instrucciones</Label>
                <Textarea
                  rows={4}
                  value={form.instructions ?? ""}
                  onChange={(e) => setForm({ ...form, instructions: e.target.value })}
                />
              </div>
            )}
            {!(form as any).is_external && (
              <div>
                <Label>Link externo (opcional)</Label>
                <Input
                  placeholder="https://..."
                  value={form.external_link ?? ""}
                  onChange={(e) => setForm({ ...form, external_link: e.target.value })}
                />
              </div>
            )}
            {!(form as any).is_external && (
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5">
                  Videos introductorios obligatorios (opcional)
                  <HelpHint>{t("help.introVideosSequentialUnlockWorkshop")}</HelpHint>
                </Label>
                {formIntroVideos.length === 0 && (
                  <p className="text-[11px] text-muted-foreground italic">
                    Sin videos. Click en "+ Agregar video" para empezar.
                  </p>
                )}
                <div className="space-y-2">
                  {formIntroVideos.map((video, idx) => {
                    const moveUp = () => {
                      if (idx === 0) return;
                      const next = [...formIntroVideos];
                      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                      setFormIntroVideos(next);
                    };
                    const moveDown = () => {
                      if (idx === formIntroVideos.length - 1) return;
                      const next = [...formIntroVideos];
                      [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
                      setFormIntroVideos(next);
                    };
                    const removeRow = () => {
                      setFormIntroVideos(formIntroVideos.filter((_, i) => i !== idx));
                    };
                    const update = (patch: Partial<(typeof formIntroVideos)[number]>) => {
                      const next = [...formIntroVideos];
                      next[idx] = { ...next[idx], ...patch };
                      setFormIntroVideos(next);
                    };
                    return (
                      <div key={idx} className="rounded-md border bg-card p-2.5 space-y-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px] tabular-nums shrink-0">
                            {idx + 1}
                          </Badge>
                          <Input
                            placeholder="Título (opcional, ej. 'Introducción al patrón MVC')"
                            value={video.title}
                            onChange={(e) => update({ title: e.target.value })}
                            className="text-xs h-8"
                          />
                          <div className="flex items-center gap-0.5 shrink-0">
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={moveUp}
                              disabled={idx === 0}
                              title="Mover arriba"
                            >
                              <ChevronUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={moveDown}
                              disabled={idx === formIntroVideos.length - 1}
                              title="Mover abajo"
                            >
                              <ChevronDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                              onClick={removeRow}
                              title="Quitar video"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                        <Select
                          value={video.library_id ?? "__custom"}
                          onValueChange={(v) => {
                            if (v === "__custom") {
                              update({ library_id: null });
                            } else {
                              const found = videoLibrary.find((vl) => vl.id === v);
                              update({
                                library_id: v,
                                url: found?.url ?? video.url,
                                title: video.title || found?.title || "",
                              });
                            }
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs">
                            <SelectValue placeholder="Biblioteca o URL personalizada…" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__custom">
                              URL personalizada (no reusable)
                            </SelectItem>
                            {videoLibrary.map((vl) => (
                              <SelectItem key={vl.id} value={vl.id}>
                                {vl.title} · {vl.provider.toUpperCase()}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Input
                          placeholder="https://www.youtube.com/watch?v=… ó https://cdn.tucentro.edu/video.mp4"
                          value={video.url}
                          onChange={(e) => update({ url: e.target.value, library_id: null })}
                          className="text-xs h-8"
                        />
                      </div>
                    );
                  })}
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setFormIntroVideos([
                      ...formIntroVideos,
                      { library_id: null, url: "", title: "" },
                    ])
                  }
                >
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Agregar video
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Tip: registra los videos en <strong>Videos</strong> (sidebar) y referénciálos aquí
                  — evita re-pegar URLs.
                </p>
              </div>
            )}
            <div>
              <Label className="text-xs text-muted-foreground mb-1 block">Fechas</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {!(form as any).is_external && (
                  <div>
                    <Label className="text-xs">Visible desde</Label>
                    <DateTimePicker
                      value={(form as any).start_date ?? ""}
                      onChange={(v) => setForm({ ...form, start_date: v } as any)}
                      className="mt-1"
                    />
                  </div>
                )}
                <div>
                  <Label className="text-xs">
                    {(form as any).is_external ? "Fecha del taller" : "Fecha límite"}
                  </Label>
                  <DateTimePicker
                    value={(form.due_date as any) ?? ""}
                    onChange={(v) => setForm({ ...form, due_date: v })}
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
            {!(form as any).is_external && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  {/* Labels uniformes en la grid: `text-xs` matchea las
                      del row "Fechas" de arriba, y `flex items-center
                      h-5` reserva el mismo alto en ambas columnas
                      (la del HelpHint del lado derecho no descoloca). */}
                  <Label className="text-xs flex items-center gap-1.5 h-5">Estado</Label>
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
                <div>
                  <Label className="text-xs flex items-center gap-1.5 h-5">
                    Intentos máximos
                    <HelpHint>
                      {`Cuántas veces puede entregar el alumno este taller. Vacío → usa el default de Admin → Configuración → Generales.`}
                    </HelpHint>
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    placeholder="Hereda del default"
                    value={form.max_attempts ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        max_attempts: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                    className="mt-1"
                  />
                </div>
              </div>
            )}
            {/* Rúbrica IA del taller: OCULTA del form principal. Antes
                era un Textarea de JSON crudo que el docente no entendía.
                La rúbrica REAL la administran los prompts globales en
                `/app/admin/ai-prompts` (o el override por curso del
                docente). El campo `rubric` queda en el schema para
                back-compat con talleres existentes — el save NO lo
                resetea (sigue siendo `form.rubric ?? null`). */}
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
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
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
                    <Checkbox checked={included} onCheckedChange={(v) => toggleAssign(s.id, !!v)} />
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
      <Dialog
        open={gradingOpen}
        onOpenChange={(o) => {
          setGradingOpen(o);
          // Al cerrar el dialog volvemos al modo grid para la próxima vez.
          if (!o) setViewingSubId(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-6xl max-h-[90vh] overflow-y-auto">
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
          {/* FraudPanel global removido — el resumen agregado a nivel
              submission se reemplaza por bloques POR PREGUNTA dentro
              del detalle del estudiante (mismo patrón del monitor de
              exámenes). El botón "Detectar copias" vive en la barra de
              acciones bulk de abajo. Toolbar visible SOLO en modo grid
              (cuando viewingSubId == null). */}
          {/* Bulk actions (IA + Detección de copias) */}
          {!(gradingWs as any)?.is_external && wsSubs.length > 0 && viewingSubId == null && (
            <div className="flex items-center justify-between p-3 rounded-md border bg-muted/30 gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-medium">Acciones masivas</p>
                <p className="text-xs text-muted-foreground">
                  Califica todas las entregas con IA y detecta copias entre estudiantes a nivel
                  pregunta. Los resultados aparecen junto a cada pregunta dentro del acordeón.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={runDetectCopies}
                  disabled={detectingCopies}
                  title="Compara las respuestas por pregunta entre estudiantes con la IA"
                >
                  {detectingCopies ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <Users className="h-4 w-4 mr-1" />
                  )}
                  Detectar copias
                </Button>
                <Button size="sm" onClick={gradeAllWithAI} disabled={aiGradingAll}>
                  {aiGradingAll ? (
                    <Spinner size="md" className="mr-1" />
                  ) : (
                    <Sparkles className="h-4 w-4 mr-1" />
                  )}
                  Calificar todo con IA
                </Button>
              </div>
            </div>
          )}
          <div className="space-y-3">
            {/* Buscador de estudiantes — solo cuando hay entregas. Sigue
                el mismo patrón visual que `ListFilters`: input con icono
                lupa, botón X cuando hay query, contador "X de Y". */}
            {/* Buscador SOLO en modo grid. En modo detalle (ver respuestas
                de un estudiante) no aplica — se ve un solo estudiante. */}
            {!(gradingWs as any)?.is_external && wsSubs.length > 0 && viewingSubId == null && (
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  <Input
                    value={gradingSearch}
                    onChange={(e) => setGradingSearch(e.target.value)}
                    placeholder="Buscar estudiante por nombre o correo…"
                    className="h-8 pl-8 pr-8 text-xs"
                  />
                  {gradingSearch && (
                    <button
                      type="button"
                      onClick={() => setGradingSearch("")}
                      aria-label="Limpiar búsqueda"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {gradingSearch && (
                  <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {filteredWsSubs.length} de {wsSubs.length}
                  </span>
                )}
              </div>
            )}
            {!(gradingWs as any)?.is_external && wsSubs.length === 0 && (
              <p className="text-sm text-muted-foreground">No hay entregas aún.</p>
            )}
            {!(gradingWs as any)?.is_external &&
              wsSubs.length > 0 &&
              filteredWsSubs.length === 0 &&
              viewingSubId == null && (
                <p className="text-sm text-muted-foreground">
                  Ningún estudiante coincide con la búsqueda.
                </p>
              )}

            {/* MODO GRID: tabla con una fila por estudiante. Reemplaza
                las Cards apiladas anteriores para alinear el UX con el
                monitor de exámenes — el docente ve toda la lista de
                un vistazo y entra al detalle solo del que necesite. */}
            {!(gradingWs as any)?.is_external &&
              viewingSubId == null &&
              filteredWsSubs.length > 0 && (
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Estudiante</TableHead>
                        <TableHead className="hidden sm:table-cell">Estado</TableHead>
                        <TableHead className="hidden md:table-cell text-right">Nota</TableHead>
                        <TableHead className="hidden lg:table-cell">IA</TableHead>
                        <TableHead className="hidden lg:table-cell">Copia</TableHead>
                        <TableHead className="text-right">Acciones</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredWsSubs.map((sub) => {
                        const aiSigsForSub = wsAiSignalsBySubmissionQuestion.get(sub.id);
                        const copyPairsForUser = wsCopyPairsByUser.get(sub.user_id) ?? [];
                        const integrity = computeWorkshopAlerts(
                          aiSigsForSub ? aiSigsForSub.values() : [],
                          copyPairsForUser,
                        );
                        const hasPendingAlerts = integrity.totalPending > 0;
                        const grade =
                          sub.final_grade != null
                            ? `${sub.final_grade}/${gradingWs?.max_score ?? 100}`
                            : "—";
                        return (
                          <TableRow
                            key={sub.id}
                            className={
                              hasPendingAlerts
                                ? "bg-red-50/30 dark:bg-red-500/5 hover:bg-red-50/50"
                                : ""
                            }
                          >
                            <TableCell className="max-w-[260px]">
                              <div className="font-medium text-sm truncate">
                                {sub.profile?.full_name ?? "—"}
                              </div>
                              <div className="text-[11px] text-muted-foreground truncate">
                                {sub.profile?.institutional_email}
                              </div>
                            </TableCell>
                            <TableCell className="hidden sm:table-cell">
                              <StatusBadge status={sub.status || "pendiente"} />
                            </TableCell>
                            <TableCell className="hidden md:table-cell text-right tabular-nums text-sm">
                              {grade}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell">
                              {integrity.aiTotal > 0 ? (
                                <Badge
                                  variant={integrity.aiPending > 0 ? "destructive" : "outline"}
                                  className={
                                    integrity.aiPending > 0
                                      ? "text-[10px] flex items-center gap-1 w-fit"
                                      : "text-[10px] flex items-center gap-1 w-fit bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                                  }
                                  title={
                                    integrity.aiPending > 0
                                      ? `${integrity.aiPending} pendiente${integrity.aiPending === 1 ? "" : "s"} de ${integrity.aiTotal}`
                                      : `${integrity.aiTotal} revisada${integrity.aiTotal === 1 ? "" : "s"}`
                                  }
                                >
                                  <Bot className="h-3 w-3" />
                                  {integrity.aiPending > 0
                                    ? `${integrity.aiPending}/${integrity.aiTotal}`
                                    : `${integrity.aiTotal} ✓`}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground text-xs">—</span>
                              )}
                            </TableCell>
                            <TableCell className="hidden lg:table-cell">
                              {integrity.copyTotal > 0 ? (
                                <Badge
                                  variant={integrity.copyPending > 0 ? "destructive" : "outline"}
                                  className={
                                    integrity.copyPending > 0
                                      ? "text-[10px] flex items-center gap-1 w-fit"
                                      : "text-[10px] flex items-center gap-1 w-fit bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                                  }
                                  title={
                                    integrity.copyPending > 0
                                      ? `${integrity.copyPending} pendiente${integrity.copyPending === 1 ? "" : "s"} de ${integrity.copyTotal}`
                                      : `${integrity.copyTotal} revisada${integrity.copyTotal === 1 ? "" : "s"}`
                                  }
                                >
                                  <Users className="h-3 w-3" />
                                  {integrity.copyPending > 0
                                    ? `${integrity.copyPending}/${integrity.copyTotal}`
                                    : `${integrity.copyTotal} ✓`}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground text-xs">—</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                <RowAction
                                  label="Ver respuestas"
                                  icon={Eye}
                                  onClick={() => setViewingSubId(sub.id)}
                                />
                                <RowAction
                                  label="Eliminar entrega"
                                  icon={Trash2}
                                  tone="destructive"
                                  onClick={() =>
                                    deleteSubmission(
                                      sub.id,
                                      sub.profile?.full_name ?? "este estudiante",
                                    )
                                  }
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}

            {/* Botón "Volver al grid" en modo detalle. Coincide con el
                patrón del monitor de exámenes (Eye → detalle → back). */}
            {!(gradingWs as any)?.is_external && viewingSubId != null && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setViewingSubId(null)}
                className="self-start h-8"
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Volver al listado de estudiantes
              </Button>
            )}

            {/* MODO DETALLE: vista pregunta-por-pregunta del estudiante
                seleccionado. Reusa el JSX de la Card anterior pero solo
                para el sub elegido. */}
            {!(gradingWs as any)?.is_external &&
              viewingSubId != null &&
              wsSubs
                .filter((sub) => sub.id === viewingSubId)
                .map((sub) => {
                  // Resumen agregado de alertas de integridad para este
                  // estudiante (suma de IA + copia pendientes/totales en
                  // sus respuestas). Lo usamos para destacar la card y
                  // pintar badges en el header — el docente sabe que tiene
                  // que expandir el acordeón sin abrirlo a ciegas.
                  const aiSigsForSub = wsAiSignalsBySubmissionQuestion.get(sub.id);
                  const copyPairsForUser = wsCopyPairsByUser.get(sub.user_id) ?? [];
                  const integrity = computeWorkshopAlerts(
                    aiSigsForSub ? aiSigsForSub.values() : [],
                    copyPairsForUser,
                  );
                  const hasPendingAlerts = integrity.totalPending > 0;
                  return (
                    <Card
                      key={sub.id}
                      id={`ws-sub-${sub.id}`}
                      className={[
                        // Borde rojo/ámbar prominente cuando hay alertas
                        // PENDIENTES de revisar. Si todas están revisadas
                        // (pero existen), volvemos al borde por status
                        // (ai_revisado = ámbar suave).
                        hasPendingAlerts
                          ? "border-red-400/70 bg-red-50/30 dark:border-red-500/40 dark:bg-red-500/5"
                          : sub.status === "ai_revisado"
                            ? "border-amber-400/50 dark:border-amber-500/30"
                            : "",
                        highlightSubId === sub.id ? "ring-2 ring-primary/60" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <CardContent className="p-4 space-y-3">
                        {/* Header */}
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium text-sm truncate">
                              {sub.profile?.full_name}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              {sub.profile?.institutional_email}
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 flex-wrap justify-end">
                            {/* Badges de alertas de integridad. Solo se
                              muestran si HAY alertas (pendientes o
                              revisadas). Color:
                                - destructive = pendientes
                                - emerald = todas revisadas */}
                            {integrity.aiTotal > 0 && (
                              <Badge
                                variant={integrity.aiPending > 0 ? "destructive" : "outline"}
                                className={
                                  integrity.aiPending > 0
                                    ? "text-[10px] flex items-center gap-1"
                                    : "text-[10px] flex items-center gap-1 bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                                }
                                title={
                                  integrity.aiPending > 0
                                    ? `IA: ${integrity.aiPending} pendiente${integrity.aiPending === 1 ? "" : "s"} de ${integrity.aiTotal}`
                                    : `IA: ${integrity.aiTotal} revisada${integrity.aiTotal === 1 ? "" : "s"}`
                                }
                              >
                                <Bot className="h-3 w-3" />
                                {integrity.aiPending > 0
                                  ? `${integrity.aiPending}/${integrity.aiTotal}`
                                  : `${integrity.aiTotal} ✓`}
                              </Badge>
                            )}
                            {integrity.copyTotal > 0 && (
                              <Badge
                                variant={integrity.copyPending > 0 ? "destructive" : "outline"}
                                className={
                                  integrity.copyPending > 0
                                    ? "text-[10px] flex items-center gap-1"
                                    : "text-[10px] flex items-center gap-1 bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                                }
                                title={
                                  integrity.copyPending > 0
                                    ? `Copia: ${integrity.copyPending} pendiente${integrity.copyPending === 1 ? "" : "s"} de ${integrity.copyTotal}`
                                    : `Copia: ${integrity.copyTotal} revisada${integrity.copyTotal === 1 ? "" : "s"}`
                                }
                              >
                                <Users className="h-3 w-3" />
                                {integrity.copyPending > 0
                                  ? `${integrity.copyPending}/${integrity.copyTotal}`
                                  : `${integrity.copyTotal} ✓`}
                              </Badge>
                            )}
                            <StatusBadge status={sub.status || "pendiente"} />
                            <RowAction
                              label="Eliminar entrega"
                              icon={Trash2}
                              tone="destructive"
                              onClick={() =>
                                deleteSubmission(
                                  sub.id,
                                  sub.profile?.full_name ?? "este estudiante",
                                )
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

                        {/* Per-question review & grading (editable). El
                        Accordion se mantiene por compatibilidad con el
                        trigger visual, pero por defecto SIEMPRE arranca
                        expandido en modo detalle — el docente entró al
                        detalle precisamente para ver las preguntas. */}
                        {wsQuestions.length > 0 && (
                          <Accordion
                            type="single"
                            collapsible
                            className="w-full"
                            defaultValue={`per-q-${sub.id}`}
                          >
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
                                  const isHighlighted =
                                    highlightSubId === sub.id && highlightWsQuestionId === q.id;
                                  return (
                                    <div
                                      key={q.id}
                                      id={`ws-q-${sub.id}-${q.id}`}
                                      className={`rounded-md border p-3 space-y-2 bg-muted/20 ${
                                        isHighlighted ? "ring-2 ring-primary/60" : ""
                                      }`}
                                    >
                                      <div className="flex flex-wrap items-center gap-2">
                                        <Badge variant="outline" className="text-[10px]">
                                          {idx + 1}
                                        </Badge>
                                        <Badge
                                          variant="secondary"
                                          className="text-[10px] capitalize"
                                        >
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
                                      {/* Sugerencia de penalización por integridad (IA o
                                      copia) por pregunta. Mismo patrón que el modal
                                      de respuestas del monitor de exámenes: cuando
                                      la pregunta tiene señal IA ≥ 0.6 o un par de
                                      copia ≥ 0.6, calculamos sugerencia = nota_actual
                                      × (1 − severidad) y mostramos un botón "Aplicar
                                      sugerencia" que precarga el input de IA. El
                                      docente puede ignorarla y poner el valor que
                                      quiera. */}
                                      {(() => {
                                        const aiSig = wsAiSignalsBySubmissionQuestion
                                          .get(sub.id)
                                          ?.get(q.id);
                                        const userPairs = wsCopyPairsByUser.get(sub.user_id) ?? [];
                                        const qPairs = userPairs.filter(
                                          (p) => p.questionId === q.id,
                                        );
                                        const plagiarismMax =
                                          qPairs.length > 0
                                            ? qPairs.reduce((m, p) => Math.max(m, p.score), 0)
                                            : null;
                                        const currentRaw =
                                          ans?.ai_grade != null ? Number(ans.ai_grade) : null;
                                        if (currentRaw == null || currentRaw <= 0) return null;
                                        const sug = computeIntegritySuggestion(
                                          currentRaw,
                                          aiSig?.score ?? null,
                                          plagiarismMax,
                                        );
                                        if (!sug) return null;
                                        const aiPct = Math.round((aiSig?.score ?? 0) * 100);
                                        const cpPct = Math.round((plagiarismMax ?? 0) * 100);
                                        return (
                                          <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300/70 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-2 text-[11px]">
                                            <AlertTriangle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300" />
                                            <span className="font-medium text-amber-700 dark:text-amber-300">
                                              {t("integrity.perQuestionSuggestion")}
                                            </span>
                                            <span className="font-semibold tabular-nums">
                                              {sug.suggested.toLocaleString("es-CO")} / {q.points}
                                            </span>
                                            <Badge variant="outline" className="text-[10px]">
                                              {sug.source === "ai"
                                                ? `IA ${aiPct}%`
                                                : sug.source === "plagio"
                                                  ? `Copia ${cpPct}%`
                                                  : `IA ${aiPct}% + Copia ${cpPct}%`}
                                            </Badge>
                                            <Button
                                              size="sm"
                                              variant="outline"
                                              className="h-6 text-[11px] ml-auto bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300"
                                              onClick={() =>
                                                patchAnswer(sub.id, q.id, {
                                                  ai_grade: sug.suggested,
                                                })
                                              }
                                            >
                                              {t("integrity.applySuggestion")}
                                            </Button>
                                          </div>
                                        );
                                      })()}

                                      {/* Bloque "Sospecha IA" por pregunta. Mismo
                                      patrón visual del monitor de exámenes:
                                      Collapsible amber con score badge + razones
                                      + botón "Marcar revisada" / "Reabrir".
                                      Solo aparece si el score IA es ≥ 0.6. */}
                                      {(() => {
                                        const aiSig = wsAiSignalsBySubmissionQuestion
                                          .get(sub.id)
                                          ?.get(q.id);
                                        if (!aiSig || aiSig.score < 0.6) return null;
                                        const reviewed = aiSig.reviewedAt != null;
                                        return (
                                          <Collapsible defaultOpen={false}>
                                            <div className="rounded-md border border-amber-300 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-2 space-y-2">
                                              <CollapsibleTrigger asChild>
                                                <button
                                                  type="button"
                                                  className="w-full flex items-center gap-2 text-[11px] font-medium text-amber-700 dark:text-amber-300 group"
                                                >
                                                  <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                                                  <Bot className="h-3 w-3" />
                                                  <span>{t("integrity.aiSection")}</span>
                                                  <Badge
                                                    variant={
                                                      aiSig.score >= 0.85
                                                        ? "destructive"
                                                        : aiSig.score >= 0.7
                                                          ? "default"
                                                          : "secondary"
                                                    }
                                                    className="text-[10px] ml-auto"
                                                  >
                                                    {Math.round(aiSig.score * 100)}%
                                                  </Badge>
                                                  {reviewed && (
                                                    <Badge
                                                      variant="outline"
                                                      className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                                                    >
                                                      <Check className="h-3 w-3 mr-1" />
                                                      {t("integrity.reviewed", {
                                                        defaultValue: "Revisada",
                                                      })}
                                                    </Badge>
                                                  )}
                                                </button>
                                              </CollapsibleTrigger>
                                              <CollapsibleContent className="space-y-2">
                                                {aiSig.reasons && (
                                                  <p className="text-[11px] text-amber-700 dark:text-amber-300 whitespace-pre-wrap pt-1 border-t border-amber-300/30">
                                                    {aiSig.reasons}
                                                  </p>
                                                )}
                                                <div className="flex justify-end pt-1 border-t border-amber-300/30">
                                                  {reviewed ? (
                                                    <Button
                                                      size="sm"
                                                      variant="outline"
                                                      className="h-7 text-[11px] bg-background"
                                                      onClick={() =>
                                                        toggleQuestionAiReviewed(
                                                          aiSig.answerId,
                                                          sub.id,
                                                          true,
                                                        )
                                                      }
                                                    >
                                                      {t("integrity.reopen", {
                                                        defaultValue: "Reabrir",
                                                      })}
                                                    </Button>
                                                  ) : (
                                                    <Button
                                                      size="sm"
                                                      variant="outline"
                                                      className="h-7 text-[11px] bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                                                      onClick={() =>
                                                        toggleQuestionAiReviewed(
                                                          aiSig.answerId,
                                                          sub.id,
                                                          false,
                                                        )
                                                      }
                                                    >
                                                      <Check className="h-3 w-3 mr-1" />
                                                      {t("integrity.markReviewed", {
                                                        defaultValue: "Marcar revisada",
                                                      })}
                                                    </Button>
                                                  )}
                                                </div>
                                              </CollapsibleContent>
                                            </div>
                                          </Collapsible>
                                        );
                                      })()}

                                      {/* Bloque "Posibles copias" por pregunta. Lista
                                      los pares de similarity_pairs filtrados por
                                      esta question_id. Cada par tiene su propio
                                      botón "Marcar revisada" (ese par específico).
                                      El trigger muestra cuántos quedan pendientes
                                      para que el docente decida si abrir. */}
                                      {(() => {
                                        const userPairs = wsCopyPairsByUser.get(sub.user_id) ?? [];
                                        const qPairs = userPairs.filter(
                                          (p) => p.questionId === q.id,
                                        );
                                        if (qPairs.length === 0) return null;
                                        const sorted = [...qPairs].sort(
                                          (a, b) => b.score - a.score,
                                        );
                                        const maxScore = sorted[0].score;
                                        const pendingCount = sorted.filter(
                                          (p) => !p.reviewedAt,
                                        ).length;
                                        const peerName = (peerId: string) => {
                                          const peer = wsSubs.find((s) => s.user_id === peerId);
                                          return (
                                            (
                                              peer as
                                                | { profile?: { full_name?: string } }
                                                | undefined
                                            )?.profile?.full_name ?? peerId.slice(0, 8)
                                          );
                                        };
                                        return (
                                          <Collapsible defaultOpen={false}>
                                            <div className="rounded-md border border-amber-300 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-2 space-y-2">
                                              <CollapsibleTrigger asChild>
                                                <button
                                                  type="button"
                                                  className="w-full flex items-center gap-2 text-[11px] font-medium text-amber-700 dark:text-amber-300 group"
                                                >
                                                  <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                                                  <Users className="h-3 w-3" />
                                                  <span>{t("integrity.copySection")}</span>
                                                  <Badge
                                                    variant="outline"
                                                    className="text-[10px] ml-auto"
                                                  >
                                                    {qPairs.length} · {Math.round(maxScore * 100)}%
                                                  </Badge>
                                                  {pendingCount > 0 ? (
                                                    <Badge
                                                      variant="outline"
                                                      className="text-[10px] bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-300"
                                                    >
                                                      {pendingCount} pendiente
                                                      {pendingCount === 1 ? "" : "s"}
                                                    </Badge>
                                                  ) : (
                                                    <Badge
                                                      variant="outline"
                                                      className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                                                    >
                                                      <Check className="h-3 w-3 mr-1" />
                                                      Todas revisadas
                                                    </Badge>
                                                  )}
                                                </button>
                                              </CollapsibleTrigger>
                                              <CollapsibleContent className="space-y-1.5 pt-1 border-t border-amber-300/30">
                                                {sorted.map((p) => {
                                                  const isReviewed = p.reviewedAt != null;
                                                  return (
                                                    <div
                                                      key={p.id}
                                                      className="rounded border bg-background p-1.5 text-xs flex items-center gap-2 flex-wrap"
                                                    >
                                                      <span className="font-medium">
                                                        {peerName(p.peerId)}
                                                      </span>
                                                      <Badge
                                                        variant={
                                                          p.score >= 0.85
                                                            ? "destructive"
                                                            : p.score >= 0.7
                                                              ? "default"
                                                              : "secondary"
                                                        }
                                                        className="text-[10px]"
                                                      >
                                                        {Math.round(p.score * 100)}%
                                                      </Badge>
                                                      {isReviewed && (
                                                        <Badge
                                                          variant="outline"
                                                          className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                                                        >
                                                          <Check className="h-3 w-3 mr-1" />
                                                          {t("integrity.reviewed", {
                                                            defaultValue: "Revisada",
                                                          })}
                                                        </Badge>
                                                      )}
                                                      <Button
                                                        size="sm"
                                                        variant="outline"
                                                        className={
                                                          isReviewed
                                                            ? "h-6 text-[10px] ml-auto bg-background"
                                                            : "h-6 text-[10px] ml-auto bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                                                        }
                                                        onClick={() =>
                                                          togglePairReviewed(p.id, isReviewed)
                                                        }
                                                      >
                                                        {isReviewed ? (
                                                          t("integrity.reopen", {
                                                            defaultValue: "Reabrir",
                                                          })
                                                        ) : (
                                                          <>
                                                            <Check className="h-3 w-3 mr-1" />
                                                            {t("integrity.markReviewed", {
                                                              defaultValue: "Marcar revisada",
                                                            })}
                                                          </>
                                                        )}
                                                      </Button>
                                                    </div>
                                                  );
                                                })}
                                              </CollapsibleContent>
                                            </div>
                                          </Collapsible>
                                        );
                                      })()}

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
                                              patchAnswer(sub.id, q.id, {
                                                ai_feedback: e.target.value,
                                              })
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
                                      {/* Conversación colapsable con resumen (count +
                                      pending). Reemplaza el FeedbackThread inline
                                      que se montaba siempre y disparaba 1 request
                                      por pregunta al abrir el accordion. */}
                                      <ConversationSection
                                        parentKind="workshop"
                                        questionId={q.id}
                                        submissionId={sub.id}
                                        summary={wsThreadsByQ[`${sub.id}:${q.id}`]}
                                        conversationLabel={t("integrity.conversation")}
                                        pendingLabel={t("integrity.conversationPending")}
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

                        {/* Acciones de calificación. Quitamos el input
                        "Calificación final" y el textarea
                        "Retroalimentación" globales: la nota final se
                        recomputa automáticamente desde las notas por
                        pregunta (botón "Recalcular calificación global"
                        del acordeón) y la retroalimentación vive
                        pregunta-por-pregunta dentro del acordeón.
                        El botón "Guardar calificación" persiste la
                        `final_grade` recalculada; "Calificar con IA"
                        dispara la evaluación por preguntas. */}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => saveGrade(sub.id, sub.final_grade ?? 0)}
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
                          {(sub.status === "calificado" || sub.status === "ai_revisado") && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="text-amber-700 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/10"
                              onClick={() => reopenSubmission(sub)}
                            >
                              Reabrir entrega
                            </Button>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
          </div>
        </DialogContent>
      </Dialog>

      {/* Workshop groups editor dialog */}
      <Dialog open={groupsOpen} onOpenChange={setGroupsOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Grupos del taller {groupsWs ? `— ${groupsWs.title}` : ""}</DialogTitle>
          </DialogHeader>
          {groupsWs && (
            <WorkshopGroupsEditor workshopId={groupsWs.id} courseId={groupsWs.course_id} />
          )}
        </DialogContent>
      </Dialog>

      {/* Workshop questions editor dialog */}
      <Dialog open={questionsOpen} onOpenChange={setQuestionsOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl max-h-[90vh] overflow-y-auto">
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

      {duplicateSource && (
        <DuplicateAssessmentDialog
          open={!!duplicateSource}
          onOpenChange={(o) => !o && setDuplicateSource(null)}
          source={duplicateSource}
          target="workshop"
          onDuplicated={() => {
            setDuplicateSource(null);
            void load();
          }}
        />
      )}
      <aiGate.GateDialog />
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
