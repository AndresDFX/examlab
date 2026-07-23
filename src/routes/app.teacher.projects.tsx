/**
 * Teacher — Projects CRUD (refactor: entregas en cajas de texto + IA).
 *
 * Espejo del módulo de talleres pero con "archivos" en vez de preguntas.
 * Cada proyecto tiene N archivos esperados (`project_files` rows). El
 * estudiante NO sube ZIPs: pega el contenido textual de cada archivo en
 * una caja, y al enviar la IA califica cada caja.
 *
 * Reusa `projects.max_files` (entero) como número de archivos esperados.
 * La generación con IA crea N rows en `project_files` con título, descripción
 * y rúbrica para que la calificación sea consistente.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { softDelete, softDeleteMany } from "@/modules/trash/soft-delete";
import { cancelPendingAiJobsForTarget } from "@/modules/ai/ai-grading";
import { CoursePicker } from "@/modules/courses/CoursePicker";
import { useAuth } from "@/hooks/use-auth";
import { PageLoader } from "@/components/ui/loaders";
import { isStaffRole } from "@/shared/lib/roles";
import { scoreCerradaMulti } from "@/modules/exams/question-scoring";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { toCSV } from "@/shared/lib/csv";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { HelpHint } from "@/components/ui/help-hint";
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
  SortableHead,
} from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { ExternalGradesEditor } from "@/modules/grading/ExternalGradesEditor";
import { ProjectGroupsEditor } from "@/modules/projects/ProjectGroupsEditor";
import { toast } from "sonner";
import { logEvent } from "@/shared/lib/audit";
import { friendlyError, friendlyUniqueViolation } from "@/shared/lib/db-errors";
import { isValidDateRange, capEndToCourseEnd, earliestCourseEnd } from "@/shared/lib/date-range";
import {
  Plus,
  Pencil,
  Trash2,
  Users,
  FileText,
  FileArchive,
  Download,
  ClipboardList,
  Sparkles,
  Save,
  UserPlus,
  FolderKanban,
  UsersRound,
  Search,
  X,
  Copy,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { DuplicateAssessmentDialog } from "@/shared/components/DuplicateAssessmentDialog";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { ListFilters } from "@/components/ui/list-filters";
import { ActivityStatusSelect } from "@/shared/components/ActivityStatusSelect";
import {
  matchesActivityStatus,
  DEFAULT_ACTIVITY_STATUS_FILTER,
  type ActivityStatusFilter,
} from "@/shared/lib/status-filter";
import { StatCard } from "@/components/ui/stat-card";
import { CheckCircle2, Lock, ExternalLink, Video, Upload, FileUp } from "lucide-react";
import { CourseListCell } from "@/components/ui/course-list-cell";
import { TeacherProjectFilesEditor } from "@/modules/projects/ProjectFiles";
import { BulkImportDefensesDialog } from "@/modules/projects/BulkImportDefensesDialog";
import { AssignSelector } from "@/shared/components/AssignSelector";
import { FeedbackThread } from "@/modules/grading/FeedbackThread";
import { FraudPanel } from "@/modules/exams/FraudPanel";
import { DecimalInput } from "@/components/ui/decimal-input";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { RowAction } from "@/components/ui/row-action";
import { Spinner } from "@/components/ui/spinner";
import { DateTimePicker } from "@/components/ui/date-picker";
import { ActivitySessionSelect } from "@/modules/sessions/ActivitySessionSelect";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { ReopenClosedBanner } from "@/shared/components/ReopenClosedBanner";
import { DateCell } from "@/components/ui/date-cell";
import { usePagination } from "@/hooks/use-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import { DataPagination } from "@/components/ui/data-pagination";
import { ListSkeleton } from "@/components/ui/table-skeleton";
import { formatDateTime, formatPercent } from "@/shared/lib/format";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

// projects, project_* aún no están en los tipos generados.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/teacher/projects")({
  component: TeacherProjects,
  validateSearch: (
    s: Record<string, unknown>,
  ): { project?: string; submission?: string; file?: string; edit?: string } => ({
    project: typeof s.project === "string" ? s.project : undefined,
    submission: typeof s.submission === "string" ? s.submission : undefined,
    file: typeof s.file === "string" ? s.file : undefined,
    // `edit=<id>` lo manda Contenidos al crear un proyecto desde un
    // contenido generado: abre el dialog de edición directamente.
    edit: typeof s.edit === "string" ? s.edit : undefined,
  }),
});

type Course = {
  id: string;
  name: string;
  period: string | null;
  language?: string | null;
  grade_scale_max?: number | null;
  /** Fecha fin del curso (DATE). La entrega del proyecto se topa a este día. */
  end_date?: string | null;
  /** courses.status: prioriza abiertos/actual en el CoursePicker. */
  status?: string | null;
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

type Project = {
  id: string;
  course_id: string;
  cut_id: string | null;
  title: string;
  description: string | null;
  instructions: string | null;
  external_link: string | null;
  /** Video explicativo obligatorio antes de la entrega de código. URL
   *  pública (YouTube/Vimeo iframe, o MP4/WebM en CDN). Si null, sin gate. */
  code_intro_video_url?: string | null;
  /** FK al row de la biblioteca de videos. Si está poblado, el frontend
   *  resuelve el URL desde la tabla `videos` e ignora
   *  `code_intro_video_url` (legacy). */
  code_intro_video_id?: string | null;
  max_files: number;
  start_date: string | null;
  due_date: string | null;
  max_score: number;
  /** Intentos máximos para este proyecto. NULL → usa el default global
   *  (app_settings.default_project_max_attempts). */
  max_attempts?: number | null;
  status: "draft" | "published" | "closed";
  is_external?: boolean;
  group_mode?: "individual" | "teacher_assigned" | "self_signup" | "group_required";
  course?: { name: string; period: string | null; language?: string | null };
  // Lista de IDs de cursos vinculados (incluye course_id primario)
  linked_course_ids?: string[];
};

function TeacherProjects() {
  const { user, roles, loading: authLoading } = useAuth();
  const { t } = useTranslation();
  const confirm = useConfirm();
  // SA accede a pantallas Docente para soporte / diagnóstico — sin SA
  // en el set, recibía "Necesitas rol Docente" silencioso al entrar.
  const isTeacher = isStaffRole(roles);
  // Gate IA: cubre generateDescription (ai-generate-questions) +
  // aiRegradeSubFile (ai-grade-submission por archivo). Pide
  // confirmación si el modo es async y el docente no tiene override.
  const aiGate = useAiAuthorizationGate();

  const [courses, setCourses] = useState<Course[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // Carga de datos (distinta de authLoading): evita el flash del empty state
  // "crea tu primer proyecto" mientras el fetch resuelve.
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [aiErrorsByProject, setAiErrorsByProject] = useState<Record<string, number>>({});
  // Per-course cut+weight for the project being created/edited.
  // Record<courseId, { cut_id, weight }>
  const [courseCuts, setCourseCuts] = useState<
    Record<string, { cut_id: string | null; weight: number }>
  >({});
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [duplicateSource, setDuplicateSource] = useState<{
    id: string;
    title: string;
    courseId: string;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  const [cutFilter, setCutFilter] = useState<string | null>(null);
  // Por defecto: activos + borradores; los cerrados se ocultan hasta cambiar
  // el filtro de estado a "Cerrados" o "Todos".
  const [statusFilter, setStatusFilter] = useState<ActivityStatusFilter>(
    DEFAULT_ACTIVITY_STATUS_FILTER,
  );
  // Proyectos filtrados por título, curso, corte y estado. A diferencia de
  // talleres/exámenes, un proyecto puede estar vinculado a N cursos
  // vía linked_course_ids — el match contra el filtro chequea esa
  // lista (cae al course_id legacy si no hay vínculos). El filtro de
  // corte aplica sobre cut_id (el corte siempre es del curso primario).
  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (courseFilter) {
        const linked = p.linked_course_ids ?? [p.course_id];
        if (!linked.includes(courseFilter)) return false;
      }
      if (cutFilter && p.cut_id !== cutFilter) return false;
      if (q && !p.title.toLowerCase().includes(q)) return false;
      if (!matchesActivityStatus(p.status, statusFilter)) return false;
      return true;
    });
  }, [projects, search, courseFilter, cutFilter, statusFilter]);

  // Quick-stats estables del listado completo (no se mueven al filtrar).
  // Mismos cuatro tiles que talleres/exámenes — pulso rápido del estado
  // del catálogo del docente.
  const projectStats = useMemo(() => {
    let draft = 0,
      published = 0,
      closed = 0,
      external = 0;
    for (const p of projects) {
      if (p.is_external) external++;
      if (p.status === "draft") draft++;
      else if (p.status === "published") published++;
      else if (p.status === "closed") closed++;
    }
    return { draft, published, closed, external };
  }, [projects]);

  // Orden por columna (asc/desc clicando el encabezado). Va ENTRE el
  // filtro y la paginación (filtrar → ORDENAR → paginar). Para el curso
  // ordenamos por el nombre del curso primario (mismo lookup que se
  // muestra como primer chip en la celda). El peso ordena numérico y los
  // proyectos sin peso (cut_id null) van al final por ser vacíos.
  const sort = useTableSort(filteredProjects, {
    columns: {
      title: (p) => p.title,
      course: (p) => courses.find((c) => c.id === p.course_id)?.name ?? "",
      cut: (p) => cuts.find((c) => c.id === p.cut_id)?.name ?? "",
      weight: (p) =>
        p.cut_id != null && (p as any).weight != null ? Number((p as any).weight) : null,
      status: (p) => p.status,
      start_date: (p) => p.start_date,
      due_date: (p) => p.due_date,
    },
    defaultSort: { key: "title", dir: "asc" },
    storageKey: "examlab_sort:teacher_projects",
  });

  const sel = useMultiSelect(sort.sorted);

  // Paginación client-side sobre la lista filtrada+ordenada. El
  // multi-select sigue trabajando sobre `sort.sorted` (todas las
  // páginas) para que "seleccionar todos" abarque coincidencias del
  // filtro, no solo los visibles. resetKey vuelve a la página 1 cuando
  // cambian los filtros activos o el orden.
  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:teacher_projects",
    resetKey: `${search}|${courseFilter ?? ""}|${cutFilter ?? ""}|${statusFilter}|${sort.resetKey}`,
  });

  // Export CSV de la lista filtrada — solo lectura. No soportamos import
  // porque la creación de un proyecto requiere rúbricas, archivos esperados
  // y vínculos a múltiples cursos que no caben en formato CSV plano. Para
  // duplicar un proyecto entre cursos existe el dialog "Duplicar".
  const exportProjectsCsv = (): string => {
    const cutById = new Map(cuts.map((c) => [c.id, c.name] as const));
    const data = filteredProjects.map((p) => ({
      title: p.title,
      course: p.course?.name ?? "",
      period: p.course?.period ?? "",
      cut: p.cut_id ? (cutById.get(p.cut_id) ?? "") : "",
      status: p.status,
      group_mode: p.group_mode ?? "individual",
      is_external: p.is_external ? "true" : "false",
      max_score: p.max_score,
      max_files: p.max_files,
      start_date: p.start_date ?? "",
      due_date: p.due_date ?? "",
      description: (p.description ?? "").replace(/\r?\n/g, " ").slice(0, 500),
    }));
    return toCSV(data);
  };

  const handleBulkDelete = async (ids: string[]) => {
    const { error } = await softDeleteMany("projects", ids);
    if (error) throw new Error(error.message);
    toast.success(
      i18n.t("toast.routes_app_teacher_projects.bulkSentToTrash", {
        defaultValue: "{{n}} proyecto(s) enviado(s) a papelera",
        n: ids.length,
      }),
    );
    void logEvent({
      action: "project.deleted",
      category: "project",
      actorRole: roles[0],
      metadata: { count: ids.length, ids },
    });
    sel.clear();
    load();
  };

  const selectedProjectItems = useMemo(
    () =>
      filteredProjects
        .filter((p) => sel.isSelected(p.id))
        .map((p) => ({ id: p.id, label: p.title })),
    [filteredProjects, sel],
  );
  const [open, setOpen] = useState(false);
  // Biblioteca de videos para el selector del form de proyecto. Carga
  // perezosa: solo cuando el dialog se abre, evita query al entrar a
  // la lista de proyectos.
  // `url` es CRÍTICO incluirlo: cuando el docente elige un video de la
  // biblioteca, ese URL es lo que persistimos en `project_intro_videos.url`
  // (la tabla no guarda library_id). Antes la SELECT pedía solo
  // id/title/provider — al elegir un video de la biblioteca, el Input
  // quedaba vacío y el filtro de save (`v.url.length > 0`) tiraba la fila.
  // Resultado: el alumno nunca veía el video introductorio aunque el
  // docente "lo guardó".
  const [videoLibrary, setVideoLibrary] = useState<
    Array<{ id: string; title: string; provider: string; url: string }>
  >([]);
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const { data } = await db
        .from("videos")
        .select("id, title, provider, url")
        .eq("is_archived", false)
        .order("title");
      setVideoLibrary(
        (data ?? []) as Array<{ id: string; title: string; provider: string; url: string }>,
      );
    })();
  }, [open]);
  const [editing, setEditing] = useState<Project | null>(null);
  const [form, setForm] = useState<Partial<Project>>({});
  /** Lista N de videos introductorios. Vive separada del `form` porque
   *  se persiste en otra tabla (`project_intro_videos`) y se sincroniza
   *  manualmente después de guardar el proyecto principal. Cada row
   *  tiene: `library_id` (FK a `videos` cuando elige biblioteca) Y/O
   *  `url` (ad-hoc). Si `library_id` está seteado, `url` se resuelve
   *  desde la biblioteca al renderizar; en DB se persiste solo la URL
   *  final (lookup ya hecho) para no introducir un join en lectura. */
  const [formIntroVideos, setFormIntroVideos] = useState<
    Array<{ library_id: string | null; url: string; title: string }>
  >([]);
  const projectDirty = useDirtyDialog(open, form);
  // Generación de descripción con IA: dialog modal con input "tema" +
  // botón que invoca la edge function `ai-generate-questions` modo
  // `projectDescriptionGeneration`. La descripción resultante reemplaza
  // el textarea actual del form (el docente puede editarla después).
  const [aiDescOpen, setAiDescOpen] = useState(false);
  const [aiDescTopic, setAiDescTopic] = useState("");
  const [aiDescLoading, setAiDescLoading] = useState(false);

  const [filesOpen, setFilesOpen] = useState(false);
  const [filesProject, setFilesProject] = useState<Project | null>(null);

  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupsProject, setGroupsProject] = useState<Project | null>(null);

  /**
   * Abre el editor de grupos del proyecto. Si está en modo `individual`,
   * lo cambia a `teacher_assigned` silenciosamente para que el flujo
   * sea de un click — espejo del comportamiento en talleres.
   */
  const openGroupsForProject = async (p: Project) => {
    const mode = (p as any).group_mode ?? "individual";
    let updated = p;
    if (mode === "individual") {
      const { error } = await db
        .from("projects")
        .update({ group_mode: "teacher_assigned" })
        .eq("id", p.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      updated = { ...p, group_mode: "teacher_assigned" } as Project;
      setProjects((prev) => prev.map((x) => (x.id === p.id ? updated : x)));
      toast.success(t("project.groupActivated"));
    }
    setGroupsProject(updated);
    setGroupsOpen(true);
  };

  const [assignOpen, setAssignOpen] = useState(false);
  const [assignProject, setAssignProject] = useState<Project | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [assignLoading, setAssignLoading] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignFilterCourses, setAssignFilterCourses] = useState<Set<string>>(new Set());
  const [studentsByCourse, setStudentsByCourse] = useState<Map<string, Set<string>>>(new Map());

  // Grading dialog state
  type Submission = {
    id: string;
    user_id: string;
    /** Si la entrega es grupal, ID del grupo. La carpeta raíz de Storage
     *  para esa entrega es `<group_id>/<sub.id>/…` en lugar de
     *  `<user_id>/…`. Necesario para resolver el storage fallback al
     *  listar archivos cuyo `code_paths` quedó null en DB. */
    group_id?: string | null;
    status: string;
    final_grade: number | null;
    ai_grade: number | null;
    submission_grade: number | null;
    defense_factor: number | null;
    defense_notes: string | null;
    defense_at: string | null;
    defense_video_url: string | null;
    repository_url: string | null;
    submitted_at: string | null;
    profile?: { full_name: string; institutional_email: string };
  };
  type SubFile = {
    id: string;
    submission_id: string;
    file_id: string;
    content: string | null;
    ai_grade: number | null;
    ai_feedback: string | null;
    ai_likelihood: number | null;
    // Texto explicativo de por qué la IA estima que la entrega es generada
    // por IA. Se persiste por archivo desde el edge function (mismo patrón
    // que workshops). Se muestra inline bajo el % cuando ai_likelihood >= 0.6
    // para que el docente entienda la marca sin ir a auditoría.
    ai_reasons?: string | null;
    zip_truncated?: boolean | null;
    zip_chars_used?: number | null;
    // Entregas tipo `codigo_zip`: paths en bucket `project-files`.
    // `code_paths` (flujo nuevo, varios archivos sueltos) o `zip_path`
    // (flujo legacy, un único ZIP). Pueden coexistir vacíos si la
    // pregunta no es de código.
    code_paths?: string[] | null;
    zip_path?: string | null;
  };
  const [gradingOpen, setGradingOpen] = useState(false);
  const [gradingProject, setGradingProject] = useState<Project | null>(null);
  const [gradingFiles, setGradingFiles] = useState<
    Array<{ id: string; title: string; points: number; type: string | null }>
  >([]);
  const [gradingSubs, setGradingSubs] = useState<Submission[]>([]);
  const [gradingAnsBySub, setGradingAnsBySub] = useState<Record<string, SubFile[]>>({});
  const [gradingLoading, setGradingLoading] = useState(false);
  // Buscador del modal de calificaciones — filtra por nombre/correo del
  // estudiante. Se limpia al abrir el dialog.
  const [gradingSearch, setGradingSearch] = useState("");
  const filteredGradingSubs = useMemo(() => {
    const q = gradingSearch.trim().toLowerCase();
    if (!q) return gradingSubs;
    return gradingSubs.filter((s) => {
      const name = (s.profile?.full_name ?? "").toLowerCase();
      const email = (s.profile?.institutional_email ?? "").toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [gradingSubs, gradingSearch]);
  // Multi-select para recalificar SOLO algunas entregas con IA. Trabaja
  // sobre las entregas filtradas — si el docente busca "Juan" y marca,
  // el bulk re-grade respeta ese subset. `useMultiSelect` deduplica
  // por id, así que entregas que dejan de estar visibles al cambiar
  // el buscador quedan "huérfanas" en el set sin generar errores.
  const gradingSel = useMultiSelect(filteredGradingSubs);
  // Submission a destacar/scrollear cuando el dialog abre desde un
  // deep-link (?submission=ID).
  const [highlightSubId, setHighlightSubId] = useState<string | null>(null);
  // Archivo a destacar dentro del accordion expandido cuando el
  // deep-link viene del modal de Conversaciones abiertas (?file=ID).
  const [highlightFileId, setHighlightFileId] = useState<string | null>(null);
  const [openAccordionItems, setOpenAccordionItems] = useState<string[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [aiRegradingId, setAiRegradingId] = useState<string | null>(null);
  // Bulk import de sustentaciones via CSV — abre el dialog separado.
  // Sin ese flujo el docente tenía que sustentar uno por uno.
  const [bulkDefensesOpen, setBulkDefensesOpen] = useState(false);
  // Bulk re-grade del proyecto entero. Itera todas las entregas filtradas
  // (respeta el buscador del modal) × todas las preguntas y llama el
  // edge per-file. Progreso visible en el botón (X/Y). Para volúmenes
  // grandes (200 alumnos × 5 archivos = 1000 calls IA) el docente puede
  // filtrar primero para regrade-batch parcial.
  const [bulkRegrading, setBulkRegrading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });

  /** Auto-assign a project to all students enrolled in any of the linked courses. */
  const autoAssignProject = async (projectId: string, courseIds: string[]) => {
    if (!courseIds.length) return 0;
    const { data: enr } = await db
      .from("course_enrollments")
      .select("user_id")
      .in("course_id", courseIds);
    const enrolled = Array.from(
      new Set(((enr ?? []) as { user_id: string }[]).map((r) => r.user_id)),
    );
    if (!enrolled.length) return 0;
    const { data: existing } = await db
      .from("project_assignments")
      .select("user_id")
      .eq("project_id", projectId);
    const existSet = new Set(((existing ?? []) as { user_id: string }[]).map((r) => r.user_id));
    const toAdd = enrolled.filter((uid) => !existSet.has(uid));
    if (!toAdd.length) return 0;
    const rows = toAdd.map((uid) => ({ project_id: projectId, user_id: uid }));
    const { error } = await db.from("project_assignments").insert(rows);
    if (error) {
      toast.error(friendlyError(error));
      return 0;
    }
    return toAdd.length;
  };

  const load = async () => {
    setLoading(true);
    // Cada query se aísla en su propio try para que un fallo (p.ej. una
    // migración faltante) no esconda los datos que SÍ podemos cargar. Antes
    // un solo `Promise.all` rechazaba el load entero y la tabla quedaba
    // vacía sin mensaje, lo que bloqueaba el diagnóstico.
    try {
      const cs = await db
        .from("courses")
        .select("id, name, period, language, grade_scale_max, end_date, status")
        .is("deleted_at", null)
        .order("name");
      if (cs.error) throw new Error(`courses: ${cs.error.message}`);
      setCourses((cs.data ?? []) as Course[]);
    } catch (e) {
      console.error("[projects] courses load failed", e);
      toast.error(friendlyError(e, t("hc_routesAppTeacherProjects.errorLoadingCourses")));
    }

    try {
      const cs2 = await db
        .from("grade_cuts")
        .select(
          "id, course_id, name, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
        )
        .order("position");
      if (cs2.error) throw new Error(`grade_cuts: ${cs2.error.message}`);
      setCuts((cs2.data ?? []) as Cut[]);
    } catch (e) {
      console.error("[projects] grade_cuts load failed", e);
      // No mostramos toast aquí: cuts es opcional para listar.
    }

    let pcsRows: {
      project_id: string;
      course_id: string;
      cut_id: string | null;
      weight: number;
    }[] = [];
    try {
      const pcs = await db.from("project_courses").select("project_id, course_id, cut_id, weight");
      if (pcs.error) throw new Error(`project_courses: ${pcs.error.message}`);
      pcsRows = (pcs.data ?? []) as {
        project_id: string;
        course_id: string;
        cut_id: string | null;
        weight: number;
      }[];
    } catch (e) {
      console.error("[projects] project_courses load failed", e);
      toast.error(friendlyError(e, t("hc_routesAppTeacherProjects.errorLoadingCourseLinks")));
    }

    try {
      // El JOIN `course:courses(...)` puede fallar si la columna `language`
      // no existe en la BD. Si falla, reintentamos sin el JOIN para mostrar
      // al menos los proyectos en bruto.
      let ps = await db
        .from("projects")
        .select("*, course:courses(name, period, language)")
        // Ocultar proyectos en papelera de la lista del docente.
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (ps.error) {
        console.warn("[projects] projects+join failed, retrying without join", ps.error);
        ps = await db
          .from("projects")
          .select("*")
          // Ocultar proyectos en papelera de la lista del docente.
          .is("deleted_at", null)
          .order("created_at", { ascending: false });
      }
      if (ps.error) throw new Error(`projects: ${ps.error.message}`);

      const linkMap = new Map<string, string[]>();
      // Per-project map: courseId → { cut_id, weight } from project_courses
      const cutsMapByProject = new Map<
        string,
        Record<string, { cut_id: string | null; weight: number }>
      >();
      for (const row of pcsRows) {
        const arr = linkMap.get(row.project_id) ?? [];
        arr.push(row.course_id);
        linkMap.set(row.project_id, arr);
        const cutsMap = cutsMapByProject.get(row.project_id) ?? {};
        cutsMap[row.course_id] = { cut_id: row.cut_id ?? null, weight: row.weight ?? 1 };
        cutsMapByProject.set(row.project_id, cutsMap);
      }
      const projectsRaw = (ps.data ?? []) as Project[];
      // Self-heal: si un proyecto tiene `course_id` pero ese vínculo
      // no aparece en project_courses (bug histórico: el sync borraba
      // el vínculo y un fallo silencioso del INSERT lo dejaba huérfano),
      // intentamos crear la fila ahora. Sin esto, ese proyecto NO se
      // encontraba al filtrar por su curso primario tras el bug.
      const missingLinks = projectsRaw
        .filter((p) => p.course_id && !(linkMap.get(p.id) ?? []).includes(p.course_id))
        .map((p) => ({ project_id: p.id, course_id: p.course_id }));
      if (missingLinks.length) {
        console.warn(
          `[projects] self-healing ${missingLinks.length} missing project_courses link(s)`,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: healErr } = await (db as any)
          .from("project_courses")
          .upsert(missingLinks, { onConflict: "project_id,course_id" });
        if (healErr) {
          console.warn("[projects] self-heal insert failed", healErr);
        } else {
          // Reflejar en memoria para que el filtro funcione ya en este render.
          for (const link of missingLinks) {
            const arr = linkMap.get(link.project_id) ?? [];
            arr.push(link.course_id);
            linkMap.set(link.project_id, arr);
          }
        }
      }
      const enriched = projectsRaw.map((p) => {
        const linked = linkMap.get(p.id) ?? [];
        const set = new Set<string>(linked);
        if (p.course_id) set.add(p.course_id);
        return {
          ...p,
          linked_course_ids: Array.from(set),
          _course_cuts: cutsMapByProject.get(p.id) ?? {},
        };
      });
      setProjects(enriched);
      // Cargar counts de errores IA por proyecto (mismo patrón que exam/workshop).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: aiErr } = await (supabase as any).rpc("count_ai_errors_per_project");
      const errMap: Record<string, number> = {};
      for (const row of (aiErr ?? []) as Array<{ project_id: string; error_count: number }>) {
        errMap[row.project_id] = Number(row.error_count) || 0;
      }
      setAiErrorsByProject(errMap);
      console.info(`[projects] loaded ${enriched.length} project(s)`);
      setLoadError(null);
    } catch (e) {
      console.error("[projects] projects load failed", e);
      // Marca loadError para que el render muestre <ErrorState> en vez
      // de una tabla vacía como si no hubiera proyectos. Mantengo el
      // toast para feedback inmediato.
      setLoadError(friendlyError(e, t("hc_routesAppTeacherProjects.couldNotLoadProjects")));
      toast.error(friendlyError(e, t("hc_routesAppTeacherProjects.errorLoadingProjects")));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isTeacher) return;
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacher, retryNonce]);

  // Deep-link desde notificación o modal de Conversaciones abiertas:
  //   ?project=PROJECT_ID&submission=SUB_ID&file=FILE_ID
  //   ?id=PROJECT_ID    (legacy, notificaciones viejas)
  // → abre el grading dialog, expande la submission y scrollea al
  // archivo cuya conversación se quiere ver. Si el proyecto ya no
  // existe, toast claro y limpia la URL para no re-disparar.
  const [autoOpenedFromUrl, setAutoOpenedFromUrl] = useState(false);
  useEffect(() => {
    if (autoOpenedFromUrl || projects.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const projectParam = params.get("project") ?? params.get("id");
    const subParam = params.get("submission");
    const fileParam = params.get("file");
    // `?edit=<ID>` lo manda Contenidos al recién crear un proyecto:
    // abre directamente el dialog de edición para que el docente
    // ajuste título/fechas/peso/rúbrica y luego dispare "Generar
    // preguntas con IA" del editor — sin tener que buscar el row
    // recién creado en el grid.
    const editParam = params.get("edit");
    if (editParam) {
      const p = projects.find((pr) => pr.id === editParam);
      if (p) {
        openEdit(p);
      } else {
        toast.info(
          i18n.t("toast.routes_app_teacher_projects.projectFromUrlNotFound", {
            defaultValue: "El proyecto referenciado en la URL ya no existe o no tienes acceso a él.",
          }),
        );
      }
      const url = new URL(window.location.href);
      url.searchParams.delete("edit");
      window.history.replaceState({}, "", url.toString());
      setAutoOpenedFromUrl(true);
      return;
    }
    if (projectParam) {
      const p = projects.find((pr) => pr.id === projectParam);
      if (p) {
        if (subParam) setHighlightSubId(subParam);
        if (fileParam) setHighlightFileId(fileParam);
        void openGradingDialog(p);
      } else {
        toast.info(
          i18n.t("toast.routes_app_teacher_projects.projectFromNotificationNotFound", {
            defaultValue:
              "El proyecto referenciado en la notificación ya no existe o no tienes acceso a él.",
          }),
        );
      }
      // Limpia los query params para que un refresh no re-dispare.
      const url = new URL(window.location.href);
      url.searchParams.delete("project");
      url.searchParams.delete("submission");
      url.searchParams.delete("file");
      url.searchParams.delete("id");
      window.history.replaceState({}, "", url.toString());
    }
    setAutoOpenedFromUrl(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, autoOpenedFromUrl]);

  // Cuando hay highlightFileId pendiente y la submission destacada ya
  // está expandida con sus answers cargadas, scrollea + ring a la card
  // del archivo. El accordion se auto-expandió en el effect anterior.
  useEffect(() => {
    if (!gradingOpen || !highlightFileId || !highlightSubId) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`pj-file-${highlightSubId}-${highlightFileId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 250);
    const clear = setTimeout(() => setHighlightFileId(null), 3500);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [gradingOpen, highlightFileId, highlightSubId, gradingSubs]);

  // Scroll + ring temporal + auto-expand del accordion a la submission
  // destacada (deep-link desde el modal "Conversaciones abiertas" o desde
  // una notificación).
  useEffect(() => {
    if (!gradingOpen || !highlightSubId || gradingSubs.length === 0) return;
    const target = gradingSubs.find((s) => s.id === highlightSubId);
    if (!target) {
      setHighlightSubId(null);
      return;
    }
    setOpenAccordionItems((prev) =>
      prev.includes(highlightSubId) ? prev : [...prev, highlightSubId],
    );
    const t = setTimeout(() => {
      const el = document.getElementById(`pj-sub-${highlightSubId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    const clear = setTimeout(() => setHighlightSubId(null), 3500);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [gradingOpen, highlightSubId, gradingSubs]);

  const openNew = () => {
    setEditing(null);
    const first = courses[0]?.id;
    const now = new Date();
    const due = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // +2 semanas
    setForm({
      title: "",
      description: "",
      external_link: "",
      code_intro_video_url: "",
      code_intro_video_id: null,
      course_id: first,
      cut_id: null,
      // Hereda la escala del curso (que hereda la de la institución).
      // Antes quedaba fijo en 100 aunque el curso fuera /5. Sobrescribible.
      max_score: courses.find((c) => c.id === first)?.grade_scale_max ?? 100,
      status: "draft",
      linked_course_ids: first ? [first] : [],
      // "Visible desde" arranca AHORA y "Fecha límite" en 2 semanas por
      // defecto. El docente típicamente quiere publicar inmediato y
      // ajusta el due_date a la fecha real del proyecto. Antes ambos
      // quedaban vacíos y obligaban a escribir desde cero.
      start_date: toLocal(now.toISOString()),
      due_date: toLocal(due.toISOString()),
    });
    setCourseCuts(first ? { [first]: { cut_id: null, weight: 1 } } : {});
    setFormIntroVideos([]);
    setOpen(true);
  };

  const openEdit = async (p: Project) => {
    setEditing(p);
    const linked = p.linked_course_ids?.length
      ? p.linked_course_ids
      : p.course_id
        ? [p.course_id]
        : [];
    setForm({ ...p, linked_course_ids: linked });
    // Carga los videos introductorios del proyecto (migrados a tabla
    // aparte en 20260603180000). El backfill convirtió legacy
    // `code_intro_video_url` a una fila position=0 — al editar se
    // ven y se pueden quitar/agregar igual que un set fresco.
    try {
      const { data: videos } = await db
        .from("project_intro_videos")
        .select("url, title, position")
        .eq("project_id", p.id)
        .order("position");
      setFormIntroVideos(
        (
          (videos as Array<{ url: string; title: string | null; position: number }> | null) ?? []
        ).map((v) => ({
          library_id: null,
          url: v.url,
          title: v.title ?? "",
        })),
      );
    } catch {
      setFormIntroVideos([]);
    }
    // Init per-course cut+weight from stored project_courses data.
    // Falls back to projects.cut_id/weight for the primary course for
    // rows that predate the migration.
    const stored = (p as any)._course_cuts as
      | Record<string, { cut_id: string | null; weight: number }>
      | undefined;
    const cc: Record<string, { cut_id: string | null; weight: number }> = {};
    for (const cid of linked) {
      if (stored?.[cid]) {
        cc[cid] = stored[cid];
      } else if (cid === p.course_id && p.cut_id) {
        cc[cid] = { cut_id: p.cut_id, weight: Number((p as any).weight ?? 1) };
      } else {
        cc[cid] = { cut_id: null, weight: 1 };
      }
    }
    setCourseCuts(cc);
    setOpen(true);
  };

  const toggleFormCourse = (courseId: string) => {
    const current = new Set(form.linked_course_ids ?? []);
    if (current.has(courseId)) {
      current.delete(courseId);
    } else {
      current.add(courseId);
    }
    const next = Array.from(current);
    const primary = next.includes(form.course_id ?? "") ? form.course_id : next[0];
    // Topar la entrega (due_date) al fin del curso que termina ANTES entre los
    // seleccionados (cabe en todos). Si ya es menor, se deja igual. No aplica a
    // externos (la fecha es marcador del evento ya ocurrido).
    const cappedDue = (form as any).is_external
      ? form.due_date
      : capEndToCourseEnd(
          form.due_date,
          earliestCourseEnd(next.map((cid) => courses.find((c) => c.id === cid)?.end_date)),
        );
    setForm({ ...form, linked_course_ids: next, course_id: primary, due_date: cappedDue });
    setCourseCuts((prev) => {
      const updated: Record<string, { cut_id: string | null; weight: number }> = {};
      for (const cid of next) {
        updated[cid] = prev[cid] ?? { cut_id: null, weight: 1 };
      }
      return updated;
    });
  };

  const save = async () => {
    const linked = form.linked_course_ids ?? [];
    if (!form.title || linked.length === 0 || !user) {
      toast.error(
        i18n.t("toast.routes_app_teacher_projects.titleAndCourseRequired", {
          defaultValue: "Título y al menos un curso son obligatorios",
        }),
      );
      return;
    }
    const primaryCourse =
      form.course_id && linked.includes(form.course_id) ? form.course_id : linked[0];
    const isExternal = !!(form as any).is_external;
    // Topar la entrega (due_date) al fin del curso que termina ANTES entre los
    // asociados (defensa al guardar: cubre edición y cambios tras elegir curso).
    // La fecha fin nunca supera la del curso. No aplica a externos.
    const cappedDue = isExternal
      ? (form.due_date ?? "")
      : capEndToCourseEnd(
          form.due_date,
          earliestCourseEnd(linked.map((cid) => courses.find((c) => c.id === cid)?.end_date)),
        );
    if (!isExternal && cappedDue !== (form.due_date ?? "")) {
      setForm((f) => ({ ...f, due_date: cappedDue }));
    }
    // Regla cross-form (goal #10): la fecha de entrega (due_date) no puede
    // ser anterior a la de inicio (start_date); iguales OK. El tope anterior NO
    // salta esta validación: si el curso termina antes del inicio, es inválido.
    if (!isExternal && !isValidDateRange(form.start_date, cappedDue)) {
      toast.error(t("common.endDateBeforeStart"));
      return;
    }
    // Patrón "campos desactivados": cuando is_external=true, omitir
    // campos sin sentido (instrucciones, link) del payload para no
    // insertar dummies. `max_files` se omite SIEMPRE — la cantidad real
    // de preguntas/entregables sale de `project_files`, no de un input.
    //
    // is_external solo se envía cuando es true. Si el column todavía no
    // está en el schema cache de PostgREST (Lovable aún no aplicó la
    // migración), mandar is_external=false rompía el insert con
    // "Could not find the 'is_external' column". El default de la
    // tabla ya es false, así que omitirlo es seguro.
    // Primary course's cut+weight (synced to projects.cut_id/weight for backwards compat)
    const primaryCC = courseCuts[primaryCourse] ?? { cut_id: null, weight: 1 };
    const payload: Record<string, any> = {
      course_id: primaryCourse,
      cut_id: primaryCC.cut_id || null,
      title: form.title,
      description: form.description ?? null,
      max_score: Number(form.max_score) || 100,
      // null → hereda del default global. Si el docente pone valor
      // explícito, override por proyecto.
      max_attempts:
        form.max_attempts != null && Number(form.max_attempts) > 0
          ? Number(form.max_attempts)
          : null,
      status: form.status ?? "draft",
      // Sesión asociada (opcional) — aparece bajo esa clase en el tablero.
      attendance_session_id: (form as any).attendance_session_id ?? null,
    };
    if (isExternal) {
      payload.is_external = true;
      // Para externos: due_date marca cuándo ocurrió, sin start.
      payload.due_date = cappedDue ? new Date(cappedDue).toISOString() : null;
    } else {
      payload.external_link = form.external_link || null;
      // Video introductorio obligatorio. Vacío → null (sin gate); URL →
      // se renderiza al alumno antes de la entrega de código.
      payload.code_intro_video_url = form.code_intro_video_url?.trim() || null;
      // FK a biblioteca de videos. Si está poblada el frontend resuelve
      // el URL desde la tabla `videos` y `code_intro_video_url` queda
      // como fallback histórico.
      payload.code_intro_video_id = form.code_intro_video_id || null;
      payload.start_date = form.start_date ? new Date(form.start_date).toISOString() : null;
      payload.due_date = cappedDue ? new Date(cappedDue).toISOString() : null;
      // Modo de trabajo (individual / grupal / mixto). Solo aplica si NO
      // es externo — en externos no hay entrega digital.
      payload.group_mode = form.group_mode ?? "individual";
    }
    // Validate weight per course and collect into payload for the primary course.
    const editingId = editing?.id;
    for (const cid of linked) {
      const cc = courseCuts[cid];
      if (!cc?.cut_id) continue;
      const requested = Math.max(0, Number(cc.weight ?? 1));
      const cut = cuts.find((c) => c.id === cc.cut_id);
      const bucket = Number(cut?.project_weight ?? 0);
      const otherProjectsSum = projects
        .filter((p) => p.cut_id === cc.cut_id && p.id !== editingId)
        .reduce((s, p) => s + Number((p as any).weight ?? 0), 0);
      const available = Math.max(0, bucket - otherProjectsSum);
      if (requested > available + 0.01) {
        const cName = courses.find((c) => c.id === cid)?.name ?? cid;
        toast.error(
          i18n.t("toast.routes_app_teacher_projects.weightExceedsBucket", {
            defaultValue:
              "{{course}}: El peso del proyecto ({{requested}}%) supera el bucket disponible del corte ({{available}}% restantes). Reduce el peso o ajusta los demás proyectos del corte.",
            course: cName,
            requested,
            available: available.toFixed(2),
          }),
        );
        return;
      }
      if (cid === primaryCourse) payload.weight = requested;
    }

    let projectId: string | null = null;
    if (editing) {
      const { error } = await db.from("projects").update(payload).eq("id", editing.id);
      if (error) return toast.error(friendlyUniqueViolation(error) ?? friendlyError(error));
      projectId = editing.id;
      toast.success(t("project.savedToast"));
      void logEvent({
        action: "project.updated",
        category: "project",
        actorRole: roles[0],
        entityType: "project",
        entityId: editing.id,
        entityName: form.title,
        courseId: form.course_id ?? undefined,
        courseName: courses.find((c) => c.id === form.course_id)?.name,
      });
    } else {
      const { data: created, error } = await db
        .from("projects")
        .insert({ ...payload, created_by: user.id })
        .select("id")
        .single();
      if (error || !created)
        return toast.error(friendlyUniqueViolation(error) ?? friendlyError(error, "Error al crear"));
      projectId = created.id;
      toast.success(t("project.createdToast"));
      void logEvent({
        action: "project.created",
        category: "project",
        actorRole: roles[0],
        entityType: "project",
        entityId: created.id,
        entityName: form.title,
        courseId: form.course_id ?? undefined,
        courseName: courses.find((c) => c.id === form.course_id)?.name,
      });
    }

    if (projectId) {
      // Sincronizar vínculos a cursos. Antes este bloque no chequeaba
      // errores: si el DELETE pasaba pero el INSERT fallaba (RLS,
      // conflict, etc.), el proyecto quedaba SIN vínculos y el filtro
      // por curso secundario dejaba de encontrarlo. Ahora hacemos
      // INSERT primero con upsert (idempotente) y solo borramos los
      // que sobran, así nunca dejamos el proyecto sin vínculos.
      const rows = linked.map((cid) => ({
        project_id: projectId,
        course_id: cid,
        cut_id: courseCuts[cid]?.cut_id || null,
        weight: courseCuts[cid]?.weight ?? 1,
      }));
      if (rows.length) {
        // upsert por la unique (project_id, course_id) — re-ejecutable.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: upErr } = await (db as any)
          .from("project_courses")
          .upsert(rows, { onConflict: "project_id,course_id" });
        if (upErr) {
          toast.error(
            i18n.t("toast.routes_app_teacher_projects.linkCoursesFailed", {
              defaultValue: "No se pudieron vincular los cursos: {{error}}",
              error: friendlyError(upErr),
            }),
          );
        }
      }
      // Quitar vínculos a cursos que ya no están en `linked`. Si la
      // lista quedó vacía no borramos nada (escenario inválido que
      // bloqueamos al inicio).
      if (linked.length) {
        const { error: delErr } = await db
          .from("project_courses")
          .delete()
          .eq("project_id", projectId)
          .not("course_id", "in", `(${linked.map((c) => `"${c}"`).join(",")})`);
        if (delErr) {
          console.warn("[projects] cleanup of stale project_courses failed", delErr);
        }
      }

      // ── Sync `project_intro_videos` (lista N) ──
      // Estrategia: DELETE all + INSERT all. Más simple que diff y al
      // editar un proyecto el docente está conscientemente reseteando
      // el set de videos — aceptamos que las views previas
      // (project_submission_video_views) caigan en cascada y el alumno
      // tenga que re-ver. Si esto se vuelve problema, migrar a diff por
      // URL/posición.
      //
      // Defense-in-depth: si el row tiene `library_id` pero su `url` aún
      // está vacío (race entre el cambio del Select y el setState que
      // copia el url, o `videoLibrary` no cargado), resolvemos la URL
      // desde el catálogo antes del filtro. Sin esto, picar un video de
      // la biblioteca y guardar rápido podía descartar la fila.
      const cleanedVideoRows = formIntroVideos
        .map((v, idx) => {
          let resolvedUrl = v.url.trim();
          if (!resolvedUrl && v.library_id) {
            const libRow = videoLibrary.find((vl) => vl.id === v.library_id);
            if (libRow?.url) resolvedUrl = libRow.url;
          }
          return { url: resolvedUrl, title: v.title.trim() || null, position: idx };
        })
        .filter((v) => v.url.length > 0);
      // Borrar todo lo existente del proyecto. CASCADE de
      // `project_submission_video_views` se dispara y resetea el progreso
      // de los estudiantes — esperado.
      await db.from("project_intro_videos").delete().eq("project_id", projectId);
      if (cleanedVideoRows.length > 0) {
        const insertRows = cleanedVideoRows.map((v) => ({
          project_id: projectId,
          url: v.url,
          title: v.title,
          position: v.position,
        }));
        const { error: vErr } = await db.from("project_intro_videos").insert(insertRows);
        if (vErr) {
          console.warn("[projects] sync project_intro_videos failed", vErr);
          toast.error(
            i18n.t("toast.routes_app_teacher_projects.saveIntroVideosFailed", {
              defaultValue: "No se pudieron guardar los videos introductorios: {{error}}",
              error: friendlyError(vErr),
            }),
          );
        }
      }

      // Al editar: si el conjunto de cursos vinculados cambió, recogemos
      // los matriculados de los cursos vigentes y borramos asignaciones
      // de usuarios que ya no están en ningún curso vinculado. autoAssign
      // luego rellena los que falten (idempotente). Sin esto, quitar un
      // curso del proyecto dejaba a sus estudiantes asignados huérfanos.
      if (editing) {
        const { data: enrAll } = await db
          .from("course_enrollments")
          .select("user_id")
          .in("course_id", linked.length ? linked : ["00000000-0000-0000-0000-000000000000"]);
        const validUsers = new Set(((enrAll ?? []) as { user_id: string }[]).map((r) => r.user_id));
        const { data: assignedNow } = await db
          .from("project_assignments")
          .select("user_id")
          .eq("project_id", projectId);
        const toUnassign = ((assignedNow ?? []) as { user_id: string }[])
          .map((r) => r.user_id)
          .filter((uid) => !validUsers.has(uid));
        if (toUnassign.length) {
          await db
            .from("project_assignments")
            .delete()
            .eq("project_id", projectId)
            .in("user_id", toUnassign);
        }
      }

      // Auto-asignar a todos los matriculados de TODOS los cursos vinculados
      // SIEMPRE (no solo al publicar). Esto garantiza que al COMPARTIR un
      // proyecto a un curso nuevo —incluso en borrador o al editar— los
      // estudiantes del nuevo curso queden asignados para que entreguen y se
      // les compute nota en ese curso (goal #30/#31). Es idempotente:
      // autoAssignProject solo inserta los que faltan.
      const added = await autoAssignProject(projectId, linked);
      if (added > 0)
        toast.success(
          i18n.t("toast.routes_app_teacher_projects.studentsAutoAssigned", {
            defaultValue: "{{n}} estudiante(s) asignados automáticamente",
            n: added,
          }),
        );

      // Notificar a los estudiantes solo cuando el proyecto está
      // publicado y NO es externo. Distintos titles para create/update.
      // kind='project' (CRITICAL_KIND tras migración 20260523000007) →
      // dispara correo. Antes era 'info' y solo iba a in-app.
      if (payload.status === "published" && !isExternal) {
        const isUpdate = !!editing;
        const title = isUpdate
          ? t("hc_routesAppTeacherProjects.notifProjectUpdatedTitle")
          : t("hc_routesAppTeacherProjects.notifProjectPublishedTitle");
        const body = isUpdate
          ? t("hc_routesAppTeacherProjects.notifProjectUpdatedBody", { title: form.title })
          : t("hc_routesAppTeacherProjects.notifProjectPublishedBody", { title: form.title });
        for (const cid of linked) {
          await supabase.rpc("notify_course_students", {
            _course_id: cid,
            _title: title,
            _body: body,
            _kind: "project",
            _link: "/app/student/projects",
          });
        }
      }
    }

    setOpen(false);
    await load();
  };

  /**
   * Genera la descripción del proyecto a partir de un tema usando la
   * edge function `ai-generate-questions` (modo
   * `projectDescriptionGeneration`). El system prompt vive en
   * `ai_prompts.use_case='project_description'` (override por curso si
   * existe). El resultado reemplaza el textarea — el docente puede
   * editarlo después.
   */
  const generateDescription = async () => {
    const topic = aiDescTopic.trim();
    if (!topic) {
      toast.error(
        i18n.t("toast.routes_app_teacher_projects.topicRequired", {
          defaultValue: "Indica un tema para generar la descripción",
        }),
      );
      return;
    }
    const decision = await aiGate.ensureAuthorized();
    if (decision === "cancel") return;
    setAiDescLoading(true);
    try {
      const courseId = form.course_id ?? null;
      const courseLanguage =
        courses.find((c) => c.id === courseId)?.language === "en" ? "en" : "es";
      const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
        body: {
          projectDescriptionGeneration: true,
          topic,
          courseId,
          courseLanguage,
        },
      });
      // Extraer el body real del FunctionsHttpError antes de throw: sin
      // esto, `error.message` siempre es "Edge Function returned a
      // non-2xx status code" y el friendlyError del catch no tiene
      // contexto útil para mostrar al docente.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = data as any;
      if (error || res?.error) {
        const detail = await extractEdgeError(error, data);
        throw new Error(detail || t("hc_routesAppTeacherProjects.aiNoDescription"));
      }
      const description = String(res?.description ?? "").trim();
      if (!description) throw new Error(t("hc_routesAppTeacherProjects.aiNoDescription"));
      setForm((prev) => ({ ...prev, description }));
      toast.success(
        i18n.t("toast.routes_app_teacher_projects.descriptionGenerated", {
          defaultValue: "Descripción generada — puedes editarla antes de guardar",
        }),
      );
      setAiDescOpen(false);
      setAiDescTopic("");
    } catch (e) {
      toast.error(friendlyError(e, t("hc_routesAppTeacherProjects.errorGeneratingDescription")));
    } finally {
      setAiDescLoading(false);
    }
  };

  const remove = async (p: Project) => {
    const ok = await confirm({
      title: t("project.deleteTitle", { title: p.title }),
      description: t("project.deleteBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await softDelete("projects", p.id);
    if (error) return toast.error(friendlyError(error));
    toast.success(t("project.deletedToast"));
    void logEvent({
      action: "project.deleted",
      category: "project",
      actorRole: roles[0],
      entityType: "project",
      entityId: p.id,
      entityName: p.title,
      courseId: p.course_id,
      courseName: courses.find((c) => c.id === p.course_id)?.name,
    });
    await load();
  };

  const openFilesDialog = (p: Project) => {
    setFilesProject(p);
    setFilesOpen(true);
  };

  const openAssignDialog = async (p: Project) => {
    setAssignProject(p);
    setStudents([]);
    setAssigned(new Set());
    setAssignError(null);
    setAssignLoading(true);
    setAssignOpen(true);
    const courseIds = p.linked_course_ids?.length ? p.linked_course_ids : [p.course_id];
    setAssignFilterCourses(new Set(courseIds as string[]));
    try {
      const { data: enr, error: enrError } = await db
        .from("course_enrollments")
        .select("user_id, course_id")
        .in("course_id", courseIds);
      if (enrError) throw enrError;

      const enrRows = (enr ?? []) as { user_id: string; course_id: string }[];
      const byCourse = new Map<string, Set<string>>();
      for (const r of enrRows) {
        if (!byCourse.has(r.course_id)) byCourse.set(r.course_id, new Set());
        byCourse.get(r.course_id)!.add(r.user_id);
      }
      setStudentsByCourse(byCourse);

      const userIds = Array.from(new Set(enrRows.map((r) => r.user_id)));
      let list: Student[] = [];
      if (userIds.length) {
        const { data: profs, error: profError } = await db
          .from("profiles")
          .select("id, full_name, institutional_email")
          .in("id", userIds)
          .order("full_name");
        if (profError) throw profError;
        list = (profs ?? []) as Student[];
      }
      setStudents(list);

      const { data: asgn, error: asgnError } = await db
        .from("project_assignments")
        .select("user_id")
        .eq("project_id", p.id);
      if (asgnError) throw asgnError;
      setAssigned(new Set((asgn ?? []).map((a: { user_id: string }) => a.user_id)));
    } catch (e) {
      console.error("[projects] assignment load failed", e);
      const message = friendlyError(e, t("hc_routesAppTeacherProjects.couldNotLoadStudents"));
      setAssignError(message);
      toast.error(message);
    } finally {
      setAssignLoading(false);
    }
  };

  /** Estudiantes visibles según los cursos seleccionados como filtro. */
  const visibleStudents = (() => {
    if (!assignFilterCourses.size) return students;
    const allowed = new Set<string>();
    for (const cid of assignFilterCourses) {
      const set = studentsByCourse.get(cid);
      if (set) for (const uid of set) allowed.add(uid);
    }
    return students.filter((s) => allowed.has(s.id));
  })();

  const assignByCourse = async (courseId: string) => {
    if (!assignProject) return;
    const courseStudents = studentsByCourse.get(courseId);
    if (!courseStudents || !courseStudents.size) {
      toast.info(
        i18n.t("toast.routes_app_teacher_projects.courseHasNoStudents", {
          defaultValue: "Ese curso no tiene estudiantes matriculados",
        }),
      );
      return;
    }
    const toAdd = Array.from(courseStudents).filter((uid) => !assigned.has(uid));
    if (!toAdd.length) {
      toast.info(
        i18n.t("toast.routes_app_teacher_projects.allCourseStudentsAssigned", {
          defaultValue: "Ya todos los del curso están asignados",
        }),
      );
      return;
    }
    const rows = toAdd.map((uid) => ({ project_id: assignProject.id, user_id: uid }));
    const { error } = await db.from("project_assignments").insert(rows);
    if (error) return toast.error(friendlyError(error));
    setAssigned((prev) => {
      const next = new Set(prev);
      for (const uid of toAdd) next.add(uid);
      return next;
    });
    toast.success(
      i18n.t("toast.routes_app_teacher_projects.studentsAssignedFromCourse", {
        defaultValue: "{{n}} estudiante(s) asignados del curso",
        n: toAdd.length,
      }),
    );
  };

  const toggleAssign = async (uid: string) => {
    if (!assignProject) return;
    const has = assigned.has(uid);
    if (has) {
      const { error } = await db
        .from("project_assignments")
        .delete()
        .eq("project_id", assignProject.id)
        .eq("user_id", uid);
      if (error) return toast.error(friendlyError(error));
      setAssigned((prev) => {
        const next = new Set(prev);
        next.delete(uid);
        return next;
      });
    } else {
      const { error } = await db
        .from("project_assignments")
        .insert({ project_id: assignProject.id, user_id: uid });
      if (error) return toast.error(friendlyError(error));
      setAssigned((prev) => new Set(prev).add(uid));
    }
  };

  const assignMany = async (visibleIds: string[]) => {
    if (!assignProject) return;
    const toAdd = visibleIds.filter((id) => !assigned.has(id));
    if (!toAdd.length) return;
    const rows = toAdd.map((id) => ({ project_id: assignProject.id, user_id: id }));
    const { error } = await db.from("project_assignments").insert(rows);
    if (error) return toast.error(friendlyError(error));
    setAssigned((prev) => new Set([...prev, ...toAdd]));
    toast.success(
      i18n.t("toast.routes_app_teacher_projects.studentsAssigned", {
        defaultValue: "{{n}} estudiantes asignados",
        n: toAdd.length,
      }),
    );
  };

  const unassignMany = async (visibleIds: string[]) => {
    if (!assignProject) return;
    const toRemove = visibleIds.filter((id) => assigned.has(id));
    if (!toRemove.length) return;
    const { error } = await db
      .from("project_assignments")
      .delete()
      .eq("project_id", assignProject.id)
      .in("user_id", toRemove);
    if (error) return toast.error(friendlyError(error));
    setAssigned((prev) => {
      const next = new Set(prev);
      toRemove.forEach((id) => next.delete(id));
      return next;
    });
    toast.success(
      i18n.t("toast.routes_app_teacher_projects.assignmentsRemoved", {
        defaultValue: "{{n}} asignación(es) removidas",
        n: toRemove.length,
      }),
    );
  };

  // ===== Grading dialog =====
  const openGradingDialog = async (p: Project) => {
    setGradingProject(p);
    setGradingFiles([]);
    setGradingSubs([]);
    setGradingAnsBySub({});
    setGradingSearch(""); // reset buscador al abrir
    setGradingOpen(true);
    setGradingLoading(true);
    try {
      const [{ data: files }, { data: subs }] = await Promise.all([
        db
          .from("project_files")
          .select("id, title, points, position, type")
          .eq("project_id", p.id)
          .order("position"),
        db
          .from("project_submissions")
          .select(
            "id, user_id, group_id, status, final_grade, ai_grade, submission_grade, defense_factor, defense_notes, defense_at, defense_video_url, repository_url, submitted_at",
          )
          .eq("project_id", p.id)
          .order("submitted_at", { ascending: false }),
      ]);
      setGradingFiles(
        (files ?? []) as Array<{ id: string; title: string; points: number; type: string | null }>,
      );

      const subsList = (subs ?? []) as Submission[];
      if (subsList.length) {
        const userIds = subsList.map((s) => s.user_id);
        const subIds = subsList.map((s) => s.id);
        const [{ data: profs }, { data: ans, error: ansErr }] = await Promise.all([
          db.from("profiles").select("id, full_name, institutional_email").in("id", userIds),
          db
            .from("project_submission_files")
            .select(
              "id, submission_id, file_id, content, ai_grade, ai_feedback, ai_likelihood, ai_reasons, code_paths, zip_path",
            )
            .in("submission_id", subIds),
        ]);
        // No tragar el error de las RESPUESTAS: si este query falla (ej. una
        // columna ausente en la DB), `ans` quedaba null y la entrega se veía
        // VACÍA sin avisar — fue el bug "no se ve lo que entregaron". Avisar.
        if (ansErr) {
          console.error("[projects] load submission files failed", ansErr);
          toast.error(
            friendlyError(ansErr, t("hc_routesAppTeacherProjects.couldNotLoadSubmissionAnswers")),
          );
        }
        const profMap = new Map(((profs ?? []) as Array<{ id: string }>).map((pp) => [pp.id, pp]));
        const grouped: Record<string, SubFile[]> = {};
        for (const a of (ans ?? []) as SubFile[]) {
          (grouped[a.submission_id] ||= []).push(a);
        }

        // Badge "ZIP truncado": zip_truncated/zip_chars_used son columnas
        // OPCIONALES que pueden faltar en algún entorno (en prod faltaban y el
        // SELECT principal fallaba ENTERO, dejando la entrega vacía). Se piden
        // en un query SEPARADO y tolerante: si falla (columna ausente), no hay
        // badge, pero el CONTENIDO de la entrega nunca deja de verse.
        try {
          const { data: zipMeta } = await db
            .from("project_submission_files")
            .select("id, zip_truncated, zip_chars_used")
            .in("submission_id", subIds);
          if (zipMeta) {
            const metaById = new Map(
              (zipMeta as Array<{ id: string; zip_truncated?: boolean; zip_chars_used?: number }>).map(
                (m) => [m.id, m],
              ),
            );
            for (const subId of Object.keys(grouped)) {
              for (const a of grouped[subId]) {
                const m = metaById.get(a.id);
                if (m) {
                  a.zip_truncated = m.zip_truncated ?? null;
                  a.zip_chars_used = m.zip_chars_used ?? null;
                }
              }
            }
          }
        } catch {
          /* columnas ausentes: sin badge, sin romper el contenido */
        }

        // ── Storage fallback para entregas tipo codigo_zip ──
        // Las filas viejas pueden tener `code_paths = NULL` (se
        // persistieron con el reintento defensivo cuando la columna
        // aún no existía en DB) pero los archivos físicos SÍ están en
        // Storage. Para que el docente pueda descargarlos, listamos
        // `<root>/<sub.id>/<file_id>/` y rellenamos code_paths al
        // vuelo en la copia local del state (no se persiste en DB).
        const codigoZipFileIds = ((files ?? []) as Array<{ id: string; type: string | null }>)
          .filter((f) => f.type === "codigo_zip")
          .map((f) => f.id);
        if (codigoZipFileIds.length > 0 && subsList.length > 0) {
          // Para cada submission × file_id pendiente, lista storage y
          // upgrade el SubFile correspondiente.
          await Promise.all(
            subsList.flatMap((sub) =>
              codigoZipFileIds.map(async (fileId) => {
                const subFiles = grouped[sub.id] ?? [];
                const existing = subFiles.find((sf) => sf.file_id === fileId);
                if (existing?.code_paths && existing.code_paths.length > 0) return;
                if (existing?.zip_path) return;
                const root = sub.group_id ?? sub.user_id;
                const prefix = `${root}/${sub.id}/${fileId}`;
                const { data: listed } = await supabase.storage
                  .from("project-files")
                  .list(prefix, { limit: 100, sortBy: { column: "name", order: "asc" } });
                if (!listed || listed.length === 0) return;
                const discovered = listed
                  .filter((e) => e.name && !e.name.endsWith("/"))
                  .map((e) => `${prefix}/${e.name}`);
                if (discovered.length === 0) return;
                if (existing) {
                  // Mutamos en sitio — `grouped` es estado local de esta
                  // función, no se ha pasado a setGradingAnsBySub todavía.
                  existing.code_paths = discovered;
                } else {
                  (grouped[sub.id] ||= []).push({
                    id: "", // sin row en DB; el grader no podrá UPDATE pero sí descargar.
                    submission_id: sub.id,
                    file_id: fileId,
                    content: null,
                    ai_grade: null,
                    ai_feedback: null,
                    ai_likelihood: null,
                    code_paths: discovered,
                  } as SubFile);
                }
              }),
            ),
          );
        }

        setGradingAnsBySub(grouped);
        setGradingSubs(
          subsList.map((s) => ({ ...s, profile: profMap.get(s.user_id) as Submission["profile"] })),
        );
      }
    } catch (e) {
      console.error("[projects] grading load failed", e);
      toast.error(friendlyError(e, "Error cargando entregas"));
    } finally {
      setGradingLoading(false);
    }
  };

  const recomputeProjectGrade = (subId: string): number => {
    if (!gradingProject) return 0;
    const ans = gradingAnsBySub[subId] ?? [];
    const totalPoints = gradingFiles.reduce((s, f) => s + Number(f.points || 0), 0);
    if (totalPoints <= 0) return 0;
    const earned = gradingFiles.reduce((s, f) => {
      const a = ans.find((x) => x.file_id === f.id);
      const g = Math.min(Number(a?.ai_grade ?? 0) || 0, Number(f.points) || 0);
      return s + g;
    }, 0);
    return Number(((earned / totalPoints) * Number(gradingProject.max_score)).toFixed(2));
  };

  // Tras recalificar UN archivo con IA, sincroniza submission_grade/final_grade
  // del PADRE en el state local (gradingSubs), igual que saveSubFileGrade. El
  // trigger SQL ya recomputa server-side, pero sin esto el state local queda
  // stale → el header y la baseline del DefensePanel muestran la nota vieja y, si
  // el docente guarda la sustentación con el input vacío, saveDefense usa el
  // submission_grade obsoleto como base (C6). Usa `newFileGrade` explícito porque
  // recomputeProjectGrade leería gradingAnsBySub aún sin el patch de este tick.
  const syncParentAfterFileRegrade = (subId: string, fileId: string, newFileGrade: number) => {
    const totalPoints = gradingFiles.reduce((s, f) => s + Number(f.points || 0), 0);
    if (totalPoints <= 0) return;
    const earned = gradingFiles.reduce((s, f) => {
      const a = (gradingAnsBySub[subId] ?? []).find((x) => x.file_id === f.id);
      const g = f.id === fileId ? newFileGrade : Number(a?.ai_grade ?? 0) || 0;
      return s + Math.min(Number(g) || 0, Number(f.points) || 0);
    }, 0);
    const newSubGrade = Number(
      ((earned / totalPoints) * Number(gradingProject?.max_score ?? 0)).toFixed(2),
    );
    setGradingSubs((prev) =>
      prev.map((s) => {
        if (s.id !== subId) return s;
        const factor = s.defense_factor;
        // El trigger recalcula final_grade solo si hay defense_factor; si no, lo
        // deja como está. Espejamos esa semántica.
        const newFinal =
          factor != null ? Number((newSubGrade * factor).toFixed(2)) : s.final_grade;
        return { ...s, submission_grade: newSubGrade, final_grade: newFinal };
      }),
    );
  };

  const patchSubFile = (subId: string, fileId: string, patch: Partial<SubFile>) => {
    setGradingAnsBySub((prev) => {
      const list = (prev[subId] ?? []).slice();
      const idx = list.findIndex((a) => a.file_id === fileId);
      if (idx >= 0) list[idx] = { ...list[idx], ...patch };
      return { ...prev, [subId]: list };
    });
  };

  const saveSubFileGrade = async (subId: string, fileId: string) => {
    const ans = (gradingAnsBySub[subId] ?? []).find((a) => a.file_id === fileId);
    if (!ans?.id) {
      toast.error(
        i18n.t("toast.routes_app_teacher_projects.noContentForFile", {
          defaultValue: "Esta entrega no tiene contenido para este archivo",
        }),
      );
      return;
    }
    setSavingId(ans.id);
    try {
      const { error } = await db
        .from("project_submission_files")
        .update({ ai_grade: ans.ai_grade, ai_feedback: ans.ai_feedback })
        .eq("id", ans.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      const newSubmissionGrade = recomputeProjectGrade(subId);
      // Modelo: submission_grade siempre se actualiza con la nota de la
      // entrega. final_grade depende de defense_factor: si ya hay sustentación,
      // se recalcula; si no, queda null hasta que el docente sustente.
      const sub = gradingSubs.find((s) => s.id === subId);
      const factor = sub?.defense_factor;
      const newFinalGrade =
        factor != null ? Number((newSubmissionGrade * factor).toFixed(2)) : null;
      const { error: subErr } = await db
        .from("project_submissions")
        .update({
          submission_grade: newSubmissionGrade,
          final_grade: newFinalGrade,
          status: factor != null ? "calificado" : "entregado",
        })
        .eq("id", subId);
      if (subErr) {
        toast.error(
          i18n.t("toast.routes_app_teacher_projects.savedButRecomputeFailed", {
            defaultValue: "Guardado, pero falló recalcular: {{error}}",
            error: friendlyError(subErr),
          }),
        );
        return;
      }
      setGradingSubs((prev) =>
        prev.map((s) =>
          s.id === subId
            ? {
                ...s,
                submission_grade: newSubmissionGrade,
                final_grade: newFinalGrade,
                status: factor != null ? "calificado" : "entregado",
              }
            : s,
        ),
      );
      toast.success(
        factor != null
          ? i18n.t("toast.routes_app_teacher_projects.savedWithFinalGrade", {
              defaultValue:
                "Guardado · final: {{finalGrade}}/{{maxScore}} (entrega {{submissionGrade}} × sustentación {{factor}})",
              finalGrade: newFinalGrade,
              maxScore: gradingProject?.max_score ?? 100,
              submissionGrade: newSubmissionGrade,
              factor,
            })
          : i18n.t("toast.routes_app_teacher_projects.savedPendingDefense", {
              defaultValue: "Entrega: {{submissionGrade}}/{{maxScore}} — falta sustentación",
              submissionGrade: newSubmissionGrade,
              maxScore: gradingProject?.max_score ?? 100,
            }),
      );
    } finally {
      setSavingId(null);
    }
  };

  /**
   * Reabre una entrega calificada para que el estudiante pueda volver a
   * enviar sus archivos + ZIP + link al repositorio. Vuelve status a
   * "entregado" y limpia notas, sustentación, calificaciones globales.
   * Las respuestas individuales (`project_submission_files`) NO se
   * borran — se quedan precargadas para que el estudiante las edite.
   */
  const reopenProjectSubmission = async (subId: string) => {
    const sub = gradingSubs.find((s) => s.id === subId);
    if (!sub) return;
    const ok = await confirm({
      title: t("hc_routesAppTeacherProjects.reopenSubmissionTitle"),
      description: t("hc_routesAppTeacherProjects.reopenSubmissionBody"),
      confirmLabel: t("hc_routesAppTeacherProjects.reopenSubmissionConfirm"),
      tone: "warning",
    });
    if (!ok) return;
    const { error } = await db
      .from("project_submissions")
      .update({
        status: "entregado",
        final_grade: null,
        ai_grade: null,
        submission_grade: null,
        defense_factor: null,
        defense_notes: null,
        defense_at: null,
        submitted_at: null,
      })
      .eq("id", subId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    void logEvent({
      action: "project.submission_reopened",
      category: "grading",
      severity: "warning",
      entityType: "project_submission",
      entityId: subId,
      entityName: gradingProject?.title,
      courseId: gradingProject?.course_id,
      metadata: {
        previous_status: sub.status,
        previous_final_grade: sub.final_grade,
        previous_defense_factor: sub.defense_factor,
      },
    });
    setGradingSubs((prev) =>
      prev.map((s) =>
        s.id === subId
          ? {
              ...s,
              status: "entregado",
              final_grade: null,
              ai_grade: null,
              submission_grade: null,
              defense_factor: null,
              defense_notes: null,
              defense_at: null,
            }
          : s,
      ),
    );
    toast.success(
      i18n.t("toast.routes_app_teacher_projects.submissionReopened", {
        defaultValue: "Entrega reabierta. El estudiante puede reenviar.",
      }),
    );
  };

  /**
   * Persiste la sustentación: factor 0..1 + notas. Recalcula final_grade
   * como submission_grade × factor. Si factor es null/vacío, deja la
   * entrega "sin sustentar" (final_grade null, status entregado).
   */
  const saveDefense = async (
    subId: string,
    factor: number | null,
    notes: string,
    videoUrl?: string | null,
    /** Override manual de submission_grade. Si `null/undefined`, NO se
     *  toca (se mantiene el valor calculado por la IA o el trigger SQL).
     *  Útil cuando el docente quiere ajustar la nota global sin pasar
     *  por la edición de cada archivo. */
    subGradeOverride?: number | null,
  ) => {
    const sub = gradingSubs.find((s) => s.id === subId);
    if (!sub) return;
    const videoVal = (videoUrl ?? "").trim() || null;
    // El override del docente gana sobre el cálculo automático. Si no hay
    // override, usar el submission_grade actual o el ai_grade legacy.
    const effectiveSubGrade =
      subGradeOverride != null && !Number.isNaN(subGradeOverride)
        ? subGradeOverride
        : (sub.submission_grade ?? sub.ai_grade);
    if (effectiveSubGrade == null) {
      toast.error(
        i18n.t("toast.routes_app_teacher_projects.submissionNotGradedYet", {
          defaultValue: "La entrega aún no tiene calificación. Califica los archivos primero.",
        }),
      );
      return;
    }
    const validFactor =
      factor != null && !Number.isNaN(factor) ? Math.max(0, Math.min(1, factor)) : null;
    const newFinal =
      validFactor != null
        ? Number((Number(effectiveSubGrade) * validFactor).toFixed(2))
        : null;
    // Si el docente cambió `submission_grade` manualmente, también lo
    // persistimos. El trigger SQL `trg_project_submission_files_recompute`
    // NO interferirá porque solo dispara al cambiar `ai_grade` de un file.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updatePayload: any = {
      defense_factor: validFactor,
      defense_notes: notes || null,
      defense_at: validFactor != null ? new Date().toISOString() : null,
      defense_video_url: videoVal,
      final_grade: newFinal,
      status: validFactor != null ? "calificado" : "entregado",
    };
    if (subGradeOverride != null && !Number.isNaN(subGradeOverride)) {
      updatePayload.submission_grade = subGradeOverride;
    }
    const { error } = await db
      .from("project_submissions")
      .update(updatePayload)
      .eq("id", subId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setGradingSubs((prev) =>
      prev.map((s) =>
        s.id === subId
          ? {
              ...s,
              defense_factor: validFactor,
              defense_notes: notes || null,
              defense_at: validFactor != null ? new Date().toISOString() : null,
              defense_video_url: videoVal,
              final_grade: newFinal,
              status: validFactor != null ? "calificado" : "entregado",
              ...(subGradeOverride != null && !Number.isNaN(subGradeOverride)
                ? { submission_grade: subGradeOverride }
                : {}),
            }
          : s,
      ),
    );
    // Tras guardar, colapsar la fila de este estudiante en el accordion
    // para volver a la vista completa de la lista (el docente pidió que el
    // estudiante "se minimice" al guardar y se vean todos de nuevo).
    setOpenAccordionItems((prev) => prev.filter((id) => id !== subId));
    // Sustentación guardada = calificación final manual → quitar de la cola
    // cualquier job IA pendiente de esta entrega (y sus archivos). La nota
    // final ya quedó persistida; fire-and-forget.
    void cancelPendingAiJobsForTarget(
      "project_submissions",
      subId,
      t("hc_routesAppTeacherProjects.aiJobCancelledDefenseReason"),
    );
    toast.success(
      validFactor != null
        ? i18n.t("toast.routes_app_teacher_projects.defenseSaved", {
            defaultValue: "Sustentación guardada · nota final: {{finalGrade}}/{{maxScore}}",
            finalGrade: newFinal,
            maxScore: gradingProject?.max_score ?? 100,
          })
        : i18n.t("toast.routes_app_teacher_projects.defenseCleared", {
            defaultValue: "Sustentación borrada",
          }),
    );

    // Notificar al estudiante cuando se guarda una sustentación válida
    // (factor != null = quedó calificado). Si se "borra" la sustentación
    // (factor null) NO notificamos — la entrega vuelve a 'entregado'
    // pendiente, no hay novedad para el alumno todavía.
    // kind='grade' → CRITICAL_KIND → dispara correo + ícono Award.
    if (validFactor != null) {
      const maxScore = gradingProject?.max_score ?? 100;
      // Destinatarios: si la entrega es de grupo, TODOS los miembros (no
      // solo el "último editor" en sub.user_id); si es individual, el dueño.
      let recipients: string[] = sub.user_id ? [sub.user_id] : [];
      if (sub.group_id) {
        const { data: members } = await db
          .from("project_group_members")
          .select("user_id")
          .eq("group_id", sub.group_id);
        const ids = ((members ?? []) as { user_id: string }[]).map((m) => m.user_id);
        if (ids.length > 0) recipients = ids;
      }
      // Excluir al propio docente que califica: un usuario multi-rol
      // (Docente + Estudiante con el MISMO id) NO debe auto-notificarse al
      // sustentar su propia entrega ("me llegó a mí como docente").
      const myId = user?.id;
      recipients = Array.from(new Set(recipients)).filter((uid) => uid && uid !== myId);
      if (recipients.length > 0) {
        const body =
          t("hc_routesAppTeacherProjects.notifDefenseGradedBody", {
            finalGrade: newFinal,
            maxScore,
          }) +
          " " +
          (notes
            ? t("hc_routesAppTeacherProjects.notifTeacherNotes", { notes: notes.slice(0, 240) })
            : t("hc_routesAppTeacherProjects.notifEnterPlatformForDetail"));
        await db.from("notifications").insert(
          recipients.map((uid) => ({
            user_id: uid,
            title: t("hc_routesAppTeacherProjects.notifDefenseGradedTitle", {
              project: gradingProject?.title ?? t("hc_routesAppTeacherProjects.projectWord"),
            }),
            body,
            kind: "grade",
            link: "/app/student/projects",
          })),
        );
      }
    }
  };

  const aiRegradeSubFile = async (
    subId: string,
    file: { id: string; title: string; points: number },
  ) => {
    const ans = (gradingAnsBySub[subId] ?? []).find((a) => a.file_id === file.id);
    if (!ans?.id) {
      toast.error(
        i18n.t("toast.routes_app_teacher_projects.noContentToRegrade", {
          defaultValue: "Sin contenido para recalificar",
        }),
      );
      return;
    }
    const decision = await aiGate.ensureAuthorized();
    if (decision === "cancel") return;
    setAiRegradingId(ans.id);
    try {
      const courseLang = (gradingProject?.course?.language === "en" ? "en" : "es") as "es" | "en";
      // fetch type + options + rubric/desc para el archivo
      const { data: meta } = await db
        .from("project_files")
        .select("description, expected_rubric, type, options")
        .eq("id", file.id)
        .maybeSingle();

      // Recalificación de `codigo_zip`: las entregas viven en Storage
      // (`code_paths[]` para varios archivos sueltos, `zip_path` legacy
      // para ZIP único). El edge function tiene un modo dedicado
      // (`projectCodeZipGrading: true`) que descarga, descomprime/lee
      // y arma el contexto para Gemini. Sin esta rama, antes pasábamos
      // `studentContent: ans.content` que está vacío para este tipo y
      // la IA respondía "sin contenido" → nota 0. Mismo body que el
      // flujo del estudiante en ProjectFiles → StudentProjectTaker.
      if (meta?.type === "codigo_zip") {
        const codePaths =
          Array.isArray(ans.code_paths) && ans.code_paths.length > 0 ? ans.code_paths : undefined;
        const zipPath = ans.zip_path ?? undefined;
        if (!codePaths && !zipPath) {
          toast.error(
            i18n.t("toast.routes_app_teacher_projects.noCodeFilesToRegrade", {
              defaultValue: "Sin archivos de código entregados para recalificar",
            }),
          );
          return;
        }
        const { data: aiData, error: aiErr } = await supabase.functions.invoke(
          "ai-grade-submission",
          {
            body: {
              projectCodeZipGrading: true,
              codePaths,
              zipPath,
              noMinify: true,
              fileTitle: file.title,
              fileDescription: meta?.description ?? null,
              expectedRubric: meta?.expected_rubric ?? null,
              maxPoints: file.points,
              courseLanguage: courseLang,
            },
          },
        );
        if (aiErr || aiData?.error) {
          const detail = await extractEdgeError(aiErr, aiData);
          toast.error(
            i18n.t("toast.routes_app_teacher_projects.aiError", {
              defaultValue: "Error IA: {{detail}}",
              detail:
                detail ||
                i18n.t("toast.routes_app_teacher_projects.unknownError", {
                  defaultValue: "Error desconocido",
                }),
            }),
          );
          return;
        }
        const newGrade = Number(aiData?.grade ?? 0);
        const newFeedback = String(aiData?.feedback ?? "");
        const newAiLikelihood =
          typeof aiData?.ai_likelihood === "number" ? aiData.ai_likelihood : null;
        const newAiReasons = typeof aiData?.ai_reasons === "string" ? aiData.ai_reasons : null;
        patchSubFile(subId, file.id, {
          ai_grade: newGrade,
          ai_feedback: newFeedback,
          ai_likelihood: newAiLikelihood,
          ai_reasons: newAiReasons,
        });
        await db
          .from("project_submission_files")
          .update({
            ai_grade: newGrade,
            ai_feedback: newFeedback,
            ai_likelihood: newAiLikelihood,
            ai_reasons: newAiReasons,
          })
          .eq("id", ans.id);
        syncParentAfterFileRegrade(subId, file.id, newGrade);
        toast.success(
          i18n.t("toast.routes_app_teacher_projects.regradeReady", {
            defaultValue: "Recalificación lista: {{grade}} / {{points}}",
            grade: newGrade,
            points: file.points,
          }),
        );
        return;
      }

      // Short-circuit determinístico para cerrada_multi: no llamamos a IA.
      if (meta?.type === "cerrada_multi") {
        let selectedArr: number[] = [];
        try {
          const parsed = JSON.parse(ans.content ?? "[]");
          if (Array.isArray(parsed)) selectedArr = parsed.filter((n) => typeof n === "number");
        } catch {
          /* mantener vacío */
        }
        const result = scoreCerradaMulti({
          selected: selectedArr,
          correctIndices: (meta.options?.correct_indices ?? []) as number[],
          totalPoints: file.points,
          minSelections: meta.options?.min_selections,
          maxSelections: meta.options?.max_selections,
        });
        const newFeedback = result.exceededMax
          ? t("hc_routesAppTeacherProjects.markedMoreThanAllowed", {
              max: meta.options?.max_selections,
            })
          : result.belowMin
            ? t("hc_routesAppTeacherProjects.markedLessThanMin", {
                min: meta.options?.min_selections,
              })
            : selectedArr.length === 0
              ? t("hc_routesAppTeacherProjects.noAnswer")
              : `${result.earned} / ${file.points} pts`;
        patchSubFile(subId, file.id, {
          ai_grade: result.earned,
          ai_feedback: newFeedback,
        });
        await db
          .from("project_submission_files")
          .update({ ai_grade: result.earned, ai_feedback: newFeedback })
          .eq("id", ans.id);
        syncParentAfterFileRegrade(subId, file.id, result.earned);
        toast.success(
          i18n.t("toast.routes_app_teacher_projects.recomputedLocally", {
            defaultValue: "Recalculado localmente (sin IA)",
          }),
        );
        return;
      }

      const { data: aiData, error: aiErr } = await supabase.functions.invoke(
        "ai-grade-submission",
        {
          body: {
            projectFileGrading: true,
            fileTitle: file.title,
            fileDescription: meta?.description ?? null,
            expectedRubric: meta?.expected_rubric ?? null,
            maxPoints: file.points,
            studentContent: ans.content ?? "",
            courseLanguage: courseLang,
          },
        },
      );
      if (aiErr || aiData?.error) {
        const detail = await extractEdgeError(aiErr, aiData);
        toast.error(
          i18n.t("toast.routes_app_teacher_projects.aiError", {
            defaultValue: "Error IA: {{detail}}",
            detail:
              detail ||
              i18n.t("toast.routes_app_teacher_projects.unknownError", {
                defaultValue: "Error desconocido",
              }),
          }),
        );
        return;
      }
      const newGrade = Number(aiData?.grade ?? 0);
      const newFeedback = String(aiData?.feedback ?? "");
      // Capturamos ai_likelihood + ai_reasons cuando vienen del edge
      // function. Antes solo guardábamos grade+feedback y perdíamos la
      // razón del posible uso de IA, lo que obligaba al docente a entrar
      // a auditoría para ver el detalle.
      const newAiLikelihood =
        typeof aiData?.ai_likelihood === "number" ? aiData.ai_likelihood : null;
      const newAiReasons = typeof aiData?.ai_reasons === "string" ? aiData.ai_reasons : null;
      patchSubFile(subId, file.id, {
        ai_grade: newGrade,
        ai_feedback: newFeedback,
        ai_likelihood: newAiLikelihood,
        ai_reasons: newAiReasons,
      });
      await db
        .from("project_submission_files")
        .update({
          ai_grade: newGrade,
          ai_feedback: newFeedback,
          ai_likelihood: newAiLikelihood,
          ai_reasons: newAiReasons,
        })
        .eq("id", ans.id);
      syncParentAfterFileRegrade(subId, file.id, newGrade);
      toast.success(
        i18n.t("toast.routes_app_teacher_projects.fileRegradedWithAi", {
          defaultValue: "Archivo recalificado con IA",
        }),
      );
    } finally {
      setAiRegradingId(null);
    }
  };

  // ── Bulk regrade: recalifica TODOS los archivos de TODAS las entregas
  //    filtradas (respetando el buscador) — o solo las que vengan en
  //    `explicitSubs` cuando el docente marcó subset con checkboxes.
  //    Llama `aiRegradeSubFile` en serie por archivo. NO paraleliza
  //    para evitar gatillar rate-limits del provider IA — la velocidad
  //    bottleneck es el ratio, no la concurrencia. Progreso visible vía
  //    `bulkProgress`.
  const bulkRegradeProject = async (explicitSubs?: Submission[]) => {
    const targets = explicitSubs ?? filteredGradingSubs;
    if (gradingFiles.length === 0 || targets.length === 0) return;
    const isSubset = explicitSubs != null;
    const ok = await confirm({
      title: isSubset
        ? t("hc_routesAppTeacherProjects.regradeSelectedTitle", { n: targets.length })
        : t("hc_routesAppTeacherProjects.regradeAllTitle"),
      description: t("hc_routesAppTeacherProjects.regradeBody", {
        scope: isSubset
          ? t("hc_routesAppTeacherProjects.regradeScopeSelected")
          : t("hc_routesAppTeacherProjects.regradeScopeFiltered"),
        subs: targets.length,
        files: gradingFiles.length,
        calls: targets.length * gradingFiles.length,
      }),
      confirmLabel: isSubset
        ? t("hc_routesAppTeacherProjects.regradeSelectedConfirm")
        : t("hc_routesAppTeacherProjects.regradeAllConfirm"),
      tone: "warning",
    });
    if (!ok) return;
    const total = targets.length * gradingFiles.length;
    setBulkProgress({ done: 0, total });
    setBulkRegrading(true);
    try {
      let done = 0;
      for (const sub of targets) {
        for (const f of gradingFiles) {
          // aiRegradeSubFile saltea entregas sin contenido (`Sin contenido
          // para recalificar`) y muestra su propio toast por error —
          // dejamos que continúe el loop sin abortar el batch. Serial a
          // propósito para no gatillar rate-limit del proveedor IA.
          await aiRegradeSubFile(sub.id, f);
          done++;
          setBulkProgress({ done, total });
        }
      }
      toast.success(
        i18n.t("toast.routes_app_teacher_projects.batchRegradeCompleted", {
          defaultValue: "Recalificación batch completada ({{done}}/{{total}}).",
          done,
          total,
        }),
      );
      if (isSubset) gradingSel.clear();
    } finally {
      setBulkRegrading(false);
    }
  };

  const deleteSubmission = async (sub: Submission) => {
    const name = sub.profile?.full_name ?? t("common.empty");
    const ok = await confirm({
      title: t("project.deleteSubmissionTitle", { name }),
      description: t("project.deleteSubmissionBody"),
      confirmLabel: t("project.deleteSubmissionConfirm"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("project_submissions").delete().eq("id", sub.id);
    if (error) return toast.error(friendlyError(error));
    setGradingSubs((prev) => prev.filter((s) => s.id !== sub.id));
    setGradingAnsBySub((prev) => {
      const next = { ...prev };
      delete next[sub.id];
      return next;
    });
    toast.success(t("project.submissionDeleted"));
  };

  /**
   * Borrado bulk de las entregas marcadas en el grid de calificación.
   * El botón vive en la toolbar superior, así que el docente puede
   * limpiar varias entregas sin tener que abrir el accordion de cada
   * una (lo cual era la única vía de acceso al delete antes).
   * Una sola query `.in("id", ids)` — atómica, una sola RT vs N gets.
   */
  const bulkDeleteSelectedSubmissions = async () => {
    const ids = filteredGradingSubs.filter((s) => gradingSel.isSelected(s.id)).map((s) => s.id);
    if (ids.length === 0) return;
    const ok = await confirm({
      title:
        ids.length === 1
          ? t("project.deleteSubmissionTitle", {
              name: gradingSubs.find((s) => s.id === ids[0])?.profile?.full_name ?? "—",
            })
          : t("hc_routesAppTeacherProjects.deleteNSubmissionsTitle", { n: ids.length }),
      description:
        ids.length === 1
          ? t("project.deleteSubmissionBody")
          : t("hc_routesAppTeacherProjects.deleteNSubmissionsBody", { n: ids.length }),
      confirmLabel: t("project.deleteSubmissionConfirm"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("project_submissions").delete().in("id", ids);
    if (error) return toast.error(friendlyError(error));
    const removed = new Set(ids);
    setGradingSubs((prev) => prev.filter((s) => !removed.has(s.id)));
    setGradingAnsBySub((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
    gradingSel.clear();
    toast.success(
      ids.length === 1
        ? t("project.submissionDeleted")
        : i18n.t("toast.routes_app_teacher_projects.submissionsDeleted", {
            defaultValue: "{{n}} entregas eliminadas",
            n: ids.length,
          }),
    );
  };

  const courseLanguage = (filesProject?.course?.language === "en" ? "en" : "es") as "es" | "en";

  // Esperar a useAuth para evitar flash del gate con roles=[] hidratando.
  if (authLoading) return <PageLoader />;
  if (!isTeacher) return <p className="text-muted-foreground">{t("project.needsTeacherRole")}</p>;

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<FolderKanban className="h-6 w-6" />}
          title={t("hc_routesAppTeacherProjects.pageTitle")}
        />
        <ErrorState
          message={t("hc_routesAppTeacherProjects.couldNotLoadProjectsTitle")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<FolderKanban className="h-6 w-6" />}
        title={t("hc_routesAppTeacherProjects.pageTitle")}
        subtitle={
          filteredProjects.length === projects.length
            ? t("hc_routesAppTeacherProjects.subtitleCount", { count: projects.length })
            : t("hc_routesAppTeacherProjects.subtitleFiltered", {
                shown: filteredProjects.length,
                total: projects.length,
              })
        }
        actions={
          <>
            <ImportExportMenu
              resourceName={t("hc_routesAppTeacherProjects.resourceName")}
              onExport={exportProjectsCsv}
            />
            <Button onClick={openNew} data-tour-id="create-project">
              <Plus className="h-4 w-4 mr-1" /> {t("hc_routesAppTeacherProjects.newProject")}
            </Button>
          </>
        }
      />

      {/* Stats 4-card — siempre visible. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Pencil}
          label={t("hc_routesAppTeacherProjects.statDrafts")}
          value={projectStats.draft}
        />
        <StatCard
          icon={CheckCircle2}
          label={t("hc_routesAppTeacherProjects.statPublished")}
          value={projectStats.published}
          tone={projectStats.published > 0 ? "success" : "default"}
        />
        <StatCard
          icon={Lock}
          label={t("hc_routesAppTeacherProjects.statClosed")}
          value={projectStats.closed}
        />
        <StatCard
          icon={ExternalLink}
          label={t("hc_routesAppTeacherProjects.statExternal")}
          value={projectStats.external}
        />
      </div>

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={t("hc_routesAppTeacherProjects.searchPlaceholder")}
        courseId={courseFilter}
        onCourseChange={(v) => {
          setCourseFilter(v);
          setCutFilter(null);
        }}
        courses={courses}
        cuts={cuts}
        cutId={cutFilter}
        onCutChange={setCutFilter}
        extra={<ActivityStatusSelect value={statusFilter} onChange={setStatusFilter} />}
        onClearExtra={() => setStatusFilter(DEFAULT_ACTIVITY_STATUS_FILTER)}
      />

      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular={t("hc_routesAppTeacherProjects.entitySingular")}
        entityNamePlural={t("hc_routesAppTeacherProjects.entityPlural")}
      />

      {/* Resumen de pesos cuando se filtra por corte: cuánto suman los
          proyectos del corte vs el bucket project_weight. */}
      {cutFilter &&
        (() => {
          const cut = cuts.find((c) => c.id === cutFilter);
          if (!cut) return null;
          const sum = filteredProjects.reduce((s, p) => s + Number((p as any).weight ?? 0), 0);
          const bucket = Number((cut as any).project_weight ?? 0);
          const ok = Math.abs(sum - bucket) < 0.01;
          return (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                {t("hc_routesAppTeacherProjects.sumOfWeightsIn")}{" "}
                <span className="font-medium text-foreground">{cut.name}</span>:
              </span>
              <Badge
                variant={ok ? "secondary" : sum > bucket + 0.01 ? "destructive" : "default"}
                className="tabular-nums"
              >
                {formatPercent(sum)}% / {formatPercent(bucket)}%
              </Badge>
              {!ok && sum < bucket - 0.01 && (
                <span className="text-muted-foreground">
                  {t("hc_routesAppTeacherProjects.remaining")}{" "}
                  <strong>{formatPercent(bucket - sum)}%</strong>{" "}
                  {t("hc_routesAppTeacherProjects.unassigned")}
                </span>
              )}
              {sum > bucket + 0.01 && (
                <span className="text-destructive">
                  {t("hc_routesAppTeacherProjects.exceedsBucketBy")}{" "}
                  <strong>{formatPercent(sum - bucket)}%</strong>.
                </span>
              )}
            </div>
          );
        })()}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {/* table-fixed: anchos de columna respetados. */}
          <Table fixed resizable>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <MultiSelectHeaderCheckbox state={sel} />
                </TableHead>
                <SortableHead sortKey="title" sort={sort} className="max-w-[320px]">
                  {t("common.title")}
                </SortableHead>
                <SortableHead sortKey="course" sort={sort} className="hidden sm:table-cell w-32">
                  {t("common.course")}
                </SortableHead>
                <SortableHead sortKey="cut" sort={sort} className="hidden md:table-cell w-24">
                  {t("exam.columns.cut")}
                </SortableHead>
                <SortableHead
                  sortKey="weight"
                  sort={sort}
                  className="hidden lg:table-cell text-right w-16"
                >
                  {t("common.weight")}
                </SortableHead>
                <SortableHead sortKey="status" sort={sort} className="w-24">
                  {t("common.status")}
                </SortableHead>
                <SortableHead sortKey="start_date" sort={sort} className="hidden md:table-cell w-28">
                  {t("common.start")}
                </SortableHead>
                <SortableHead sortKey="due_date" sort={sort} className="hidden sm:table-cell w-28">
                  {t("common.end")}
                </SortableHead>
                <TableHead className="text-right w-20">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagination.paginatedItems.map((p) => (
                <TableRow key={p.id} data-state={sel.isSelected(p.id) ? "selected" : undefined}>
                  <TableCell className="w-10">
                    <MultiSelectCheckbox id={p.id} state={sel} />
                  </TableCell>
                  <TableCell className="font-medium">
                    <div className="flex flex-col gap-0.5">
                      <span className="truncate max-w-[18rem]">{p.title}</span>
                      <span className="text-xs text-muted-foreground sm:hidden truncate">
                        {(p.linked_course_ids ?? [p.course_id])
                          .map((cid) => courses.find((c) => c.id === cid)?.name)
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden sm:table-cell">
                    <CourseListCell
                      courses={(p.linked_course_ids ?? [p.course_id])
                        .map((cid) => courses.find((c) => c.id === cid))
                        .filter((c): c is NonNullable<typeof c> => !!c)
                        .map((c) => ({ id: c.id, name: c.name, period: c.period }))}
                      popoverTitle={t("hc_routesAppTeacherProjects.projectCourses")}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs hidden md:table-cell">
                    {(() => {
                      const cutName = cuts.find((c) => c.id === p.cut_id)?.name ?? "—";
                      return (
                        <div className="truncate" title={cutName}>
                          {cutName}
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums text-right hidden lg:table-cell">
                    {p.cut_id != null && (p as any).weight != null
                      ? `${formatPercent(Number((p as any).weight))}%`
                      : "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={p.status} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <DateCell value={p.start_date} variant="datetime" />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <DateCell value={p.due_date} variant="datetime" />
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActionsMenu
                      actions={[
                        {
                          label: t("hc_routesAppTeacherProjects.actionProjectQuestions"),
                          icon: FileText,
                          onClick: () => openFilesDialog(p),
                        },
                        {
                          label: t("hc_routesAppTeacherProjects.actionAssignStudents"),
                          icon: Users,
                          onClick: () => openAssignDialog(p),
                        },
                        !p.is_external && {
                          label: t("hc_routesAppTeacherProjects.actionGroups"),
                          icon: UsersRound,
                          onClick: () => openGroupsForProject(p),
                        },
                        {
                          label: t("hc_routesAppTeacherProjects.actionSubmissionsGrading"),
                          icon: ClipboardList,
                          onClick: () => openGradingDialog(p),
                        },
                        { label: t("common.edit"), icon: Pencil, onClick: () => openEdit(p) },
                        {
                          label: t("hc_routesAppTeacherProjects.actionDuplicate"),
                          icon: Copy,
                          onClick: () =>
                            setDuplicateSource({
                              id: p.id,
                              title: p.title,
                              courseId: p.course_id,
                            }),
                        },
                        {
                          label: t("common.delete"),
                          icon: Trash2,
                          tone: "destructive",
                          separatorBefore: true,
                          onClick: () => remove(p),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {loading ? (
                <TableSkeleton cols={9} rows={6} />
              ) : projects.length === 0 ? (
                <TableEmpty
                  colSpan={9}
                  icon={FolderKanban}
                  text={t("hc_routesAppTeacherProjects.emptyNoProjects")}
                  hint={t("hc_routesAppTeacherProjects.emptyNoProjectsHint")}
                  action={
                    <Button size="sm" onClick={openNew}>
                      <Plus className="h-4 w-4 mr-1" />
                      {t("hc_routesAppTeacherProjects.createFirstProject")}
                    </Button>
                  }
                />
              ) : filteredProjects.length === 0 ? (
                <TableEmpty
                  colSpan={9}
                  icon={FolderKanban}
                  text={t("hc_routesAppTeacherProjects.emptyNoResults")}
                  hint={t("hc_routesAppTeacherProjects.emptyNoResultsHint")}
                />
              ) : null}
            </TableBody>
          </Table>
          <DataPagination state={pagination} entityNamePlural={t("hc_routesAppTeacherProjects.entityPlural")} />
        </CardContent>
      </Card>

      {/* New / edit project dialog */}
      <Dialog open={open} onOpenChange={projectDirty.guardOpenChange(setOpen)}>
        <DialogContent data-tour-id="dialog-project">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("hc_routesAppTeacherProjects.editProject")
                : t("hc_routesAppTeacherProjects.newProject")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {/*
             * Toggle "Actividad externa": cuando el proyecto ya ocurrió fuera
             * de la plataforma y solo se registra la nota. Esconde campos que
             * no aplican (instrucciones, link, archivos esperados) y al editar
             * la calificación se muestra el editor de notas externas.
             */}
            <div
              className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 p-2.5"
              data-tour-id="project-field-external"
            >
              <div className="space-y-0.5">
                <Label htmlFor="project-is-external" className="text-sm">
                  {t("hc_routesAppTeacherProjects.externalActivity")}
                </Label>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  {t("hc_routesAppTeacherProjects.externalActivityHint")}
                </p>
              </div>
              <Switch
                id="project-is-external"
                checked={!!(form as any).is_external}
                onCheckedChange={(v) => setForm({ ...form, is_external: v } as any)}
              />
            </div>
            {/* Modo de trabajo del proyecto. NO aplica en externos (esos
                no tienen entrega digital). 'individual' = cada estudiante
                entrega solo; 'group_required' = todos deben estar en un
                grupo o no pueden entregar; 'teacher_assigned' (Mixto) =
                quien tenga grupo entrega en grupo, los demas individual. */}
            {!(form as any).is_external && (
              <div className="space-y-1" data-tour-id="project-field-group-mode">
                <Label>{t("hc_routesAppTeacherProjects.workMode")}</Label>
                <Select
                  value={form.group_mode ?? "individual"}
                  onValueChange={(v) =>
                    setForm({ ...form, group_mode: v as Project["group_mode"] })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="individual">
                      {t("hc_routesAppTeacherProjects.workModeIndividual")}
                    </SelectItem>
                    <SelectItem value="group_required">
                      {t("hc_routesAppTeacherProjects.workModeGroupRequired")}
                    </SelectItem>
                    <SelectItem value="teacher_assigned">
                      {t("hc_routesAppTeacherProjects.workModeMixed")}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground leading-tight">
                  {t("hc_routesAppTeacherProjects.workModeHint")}
                </p>
              </div>
            )}
            <div data-tour-id="project-field-title">
              <Label required>{t("hc_routesAppTeacherProjects.title")}</Label>
              <Input
                value={form.title ?? ""}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div data-tour-id="project-field-description">
              <div className="flex items-center justify-between gap-2 mb-1">
                <Label className="m-0">
                  {t("common.description")}{" "}
                  <HelpHint><span dangerouslySetInnerHTML={{ __html: t("help.projectDescriptionContext") }} /></HelpHint>
                </Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => {
                    setAiDescTopic(form.title ?? "");
                    setAiDescOpen(true);
                  }}
                >
                  <Sparkles className="h-3 w-3 mr-1" />
                  {t("hc_routesAppTeacherProjects.generateWithAi")}
                </Button>
              </div>
              <Textarea
                rows={4}
                value={form.description ?? ""}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder={t("hc_routesAppTeacherProjects.descriptionPlaceholder")}
              />
            </div>
            {!(form as any).is_external && (
              <div>
                <Label>{t("hc_routesAppTeacherProjects.externalLink")}</Label>
                <Input
                  placeholder="https://..."
                  value={form.external_link ?? ""}
                  onChange={(e) => setForm({ ...form, external_link: e.target.value })}
                />
              </div>
            )}
            {!(form as any).is_external && (
              <div>
                <Label className="flex items-center gap-1.5">
                  {t("hc_routesAppTeacherProjects.maxAttempts")}
                  <HelpHint>{t("hc_routesAppTeacherProjects.maxAttemptsHint")}</HelpHint>
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  placeholder={t("hc_routesAppTeacherProjects.maxAttemptsPlaceholder")}
                  value={form.max_attempts ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      max_attempts: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </div>
            )}
            {!(form as any).is_external && (
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5">
                  {t("hc_routesAppTeacherProjects.introVideos")}
                  <HelpHint>{t("help.introVideosHelpProject")}</HelpHint>
                </Label>
                {formIntroVideos.length === 0 && (
                  <p className="text-[11px] text-muted-foreground italic">
                    {t("hc_routesAppTeacherProjects.noVideosHint")}
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
                    const remove = () => {
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
                            placeholder={t("hc_routesAppTeacherProjects.videoTitlePlaceholder")}
                            value={video.title}
                            onChange={(e) => update({ title: e.target.value })}
                            className="text-xs h-8"
                          />
                          <div className="flex items-center gap-0.5 shrink-0">
                            <RowAction
                              label={t("hc_routesAppTeacherProjects.moveUp")}
                              icon={ChevronUp}
                              onClick={moveUp}
                              disabled={idx === 0}
                            />
                            <RowAction
                              label={t("hc_routesAppTeacherProjects.moveDown")}
                              icon={ChevronDown}
                              onClick={moveDown}
                              disabled={idx === formIntroVideos.length - 1}
                            />
                            <RowAction
                              label={t("hc_routesAppTeacherProjects.removeVideo")}
                              icon={Trash2}
                              tone="destructive"
                              onClick={remove}
                            />
                          </div>
                        </div>
                        {/* Selector biblioteca / URL custom. Si el docente
                            elige uno de la biblioteca, copiamos su URL al
                            row. Si después edita la URL a mano, queda como
                            ad-hoc (library_id se limpia). */}
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
                            <SelectValue
                              placeholder={t("hc_routesAppTeacherProjects.libraryOrUrl")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__custom">
                              {t("hc_routesAppTeacherProjects.customUrlOption")}
                            </SelectItem>
                            {videoLibrary.map((vl) => (
                              <SelectItem key={vl.id} value={vl.id}>
                                {vl.title} · {vl.provider.toUpperCase()}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {/* Input de URL: solo se habilita cuando el modo es
                            "URL personalizada". Cuando se eligió un video de
                            la biblioteca, la URL viene del registro de
                            `videos` y NO debe ser editable — si el docente
                            la cambia rompe el mapping (Y antes podía dejarla
                            vacía y la fila se descartaba al guardar). */}
                        {video.library_id ? (
                          <div className="rounded-md border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                            {t("hc_routesAppTeacherProjects.urlManagedFromVideos")}{" "}
                            <span className="font-mono truncate inline-block max-w-[400px] align-bottom">
                              {video.url || t("hc_routesAppTeacherProjects.loadingParen")}
                            </span>
                          </div>
                        ) : (
                          <Input
                            placeholder={t("hc_routesAppTeacherProjects.videoUrlPlaceholder")}
                            value={video.url}
                            onChange={(e) => update({ url: e.target.value, library_id: null })}
                            className="text-xs h-8"
                          />
                        )}
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
                  {t("hc_routesAppTeacherProjects.addVideo")}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  {t("hc_routesAppTeacherProjects.videoTipPrefix")}{" "}
                  <strong>{t("hc_routesAppTeacherProjects.videosSidebar")}</strong>{" "}
                  {t("hc_routesAppTeacherProjects.videoTipSuffix")}
                </p>
              </div>
            )}
            <div className="space-y-2">
              <Label required>
                {t("nav.courses")} (puedes seleccionar varios){" "}
                <HelpHint>{t("help.linkedCoursesHelp")}</HelpHint>
              </Label>
              <CoursePicker
                courses={courses}
                selectedIds={form.linked_course_ids ?? []}
                onToggle={toggleFormCourse}
                emptyText={t("hc_routesAppTeacherProjects.noCoursesAvailable")}
              />
            </div>
            {(form.linked_course_ids ?? []).length > 0 && (
              <div className="space-y-2">
                <Label>
                  {t("hc_routesAppTeacherProjects.cutAndWeightPerCourse")}{" "}
                  <HelpHint>{t("help.cutWeightPerCourseProject")}</HelpHint>
                </Label>
                {(form.linked_course_ids ?? []).map((cid) => {
                  const course = courses.find((c) => c.id === cid);
                  const cc = courseCuts[cid] ?? { cut_id: null, weight: 1 };
                  const cutsForCourse = cuts.filter((c) => c.course_id === cid);
                  const selectedCut = cc.cut_id ? cuts.find((c) => c.id === cc.cut_id) : null;
                  const pjBucket = Number(selectedCut?.project_weight ?? 0);
                  const fmEditingId = editing?.id;
                  const otherSum = projects
                    .filter((p) => p.cut_id === cc.cut_id && p.id !== fmEditingId)
                    .reduce((s, p) => s + Number((p as any).weight ?? 0), 0);
                  const pjMax = Math.max(0, pjBucket - otherSum);
                  const overBucket = !!cc.cut_id && Number(cc.weight) > pjMax + 0.01;
                  return (
                    <div key={cid} className="rounded-md border bg-muted/30 p-3 space-y-2">
                      <p className="text-sm font-medium">{course?.name ?? cid}</p>
                      {/* Pair Corte/Peso dentro de Card con p-3 — mismo
                          patrón que workshops: Selects truncan nombres
                          de cortes a ~155px. Stack en mobile. */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            {t("hc_routesAppTeacherProjects.cut")}
                          </Label>
                          <Select
                            value={cc.cut_id ?? "__none"}
                            onValueChange={(v) =>
                              setCourseCuts((prev) => ({
                                ...prev,
                                [cid]: {
                                  ...(prev[cid] ?? { weight: 1 }),
                                  cut_id: v === "__none" ? null : v,
                                },
                              }))
                            }
                          >
                            <SelectTrigger className="mt-1 h-8 text-sm">
                              <SelectValue placeholder={t("hc_routesAppTeacherProjects.noCut")} />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__none">
                                {t("hc_routesAppTeacherProjects.noCut")}
                              </SelectItem>
                              {cutsForCourse.map((c) => (
                                <SelectItem key={c.id} value={c.id}>
                                  {c.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {cutsForCourse.length === 0 && (
                            <p className="text-xs text-muted-foreground mt-1">
                              {t("hc_routesAppTeacherProjects.noCutsDefined")}
                            </p>
                          )}
                        </div>
                        <div>
                          <Label className="text-xs text-muted-foreground">
                            {t("hc_routesAppTeacherProjects.weightPercent")}
                          </Label>
                          <div className="relative mt-1">
                            <DecimalInput
                              min={0}
                              max={pjMax > 0 ? pjMax : undefined}
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
                              {t("hc_routesAppTeacherProjects.available")}{" "}
                              <strong>{pjMax.toFixed(1)}%</strong>{" "}
                              {t("hc_routesAppTeacherProjects.bucketBreakdown", {
                                bucket: pjBucket,
                                others: otherSum.toFixed(1),
                              })}
                              {overBucket && (
                                <span className="block">
                                  {t("hc_routesAppTeacherProjects.exceedsAvailableBucket")}
                                </span>
                              )}
                            </p>
                          )}
                          {!cc.cut_id && (
                            <p className="text-xs text-muted-foreground mt-1">
                              {t("hc_routesAppTeacherProjects.assignCutToConfigureWeight")}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {!(form as any).is_external && (
                <div>
                  <Label required>{t("common.startDate")}</Label>
                  <DateTimePicker
                    value={form.start_date ? toLocal(form.start_date) : ""}
                    onChange={(v) => setForm({ ...form, start_date: v })}
                  />
                </div>
              )}
              <div>
                <Label required>
                  {(form as any).is_external
                    ? t("hc_routesAppTeacherProjects.eventDate")
                    : t("common.endDate")}
                </Label>
                <DateTimePicker
                  value={form.due_date ? toLocal(form.due_date) : ""}
                  onChange={(v) => setForm({ ...form, due_date: v })}
                />
              </div>
            </div>
            {!form.is_external && (
              <ActivitySessionSelect
                courseId={(form.course_id as string) ?? Object.keys(courseCuts)[0] ?? null}
                value={(form as any).attendance_session_id ?? null}
                onChange={(sid) => setForm((f) => ({ ...(f as any), attendance_session_id: sid }))}
              />
            )}
            {editing && !form.is_external && form.status === "closed" && (
              <ReopenClosedBanner
                hint={t("hc_routesAppTeacherProjects.reopenClosedHint")}
                onReopen={() => {
                  const dueMs = form.due_date ? new Date(form.due_date).getTime() : NaN;
                  const isFuture = !Number.isNaN(dueMs) && dueMs > Date.now();
                  const nextDue = isFuture
                    ? form.due_date
                    : toLocal(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
                  setForm({ ...form, status: "published", due_date: nextDue });
                }}
              />
            )}
            {!form.is_external && (
              <div>
                <Label>{t("hc_routesAppTeacherProjects.status")}</Label>
                <Select
                  value={form.status ?? "draft"}
                  onValueChange={(v) => setForm({ ...form, status: v as Project["status"] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">
                      {t("hc_routesAppTeacherProjects.statusDraft")}
                    </SelectItem>
                    <SelectItem value="published">
                      {t("hc_routesAppTeacherProjects.statusPublished")}
                    </SelectItem>
                    <SelectItem value="closed">
                      {t("hc_routesAppTeacherProjects.statusClosed")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save}>{t("common.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI description generator dialog. El docente escribe un tema y
          la IA devuelve la descripción global del proyecto, que reemplaza
          el textarea del form principal. */}
      <Dialog open={aiDescOpen} onOpenChange={(o) => !aiDescLoading && setAiDescOpen(o)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              {t("hc_routesAppTeacherProjects.generateDescriptionTitle")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label required>{t("hc_routesAppTeacherProjects.topicOrTitle")}</Label>
              <Input
                value={aiDescTopic}
                onChange={(e) => setAiDescTopic(e.target.value)}
                placeholder={t("hc_routesAppTeacherProjects.topicPlaceholder")}
                disabled={aiDescLoading}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("hc_routesAppTeacherProjects.descriptionContextHint")}
              </p>
            </div>
            {form.description && (
              <p className="text-[11px] text-amber-700 dark:text-amber-300">
                {t("hc_routesAppTeacherProjects.willReplaceDescription")}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAiDescOpen(false)} disabled={aiDescLoading}>
              {t("common.cancel")}
            </Button>
            <Button onClick={generateDescription} disabled={aiDescLoading || !aiDescTopic.trim()}>
              {aiDescLoading ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 mr-1" />
              )}
              {t("hc_routesAppTeacherProjects.generate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Project groups editor dialog */}
      <Dialog open={groupsOpen} onOpenChange={setGroupsOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t("hc_routesAppTeacherProjects.projectGroups")}{" "}
              {groupsProject ? `— ${groupsProject.title}` : ""}
            </DialogTitle>
          </DialogHeader>
          {groupsProject && (
            <ProjectGroupsEditor
              projectId={groupsProject.id}
              courseIds={
                groupsProject.linked_course_ids?.length
                  ? groupsProject.linked_course_ids
                  : [groupsProject.course_id]
              }
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Files (slots) editor */}
      <Dialog open={filesOpen} onOpenChange={setFilesOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t("hc_routesAppTeacherProjects.questionsLabel")} — {filesProject?.title}
            </DialogTitle>
          </DialogHeader>
          {filesProject && (
            <TeacherProjectFilesEditor
              projectId={filesProject.id}
              courseLanguage={courseLanguage}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Assignment dialog */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("hc_routesAppTeacherProjects.assignLabel")} — {assignProject?.title}
            </DialogTitle>
          </DialogHeader>

          <AssignSelector
            items={visibleStudents}
            selectedIds={assigned}
            onToggle={(id) => toggleAssign(id)}
            onSelectAll={assignMany}
            onDeselectAll={unassignMany}
            loading={assignLoading}
            errorText={assignError}
            emptyText={t("hc_routesAppTeacherProjects.noEnrolledStudents")}
            countNoun={t("hc_routesAppTeacherProjects.assignedNoun")}
            headerExtras={
              assignProject && (assignProject.linked_course_ids ?? []).length > 0 ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground">
                    {t("hc_routesAppTeacherProjects.filterByCourseHint")}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(assignProject.linked_course_ids ?? []).map((cid) => {
                      const c = courses.find((cc) => cc.id === cid);
                      if (!c) return null;
                      const enabled = assignFilterCourses.has(cid);
                      const count = studentsByCourse.get(cid)?.size ?? 0;
                      return (
                        <div key={cid} className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => {
                              setAssignFilterCourses((prev) => {
                                const next = new Set(prev);
                                if (next.has(cid)) next.delete(cid);
                                else next.add(cid);
                                return next;
                              });
                            }}
                            className={`text-[10px] px-2 py-0.5 rounded-full border ${
                              enabled
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {c.name} ({count})
                          </button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            title={t("hc_routesAppTeacherProjects.assignAllEnrolledOfCourse")}
                            onClick={() => assignByCourse(cid)}
                          >
                            <UserPlus className="h-3 w-3" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null
            }
          />
        </DialogContent>
      </Dialog>

      {/* Grading / submissions dialog */}
      <Dialog open={gradingOpen} onOpenChange={setGradingOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <DialogTitle>
                {gradingProject?.is_external
                  ? t("hc_routesAppTeacherProjects.externalGrades")
                  : t("hc_routesAppTeacherProjects.submissions")}{" "}
                — {gradingProject?.title}
              </DialogTitle>
              {/* Bulk import sustentaciones — solo proyectos NO externos.
                  Para externos las notas se ingresan via ExternalGradesEditor
                  (otro flujo, columna final_grade directa sin factor). */}
              {!gradingProject?.is_external && gradingSubs.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBulkDefensesOpen(true)}
                  type="button"
                >
                  <FileUp className="h-3.5 w-3.5 mr-1" />
                  {t("hc_routesAppTeacherProjects.importDefensesCsv", {
                    defaultValue: "Importar sustentaciones",
                  })}
                </Button>
              )}
            </div>
          </DialogHeader>
          {/* Proyecto externo: mostrar el editor de notas externas en lugar
              de la lista de entregas reales. */}
          {gradingProject?.is_external && (
            <ExternalGradesEditor
              kind="project"
              refId={gradingProject.id}
              courseId={gradingProject.course_id}
              maxScore={Number(gradingProject.max_score) || 100}
            />
          )}
          {!gradingProject?.is_external && gradingLoading && (
            <ListSkeleton rows={3} rowHeight="h-24" />
          )}
          {!gradingProject?.is_external && !gradingLoading && gradingSubs.length === 0 && (
            <p className="text-sm text-muted-foreground p-4 text-center">
              {t("hc_routesAppTeacherProjects.noSubmissionsYet")}
            </p>
          )}
          {!gradingProject?.is_external &&
            !gradingLoading &&
            gradingProject &&
            gradingSubs.length > 0 && (
              <FraudPanel
                kind="project"
                refId={gradingProject.id}
                userNames={Object.fromEntries(
                  gradingSubs.map((s) => [s.user_id, (s as any).profile?.full_name ?? "—"]),
                )}
              />
            )}
          {!gradingProject?.is_external && !gradingLoading && gradingSubs.length > 0 && (
            <div className="space-y-2">
              {/* Buscador de estudiantes — patrón compartido con
                  workshops/exam monitor. Filtra cliente-side; el
                  Accordion sigue manteniendo su state global. */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  <Input
                    value={gradingSearch}
                    onChange={(e) => setGradingSearch(e.target.value)}
                    placeholder={t("hc_routesAppTeacherProjects.searchStudentPlaceholder")}
                    className="h-8 pl-8 pr-8 text-xs"
                  />
                  {gradingSearch && (
                    <button
                      type="button"
                      onClick={() => setGradingSearch("")}
                      aria-label={t("hc_routesAppTeacherProjects.clearSearch")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {gradingSearch && (
                  <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                    {t("hc_routesAppTeacherProjects.countOf", {
                      shown: filteredGradingSubs.length,
                      total: gradingSubs.length,
                    })}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <p className="text-xs text-muted-foreground">
                  {t("hc_routesAppTeacherProjects.submissionsSummary", {
                    count: gradingSubs.length,
                    maxScore: gradingProject?.max_score,
                  })}{" "}
                  · <span className="font-medium">{t("hc_routesAppTeacherProjects.decimalsWithComma")}</span>
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Hint para invitar a usar los checkboxes — análogo al
                      monitor del examen. Solo aparece cuando hay
                      entregas seleccionables y aún ninguna marcada. */}
                  {gradingSel.count === 0 && filteredGradingSubs.length > 1 && (
                    <span className="text-[11px] text-muted-foreground hidden md:inline-flex items-center gap-1">
                      <span aria-hidden>↙</span>
                      {t("hc_routesAppTeacherProjects.markToRegradeSome")}
                    </span>
                  )}
                  {gradingSel.count > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => gradingSel.clear()}
                      disabled={bulkRegrading}
                    >
                      {t("hc_routesAppTeacherProjects.clearWithCount", { count: gradingSel.count })}
                    </Button>
                  )}
                  {/* Eliminar entregas marcadas — bulk. Antes la única
                      forma de borrar era abrir el accordion y usar el
                      botón de fila. Ahora el docente puede limpiar N
                      entregas en un solo .in("id", ids) sin desplegar. */}
                  {gradingSel.count > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void bulkDeleteSelectedSubmissions()}
                      disabled={bulkRegrading}
                      className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      {t("hc_routesAppTeacherProjects.deleteWithCount", { count: gradingSel.count })}
                    </Button>
                  )}
                  {/* Bulk regrade con IA: si hay selección recalifica solo
                      esas entregas; sin selección recalifica todas las
                      filtradas. Mismo `aiRegradeSubFile` por archivo
                      detrás — un solo handler, branching en el confirm. */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const subset =
                        gradingSel.count > 0
                          ? filteredGradingSubs.filter((s) => gradingSel.isSelected(s.id))
                          : undefined;
                      void bulkRegradeProject(subset);
                    }}
                    disabled={bulkRegrading || filteredGradingSubs.length === 0}
                    title={
                      gradingSel.count > 0
                        ? t("hc_routesAppTeacherProjects.regradeSelectedTooltip")
                        : t("hc_routesAppTeacherProjects.regradeAllTooltip")
                    }
                  >
                    {bulkRegrading ? (
                      <Spinner size="sm" className="mr-1" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5 mr-1 text-amber-500" />
                    )}
                    {bulkRegrading
                      ? t("hc_routesAppTeacherProjects.regradingProgress", {
                          done: bulkProgress.done,
                          total: bulkProgress.total,
                        })
                      : gradingSel.count > 0
                        ? t("hc_routesAppTeacherProjects.regradeNWithAi", { count: gradingSel.count })
                        : t("hc_routesAppTeacherProjects.regradeAllWithAi")}
                  </Button>
                </div>
              </div>
              {filteredGradingSubs.length === 0 && (
                <p className="text-sm text-muted-foreground p-2 text-center">
                  {t("hc_routesAppTeacherProjects.noStudentMatchesSearch")}
                </p>
              )}
              <Accordion
                type="multiple"
                className="w-full"
                value={openAccordionItems}
                onValueChange={setOpenAccordionItems}
              >
                {filteredGradingSubs.map((sub) => {
                  const ans = gradingAnsBySub[sub.id] ?? [];
                  // grade que aparece en el badge del header: la final si ya
                  // hay sustentación, si no la de la entrega (submission_grade
                  // o el legacy ai_grade), si no nada.
                  const headerGrade = sub.final_grade ?? sub.submission_grade ?? sub.ai_grade;
                  return (
                    <AccordionItem
                      key={sub.id}
                      value={sub.id}
                      id={`pj-sub-${sub.id}`}
                      className={
                        highlightSubId === sub.id ? "ring-2 ring-primary/60 rounded-md" : ""
                      }
                    >
                      <AccordionTrigger className="hover:no-underline">
                        <div className="flex flex-1 items-center gap-2 text-left">
                          {/* Checkbox de multi-select. `onClick stop` evita
                              que el click en el checkbox expanda/colapse
                              el AccordionTrigger; Radix Accordion lo
                              dispara con cualquier click dentro del
                              trigger por default. */}
                          <span
                            className="shrink-0"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <MultiSelectCheckbox
                              id={sub.id}
                              state={gradingSel}
                              ariaLabel={t("hc_routesAppTeacherProjects.selectSubmissionOf", {
                                name: sub.profile?.full_name ?? "—",
                              })}
                            />
                          </span>
                          <span className="font-medium text-sm">
                            {sub.profile?.full_name ?? "—"}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {sub.profile?.institutional_email}
                          </span>
                          <div className="ml-auto">
                            <StatusBadge status={sub.status} />
                          </div>
                          {sub.defense_factor == null && headerGrade != null && (
                            <Badge variant="secondary" className="text-[9px]">
                              {t("hc_routesAppTeacherProjects.pendingDefenseBadge")}
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-[10px] tabular-nums">
                            {headerGrade != null
                              ? `${headerGrade}/${gradingProject?.max_score}`
                              : "—"}
                          </Badge>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent>
                        <div className="space-y-3">
                          <div className="flex items-center justify-between flex-wrap gap-2">
                            <p className="text-[11px] text-muted-foreground tabular-nums">
                              {t("hc_routesAppTeacherProjects.sentLabel")}{" "}
                              {formatDateTime(sub.submitted_at)}
                            </p>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive"
                              onClick={() => deleteSubmission(sub)}
                            >
                              <Trash2 className="h-3.5 w-3.5 mr-1" />{" "}
                              {t("hc_routesAppTeacherProjects.deleteSubmission")}
                            </Button>
                          </div>
                          {sub.repository_url && (
                            <div className="rounded-md border bg-amber-500/5 dark:bg-amber-500/10 border-amber-500/30 p-2.5 space-y-1">
                              <div className="text-[11px] text-muted-foreground">
                                {t("hc_routesAppTeacherProjects.studentRepository")}
                              </div>
                              <a
                                href={sub.repository_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-primary hover:underline break-all"
                              >
                                {sub.repository_url}
                              </a>
                            </div>
                          )}
                          {/* Lo que entregó el estudiante va PRIMERO. Antes
                              esta sección quedaba DEBAJO del panel de
                              sustentación (fuera de pantalla) y el docente
                              creía que "no se veía lo que entregaron". */}
                          {gradingFiles.length > 0 && (
                            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {t("hc_routesAppTeacherProjects.whatStudentSubmitted")}
                            </div>
                          )}
                          {gradingFiles.map((f) => {
                            const a = ans.find((x) => x.file_id === f.id);
                            const isHighlighted =
                              highlightSubId === sub.id && highlightFileId === f.id;
                            return (
                              <Card
                                key={f.id}
                                id={`pj-file-${sub.id}-${f.id}`}
                                className={isHighlighted ? "ring-2 ring-primary/60" : undefined}
                              >
                                <CardContent className="p-3 space-y-2">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                                    <span className="text-sm font-medium">{f.title}</span>
                                    <span className="text-[10px] text-muted-foreground">
                                      {f.points} pts
                                    </span>
                                    {a?.zip_truncated && (
                                      <Badge
                                        variant="outline"
                                        className="text-[10px] border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                                        title={t("hc_routesAppTeacherProjects.zipTruncatedTooltip", {
                                          chars:
                                            a.zip_chars_used ??
                                            t("hc_routesAppTeacherProjects.partWord"),
                                        })}
                                      >
                                        {t("hc_routesAppTeacherProjects.zipTruncatedBadge")}
                                      </Badge>
                                    )}
                                    {a?.ai_likelihood != null && (
                                      <Badge
                                        variant={
                                          Number(a.ai_likelihood) >= 0.6 ? "destructive" : "outline"
                                        }
                                        className="text-[10px] ml-auto"
                                      >
                                        {t("hc_routesAppTeacherProjects.aiBadge", {
                                          pct: Math.round(Number(a.ai_likelihood) * 100),
                                        })}
                                      </Badge>
                                    )}
                                  </div>
                                  {/* Razones IA inline — visibles solo cuando el
                                      likelihood supera el umbral 0.6 para no
                                      ensuciar la UI con texto explicativo
                                      cuando la firma es baja. El docente puede
                                      copiar/pegar esto al feedback con un click
                                      si quiere documentar la penalización. */}
                                  {a?.ai_reasons &&
                                    a?.ai_likelihood != null &&
                                    Number(a.ai_likelihood) >= 0.6 && (
                                      <div className="rounded-md border border-amber-300/60 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                                        <div className="font-medium mb-0.5">
                                          {t("hc_routesAppTeacherProjects.aiReasonsLabel")}
                                        </div>
                                        <div className="whitespace-pre-line">{a.ai_reasons}</div>
                                      </div>
                                    )}
                                  {f.type === "codigo_zip" &&
                                    ((a?.code_paths && a.code_paths.length > 0) || a?.zip_path) && (
                                      <div className="rounded-md border bg-muted/30 p-2 space-y-1.5">
                                        <div className="text-[11px] font-medium text-muted-foreground">
                                          {t("hc_routesAppTeacherProjects.submittedFiles")}
                                        </div>
                                        {a?.code_paths && a.code_paths.length > 0
                                          ? a.code_paths.map((p) => (
                                              <div key={p} className="flex items-center gap-2 min-w-0">
                                                <FileArchive className="h-3.5 w-3.5 text-primary shrink-0" />
                                                <span className="text-[11px] font-mono truncate flex-1">
                                                  {p.split("/").pop()}
                                                </span>
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  className="h-6 px-2 text-[10px]"
                                                  onClick={async () => {
                                                    const { data, error } = await supabase.storage
                                                      .from("project-files")
                                                      .createSignedUrl(p, 60);
                                                    if (error || !data?.signedUrl) {
                                                      toast.error(
                                                        friendlyError(error, t("hc_routesAppTeacherProjects.couldNotGenerateDownloadLink")),
                                                      );
                                                      return;
                                                    }
                                                    window.open(
                                                      data.signedUrl,
                                                      "_blank",
                                                      "noopener,noreferrer",
                                                    );
                                                  }}
                                                >
                                                  <Download className="h-3 w-3 mr-1" />
                                                  {t("hc_routesAppTeacherProjects.download")}
                                                </Button>
                                              </div>
                                            ))
                                          : a?.zip_path && (
                                              <div className="flex items-center gap-2 min-w-0">
                                                <FileArchive className="h-3.5 w-3.5 text-primary shrink-0" />
                                                <span className="text-[11px] font-mono truncate flex-1">
                                                  {a.zip_path.split("/").pop()}{" "}
                                                  {t("hc_routesAppTeacherProjects.zipLegacy")}
                                                </span>
                                                <Button
                                                  size="sm"
                                                  variant="outline"
                                                  className="h-6 px-2 text-[10px]"
                                                  onClick={async () => {
                                                    if (!a.zip_path) return;
                                                    const { data, error } = await supabase.storage
                                                      .from("project-files")
                                                      .createSignedUrl(a.zip_path, 60);
                                                    if (error || !data?.signedUrl) {
                                                      toast.error(
                                                        friendlyError(error, t("hc_routesAppTeacherProjects.couldNotGenerateDownloadLink")),
                                                      );
                                                      return;
                                                    }
                                                    window.open(
                                                      data.signedUrl,
                                                      "_blank",
                                                      "noopener,noreferrer",
                                                    );
                                                  }}
                                                >
                                                  <Download className="h-3 w-3 mr-1" />
                                                  {t("hc_routesAppTeacherProjects.download")}
                                                </Button>
                                              </div>
                                            )}
                                      </div>
                                    )}
                                  {/* Para `codigo_zip` el `content` está vacío:
                                      ocultamos el Textarea para no mostrar un
                                      cajón vacío y confundir al docente. */}
                                  {f.type !== "codigo_zip" && (
                                    <Textarea
                                      value={a?.content ?? ""}
                                      readOnly
                                      rows={6}
                                      className="font-mono text-xs"
                                    />
                                  )}
                                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                    <div>
                                      <Label className="text-[10px]">
                                        {t("hc_routesAppTeacherProjects.gradeMax", {
                                          points: f.points,
                                        })}
                                      </Label>
                                      <DecimalInput
                                        min={0}
                                        max={f.points}
                                        value={a?.ai_grade ?? null}
                                        onChange={(v) =>
                                          patchSubFile(sub.id, f.id, { ai_grade: v })
                                        }
                                      />
                                    </div>
                                    <div className="md:col-span-2">
                                      <Label className="text-[10px]">
                                        {t("hc_routesAppTeacherProjects.feedback")}
                                      </Label>
                                      <Textarea
                                        rows={2}
                                        value={a?.ai_feedback ?? ""}
                                        onChange={(e) =>
                                          patchSubFile(sub.id, f.id, {
                                            ai_feedback: e.target.value,
                                          })
                                        }
                                      />
                                    </div>
                                  </div>
                                  <div className="flex gap-2 justify-end">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={aiRegradingId === a?.id}
                                      onClick={() => aiRegradeSubFile(sub.id, f)}
                                    >
                                      {aiRegradingId === a?.id ? (
                                        <Spinner size="sm" className="mr-1" />
                                      ) : (
                                        <Sparkles className="h-3.5 w-3.5 mr-1" />
                                      )}
                                      {t("hc_routesAppTeacherProjects.regradeAi")}
                                    </Button>
                                    <Button
                                      size="sm"
                                      disabled={savingId === a?.id}
                                      onClick={() => saveSubFileGrade(sub.id, f.id)}
                                    >
                                      {savingId === a?.id ? (
                                        <Spinner size="sm" className="mr-1" />
                                      ) : (
                                        <Save className="h-3.5 w-3.5 mr-1" />
                                      )}
                                      {t("common.save")}
                                    </Button>
                                  </div>
                                  <FeedbackThread
                                    parentKind="project"
                                    questionId={f.id}
                                    submissionId={sub.id}
                                    isTeacher
                                  />
                                </CardContent>
                              </Card>
                            );
                          })}
                          {/* Sustentación + reabrir DESPUÉS de las entregas:
                              primero se ve/califica lo entregado, luego se
                              registra la sustentación y la nota final. */}
                          <DefensePanel
                            sub={sub}
                            maxScore={Number(gradingProject?.max_score ?? 100)}
                            onSave={saveDefense}
                          />
                          {(sub.status === "calificado" || sub.status === "ai_revisado") && (
                            <div className="flex justify-end">
                              <Button
                                size="sm"
                                variant="outline"
                                className="text-amber-700 dark:text-amber-300 border-amber-500/40 hover:bg-amber-500/10"
                                onClick={() => reopenProjectSubmission(sub.id)}
                              >
                                {t("hc_routesAppTeacherProjects.reopenSubmissionButton")}
                              </Button>
                            </div>
                          )}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Bulk import sustentaciones — separado del grading dialog para no
          cargar su árbol de submissions/files al abrir, y para que el reset
          de estado (parsedRows/errors) viva en el sub-dialog. */}
      {gradingProject && (
        <BulkImportDefensesDialog
          open={bulkDefensesOpen}
          onOpenChange={setBulkDefensesOpen}
          projectId={gradingProject.id}
          projectTitle={gradingProject.title}
          maxScore={Number(gradingProject.max_score) || 100}
          submissions={gradingSubs}
          onApplied={(updates) => {
            // Merge en el state local del grading dialog para que el accordion
            // refleje los cambios sin recargar.
            setGradingSubs((prev) =>
              prev.map((s) => {
                const u = updates.get(s.id);
                return u ? { ...s, ...u } : s;
              }),
            );
          }}
        />
      )}

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={selectedProjectItems}
        entityNameSingular={t("hc_routesAppTeacherProjects.entitySingular")}
        entityNamePlural={t("hc_routesAppTeacherProjects.entityPlural")}
        extraWarning={t("hc_routesAppTeacherProjects.bulkDeleteExtraWarning")}
        onConfirm={handleBulkDelete}
      />

      {duplicateSource && (
        <DuplicateAssessmentDialog
          open={!!duplicateSource}
          onOpenChange={(o) => !o && setDuplicateSource(null)}
          source={duplicateSource}
          target="project"
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

/**
 * Panel de sustentación dentro del dialog de calificación. Muestra la
 * nota de la entrega + un input 0..1 para el factor de sustentación +
 * notas + botón guardar. Calcula la nota final como
 * `submission_grade × defense_factor` cuando se guarda.
 */
function DefensePanel({
  sub,
  maxScore,
  onSave,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sub: any;
  maxScore: number;
  onSave: (
    subId: string,
    factor: number | null,
    notes: string,
    videoUrl?: string | null,
    subGradeOverride?: number | null,
  ) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [factor, setFactor] = useState<string>(
    sub.defense_factor != null ? String(sub.defense_factor) : "",
  );
  const [notes, setNotes] = useState<string>(sub.defense_notes ?? "");
  const [saving, setSaving] = useState(false);
  // Nota de entrega EDITABLE. La IA computa automáticamente sumando los
  // ai_grade ponderados de los archivos (trigger SQL desde mig
  // 20260955000000). Pero el docente puede sobrescribir manualmente si
  // detecta que la ponderación quedó mal o quiere ajustar. Si el input
  // queda vacío, no se manda override (el trigger sigue mandando).
  const initialSubGrade =
    sub.submission_grade != null
      ? String(sub.submission_grade)
      : sub.ai_grade != null
        ? String(sub.ai_grade)
        : "";
  const [subGradeStr, setSubGradeStr] = useState<string>(initialSubGrade);
  // Video de sustentación: `videoUrl` guarda un enlace externo (http…) o un
  // path del bucket project-files (subido). El input de URL solo refleja el
  // caso externo; el subido se muestra como chip "Ver video (subido)".
  const [videoUrl, setVideoUrl] = useState<string>(sub.defense_video_url ?? "");
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const isExternalUrl = /^https?:\/\//i.test(videoUrl);
  const handleUploadVideo = async (file: File) => {
    setUploadingVideo(true);
    try {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) {
        toast.error(i18n.t("toast.routes_app_teacher_projects.notAuthenticated"));
        return;
      }
      // Path bajo el uid del docente → permitido por la policy de INSERT
      // del bucket project-files (folder[1] = auth.uid()).
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${u.user.id}/defense/${sub.id}-${safe}`;
      const { error } = await supabase.storage
        .from("project-files")
        .upload(path, file, { upsert: true });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      setVideoUrl(path);
      toast.success(i18n.t("toast.routes_app_teacher_projects.defenseVideoUploaded"));
    } finally {
      setUploadingVideo(false);
    }
  };
  const openVideo = async () => {
    if (!videoUrl) return;
    if (/^https?:\/\//i.test(videoUrl)) {
      window.open(videoUrl, "_blank", "noopener,noreferrer");
      return;
    }
    const { data, error } = await supabase.storage
      .from("project-files")
      .createSignedUrl(videoUrl, 120);
    if (error || !data?.signedUrl) {
      toast.error(friendlyError(error, t("hc_routesAppTeacherProjects.couldNotOpenVideo")));
      return;
    }
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  };
  const baselineSubGrade: number | null = sub.submission_grade ?? sub.ai_grade ?? null;
  // Valor efectivo: si el docente editó el input, usar eso para preview.
  // Si está vacío, fallback a la baseline (calculada por IA).
  const subGradeNumRaw =
    subGradeStr.trim() === "" ? null : Number(subGradeStr.replace(",", "."));
  const subGradeValid =
    subGradeNumRaw == null ||
    (!Number.isNaN(subGradeNumRaw) && subGradeNumRaw >= 0 && subGradeNumRaw <= maxScore);
  const effectiveSubGrade =
    subGradeNumRaw != null && subGradeValid ? subGradeNumRaw : baselineSubGrade;
  const subGradeChanged =
    subGradeNumRaw != null &&
    subGradeValid &&
    (baselineSubGrade == null || Number(baselineSubGrade) !== subGradeNumRaw);
  const factorNum = factor.trim() === "" ? null : Number(factor.replace(",", "."));
  const factorValid = factorNum == null || (factorNum >= 0 && factorNum <= 1);
  const previewFinal =
    effectiveSubGrade != null && factorNum != null && factorValid
      ? Number((Number(effectiveSubGrade) * factorNum).toFixed(2))
      : null;
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="p-3 space-y-2">
        <div className="text-sm font-medium">{t("hc_routesAppTeacherProjects.defense")}</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground text-[11px]">
              {t("hc_routesAppTeacherProjects.submissionGrade")}{" "}
              <span className="text-[10px]">(/{maxScore})</span>
            </div>
            <Input
              type="text"
              inputMode="decimal"
              placeholder={baselineSubGrade != null ? String(baselineSubGrade) : "0"}
              value={subGradeStr}
              onChange={(e) => setSubGradeStr(e.target.value)}
              className="h-8 text-xs font-mono tabular-nums"
            />
            {!subGradeValid && (
              <p className="text-[10px] text-destructive mt-0.5">
                0 — {maxScore}
              </p>
            )}
            {subGradeChanged && subGradeValid && (
              <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-0.5">
                Override manual (IA: {baselineSubGrade ?? 0})
              </p>
            )}
          </div>
          <div>
            <div className="text-muted-foreground text-[11px]">
              {t("hc_routesAppTeacherProjects.factor01")}
            </div>
            <Input
              type="text"
              inputMode="decimal"
              placeholder={t("hc_routesAppTeacherProjects.factorPlaceholder")}
              value={factor}
              onChange={(e) => setFactor(e.target.value)}
              className="h-8 text-xs"
            />
            {!factorValid && (
              <p className="text-[10px] text-destructive mt-0.5">
                {t("hc_routesAppTeacherProjects.factorRange")}
              </p>
            )}
          </div>
          <div>
            <div className="text-muted-foreground text-[11px]">
              {t("hc_routesAppTeacherProjects.finalGradeFormula")}
            </div>
            <div className="font-mono tabular-nums font-semibold">
              {previewFinal != null ? `${previewFinal}/${maxScore}` : "—"}
            </div>
          </div>
        </div>
        <Textarea
          rows={2}
          placeholder={t("hc_routesAppTeacherProjects.defenseNotesPlaceholder")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="text-xs"
        />
        {/* Video de sustentación: pegar un enlace o subir un archivo. */}
        <div className="space-y-1">
          <div className="text-muted-foreground text-[11px]">
            {t("hc_routesAppTeacherProjects.defenseVideoLabel")}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="url"
              placeholder={t("hc_routesAppTeacherProjects.defenseVideoLinkPlaceholder")}
              value={isExternalUrl ? videoUrl : ""}
              onChange={(e) => setVideoUrl(e.target.value)}
              className="h-8 text-xs flex-1 min-w-[180px]"
            />
            <label className="inline-flex shrink-0 cursor-pointer items-center gap-1 h-8 px-2.5 rounded-md border text-xs hover:bg-muted/50">
              <input
                type="file"
                accept="video/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.currentTarget.value = "";
                  if (f) void handleUploadVideo(f);
                }}
              />
              {uploadingVideo ? <Spinner size="sm" /> : <Upload className="h-3.5 w-3.5" />}
              {t("hc_routesAppTeacherProjects.upload")}
            </label>
          </div>
          {videoUrl && (
            <div className="flex items-center gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => void openVideo()}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <Video className="h-3.5 w-3.5" /> {t("hc_routesAppTeacherProjects.viewVideo")}{" "}
                {isExternalUrl
                  ? t("hc_routesAppTeacherProjects.viewVideoLink")
                  : t("hc_routesAppTeacherProjects.viewVideoUploaded")}
              </button>
              <button
                type="button"
                onClick={() => setVideoUrl("")}
                className="text-muted-foreground hover:text-destructive"
              >
                {t("hc_routesAppTeacherProjects.removeWord")}
              </button>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground">
            {t("hc_routesAppTeacherProjects.defenseVideoTip")}
          </p>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={async () => {
              if (!factorValid || !subGradeValid) return;
              setSaving(true);
              try {
                // Pasar el override solo si el docente cambió la nota;
                // si no, mandar undefined para que el server siga usando
                // el cálculo del trigger.
                await onSave(
                  sub.id,
                  factorNum,
                  notes,
                  videoUrl,
                  subGradeChanged ? subGradeNumRaw : undefined,
                );
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving || !factorValid || !subGradeValid}
          >
            {saving ? <Spinner size="sm" className="mr-1" /> : null}
            {t("hc_routesAppTeacherProjects.saveDefense")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function toLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
