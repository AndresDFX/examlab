import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { softDelete, softDeleteMany } from "@/modules/trash/soft-delete";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { logEvent } from "@/shared/lib/audit";
import { friendlyError, friendlyUniqueViolation } from "@/shared/lib/db-errors";
import { toCSV, downloadCSV, parseCSV } from "@/shared/lib/csv";
import { SESSIONS_TEMPLATE, parseSessionsCsv } from "@/modules/sessions/csv";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { DateCell } from "@/components/ui/date-cell";
import {
  deriveCourseDisplayState,
  summarizeCourses,
} from "@/modules/courses/course-status";
import {
  nextBoardContentName,
  uploadBoardContent,
  BOARD_ACCEPTED_EXTENSIONS,
} from "@/modules/contents/board-content-upload";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  SortableHead,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Users,
  Pencil,
  Copy,
  UserCog,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  BookOpen,
  CalendarRange,
  CalendarClock,
  Archive,
  FileText,
  Hammer,
  FolderKanban,
  Link2,
  Upload,
  Download,
  MessageSquareText,
  Award,
  Video,
  RefreshCw,
  Stethoscope,
  Play,
  CheckCircle2,
} from "lucide-react";
import { CourseCertificateSettingsDialog } from "@/modules/certificates/CourseCertificateSettingsDialog";
import { CourseDiagnosticDialog } from "@/modules/courses/CourseDiagnosticDialog";
import { LinkCalendarEventsDialog } from "@/modules/calendar/LinkCalendarEventsDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { classNumberFromFilename, isTeacherOnlyFile } from "@/modules/contents/contents-extract";
import { DecimalInput } from "@/components/ui/decimal-input";
import { HelpHint } from "@/components/ui/help-hint";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { CourseScheduleEditor } from "@/modules/schedules/CourseScheduleEditor";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { AssignSelector } from "@/shared/components/AssignSelector";
import { DatePicker } from "@/components/ui/date-picker";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

// grade_cuts/grade_cut_items aren't always reflected in the auto-generated types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/admin/courses")({
  component: AdminCourses,
  validateSearch: (
    s: Record<string, unknown>,
  ): { fromSubject?: string; subjectFilter?: string } => ({
    // `fromSubject=<id>` viene del menú 'Crear curso desde esta
    // asignatura' en /admin Universidad → Asignaturas. Al recibirlo,
    // este route abre el dialog 'Nuevo curso' con campos pre-rellenados
    // desde la asignatura (name, program_id, semestre, pesos).
    fromSubject: typeof s.fromSubject === "string" ? s.fromSubject : undefined,
    // `subjectFilter=<id>` filtra el grid a los cursos cuya
    // subject_id matchee — útil para 'Ver cursos asociados'.
    subjectFilter: typeof s.subjectFilter === "string" ? s.subjectFilter : undefined,
  }),
});

type Course = {
  id: string;
  name: string;
  description: string | null;
  period: string | null;
  /** Código corto / abreviatura (opcional). Ej: "ProgII". */
  code: string | null;
  /** Número de semestre dentro del programa (1..12, opcional). */
  semestre: number | null;
  /** Identificador del grupo / sección (opcional). Ej: "341-C". */
  grupo: string | null;
  /** FK al programa académico (opcional). NULL si el curso no está
   *  asociado a ningún programa todavía. */
  program_id: string | null;
  /** FK al periodo académico (opcional). Coexiste con el campo
   *  `period` (text) por compat — al guardar, ambos se setean. */
  period_id: string | null;
  /** FK a la asignatura (template del plan). Múltiples cursos pueden
   *  apuntar a la misma asignatura (distintos grupos/periodos). */
  subject_id: string | null;
  start_date: string | null;
  end_date: string | null;
  grade_scale_min: number;
  grade_scale_max: number;
  exam_weight: number;
  workshop_weight: number;
  attendance_weight: number;
  project_weight: number;
  passing_grade: number;
  max_exam_attempts: number;
  /** Ciclo de vida del curso (col agregada en mig 20260964000000;
   *  types.ts se regenera en Publish). 'borrador' | 'en_curso' |
   *  'finalizado'. Puede venir undefined en entornos pre-migración. */
  status?: string | null;
  finalized_at?: string | null;
};

type DraftCut = {
  // Present only when the cut already exists in the DB.
  id?: string;
  name: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
  weight: number;
  exam_weight: number;
  workshop_weight: number;
  attendance_weight: number;
  project_weight: number;
};

/** Normaliza un valor de fecha (ISO timestamp o YYYY-MM-DD) a YYYY-MM-DD para inputs <date>. */
function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  // Si viene como ISO con tiempo, recorta. Si viene YYYY-MM-DD, la primera parte ya es eso.
  return value.length >= 10 ? value.slice(0, 10) : value;
}

/** Formatea un porcentaje quitando ceros sobrantes y usando coma. "33,33", "30", "0". */
function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return "0";
  // 2 decimales máx, sin trailing zeros, locale es-CO para usar coma.
  return n.toLocaleString("es-CO", { maximumFractionDigits: 2 });
}
type Profile = { id: string; full_name: string; institutional_email: string };

/** Stats por curso para la columna "Actividad" del grid. Se cargan en
 *  batch con queries sobre tablas relacionadas (sin RPC). Mejor UX que
 *  navegar al detalle del curso para saber cuánta gente y contenido hay. */
type CourseStats = {
  students: number;
  teachers: number;
  exams: number;
  workshops: number;
  projects: number;
};

export function AdminCourses() {
  const { t } = useTranslation();
  const { user, roles } = useAuth();
  const activeRole = useActiveRole();
  const confirm = useConfirm();
  const [courses, setCourses] = useState<Course[]>([]);
  /** Mapa courseId → stats. Vacío al inicio; se llena después del primer
   *  load de cursos. Si falla la carga (RLS / network), simplemente la
   *  columna "Actividad" muestra "—" — el grid no se rompe. */
  const [courseStats, setCourseStats] = useState<Map<string, CourseStats>>(new Map());
  // Escala de calificación POR DEFECTO de la institución (app_settings).
  // Un curso NUEVO la hereda; el docente/admin puede sobrescribirla al
  // crear/editar el curso. Fallback 0–5 si no hay app_settings.
  const [defaultScale, setDefaultScale] = useState<{ min: number; max: number }>({
    min: 0,
    max: 5,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Filtro de institución (solo SuperAdmin). 'all' = ve cross-tenant
  // (default). Cuando elige una, la query se restringe con `.eq('tenant_id', X)`.
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Course> | null>(null);
  const [certForCourse, setCertForCourse] = useState<Course | null>(null);
  // Diagnóstico del curso — dialog separado abierto desde el menú de
  // acciones de fila. Escanea calificaciones pendientes, errores IA,
  // conversaciones abiertas y asistencia, con acciones de remediación
  // (re-encolar IA, cerrar conversación, navegar a calificar).
  const [diagnosticForCourse, setDiagnosticForCourse] = useState<Course | null>(null);
  // Editor de horarios — dialog independiente abierto desde el menú
  // de acciones de fila. Mantener fuera del editing principal evita
  // sobrecargar el dialog del form de curso.
  const [scheduleForCourse, setScheduleForCourse] = useState<Course | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Search params: `subjectFilter` viene del flujo 'Ver cursos asociados'
  // desde el panel de asignaturas. Filtra el grid a una sola asignatura.
  // Usamos `strict: false` porque este componente se reusa en /app/teacher/courses,
  // y `Route.useSearch()` (atado a /app/admin/courses) dispara "Invariant failed"
  // cuando la ruta activa no coincide.
  const routeSearch = useSearch({ strict: false }) as {
    subjectFilter?: string;
    fromSubject?: string;
  };
  const subjectFilter = routeSearch.subjectFilter ?? null;
  const fromSubject = routeSearch.fromSubject ?? null;

  // Filtros UI del grid (separados del subjectFilter de la URL que viene
  // del deep-link "Ver cursos asociados" de Asignaturas). El admin elige
  // Programa → filtra el listado a cursos cuya asignatura pertenece a
  // ese programa; encima puede filtrar por Asignatura específica. Los
  // dos se combinan (AND) con search + tenantFilter.
  const [programFilterUi, setProgramFilterUi] = useState<string>("all");
  const [subjectFilterUi, setSubjectFilterUi] = useState<string>("all");
  const [periodFilterUi, setPeriodFilterUi] = useState<string>("all");
  // Filtro por estado de ciclo de vida del curso. Default = "en_curso"
  // (lo vigente/accionable ahora) en vez de "all": el docente/admin abre
  // el listado y ve por defecto solo los cursos en curso, los borradores
  // / próximos / finalizados se ven cambiando este filtro o eligiendo
  // "Todos". Valor DETERMINISTA constante (no leer storage en el init —
  // ver regla de hidratación React #418 en CLAUDE.md). Matchea contra el
  // estado de DISPLAY derivado (borrador | proximo | en_curso | finalizado).
  const [statusFilterUi, setStatusFilterUi] = useState<string>("en_curso");

  // Filtramos por nombre + período + descripción. Case-insensitive,
  // includes. El multi-select trabaja sobre la lista visible. Si hay
  // subjectFilter (URL search), también acotamos.
  const filteredCourses = useMemo(() => {
    let result = courses;
    if (subjectFilter) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = result.filter((c: any) => c.subject_id === subjectFilter);
    }
    if (programFilterUi !== "all") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = result.filter((c: any) => c.program_id === programFilterUi);
    }
    if (subjectFilterUi !== "all") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = result.filter((c: any) => c.subject_id === subjectFilterUi);
    }
    if (periodFilterUi !== "all") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = result.filter((c: any) => c.period_id === periodFilterUi);
    }
    if (statusFilterUi !== "all") {
      // Comparamos contra el estado de DISPLAY derivado (no contra
      // c.status crudo) para que "Próximo" — que es en_curso + fecha
      // futura, no un valor persistido — sea filtrable por separado.
      const now = Date.now();
      result = result.filter((c) => deriveCourseDisplayState(c, now) === statusFilterUi);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (c) =>
          c.name?.toLowerCase().includes(q) ||
          c.period?.toLowerCase().includes(q) ||
          c.description?.toLowerCase().includes(q),
      );
    }
    return result;
  }, [courses, search, subjectFilter, programFilterUi, subjectFilterUi, periodFilterUi, statusFilterUi]);

  // Orden por columna (asc/desc clicando el encabezado). Va ENTRE el
  // filtro y la paginación: filtrar → ORDENAR → paginar. Las columnas con
  // orden natural: nombre, período (texto), escala (max), fechas
  // inicio/fin, actividad (suma de items). Los conteos de actividad salen
  // del mapa courseStats — replicamos el lookup en los accessors.
  const sort = useTableSort(filteredCourses, {
    columns: {
      name: (c) => c.name,
      period: (c) => c.period,
      // Orden por estado de DISPLAY (string): borrador < en_curso <
      // finalizado < proximo. El orden alfabético es aceptable acá.
      status: (c) => deriveCourseDisplayState(c, Date.now()),
      scale: (c) => c.grade_scale_max,
      start_date: (c) => c.start_date,
      end_date: (c) => c.end_date,
      activity: (c) => {
        const s = courseStats.get(c.id);
        return s ? s.exams + s.workshops + s.projects : null;
      },
    },
    defaultSort: { key: "name", dir: "asc" },
    storageKey: "examlab_sort:admin_courses",
  });

  const sel = useMultiSelect(sort.sorted);

  // Stats compactas arriba del listado — mismo patrón que el resto de
  // listados (proyectos / talleres / etc). Ahora derivadas del ciclo de
  // vida EXPLÍCITO del curso (status) vía el helper puro: borrador,
  // activos (display 'en_curso'), próximos (publicado sin empezar),
  // finalizados. Ver src/modules/courses/course-status.ts.
  // Nombre `coursesSummary` (no `courseStats`) para no colisionar con
  // el `courseStats: Map<string, CourseStats>` ya declarado arriba —
  // ese guarda counts por curso (entregas, alumnos), distinto concepto.
  const coursesSummary = useMemo(() => summarizeCourses(courses, Date.now()), [courses]);

  // Paginación client-side. La RLS ya acota a lo que el caller puede
  // ver; partir en páginas evita renderizar 500 filas en tenants
  // grandes. resetKey incluye los filtros activos para que al filtrar
  // el usuario vuelva a página 1 (no se quede en una página fuera de
  // rango con grid vacío).
  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:admin_courses",
    resetKey: `${search}|${subjectFilter ?? ""}|${programFilterUi}|${subjectFilterUi}|${periodFilterUi}|${statusFilterUi}|${tenantFilter}|${sort.resetKey}`,
  });

  // Export del listado filtrado. No soportamos import porque cada curso
  // arrastra cortes con weights, weights de docente, matrículas y enlaces
  // a exams/workshops/projects — no es razonable bulk-import por CSV.
  const exportCoursesCsv = (): string => {
    const data = filteredCourses.map((c) => ({
      name: c.name,
      period: c.period ?? "",
      description: (c.description ?? "").replace(/\r?\n/g, " ").slice(0, 500),
      start_date: c.start_date ?? "",
      end_date: c.end_date ?? "",
      grade_scale_min: c.grade_scale_min,
      grade_scale_max: c.grade_scale_max,
      passing_grade: c.passing_grade,
      max_exam_attempts: c.max_exam_attempts,
      exam_weight: c.exam_weight,
      workshop_weight: c.workshop_weight,
      project_weight: c.project_weight,
      attendance_weight: c.attendance_weight,
    }));
    return toCSV(data);
  };

  const handleBulkDelete = async (ids: string[]) => {
    // Soft-delete a papelera. La fila queda invisible para las listas
    // (filtran is('deleted_at', null)) pero recuperable desde /app/trash
    // hasta que el cron de purga (30 días) la borre físicamente. Como
    // NO hacemos DELETE físico ya, los hijos (examenes/talleres/etc.)
    // tampoco se borran — el restore reactiva el árbol intacto.
    const { error } = await softDeleteMany("courses", ids);
    if (error) throw new Error(error.message);
    toast.success(
      i18n.t("toast.routes_app_admin_courses.coursesSentToTrash", {
        defaultValue: "{{count}} curso(s) enviado(s) a papelera",
        count: ids.length,
      }),
    );
    void logEvent({
      action: "course.deleted",
      category: "course",
      actorRole: roles[0],
      severity: "warning",
      metadata: { count: ids.length, ids },
    });
    sel.clear();
    load();
  };

  const selectedCourseItems = useMemo(
    () =>
      courses
        .filter((c) => sel.isSelected(c.id))
        .map((c) => ({ id: c.id, label: `${c.name}${c.period ? ` (${c.period})` : ""}` })),
    [courses, sel],
  );

  // Cortes evaluativos del curso en edición (en memoria; se persiste al guardar).
  const [editingCuts, setEditingCuts] = useState<DraftCut[]>([]);
  // IDs que existían al abrir el diálogo. Lo que falte al guardar se elimina.
  const [originalCutIds, setOriginalCutIds] = useState<Set<string>>(new Set());

  // Guard contra cerrar el modal sin guardar (click fuera, Escape o X).
  const courseDirty = useDirtyDialog(open, { editing, editingCuts });
  // Cortes expandidos en la UI para ver/editar sub-pesos.
  const [expandedCuts, setExpandedCuts] = useState<Set<number>>(new Set());

  // Enrollment
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollCourse, setEnrollCourse] = useState<Course | null>(null);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [enrolledIds, setEnrolledIds] = useState<Set<string>>(new Set());

  // Teacher assignment
  const [teacherOpen, setTeacherOpen] = useState(false);
  const [teacherCourse, setTeacherCourse] = useState<Course | null>(null);
  const [teachers, setTeachers] = useState<Profile[]>([]);
  const [assignedTeacherIds, setAssignedTeacherIds] = useState<Set<string>>(new Set());

  // Programas académicos activos — alimentan el dropdown del form de
  // curso. Cargados junto con la lista de cursos para no hacer query
  // redundante al abrir el dialog.
  const [programs, setPrograms] = useState<Array<{ id: string; name: string }>>([]);
  // Periodos académicos no-cerrados — alimentan el otro dropdown.
  // Los cerrados se filtran para evitar asociar cursos nuevos a periodos
  // históricos, pero se permiten en modo edición (el código del periodo
  // sigue mostrándose por el embed).
  const [periods, setPeriods] = useState<
    Array<{ id: string; code: string; name: string | null; status: string }>
  >([]);
  // Asignaturas activas — alimentan el dropdown del template del plan.
  // Filtramos por programa cuando hay program_id elegido (relevancia).
  const [subjects, setSubjects] = useState<
    Array<{
      id: string;
      name: string;
      code: string | null;
      program_id: string | null;
      semestre: number | null;
      sistema_evaluacion?: {
        exam_weight?: number;
        workshop_weight?: number;
        project_weight?: number;
        attendance_weight?: number;
        grade_scale_min?: number;
        grade_scale_max?: number;
      } | null;
    }>
  >([]);

  // Duplicate
  const [dupOpen, setDupOpen] = useState(false);
  const [dupSource, setDupSource] = useState<Course | null>(null);
  const [dupName, setDupName] = useState("");
  const [dupPeriod, setDupPeriod] = useState("");
  const [dupCopyExams, setDupCopyExams] = useState(true);
  const [dupCopyWorkshops, setDupCopyWorkshops] = useState(true);
  // Copiar el TABLERO (sesiones del cronograma) al curso nuevo. Útil para
  // cursos que se repiten cada periodo con la misma estructura de clases.
  // Copia fecha/hora/título/enlace de reunión; NO content_id (los
  // contenidos son del curso origen) ni grabaciones/notas (son de esa
  // instancia puntual).
  const [dupCopyBoard, setDupCopyBoard] = useState(true);
  const [dupCopyStudents, setDupCopyStudents] = useState(false);
  // Por defecto NO copiar docentes (opt-in).
  const [dupCopyTeachers, setDupCopyTeachers] = useState(false);
  const [dupLoading, setDupLoading] = useState(false);

  // SuperAdmin tiene los mismos privilegios que Admin para gestión de
  // cursos. Su vista incluye filtro extra cross-tenant abajo.
  const isAdmin = roles.includes("Admin") || roles.includes("SuperAdmin");
  const isTeacher = roles.includes("Docente");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // Solo `true` cuando el usuario está ACTIVAMENTE actuando como SuperAdmin.
  // Si tiene también el rol Admin y cambió al switcher, debe verse como
  // Admin común — sin filtro cross-tenant. Antes era `roles.includes(...)`,
  // que filtraba bien sólo el rol pero no la intención del usuario.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isSuperAdminCaller = activeRole === "SuperAdmin" && (roles as any[]).includes("SuperAdmin");
  // Docente tiene los mismos privilegios que Admin para gestionar
  // cursos, EXCEPTO auto-asignarse en course_teachers (lo bloquea
  // tanto la RLS como el filtro del dialog de docentes más abajo).
  const canManage = isAdmin || isTeacher;

  const load = async () => {
    // Docente actuando como tal (ROL ACTIVO = Docente): ve SOLO los cursos
    // donde es docente (course_teachers). Un Admin/SuperAdmin —o un usuario
    // multi-rol que cambió el switcher a Admin— ve todos los de su tenant via
    // RLS. La RLS de `courses` deja ver todo el tenant (para matrícula/gestión),
    // así que el scoping del docente es un filtro de UI por ROL ACTIVO (mismo
    // patrón que el resto de páginas compartidas Admin/Docente). Reporte:
    // "como docente veo cursos de los que no soy docente".
    let teacherCourseIds: string[] | null = null;
    if (activeRole === "Docente" && !isSuperAdminCaller && user) {
      const { data: ctRows } = await supabase
        .from("course_teachers")
        .select("course_id")
        .eq("user_id", user.id);
      teacherCourseIds = [
        ...new Set(((ctRows ?? []) as Array<{ course_id: string }>).map((r) => r.course_id)),
      ];
    }

    // SuperAdmin con filtro de institución activo: aplicamos
    // `.eq('tenant_id', X)` a la query principal. Para Admin normal el
    // filtro no se renderiza (solo ve su tenant via RLS), así que
    // tenantFilter queda en 'all' y la query no se restringe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any[] = [];
    // Docente sin cursos asignados → lista vacía SIN pegarle a `courses`
    // (un `.in("id", [])` en PostgREST devuelve TODOS los rows, no ninguno).
    if (!(teacherCourseIds && teacherCourseIds.length === 0)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabase
        .from("courses")
        .select("*")
        // Excluir cursos en papelera. Visibles desde /app/trash hasta
        // que el cron de purga (30 días) los borre físicamente.
        .is("deleted_at", null)
        .order("period", { ascending: false, nullsFirst: false })
        .order("name");
      if (isSuperAdminCaller && tenantFilter !== "all") {
        q = q.eq("tenant_id", tenantFilter);
      }
      // Scoping del docente: solo sus cursos.
      if (teacherCourseIds && teacherCourseIds.length > 0) {
        q = q.in("id", teacherCourseIds);
      }
      const res = await q;
      if (res.error) {
        setLoadError(friendlyError(res.error, t("hc_routesAppAdminCourses.loadErrorMessage")));
        return;
      }
      data = res.data ?? [];
    }
    setLoadError(null);
    // Cargar programas activos (best-effort — si falla, el dropdown
    // queda vacío pero el form sigue funcionando: program_id es opcional).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: progs } = await (supabase as any)
      .from("academic_programs")
      .select("id, name")
      .eq("active", true)
      .order("name");
    setPrograms((progs ?? []) as Array<{ id: string; name: string }>);
    // Periodos académicos (best-effort).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: pers } = await (supabase as any)
      .from("academic_periods")
      .select("id, code, name, status")
      .order("code", { ascending: false });
    setPeriods(
      (pers ?? []) as Array<{ id: string; code: string; name: string | null; status: string }>,
    );
    // Asignaturas activas (best-effort). Incluimos sistema_evaluacion
    // para poder pre-rellenar los pesos del curso cuando viene del
    // flujo 'Crear curso desde esta asignatura'.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: subs } = await (supabase as any)
      .from("academic_subjects")
      .select("id, name, code, program_id, semestre, sistema_evaluacion")
      .eq("active", true)
      .order("name");
    setSubjects(
      (subs ?? []) as Array<{
        id: string;
        name: string;
        code: string | null;
        program_id: string | null;
        semestre: number | null;
        sistema_evaluacion?: {
          exam_weight?: number;
          workshop_weight?: number;
          project_weight?: number;
          attendance_weight?: number;
          grade_scale_min?: number;
          grade_scale_max?: number;
        } | null;
      }>,
    );
    // Tenants visibles — solo el SuperAdmin ve >1 institución; el Admin
    // normal ve solo el suyo (RLS). Si el array queda en ≤1, el filtro
    // UI no se renderiza más abajo.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tens } = await (supabase as any)
      .from("tenants")
      .select("id, slug, name")
      .is("deleted_at", null)
      .order("name");
    setTenants((tens ?? []) as Array<{ id: string; slug: string; name: string }>);
    // Escala por defecto de la institución (para heredarla en cursos nuevos).
    // limit(1): el Admin ve solo su app_settings (RLS); el SuperAdmin podría
    // ver varias filas → tomamos la primera (igual la puede sobrescribir).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: appSet } = await (supabase as any)
      .from("app_settings")
      .select("default_grade_scale_min, default_grade_scale_max")
      .limit(1);
    const scaleRow = (appSet ?? [])[0] as
      | { default_grade_scale_min?: number; default_grade_scale_max?: number }
      | undefined;
    setDefaultScale({
      min: Number(scaleRow?.default_grade_scale_min ?? 0),
      max: Number(scaleRow?.default_grade_scale_max ?? 5),
    });
    setCourses((data ?? []) as unknown as Course[]);

    // Stats por curso (Actividad): cargamos en paralelo 5 queries
    // ligeras (solo course_id) y agrupamos en memoria. Evita N+1 y RPCs.
    // Talleres y proyectos son M:N (workshop_courses / project_courses);
    // exámenes son 1:N directo. course_enrollments (alumnos) y
    // course_teachers son tablas de relación directas.
    const courseIds = (data ?? []).map((c: { id: string }) => c.id);
    if (courseIds.length > 0) {
      try {
        const [{ data: studs }, { data: teaches }, { data: exs }, { data: wks }, { data: prs }] =
          await Promise.all([
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (supabase as any)
              .from("course_enrollments")
              .select("course_id")
              .in("course_id", courseIds),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (supabase as any)
              .from("course_teachers")
              .select("course_id")
              .in("course_id", courseIds),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (supabase as any)
              .from("exams")
              .select("course_id")
              .in("course_id", courseIds)
              .is("deleted_at", null),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (supabase as any)
              .from("workshop_courses")
              .select("course_id")
              .in("course_id", courseIds),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (supabase as any)
              .from("project_courses")
              .select("course_id")
              .in("course_id", courseIds),
          ]);
        const next = new Map<string, CourseStats>();
        for (const id of courseIds) {
          next.set(id, { students: 0, teachers: 0, exams: 0, workshops: 0, projects: 0 });
        }
        const bump = (rows: Array<{ course_id: string }> | null, key: keyof CourseStats) => {
          for (const r of rows ?? []) {
            const s = next.get(r.course_id);
            if (s) s[key] = s[key] + 1;
          }
        };
        bump(studs as Array<{ course_id: string }> | null, "students");
        bump(teaches as Array<{ course_id: string }> | null, "teachers");
        bump(exs as Array<{ course_id: string }> | null, "exams");
        bump(wks as Array<{ course_id: string }> | null, "workshops");
        bump(prs as Array<{ course_id: string }> | null, "projects");
        setCourseStats(next);
      } catch {
        // Si falla, dejamos el mapa vacío — la UI muestra "—".
        setCourseStats(new Map());
      }
    } else {
      setCourseStats(new Map());
    }
  };
  useEffect(() => {
    load();
    // SuperAdmin: recargamos cuando cambia el filtro de institución para
    // aplicar `.eq('tenant_id', X)` a la query principal. Para Admin
    // normal tenantFilter queda en 'all' permanente y este effect corre
    // solo al montar. `activeRole` en deps: si el usuario multi-rol cambia
    // entre Admin y Docente con el switcher, re-cargamos para re-aplicar (o
    // quitar) el scoping de "solo mis cursos" del docente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantFilter, activeRole]);

  // Si el admin viene del flujo "Crear curso desde esta asignatura"
  // (via /admin/asignaturas), pre-abrimos el dialog con los campos
  // pre-rellenados desde la asignatura. Solo se dispara una vez
  // cuando subjects ya está cargado (sin él no podemos resolver
  // el subject).
  const [fromSubjectHandled, setFromSubjectHandled] = useState(false);
  useEffect(() => {
    if (!fromSubject || fromSubjectHandled || subjects.length === 0) return;
    const subj = subjects.find((s) => s.id === fromSubject);
    if (!subj) return;
    const ev = subj.sistema_evaluacion ?? {};
    setEditing({
      id: "",
      // Nombre del curso = nombre de la asignatura (el admin puede
      // ajustarlo antes de guardar, ej. agregar grupo/periodo).
      name: subj.name,
      description: "",
      period: "",
      code: subj.code ?? null,
      semestre: subj.semestre ?? null,
      grupo: null,
      program_id: subj.program_id ?? null,
      period_id: null,
      subject_id: subj.id,
      start_date: "",
      end_date: "",
      // Escala: HEREDA de la asignatura si la definió; si no, el default de
      // la institución (app_settings). Sobrescribible por el admin.
      grade_scale_min: Number(ev.grade_scale_min ?? defaultScale.min),
      grade_scale_max: Number(ev.grade_scale_max ?? defaultScale.max),
      // Pesos: si la asignatura los definió, los heredamos; si no,
      // usamos los defaults del sistema.
      exam_weight: Number(ev.exam_weight ?? 40),
      workshop_weight: Number(ev.workshop_weight ?? 30),
      attendance_weight: Number(ev.attendance_weight ?? 10),
      project_weight: Number(ev.project_weight ?? 20),
      passing_grade: 3,
      max_exam_attempts: 1,
    });
    setEditingCuts([]);
    setOriginalCutIds(new Set());
    setExpandedCuts(new Set());
    setOpen(true);
    setFromSubjectHandled(true);
  }, [fromSubject, fromSubjectHandled, subjects]);

  // ── Course CRUD ──────────────────────────────────────────

  const openNew = () => {
    setEditing({
      id: "",
      name: "",
      description: "",
      period: "",
      code: null,
      semestre: null,
      grupo: null,
      program_id: null,
      period_id: null,
      subject_id: null,
      start_date: "",
      end_date: "",
      // Hereda la escala de la institución (app_settings); sobrescribible.
      grade_scale_min: defaultScale.min,
      grade_scale_max: defaultScale.max,
      exam_weight: 40,
      workshop_weight: 30,
      attendance_weight: 10,
      project_weight: 20,
      passing_grade: 3,
      max_exam_attempts: 1,
    });
    setEditingCuts([]);
    setOriginalCutIds(new Set());
    setExpandedCuts(new Set());
    setOpen(true);
  };

  /** Carga los cortes existentes del curso al abrir el diálogo en modo edición. */
  const openEdit = async (c: Course) => {
    setEditing({
      ...c,
      start_date: toDateInput(c.start_date),
      end_date: toDateInput(c.end_date),
    });
    const { data: cuts } = await db
      .from("grade_cuts")
      .select("*")
      .eq("course_id", c.id)
      .order("position");
    const list = ((cuts ?? []) as DraftCut[]).map((x) => ({
      id: x.id,
      name: x.name,
      position: x.position,
      start_date: x.start_date,
      end_date: x.end_date,
      weight: Number(x.weight ?? 0),
      exam_weight: Number(x.exam_weight ?? 0),
      workshop_weight: Number(x.workshop_weight ?? 0),
      attendance_weight: Number(x.attendance_weight ?? 0),
      project_weight: Number(x.project_weight ?? 0),
    }));
    setEditingCuts(list);
    setOriginalCutIds(new Set(list.map((x) => x.id!).filter(Boolean)));
    setExpandedCuts(new Set());
    setOpen(true);
  };

  /** Crea un corte vacío con defaults razonables. */
  const makeEmptyCut = (position: number, n: number): DraftCut => ({
    name: t("hc_routesAppAdminCourses.cutDefaultName", { n: position + 1 }),
    position,
    start_date: null,
    end_date: null,
    weight: n > 0 ? Math.round(100 / n) : 0,
    // Sub-pesos arrancan en 0; el docente los llena hasta sumar cut.weight
    // según los tipos de evaluación que vaya a usar en este corte.
    exam_weight: 0,
    workshop_weight: 0,
    attendance_weight: 0,
    project_weight: 0,
  });

  /** Cambia el número total de cortes. Pide confirmación si se reduce y hay items. */
  const handleCutCountChange = async (next: number) => {
    const target = Math.max(0, Math.min(20, Math.floor(next || 0)));
    const current = editingCuts.length;
    if (target === current) return;

    if (target > current) {
      // Aumentar: agregar cortes vacíos al final.
      const additions: DraftCut[] = [];
      for (let i = current; i < target; i++) additions.push(makeEmptyCut(i, target));
      setEditingCuts([...editingCuts, ...additions]);
      return;
    }

    // Reducir: revisar si los cortes a eliminar (ya en BD) tienen items.
    const toRemove = editingCuts.slice(target);
    const idsInDb = toRemove.map((c) => c.id).filter(Boolean) as string[];
    let itemsCount = 0;
    if (idsInDb.length) {
      const { count } = await db
        .from("grade_cut_items")
        .select("id", { count: "exact", head: true })
        .in("cut_id", idsInDb);
      itemsCount = count ?? 0;
    }
    const ok = await confirm({
      title: t("course.reduceCutsTitle", { target }),
      description:
        itemsCount > 0
          ? t("course.reduceCutsBodyItems", { cuts: toRemove.length, items: itemsCount })
          : t("course.reduceCutsBody", { cuts: toRemove.length }),
      confirmLabel: t("course.reduceCutsConfirm"),
      tone: "destructive",
    });
    if (!ok) return;
    setEditingCuts(editingCuts.slice(0, target));
    setExpandedCuts(new Set());
  };

  /** Aplica un parche a un corte por índice. */
  const updateDraftCut = (index: number, patch: Partial<DraftCut>) => {
    setEditingCuts((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  /** Toggle expand/collapse para los sub-pesos. */
  const toggleExpand = (index: number) => {
    setExpandedCuts((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const save = async () => {
    if (!editing?.name?.trim()) {
      toast.error(
        i18n.t("toast.routes_app_admin_courses.nameRequired", {
          defaultValue: "Nombre requerido",
        }),
      );
      return;
    }
    const startInput = toDateInput(editing.start_date);
    const endInput = toDateInput(editing.end_date);
    if (startInput && endInput && startInput > endInput) {
      toast.error(
        i18n.t("toast.routes_app_admin_courses.endDateAfterStart", {
          defaultValue: "La fecha de fin debe ser posterior a la fecha de inicio",
        }),
      );
      return;
    }

    // ── Validación de pesos ──
    // Tolerancia de 0.01 para evitar falsos negativos por suma flotante
    // (ej. 33,33 + 33,33 + 33,34 = 100 exacto pero 99.99999... en JS).
    const TOL = 0.01;
    if (editingCuts.length === 0) {
      // Sin cortes: los pesos por tipo del curso deben sumar 100.
      const total =
        Number(editing.exam_weight ?? 0) +
        Number(editing.workshop_weight ?? 0) +
        Number(editing.attendance_weight ?? 0) +
        Number(editing.project_weight ?? 0);
      if (Math.abs(total - 100) >= TOL) {
        toast.error(
          i18n.t("toast.routes_app_admin_courses.courseWeightsMustSum100", {
            defaultValue: "Los pesos del curso deben sumar 100% (suma actual: {{total}}%)",
            total: formatPercent(total),
          }),
        );
        return;
      }
    } else {
      // Con cortes: (a) la suma de cut.weight debe ser 100; (b) en cada
      // corte, los sub-pesos deben sumar exactamente cut.weight.
      const sumCuts = editingCuts.reduce((a, c) => a + Number(c.weight || 0), 0);
      if (Math.abs(sumCuts - 100) >= TOL) {
        toast.error(
          i18n.t("toast.routes_app_admin_courses.cutWeightsMustSum100", {
            defaultValue: "Los pesos de los cortes deben sumar 100% (suma actual: {{total}}%)",
            total: formatPercent(sumCuts),
          }),
        );
        return;
      }
      const offending: string[] = [];
      editingCuts.forEach((c, i) => {
        const subSum =
          Number(c.exam_weight || 0) +
          Number(c.workshop_weight || 0) +
          Number(c.attendance_weight || 0) +
          Number(c.project_weight || 0);
        const target = Number(c.weight || 0);
        if (Math.abs(subSum - target) >= TOL) {
          const label = c.name?.trim() || t("hc_routesAppAdminCourses.cutDefaultName", { n: i + 1 });
          offending.push(
            t("hc_routesAppAdminCourses.subWeightOffending", {
              label,
              sub: formatPercent(subSum),
              target: formatPercent(target),
            }),
          );
        }
      });
      if (offending.length > 0) {
        // Auto-expande los cortes con error para que el docente vea
        // los inputs sin tener que abrirlos uno por uno.
        const idxsWithError = editingCuts
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => {
            const subSum =
              Number(c.exam_weight || 0) +
              Number(c.workshop_weight || 0) +
              Number(c.attendance_weight || 0) +
              Number(c.project_weight || 0);
            return Math.abs(subSum - Number(c.weight || 0)) >= TOL;
          })
          .map(({ i }) => i);
        setExpandedCuts(new Set(idxsWithError));
        toast.error(
          i18n.t("toast.routes_app_admin_courses.subWeightsMismatch", {
            defaultValue: "Sub-pesos no cuadran con el peso del corte:\n{{details}}",
            details: offending.join("\n"),
          }),
        );
        return;
      }
    }
    // Si seleccionaron periodo del dropdown, denormalizamos el code al
    // campo legacy `period` (texto) para que queries antiguas sigan
    // funcionando. Si no hay period_id pero sí texto, respetamos el texto.
    const selectedPeriod = editing.period_id
      ? periods.find((p) => p.id === editing.period_id)
      : null;
    const periodText = selectedPeriod?.code ?? editing.period?.trim() ?? null;
    const payload = {
      name: editing.name,
      description: editing.description || null,
      period: periodText || null,
      // Opcionales: solo persistimos si tienen valor — null para limpiar.
      code: editing.code?.trim() || null,
      semestre: editing.semestre == null ? null : Number(editing.semestre),
      grupo: editing.grupo?.trim() || null,
      program_id: editing.program_id || null,
      subject_id: editing.subject_id || null,
      // Si hay period_id, denormalizamos el code al campo legacy `period`
      // para que las queries que aún lo usan no rompan. Si no hay
      // period_id pero sí period (texto editado a mano), respetamos el texto.
      period_id: editing.period_id || null,
      start_date: startInput || null,
      end_date: endInput || null,
      grade_scale_min: Number(editing.grade_scale_min ?? 0),
      grade_scale_max: Number(editing.grade_scale_max ?? 5),
      exam_weight: Number(editing.exam_weight ?? 40),
      workshop_weight: Number(editing.workshop_weight ?? 30),
      attendance_weight: Number(editing.attendance_weight ?? 10),
      project_weight: Number(editing.project_weight ?? 20),
      passing_grade: Number(editing.passing_grade ?? 3),
      max_exam_attempts: Math.max(1, Number(editing.max_exam_attempts ?? 1)),
    };
    let courseId = editing.id ?? "";
    // Cast a any: code/semestre/grupo recién agregados en la migración
    // 20260610000000; types.ts se regenera tras Publish en Lovable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any;
    if (editing.id) {
      const { error } = await db.from("courses").update(payload).eq("id", editing.id);
      if (error) return toast.error(friendlyError(error));
    } else {
      const { data: created, error } = await db
        .from("courses")
        .insert(payload)
        .select("id")
        .single();
      if (error || !created)
        return toast.error(friendlyError(error, t("hc_routesAppAdminCourses.errorCreatingCourse")));
      courseId = created.id as string;
    }

    // ── Persistencia de cortes evaluativos ──
    try {
      // 1) Eliminar cortes que estaban en la BD pero ya no en editingCuts.
      const currentIds = new Set(editingCuts.map((c) => c.id).filter(Boolean) as string[]);
      const toDelete = [...originalCutIds].filter((id) => !currentIds.has(id));
      if (toDelete.length) {
        // Borrar primero los items (no asumimos cascade en la FK).
        await db.from("grade_cut_items").delete().in("cut_id", toDelete);
        const { error: delErr } = await db.from("grade_cuts").delete().in("id", toDelete);
        if (delErr) throw delErr;
      }

      // 2) Actualizar/insertar el resto.
      for (let i = 0; i < editingCuts.length; i++) {
        const c = editingCuts[i];
        const cutPayload = {
          course_id: courseId,
          name: c.name?.trim() || t("hc_routesAppAdminCourses.cutDefaultName", { n: i + 1 }),
          position: i,
          start_date: c.start_date || null,
          end_date: c.end_date || null,
          weight: Number(c.weight || 0),
          exam_weight: Number(c.exam_weight || 0),
          workshop_weight: Number(c.workshop_weight || 0),
          attendance_weight: Number(c.attendance_weight || 0),
          project_weight: Number(c.project_weight || 0),
        };
        if (c.id) {
          const { error } = await db.from("grade_cuts").update(cutPayload).eq("id", c.id);
          if (error) throw error;
        } else {
          const { error } = await db.from("grade_cuts").insert(cutPayload);
          if (error) throw error;
        }
      }
    } catch (e) {
      // El throw que cae acá viene de las queries de grade_cuts arriba.
      // Si es unique_violation (dos cortes con el mismo nombre en el
      // mismo curso) lo traducimos al mensaje humano.
      const friendly = friendlyUniqueViolation(e);
      const msg = friendly ?? (e instanceof Error ? e.message : String(e));
      toast.error(
        i18n.t("toast.routes_app_admin_courses.courseSavedCutsSyncFailed", {
          defaultValue: "Curso guardado, pero falló la sincronización de cortes: {{error}}",
          error: msg,
        }),
      );
      setOpen(false);
      setEditing(null);
      setEditingCuts([]);
      setOriginalCutIds(new Set());
      load();
      return;
    }

    toast.success(
      i18n.t("toast.routes_app_admin_courses.courseSaved", {
        defaultValue: "Curso guardado correctamente",
      }),
    );
    void logEvent({
      action: editing?.id ? "course.updated" : "course.created",
      category: "course",
      actorRole: roles[0],
      entityType: "course",
      entityId: editing?.id,
      entityName: editing?.name,
    });
    setOpen(false);
    setEditing(null);
    setEditingCuts([]);
    setOriginalCutIds(new Set());
    load();
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: t("course.deleteTitle"),
      description: t("course.deleteBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const course = courses.find((c) => c.id === id);
    const { error } = await softDelete("courses", id);
    if (error) return toast.error(friendlyError(error));
    toast.success(t("course.deletedToast"));
    void logEvent({
      action: "course.deleted",
      category: "course",
      actorRole: roles[0],
      severity: "warning",
      entityType: "course",
      entityId: id,
      entityName: course?.name,
    });
    load();
  };

  // ── Transición de ciclo de vida del curso ────────────────
  // El estado se escribe SIEMPRE por el RPC set_course_status (no por el
  // UPDATE genérico de save()), así el form nunca cambia el estado en
  // silencio. La autorización fina (docente del curso / Admin del tenant)
  // la enforza el RPC server-side; el grid del docente ya lista solo sus
  // cursos, así que no hace falta un gate extra en cliente.
  const changeCourseStatus = async (course: Course, next: "borrador" | "en_curso" | "finalizado") => {
    const { error } = await db.rpc("set_course_status", {
      _course_id: course.id,
      _status: next,
    });
    if (error) return toast.error(friendlyError(error));
    toast.success(t("toast.routes_app_admin_courses.statusChanged"));
    void logEvent({
      action: "course.updated",
      category: "course",
      actorRole: roles[0],
      entityType: "course",
      entityId: course.id,
      entityName: course.name,
      metadata: { status: next },
    });
    load();
  };

  /** Publicar (borrador → en_curso). */
  const publishCourse = async (course: Course) => {
    const ok = await confirm({
      title: t("course.actionPublishConfirmTitle"),
      description: t("course.actionPublishConfirmBody"),
      confirmLabel: t("course.actionPublish"),
      tone: "default",
    });
    if (!ok) return;
    await changeCourseStatus(course, "en_curso");
  };

  /** Finalizar (en_curso → finalizado). */
  const finalizeCourse = async (course: Course) => {
    const ok = await confirm({
      title: t("course.actionFinalizeConfirmTitle"),
      description: t("course.actionFinalizeConfirmBody"),
      confirmLabel: t("course.actionFinalize"),
      tone: "warning",
    });
    if (!ok) return;
    await changeCourseStatus(course, "finalizado");
  };

  /** Reabrir (finalizado → en_curso). */
  const reopenCourse = async (course: Course) => {
    const ok = await confirm({
      title: t("course.actionReopenConfirmTitle"),
      description: t("course.actionReopenConfirmBody"),
      confirmLabel: t("course.actionReopen"),
      tone: "default",
    });
    if (!ok) return;
    await changeCourseStatus(course, "en_curso");
  };

  /** Mover a borrador (despublicar — caso raro). */
  const moveCourseToDraft = async (course: Course) => {
    const ok = await confirm({
      title: t("course.actionMoveToDraft"),
      description: t("course.actionPublishConfirmBody"),
      confirmLabel: t("course.actionMoveToDraft"),
      tone: "warning",
    });
    if (!ok) return;
    await changeCourseStatus(course, "borrador");
  };

  // ── Student Enrollment ───────────────────────────────────

  const openEnroll = async (c: Course) => {
    setEnrollCourse(c);
    const [{ data: profs }, { data: enr }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, institutional_email").order("full_name"),
      supabase.from("course_enrollments").select("user_id").eq("course_id", c.id),
    ]);
    setAllProfiles(profs ?? []);
    setEnrolledIds(new Set((enr ?? []).map((e: any) => e.user_id)));
    setEnrollOpen(true);
  };

  const toggleEnroll = async (uid: string, checked: boolean) => {
    if (!enrollCourse) return;
    if (checked) {
      const { error } = await supabase
        .from("course_enrollments")
        .upsert(
          { course_id: enrollCourse.id, user_id: uid },
          { onConflict: "course_id,user_id", ignoreDuplicates: true },
        );
      if (error) return toast.error(friendlyError(error));
      setEnrolledIds((prev) => new Set([...prev, uid]));
      toast.success(
        i18n.t("toast.routes_app_admin_courses.studentEnrolled", {
          defaultValue: "Estudiante matriculado correctamente",
        }),
      );
    } else {
      const { error } = await supabase
        .from("course_enrollments")
        .delete()
        .eq("course_id", enrollCourse.id)
        .eq("user_id", uid);
      if (error) return toast.error(friendlyError(error));
      setEnrolledIds((prev) => {
        const s = new Set(prev);
        s.delete(uid);
        return s;
      });
      toast.success(
        i18n.t("toast.routes_app_admin_courses.studentUnenrolled", {
          defaultValue: "Estudiante desmatriculado correctamente",
        }),
      );
    }
  };

  const enrollMany = async (visibleIds: string[]) => {
    if (!enrollCourse) return;
    const toAdd = visibleIds.filter((id) => !enrolledIds.has(id));
    if (!toAdd.length) return;
    const { error } = await supabase
      .from("course_enrollments")
      .insert(toAdd.map((id) => ({ course_id: enrollCourse.id, user_id: id })));
    if (error) return toast.error(friendlyError(error));
    setEnrolledIds((prev) => new Set([...prev, ...toAdd]));
    toast.success(
      i18n.t("toast.routes_app_admin_courses.studentsEnrolledMany", {
        defaultValue: "{{count}} estudiante(s) matriculados correctamente",
        count: toAdd.length,
      }),
    );
  };

  const unenrollMany = async (visibleIds: string[]) => {
    if (!enrollCourse) return;
    const toRemove = visibleIds.filter((id) => enrolledIds.has(id));
    if (!toRemove.length) return;
    for (const id of toRemove) {
      await supabase
        .from("course_enrollments")
        .delete()
        .eq("course_id", enrollCourse.id)
        .eq("user_id", id);
    }
    setEnrolledIds((prev) => {
      const s = new Set(prev);
      toRemove.forEach((id) => s.delete(id));
      return s;
    });
    toast.success(
      i18n.t("toast.routes_app_admin_courses.studentsUnenrolledMany", {
        defaultValue: "{{count}} estudiante(s) desmatriculados correctamente",
        count: toRemove.length,
      }),
    );
  };

  // ── Teacher Assignment ───────────────────────────────────

  const openTeachers = async (c: Course) => {
    setTeacherCourse(c);
    // Get all users with Docente role
    const { data: roleRows } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "Docente");
    const teacherIds = (roleRows ?? []).map((r: any) => r.user_id);
    if (teacherIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", teacherIds)
        .order("full_name");
      setTeachers((profs ?? []) as Profile[]);
    } else {
      setTeachers([]);
    }
    const { data: assigned } = await supabase
      .from("course_teachers")
      .select("user_id")
      .eq("course_id", c.id);
    setAssignedTeacherIds(new Set((assigned ?? []).map((a: any) => a.user_id)));
    setTeacherOpen(true);
  };

  const toggleTeacher = async (uid: string, checked: boolean) => {
    if (!teacherCourse) return;
    if (checked) {
      const { error } = await supabase
        .from("course_teachers")
        .insert({ course_id: teacherCourse.id, user_id: uid });
      if (error) return toast.error(friendlyError(error));
      setAssignedTeacherIds((prev) => new Set([...prev, uid]));
      toast.success(
        i18n.t("toast.routes_app_admin_courses.teacherAssigned", {
          defaultValue: "Docente asignado correctamente",
        }),
      );
    } else {
      const { error } = await supabase
        .from("course_teachers")
        .delete()
        .eq("course_id", teacherCourse.id)
        .eq("user_id", uid);
      if (error) return toast.error(friendlyError(error));
      setAssignedTeacherIds((prev) => {
        const s = new Set(prev);
        s.delete(uid);
        return s;
      });
      toast.success(
        i18n.t("toast.routes_app_admin_courses.teacherUnassigned", {
          defaultValue: "Docente desasignado correctamente",
        }),
      );
    }
  };

  const assignTeachersMany = async (visibleIds: string[]) => {
    if (!teacherCourse) return;
    const toAdd = visibleIds.filter((id) => !assignedTeacherIds.has(id));
    if (!toAdd.length) return;
    const { error } = await supabase
      .from("course_teachers")
      .insert(toAdd.map((id) => ({ course_id: teacherCourse.id, user_id: id })));
    if (error) return toast.error(friendlyError(error));
    setAssignedTeacherIds((prev) => new Set([...prev, ...toAdd]));
    toast.success(
      i18n.t("toast.routes_app_admin_courses.teachersAssignedMany", {
        defaultValue: "{{count}} docente(s) asignados correctamente",
        count: toAdd.length,
      }),
    );
  };

  const unassignTeachersMany = async (visibleIds: string[]) => {
    if (!teacherCourse) return;
    const toRemove = visibleIds.filter((id) => assignedTeacherIds.has(id));
    if (!toRemove.length) return;
    for (const id of toRemove) {
      await supabase
        .from("course_teachers")
        .delete()
        .eq("course_id", teacherCourse.id)
        .eq("user_id", id);
    }
    setAssignedTeacherIds((prev) => {
      const s = new Set(prev);
      toRemove.forEach((id) => s.delete(id));
      return s;
    });
    toast.success(
      i18n.t("toast.routes_app_admin_courses.teachersUnassignedMany", {
        defaultValue: "{{count}} docente(s) desasignados correctamente",
        count: toRemove.length,
      }),
    );
  };

  // ── Duplicate Course ─────────────────────────────────────

  const openDuplicate = (c: Course) => {
    setDupSource(c);
    setDupName(`${c.name} (copia)`);
    setDupPeriod(c.period ?? "");
    setDupCopyExams(true);
    setDupCopyWorkshops(true);
    setDupCopyBoard(true);
    setDupCopyStudents(true);
    setDupCopyTeachers(false); // opt-in
    setDupOpen(true);
  };

  const doDuplicate = async () => {
    if (!dupSource || !dupName.trim()) {
      toast.error(
        i18n.t("toast.routes_app_admin_courses.duplicateNameRequired", {
          defaultValue: "Nombre requerido",
        }),
      );
      return;
    }
    setDupLoading(true);
    let copiedStudents = 0;
    try {
      // 1. Create new course — usar `db` (cast a any) porque el trigger
      // `tg_courses_set_tenant_on_insert` autoasigna `tenant_id` desde
      // `current_tenant_id()`, pero los types generados de Supabase lo
      // marcan como required en el INSERT type.
      const { data: newCourse, error: cErr } = await db
        .from("courses")
        .insert({
          name: dupName,
          description: dupSource.description,
          period: dupPeriod || null,
          start_date: toDateInput(dupSource.start_date) || null,
          end_date: toDateInput(dupSource.end_date) || null,
          grade_scale_min: dupSource.grade_scale_min,
          grade_scale_max: dupSource.grade_scale_max,
          passing_grade: dupSource.passing_grade,
          exam_weight: dupSource.exam_weight,
          workshop_weight: dupSource.workshop_weight,
          attendance_weight: dupSource.attendance_weight,
          project_weight: dupSource.project_weight ?? 0,
          max_exam_attempts: dupSource.max_exam_attempts ?? 1,
        })
        .select()
        .single();
      if (cErr || !newCourse)
        throw new Error(cErr?.message ?? t("hc_routesAppAdminCourses.errorCreatingCourse"));

      // 2. Copy students (CRÍTICO: replicar todas las matrículas)
      if (dupCopyStudents) {
        const { data: enr, error: enrErr } = await supabase
          .from("course_enrollments")
          .select("user_id")
          .eq("course_id", dupSource.id);
        if (enrErr) console.error("read enrollments:", enrErr);
        if (enr?.length) {
          const rows = enr.map((e: any) => ({ course_id: newCourse.id, user_id: e.user_id }));
          // upsert con ignoreDuplicates evita 23505 si el doble-click
          // del admin (o un retry post-error) re-corre la copia.
          // UNIQUE constraint en (course_id, user_id) — sin upsert, el
          // 2do intento abortaba TODA la copia dejando el curso destino
          // con 0 alumnos.
          const { error: insErr, count } = await supabase
            .from("course_enrollments")
            .upsert(rows, {
              onConflict: "course_id,user_id",
              ignoreDuplicates: true,
              count: "exact",
            });
          if (insErr) {
            console.error("copy enrollments:", insErr);
            toast.error(
              i18n.t("toast.routes_app_admin_courses.copyEnrollmentsFailed", {
                defaultValue: "No se pudieron copiar las matrículas: {{error}}",
                error: friendlyError(insErr),
              }),
            );
          } else {
            copiedStudents = count ?? rows.length;
          }
        }
      }

      // 3. Copy teachers (opt-in)
      if (dupCopyTeachers) {
        const { data: ct } = await supabase
          .from("course_teachers")
          .select("user_id")
          .eq("course_id", dupSource.id);
        if (ct?.length) {
          // upsert ignoreDuplicates — mismo motivo que enrollments.
          await supabase
            .from("course_teachers")
            .upsert(
              ct.map((t: any) => ({ course_id: newCourse.id, user_id: t.user_id })),
              { onConflict: "course_id,user_id", ignoreDuplicates: true },
            );
        }
      }

      // 4. Copy exams (without submissions/assignments)
      if (dupCopyExams) {
        const { data: exams } = await supabase
          .from("exams")
          .select("*")
          .eq("course_id", dupSource.id)
          .is("deleted_at", null);
        for (const exam of exams ?? []) {
          const { data: newExam } = await supabase
            .from("exams")
            .insert({
              course_id: newCourse.id,
              created_by: exam.created_by,
              title: exam.title,
              description: exam.description,
              start_time: exam.start_time,
              end_time: exam.end_time,
              time_limit_minutes: exam.time_limit_minutes,
              navigation_type: exam.navigation_type,
              shuffle_enabled: exam.shuffle_enabled,
              max_attempts: (exam as any).max_attempts ?? null,
            })
            .select()
            .single();
          if (newExam) {
            // Copy questions
            const { data: qs } = await supabase
              .from("questions")
              .select("*")
              .eq("exam_id", exam.id);
            if (qs?.length) {
              await supabase.from("questions").insert(
                qs.map((q: any) => ({
                  exam_id: newExam.id,
                  type: q.type,
                  content: q.content,
                  expected_rubric: q.expected_rubric,
                  options: q.options,
                  points: q.points,
                  position: q.position,
                  language: q.language,
                  starter_code: q.starter_code,
                  test_cases: q.test_cases,
                })),
              );
            }
          }
        }
      }

      // 5. Copy workshops (without submissions/assignments)
      if (dupCopyWorkshops) {
        const { data: ws } = await supabase
          .from("workshops")
          .select("*")
          .eq("course_id", dupSource.id)
          .is("deleted_at", null);
        if (ws?.length) {
          await supabase.from("workshops").insert(
            ws.map((w: any) => ({
              course_id: newCourse.id,
              created_by: w.created_by,
              title: w.title,
              description: w.description,
              instructions: w.instructions,
              external_link: w.external_link,
              due_date: w.due_date,
              rubric: w.rubric,
              max_score: w.max_score,
              status: "draft",
            })),
          );
        }
      }

      // 6. Copy board (sesiones del cronograma). Copiamos la ESTRUCTURA:
      // fecha, hora, duración, título y enlace de reunión. NO copiamos
      // content_id/content_class_index (los contenidos pertenecen al curso
      // origen y no se duplican acá) ni recording_url/notes_url (son de la
      // instancia puntual de la clase). El docente reasigna contenido en el
      // curso nuevo. Excluimos las sesiones en papelera (deleted_at).
      if (dupCopyBoard) {
        const { data: sess } = await supabase
          .from("attendance_sessions")
          .select("session_date, start_time, duration_minutes, title, meeting_url")
          .eq("course_id", dupSource.id)
          .is("deleted_at", null)
          .order("session_date", { ascending: true });
        if (sess?.length) {
          const { error: sErr } = await db.from("attendance_sessions").insert(
            (sess as any[]).map((s) => ({
              course_id: newCourse.id,
              session_date: s.session_date,
              start_time: s.start_time,
              duration_minutes: s.duration_minutes,
              title: s.title,
              meeting_url: s.meeting_url,
              created_by: user?.id ?? null,
            })),
          );
          if (sErr) {
            console.error("copy board sessions:", sErr);
            toast.error(
              i18n.t("toast.routes_app_admin_courses.copyBoardFailed", {
                defaultValue: "No se pudo copiar el tablero: {{error}}",
                error: friendlyError(sErr),
              }),
            );
          }
        }
      }

      const studentsMsg = dupCopyStudents
        ? i18n.t("toast.routes_app_admin_courses.duplicateStudentsSuffix", {
            defaultValue: " ({{count}} estudiante(s) copiado(s))",
            count: copiedStudents,
          })
        : "";
      toast.success(
        i18n.t("toast.routes_app_admin_courses.courseDuplicated", {
          defaultValue: "Curso duplicado correctamente{{suffix}}",
          suffix: studentsMsg,
        }),
      );
      setDupOpen(false);
      load();
    } catch (e: any) {
      toast.error(friendlyError(e, t("hc_routesAppAdminCourses.errorDuplicating")));
    } finally {
      setDupLoading(false);
    }
  };

  if (!canManage)
    return (
      <p className="text-muted-foreground">{t("hc_routesAppAdminCourses.needAdminOrTeacherRole")}</p>
    );

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<BookOpen className="h-6 w-6" />}
          title={t("hc_routesAppAdminCourses.coursesTitle")}
        />
        <ErrorState
          message={t("hc_routesAppAdminCourses.loadErrorTitle")}
          hint={loadError}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<BookOpen className="h-6 w-6" />}
        title={t("hc_routesAppAdminCourses.coursesTitle")}
        subtitle={
          search.trim()
            ? t("hc_routesAppAdminCourses.subtitleFiltered", {
                shown: filteredCourses.length,
                total: courses.length,
              })
            : t("hc_routesAppAdminCourses.subtitleRegistered", { count: courses.length })
        }
        actions={
          <>
            <ImportExportMenu
              resourceName={t("hc_routesAppAdminCourses.resourceCourses")}
              onExport={exportCoursesCsv}
            />
            <Button size="sm" onClick={openNew} data-tour-id="create-course">
              <Plus className="h-4 w-4 mr-1" /> {t("hc_routesAppAdminCourses.newCourse")}
            </Button>
          </>
        }
      />

      {/* Stats — ahora 5 cards (se agregó Borrador con el ciclo de vida
          explícito del curso). En mobile 2 columnas, desde md 5. El gate
          `courses.length > 0` se mantiene quitado: un 0 es informativo. */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard
          icon={BookOpen}
          label={t("hc_routesAppAdminCourses.statTotal")}
          value={coursesSummary.total}
        />
        <StatCard
          icon={FileText}
          label={t("hc_routesAppAdminCourses.statDraft")}
          value={coursesSummary.draft}
        />
        <StatCard
          icon={CalendarRange}
          label={t("hc_routesAppAdminCourses.statActive")}
          value={coursesSummary.active}
          tone={coursesSummary.active > 0 ? "success" : "default"}
        />
        <StatCard
          icon={CalendarClock}
          label={t("hc_routesAppAdminCourses.statUpcoming")}
          value={coursesSummary.upcoming}
        />
        <StatCard
          icon={Archive}
          label={t("hc_routesAppAdminCourses.statFinalized")}
          value={coursesSummary.finalized}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t("hc_routesAppAdminCourses.searchPlaceholder")}
          />
        </div>
        {/* Filtro por estado del curso. Default "en_curso" (lo vigente);
            el usuario abre "Todos" o un estado puntual cuando lo necesita.
            Opera sobre el estado de DISPLAY derivado (incluye "proximo"). */}
        <Select value={statusFilterUi} onValueChange={setStatusFilterUi}>
          <SelectTrigger className="w-full sm:w-44 h-9 text-xs">
            <SelectValue placeholder={t("hc_routesAppAdminCourses.statusFilterPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("hc_routesAppAdminCourses.statusFilterAll")}</SelectItem>
            <SelectItem value="en_curso">{t("hc_routesAppAdminCourses.statusFilterActive")}</SelectItem>
            <SelectItem value="proximo">{t("hc_routesAppAdminCourses.statusFilterUpcoming")}</SelectItem>
            <SelectItem value="borrador">{t("hc_routesAppAdminCourses.statusFilterDraft")}</SelectItem>
            <SelectItem value="finalizado">{t("hc_routesAppAdminCourses.statusFilterFinalized")}</SelectItem>
          </SelectContent>
        </Select>
        {/* Filtro de institución (solo SuperAdmin con >1 tenant visible).
            Antes /app/admin/courses no tenía filtro funcional por tenant
            — el SuperAdmin veía cursos cross-tenant sin poder acotar a
            una institución específica. Ahora aplica .eq('tenant_id', X)
            a la query principal. */}
        {/* Gate `> 0` (no `> 1`): el filtro queda visible siempre que el
            SuperAdmin tenga al menos una institución cargada, consistente
            con Usuarios/Errores/Cola/Certificados/Auditoría. */}
        {isSuperAdminCaller && tenants.length > 0 && (
          <Select value={tenantFilter} onValueChange={setTenantFilter}>
            {/* En mobile: w-full para que después del wrap ocupe todo el
                ancho disponible (sin un dropdown chiquito a la izquierda
                y whitespace a la derecha). Desde sm: ancho fijo 192px
                pegado al search. Mismo patrón que app.admin.users.tsx. */}
            <SelectTrigger className="w-full sm:w-48 h-9 text-xs">
              <SelectValue placeholder={t("tenant.filterTenantPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("tenant.filterAllTenants")}</SelectItem>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/* Filtros académicos: Programa + Asignatura.
            - Programa: filtra cursos cuyo program_id matchee.
            - Asignatura: filtra cursos cuyo subject_id matchee. La lista
              se acota al programa elegido para no abrumar.
            Solo se renderizan si la institución tiene programas / asigna-
            turas cargados (para tenants sin estructura académica
            todavía, no hay nada que filtrar). */}
        {programs.length > 0 && (
          <Select
            value={programFilterUi}
            onValueChange={(v) => {
              setProgramFilterUi(v);
              // Si cambia el programa, limpiamos la asignatura cuando no
              // pertenece al nuevo programa — evita estados inconsistentes
              // (Programa=A, Asignatura=de-otro-programa).
              if (v !== "all") {
                const subj = subjects.find((s) => s.id === subjectFilterUi);
                if (subj && subj.program_id && subj.program_id !== v) {
                  setSubjectFilterUi("all");
                }
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-48 h-9 text-xs">
              <SelectValue placeholder={t("hc_routesAppAdminCourses.allPrograms")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("hc_routesAppAdminCourses.allPrograms")}</SelectItem>
              {programs.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {subjects.length > 0 && (
          <Select value={subjectFilterUi} onValueChange={setSubjectFilterUi}>
            <SelectTrigger className="w-full sm:w-48 h-9 text-xs">
              <SelectValue placeholder={t("hc_routesAppAdminCourses.allSubjects")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("hc_routesAppAdminCourses.allSubjects")}</SelectItem>
              {subjects
                .filter(
                  (s) =>
                    programFilterUi === "all" || !s.program_id || s.program_id === programFilterUi,
                )
                .map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                    {s.code ? ` (${s.code})` : ""}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        )}
        {/* Periodo: filtra cursos cuyo period_id matchee. Solo si la
            institución tiene periodos cargados. */}
        {periods.length > 0 && (
          <Select value={periodFilterUi} onValueChange={setPeriodFilterUi}>
            <SelectTrigger className="w-full sm:w-48 h-9 text-xs">
              <SelectValue placeholder={t("hc_routesAppAdminCourses.allPeriods", { defaultValue: "Todos los periodos" })} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("hc_routesAppAdminCourses.allPeriods", { defaultValue: "Todos los periodos" })}
              </SelectItem>
              {periods.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name ?? p.code}
                  {p.name && p.code ? ` (${p.code})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular={t("hc_routesAppAdminCourses.entityCourseSingular")}
        entityNamePlural={t("hc_routesAppAdminCourses.entityCoursePlural")}
      />

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {/* table-fixed via `fixed`: las columnas respetan los anchos
              de los TableHead (definidos por las clases `w-X`). Sin
              esto, un nombre/descripción largos expanden la tabla y
              empujan acciones fuera de pantalla. */}
          <Table fixed resizable>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <MultiSelectHeaderCheckbox state={sel} />
                </TableHead>
                <SortableHead sortKey="name" sort={sort} className="max-w-[320px]">
                  {t("common.name")}
                </SortableHead>
                <SortableHead sortKey="period" sort={sort} className="hidden sm:table-cell w-32">
                  {t("common.period")}
                </SortableHead>
                <SortableHead sortKey="status" sort={sort} className="hidden sm:table-cell w-28">
                  {t("hc_routesAppAdminCourses.statusColumn")}
                </SortableHead>
                <SortableHead sortKey="scale" sort={sort} className="hidden sm:table-cell w-24">
                  {t("common.scale")}
                </SortableHead>
                <SortableHead sortKey="start_date" sort={sort} className="hidden md:table-cell w-28">
                  {t("common.start")}
                </SortableHead>
                <SortableHead sortKey="end_date" sort={sort} className="hidden md:table-cell w-28">
                  {t("common.end")}
                </SortableHead>
                <SortableHead
                  sortKey="activity"
                  sort={sort}
                  className="hidden lg:table-cell w-44"
                  title={t("hc_routesAppAdminCourses.activityColumnTitle")}
                >
                  {t("hc_routesAppAdminCourses.activityColumn")}
                </SortableHead>
                <TableHead className="text-right w-28">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCourses.length === 0 &&
                (() => {
                  // "Filtros activos" incluye el nuevo default de estado:
                  // si hay cursos pero NINGUNO está "en_curso" (el default),
                  // el listado sale vacío con texto accionable ("prueba el
                  // filtro Todos") en vez del empty-state de "crea tu primer
                  // curso", que confundiría (el curso existe, solo está
                  // finalizado/borrador). search.trim(), statusFilterUi y los
                  // filtros académicos cuentan como filtro activo.
                  const hasActiveFilters =
                    !!search.trim() ||
                    statusFilterUi !== "all" ||
                    programFilterUi !== "all" ||
                    subjectFilterUi !== "all" ||
                    periodFilterUi !== "all";
                  const filteredEmpty = hasActiveFilters && courses.length > 0;
                  return (
                    <TableEmpty
                      colSpan={9}
                      icon={BookOpen}
                      text={
                        filteredEmpty
                          ? t("hc_routesAppAdminCourses.noMatches")
                          : t("course.emptyTitle")
                      }
                      hint={
                        filteredEmpty
                          ? t("hc_routesAppAdminCourses.noMatchesHint")
                          : t("course.emptyHint")
                      }
                      action={
                        filteredEmpty ? undefined : (
                          <Button size="sm" onClick={openNew}>
                            <Plus className="h-4 w-4 mr-1" />
                            {t("course.createFirst")}
                          </Button>
                        )
                      }
                    />
                  );
                })()}
              {pagination.paginatedItems.map((c) => (
                <TableRow key={c.id} data-state={sel.isSelected(c.id) ? "selected" : undefined}>
                  <TableCell className="w-10">
                    <MultiSelectCheckbox id={c.id} state={sel} />
                  </TableCell>
                  <TableCell className="font-medium">
                    {/* Wrapper truncate: con table-fixed el cell respeta
                        el ancho de su columna, pero solo si el contenido
                        usa truncate. min-w-0 permite el shrinking dentro
                        del flex-col. La descripción se queda en el title
                        del span para que se vea al pasar el mouse — la
                        columna dedicada se reemplazó por Actividad. */}
                    <div className="flex flex-col gap-1 min-w-0">
                      <span
                        className="truncate"
                        title={c.description ? `${c.name}\n\n${c.description}` : c.name}
                      >
                        {c.name}
                      </span>
                      <div className="flex flex-wrap items-center gap-1 sm:hidden">
                        {c.period && (
                          <Badge variant="outline" className="text-[10px] w-fit">
                            {c.period}
                          </Badge>
                        )}
                        {/* En mobile el estado se ve acá (la columna Estado
                            está oculta en <sm). */}
                        <StatusBadge status={deriveCourseDisplayState(c, Date.now())} />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {c.period ? (
                      <Badge variant="outline" className="text-xs">
                        {c.period}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <StatusBadge status={deriveCourseDisplayState(c, Date.now())} />
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="text-xs tabular-nums">
                      <span className="font-medium">
                        {c.grade_scale_min}–{c.grade_scale_max}
                      </span>
                      <span className="text-muted-foreground ml-1">(≥{c.passing_grade})</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <DateCell value={c.start_date} variant="auto" />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">
                    <DateCell value={c.end_date} variant="auto" />
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {/* Stats por curso: estudiantes, docentes, items totales.
                        Permite al admin saber qué cursos son los más
                        cargados sin tener que entrar uno a uno. Si las
                        stats aún no cargaron (o fallaron), mostramos "—". */}
                    {(() => {
                      const s = courseStats.get(c.id);
                      if (!s) {
                        return <span className="text-muted-foreground text-xs">—</span>;
                      }
                      const items = s.exams + s.workshops + s.projects;
                      return (
                        <div className="flex items-center gap-2 text-xs tabular-nums">
                          <span
                            className="inline-flex items-center gap-0.5 text-muted-foreground"
                            title={t("hc_routesAppAdminCourses.activityStudentsTitle", {
                              count: s.students,
                            })}
                          >
                            <Users className="h-3 w-3" />
                            <span className="font-medium text-foreground">{s.students}</span>
                          </span>
                          <span
                            className="inline-flex items-center gap-0.5 text-muted-foreground"
                            title={t("hc_routesAppAdminCourses.activityTeachersTitle", {
                              count: s.teachers,
                            })}
                          >
                            <UserCog className="h-3 w-3" />
                            <span className="font-medium text-foreground">{s.teachers}</span>
                          </span>
                          <span
                            className="inline-flex items-center gap-0.5 text-muted-foreground"
                            title={t("hc_routesAppAdminCourses.activityItemsTitle", {
                              items,
                              exams: s.exams,
                              workshops: s.workshops,
                              projects: s.projects,
                            })}
                          >
                            <FileText className="h-3 w-3" />
                            <span className="font-medium text-foreground">{items}</span>
                          </span>
                        </div>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="text-right">
                    <RowActionsMenu
                      actions={[
                        {
                          // Tablero del curso — ahora PÁGINA completa (antes
                          // modal). La ruta es compartida Docente/Admin/SA
                          // (excepción RBAC en src/shared/lib/rbac.ts).
                          label: t("course.boardShort"),
                          icon: CalendarRange,
                          to: "/app/teacher/board/$courseId",
                          params: { courseId: c.id },
                        },
                        {
                          label: t("hc_routesAppAdminCourses.actionForum"),
                          icon: MessageSquareText,
                          to: "/app/forum/$courseId",
                          params: { courseId: c.id },
                        },
                        {
                          label: t("course.students"),
                          icon: Users,
                          onClick: () => openEnroll(c),
                        },
                        {
                          label: t("course.teachers"),
                          icon: UserCog,
                          onClick: () => openTeachers(c),
                        },
                        {
                          label: t("common.duplicate"),
                          icon: Copy,
                          onClick: () => openDuplicate(c),
                        },
                        {
                          label: t("hc_routesAppAdminCourses.actionCertifications"),
                          icon: Award,
                          onClick: () => setCertForCourse(c),
                        },
                        {
                          // Editor de horario semanal (días + horas + aula
                          // + modalidad). Dialog separado para no
                          // sobrecargar el form principal del curso.
                          label: t("hc_routesAppAdminCourses.actionSchedule"),
                          icon: CalendarClock,
                          onClick: () => setScheduleForCourse(c),
                        },
                        {
                          // Diagnóstico del curso — escaneo de calificaciones
                          // pendientes, errores IA, conversaciones abiertas
                          // y asistencia, con acciones de remediación.
                          label: t("hc_routesAppAdminCourses.actionDiagnostic", {
                            defaultValue: "Diagnóstico del curso",
                          }),
                          icon: Stethoscope,
                          iconColor: "var(--brand-primary)",
                          onClick: () => setDiagnosticForCourse(c),
                          separatorBefore: true,
                        },
                        // ── Transiciones de ciclo de vida ──
                        // Solo la transición relevante por estado se renderiza
                        // (RowActionsMenu filtra los items nullish). Gateamos
                        // por el `status` PERSISTIDO (null legacy = en_curso),
                        // no por el display: un curso 'proximo' sigue siendo
                        // status='en_curso' y debe poder finalizarse.
                        (c.status ?? "en_curso") === "borrador" && {
                          label: t("course.actionPublish"),
                          icon: Play,
                          onClick: () => publishCourse(c),
                          separatorBefore: true,
                        },
                        (c.status ?? "en_curso") === "en_curso" && {
                          label: t("course.actionFinalize"),
                          icon: CheckCircle2,
                          onClick: () => finalizeCourse(c),
                          separatorBefore: true,
                        },
                        c.status === "finalizado" && {
                          label: t("course.actionReopen"),
                          icon: RefreshCw,
                          onClick: () => reopenCourse(c),
                          separatorBefore: true,
                        },
                        c.status === "finalizado" && {
                          label: t("course.actionMoveToDraft"),
                          icon: Pencil,
                          onClick: () => moveCourseToDraft(c),
                        },
                        { label: t("common.edit"), icon: Pencil, onClick: () => openEdit(c) },
                        {
                          label: t("common.delete"),
                          icon: Trash2,
                          tone: "destructive",
                          separatorBefore: true,
                          onClick: () => remove(c.id),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DataPagination
            state={pagination}
            entityNamePlural={t("hc_routesAppAdminCourses.entityCoursePlural")}
          />
        </CardContent>
      </Card>

      {/* ── Create/Edit Dialog ── */}
      <Dialog open={open} onOpenChange={courseDirty.guardOpenChange(setOpen)}>
        <DialogContent
          className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] overflow-y-auto"
          data-tour-id="dialog-course"
        >
          <DialogHeader>
            <DialogTitle>
              {editing?.id
                ? t("hc_routesAppAdminCourses.dialogEditCourse")
                : t("hc_routesAppAdminCourses.dialogNewCourse")}
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div data-tour-id="course-field-name">
                <Label required>{t("hc_routesAppAdminCourses.fieldName")}</Label>
                <Input
                  value={editing.name ?? ""}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder={t("hc_routesAppAdminCourses.placeholderName")}
                />
              </div>
              {/* Periodo académico — si el admin mantiene la lista
                  centralizada (Configuración → Académico) el docente
                  selecciona del dropdown. El campo `period` (texto) se
                  rellena automáticamente con el code del periodo para
                  preservar compat con queries y display existentes.
                  Si NO hay periodos definidos todavía, el dropdown está
                  vacío y el admin puede igual escribir el texto en
                  "Periodo (texto libre)" abajo. */}
              <div data-tour-id="course-field-period">
                <Label required>{t("hc_routesAppAdminCourses.fieldAcademicPeriod")}</Label>
                <Select
                  value={editing.period_id ?? "__manual__"}
                  onValueChange={(v) =>
                    setEditing({
                      ...editing,
                      period_id: v === "__manual__" ? null : v,
                      // Si seleccionan un periodo del dropdown, sincroniza
                      // el campo de texto para reflejar el code.
                      period:
                        v === "__manual__"
                          ? editing.period
                          : (periods.find((p) => p.id === v)?.code ?? editing.period),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("hc_routesAppAdminCourses.selectPeriodPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__manual__">
                      {t("hc_routesAppAdminCourses.periodFreeTextOption")}
                    </SelectItem>
                    {periods.map((p) => (
                      <SelectItem key={p.id} value={p.id} disabled={p.status === "cerrado"}>
                        {p.code}
                        {p.name ? ` — ${p.name}` : ""}
                        {p.status === "cerrado"
                          ? ` ${t("hc_routesAppAdminCourses.periodClosedSuffix")}`
                          : ""}
                        {p.status === "planificado"
                          ? ` ${t("hc_routesAppAdminCourses.periodPlannedSuffix")}`
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!editing.period_id && (
                  <Input
                    className="mt-2"
                    value={editing.period ?? ""}
                    onChange={(e) => setEditing({ ...editing, period: e.target.value })}
                    placeholder={t("hc_routesAppAdminCourses.placeholderPeriodFreeText")}
                  />
                )}
              </div>
              {/* Programa / Nivel. Funciona como FILTRO de la lista de
                  asignaturas: cuando hay programa elegido, el siguiente
                  select solo muestra las asignaturas pertenecientes a
                  ESE programa — útil cuando la institución tiene
                  decenas de asignaturas cross-program y el admin
                  necesita acotar. Si dejás "Todos los programas", la
                  lista de asignaturas muestra todas.
                  La fuente de verdad sobre el programa del curso sigue
                  siendo la asignatura (program_id del curso se setea
                  desde subj.program_id al elegir); este field es
                  PURAMENTE un filtro de la UI. */}
              <div>
                <Label>{t("hc_routesAppAdminCourses.fieldProgramLevel")}</Label>
                <Select
                  value={editing.program_id ?? "__none__"}
                  onValueChange={(v) => {
                    const nextProgramId = v === "__none__" ? null : v;
                    // Si la asignatura actualmente elegida NO pertenece
                    // al nuevo programa, deseleccionamos la asignatura
                    // (queda en blanco). Esto evita estados inconsistentes
                    // donde Programa=A pero Asignatura=B(A's subject) tras
                    // cambiar a Programa B.
                    const currentSubj = subjects.find((s) => s.id === editing.subject_id);
                    const subjectStillValid =
                      !nextProgramId ||
                      !currentSubj?.program_id ||
                      currentSubj.program_id === nextProgramId;
                    setEditing({
                      ...editing,
                      program_id: nextProgramId,
                      subject_id: subjectStillValid ? editing.subject_id : null,
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("hc_routesAppAdminCourses.allPrograms")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">{t("hc_routesAppAdminCourses.allPrograms")}</SelectItem>
                    {programs.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* Asignatura del plan. La asignatura es la FUENTE DE VERDAD
                  para programa + semestre del curso: al elegirla, ambos
                  se heredan automáticamente — el form no pide grado/
                  semestre como input separado. Filtrada por el programa
                  seleccionado arriba (si no hay programa → todas). */}
              <div data-tour-id="course-field-subject">
                <Label>{t("hc_routesAppAdminCourses.fieldPlanSubject")}</Label>
                <Select
                  value={editing.subject_id ?? "__none__"}
                  onValueChange={(v) => {
                    if (v === "__none__") {
                      // Al limpiar la asignatura NO tocamos program_id:
                      // el admin puede dejar el filtro Programa elegido
                      // para luego elegir otra del mismo programa. La escala
                      // vuelve al default de la institución (sin asignatura).
                      setEditing({
                        ...editing,
                        subject_id: null,
                        semestre: null,
                        grade_scale_min: defaultScale.min,
                        grade_scale_max: defaultScale.max,
                      });
                      return;
                    }
                    const subj = subjects.find((s) => s.id === v);
                    const ev = subj?.sistema_evaluacion ?? {};
                    setEditing({
                      ...editing,
                      subject_id: v,
                      // Heredamos siempre desde la asignatura — incluso
                      // si el admin tenía otro program_id como filtro,
                      // gana el de la asignatura elegida.
                      program_id: subj?.program_id ?? editing.program_id ?? null,
                      // Semestre derivado: viene de la asignatura, no
                      // se pide como input.
                      semestre: subj?.semestre ?? null,
                      // Escala: hereda de la asignatura si la definió; si no,
                      // el default de la institución. Sobrescribible.
                      grade_scale_min: Number(ev.grade_scale_min ?? defaultScale.min),
                      grade_scale_max: Number(ev.grade_scale_max ?? defaultScale.max),
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("hc_routesAppAdminCourses.noSubjectAssociated")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">
                      {t("hc_routesAppAdminCourses.noSubjectAssociated")}
                    </SelectItem>
                    {subjects
                      .filter(
                        (s) =>
                          // Filtro por programa seleccionado: si hay uno,
                          // solo asignaturas de ese programa (o sin
                          // programa fijo, por defensa).
                          !editing.program_id ||
                          !s.program_id ||
                          s.program_id === editing.program_id,
                      )
                      .map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                          {s.code ? ` (${s.code})` : ""}
                          {s.semestre
                            ? ` ${t("hc_routesAppAdminCourses.subjectSemesterSuffix", { n: s.semestre })}`
                            : ""}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {/* Confirmación visual de qué se está heredando. Se
                    muestra el semestre de la asignatura (que es lo
                    que reemplaza al input "Grado / Semestre" que tenía
                    el form antes). */}
                {(() => {
                  const subj = subjects.find((s) => s.id === editing.subject_id);
                  if (!subj) return null;
                  const parts: string[] = [];
                  if (subj.program_id) {
                    const prog = programs.find((p) => p.id === subj.program_id);
                    if (prog)
                      parts.push(t("hc_routesAppAdminCourses.inheritedProgram", { name: prog.name }));
                  }
                  if (subj.semestre)
                    parts.push(
                      t("hc_routesAppAdminCourses.inheritedSemester", { n: subj.semestre }),
                    );
                  if (parts.length === 0) return null;
                  return (
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {t("hc_routesAppAdminCourses.inheritedFromSubject", {
                        parts: parts.join(" · "),
                      })}
                    </p>
                  );
                })()}
              </div>
              {/* Campos opcionales para los headers de los informes
                  institucionales (Diagnóstico, Acuerdo Pedagógico).
                  El "Grado / Semestre" se removió: se deriva de la
                  asignatura del plan (subj.semestre) y NO se pide como
                  input separado para evitar inconsistencias. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>{t("hc_routesAppAdminCourses.fieldCode")}</Label>
                  <Input
                    value={editing.code ?? ""}
                    onChange={(e) => setEditing({ ...editing, code: e.target.value || null })}
                    placeholder={t("hc_routesAppAdminCourses.placeholderCode")}
                  />
                </div>
                <div>
                  <Label>{t("hc_routesAppAdminCourses.fieldGroup")}</Label>
                  <Input
                    value={editing.grupo ?? ""}
                    onChange={(e) => setEditing({ ...editing, grupo: e.target.value || null })}
                    placeholder={t("hc_routesAppAdminCourses.placeholderGroup")}
                  />
                </div>
              </div>
              <div
                className="grid grid-cols-1 sm:grid-cols-2 gap-3"
                data-tour-id="course-field-dates"
              >
                <div>
                  <Label required>{t("hc_routesAppAdminCourses.fieldStartDate")}</Label>
                  <DatePicker
                    value={toDateInput(editing.start_date) ?? ""}
                    onChange={(v) => setEditing({ ...editing, start_date: v || null })}
                  />
                </div>
                <div>
                  <Label required>{t("hc_routesAppAdminCourses.fieldEndDate")}</Label>
                  <DatePicker
                    value={toDateInput(editing.end_date) ?? ""}
                    onChange={(v) => setEditing({ ...editing, end_date: v || null })}
                  />
                </div>
              </div>
              {/* Estado del ciclo de vida — SOLO en modo edición (los cursos
                  nuevos siempre nacen 'borrador'). El cambio NO va al payload
                  de save(): llama el RPC set_course_status directamente para
                  que las transiciones sean explícitas. */}
              {editing.id && (
                <div>
                  <Label>
                    {t("course.statusFormLabel")}{" "}
                    <HelpHint>{t("course.statusFormHint")}</HelpHint>
                  </Label>
                  <Select
                    value={(editing.status as string | undefined) ?? "en_curso"}
                    onValueChange={(v) => {
                      const next = v as "borrador" | "en_curso" | "finalizado";
                      // Reflejo optimista en el form; el RPC + load() refrescan
                      // el grid (y finalized_at/by server-side).
                      setEditing((prev) => (prev ? { ...prev, status: next } : prev));
                      void (async () => {
                        const { error } = await db.rpc("set_course_status", {
                          _course_id: editing.id,
                          _status: next,
                        });
                        if (error) {
                          toast.error(friendlyError(error));
                          return;
                        }
                        toast.success(t("toast.routes_app_admin_courses.statusChanged"));
                        load();
                      })();
                    }}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="borrador">{t("course.status.borrador")}</SelectItem>
                      <SelectItem value="en_curso">{t("course.status.en_curso")}</SelectItem>
                      <SelectItem value="finalizado">{t("course.status.finalizado")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div>
                <Label>{t("hc_routesAppAdminCourses.fieldDescription")}</Label>
                <Textarea
                  value={editing.description ?? ""}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </div>

              <div className="rounded-md border p-3 space-y-3">
                <p className="text-sm font-medium">{t("hc_routesAppAdminCourses.gradeScale")}</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">{t("hc_routesAppAdminCourses.minGrade")}</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={editing.grade_scale_min ?? 0}
                      onChange={(e) =>
                        setEditing({ ...editing, grade_scale_min: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t("hc_routesAppAdminCourses.maxGrade")}</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={editing.grade_scale_max ?? 5}
                      onChange={(e) =>
                        setEditing({ ...editing, grade_scale_max: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">{t("hc_routesAppAdminCourses.passingGrade")}</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={editing.passing_grade ?? 3}
                      onChange={(e) =>
                        setEditing({ ...editing, passing_grade: Number(e.target.value) })
                      }
                    />
                  </div>
                </div>
                {/* Pesos por tipo a nivel de curso. Cuando el curso tiene
                    cortes, los pesos se definen DENTRO de cada corte (cada
                    cut tiene sus buckets exam/workshop/project/attendance),
                    así que estos campos globales se ocultan para no inducir
                    a error. Si no hay cortes, aplican al curso completo. */}
                {editingCuts.length === 0 ? (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                      <div>
                        <Label className="text-xs">{t("hc_routesAppAdminCourses.weightExams")}</Label>
                        <DecimalInput
                          min={0}
                          max={100}
                          value={editing.exam_weight ?? null}
                          onChange={(v) => setEditing({ ...editing, exam_weight: v ?? 0 })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          {t("hc_routesAppAdminCourses.weightWorkshops")}
                        </Label>
                        <DecimalInput
                          min={0}
                          max={100}
                          value={editing.workshop_weight ?? null}
                          onChange={(v) => setEditing({ ...editing, workshop_weight: v ?? 0 })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          {t("hc_routesAppAdminCourses.weightAttendance")}
                        </Label>
                        <DecimalInput
                          min={0}
                          max={100}
                          value={editing.attendance_weight ?? null}
                          onChange={(v) => setEditing({ ...editing, attendance_weight: v ?? 0 })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">
                          {t("hc_routesAppAdminCourses.weightProject")}
                        </Label>
                        <DecimalInput
                          min={0}
                          max={100}
                          value={editing.project_weight ?? null}
                          onChange={(v) => setEditing({ ...editing, project_weight: v ?? 0 })}
                        />
                      </div>
                    </div>
                    {(() => {
                      const total =
                        (editing.exam_weight ?? 0) +
                        (editing.workshop_weight ?? 0) +
                        (editing.attendance_weight ?? 0) +
                        (editing.project_weight ?? 0);
                      const ok = Math.abs(total - 100) < 0.01;
                      return (
                        <div className="flex items-center justify-between">
                          <p className="text-xs text-muted-foreground">
                            {t("hc_routesAppAdminCourses.totalWeightsMustSum")}
                          </p>
                          <Badge variant={ok ? "default" : "destructive"} className="text-xs">
                            {formatPercent(total)}%
                          </Badge>
                        </div>
                      );
                    })()}
                  </>
                ) : null}

                {/* ── Cortes evaluativos (inline, en memoria) ── */}
                <div className="rounded-md border p-3 space-y-3" data-tour-id="course-field-cuts">
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <Label className="text-xs">
                        {t("hc_routesAppAdminCourses.cutCount")}{" "}
                        <HelpHint><span dangerouslySetInnerHTML={{ __html: t("help.courseCutsDefinition") }} /></HelpHint>
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        max={20}
                        className="w-20 text-right"
                        value={editingCuts.length}
                        onChange={(e) => {
                          const v = e.target.value === "" ? 0 : Number(e.target.value);
                          void handleCutCountChange(v);
                        }}
                      />
                      {editingCuts.length > 0 &&
                        (() => {
                          const sumCuts = editingCuts.reduce(
                            (a, c) => a + Number(c.weight || 0),
                            0,
                          );
                          // Tolerancia de 0.01 para que decimales como
                          // 33,33 + 33,33 + 33,34 = 100 no fallen por
                          // suma flotante imprecisa.
                          const ok = Math.abs(sumCuts - 100) < 0.01;
                          return (
                            <Badge variant={ok ? "default" : "destructive"} className="text-xs">
                              {t("hc_routesAppAdminCourses.cutTotalBadge", {
                                total: formatPercent(sumCuts),
                              })}
                            </Badge>
                          );
                        })()}
                    </div>
                  </div>

                  {editingCuts.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">
                      {t("hc_routesAppAdminCourses.noCutsConfigured")}
                    </p>
                  )}

                  {editingCuts.length > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {t("hc_routesAppAdminCourses.cutsHintBefore")}{" "}
                      <ChevronRight className="inline h-3 w-3 align-text-bottom" />{" "}
                      {t("hc_routesAppAdminCourses.cutsHintAfter")}
                    </p>
                  )}

                  <div
                    className={`space-y-2 ${editingCuts.length > 3 ? "max-h-[40dvh] overflow-y-auto pr-1" : ""}`}
                  >
                    {editingCuts.map((cut, idx) => {
                      const subSum =
                        Number(cut.exam_weight || 0) +
                        Number(cut.workshop_weight || 0) +
                        Number(cut.attendance_weight || 0) +
                        Number(cut.project_weight || 0);
                      const isOpen = expandedCuts.has(idx);
                      return (
                        <div
                          key={cut.id ?? `new-${idx}`}
                          className="rounded border bg-muted/30 p-2 space-y-2 min-w-0"
                        >
                          {/* Fila 1: chevron + nombre (siempre full width en mobile) */}
                          <div className="flex items-center gap-2 min-w-0">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleExpand(idx)}
                              className="h-8 w-8 p-0 shrink-0"
                              title={
                                isOpen
                                  ? t("hc_routesAppAdminCourses.hideSubWeights")
                                  : t("hc_routesAppAdminCourses.showSubWeights")
                              }
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </Button>
                            <Input
                              value={cut.name}
                              onChange={(e) => updateDraftCut(idx, { name: e.target.value })}
                              placeholder={t("hc_routesAppAdminCourses.cutDefaultName", {
                                n: idx + 1,
                              })}
                              className="min-w-0 flex-1"
                            />
                          </div>
                          {/* Fila 2: fechas + peso (3 columnas desde sm) */}
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 min-w-0">
                            <div className="min-w-0">
                              <Label className="text-[10px] text-muted-foreground">
                                {t("hc_routesAppAdminCourses.cutStart")}
                              </Label>
                              <DatePicker
                                value={cut.start_date ?? ""}
                                onChange={(v) => updateDraftCut(idx, { start_date: v || null })}
                                className="min-w-0 w-full"
                              />
                            </div>
                            <div className="min-w-0">
                              <Label className="text-[10px] text-muted-foreground">
                                {t("hc_routesAppAdminCourses.cutEnd")}
                              </Label>
                              <DatePicker
                                value={cut.end_date ?? ""}
                                onChange={(v) => updateDraftCut(idx, { end_date: v || null })}
                                className="min-w-0 w-full"
                              />
                            </div>
                            <div className="min-w-0">
                              <Label className="text-[10px] text-muted-foreground">
                                {t("hc_routesAppAdminCourses.cutWeightPercent")}
                              </Label>
                              <DecimalInput
                                min={0}
                                max={100}
                                value={cut.weight ?? null}
                                onChange={(v) => updateDraftCut(idx, { weight: v ?? 0 })}
                                placeholder={t("hc_routesAppAdminCourses.weightRangePlaceholder")}
                                className="min-w-0 w-full"
                              />
                            </div>
                          </div>

                          {isOpen && (
                            <div className="space-y-2 rounded bg-background p-2 min-w-0">
                              {/* Pesos por bucket del corte (Talleres /
                                  Exámenes / Proyectos / Asistencia).
                                  Mobile-first: 1 col en xs (cada input
                                  full-width, decimal pad cómodo), 2 en
                                  sm, 4 en lg. Antes era grid-cols-2
                                  sin prefijo y a 375px los labels +
                                  inputs apenas cabían. */}
                              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 min-w-0">
                                <div className="min-w-0">
                                  <Label className="text-xs">
                                    {t("hc_routesAppAdminCourses.subWorkshops")}
                                  </Label>
                                  <DecimalInput
                                    min={0}
                                    max={100}
                                    value={cut.workshop_weight ?? null}
                                    onChange={(v) =>
                                      updateDraftCut(idx, { workshop_weight: v ?? 0 })
                                    }
                                    className="h-8 min-w-0 w-full"
                                  />
                                </div>
                                <div className="min-w-0">
                                  <Label className="text-xs">
                                    {t("hc_routesAppAdminCourses.subExams")}
                                  </Label>
                                  <DecimalInput
                                    min={0}
                                    max={100}
                                    value={cut.exam_weight ?? null}
                                    onChange={(v) => updateDraftCut(idx, { exam_weight: v ?? 0 })}
                                    className="h-8 min-w-0 w-full"
                                  />
                                </div>
                                <div className="min-w-0">
                                  <Label className="text-xs">
                                    {t("hc_routesAppAdminCourses.subProjects")}
                                  </Label>
                                  <DecimalInput
                                    min={0}
                                    max={100}
                                    value={cut.project_weight ?? null}
                                    onChange={(v) =>
                                      updateDraftCut(idx, { project_weight: v ?? 0 })
                                    }
                                    className="h-8 min-w-0 w-full"
                                  />
                                </div>
                                <div className="min-w-0">
                                  <Label className="text-xs">
                                    {t("hc_routesAppAdminCourses.subAttendance")}
                                  </Label>
                                  <DecimalInput
                                    min={0}
                                    max={100}
                                    value={cut.attendance_weight ?? null}
                                    onChange={(v) =>
                                      updateDraftCut(idx, { attendance_weight: v ?? 0 })
                                    }
                                    className="h-8 min-w-0 w-full"
                                  />
                                </div>
                              </div>
                              <div className="flex items-center justify-end gap-2">
                                {/* Regla: la suma de sub-pesos del corte = cut.weight (no 100).
                                    El total se mide contra el peso del corte sobre la nota
                                    final, así un corte de 30% se llena con sub-pesos que
                                    sumen 30. Sub-pesos en 0 son válidos. Tolerancia 0.01
                                    para evitar falsos negativos por suma flotante. */}
                                {(() => {
                                  const target = Number(cut.weight ?? 0);
                                  const ok = Math.abs(subSum - target) < 0.01;
                                  return (
                                    <Badge
                                      variant={ok ? "secondary" : "destructive"}
                                      className="text-xs"
                                    >
                                      {t("hc_routesAppAdminCourses.subWeightsBadge", {
                                        sub: formatPercent(subSum),
                                        target: formatPercent(target),
                                      })}
                                    </Badge>
                                  );
                                })()}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* ── Reintentos por examen ── */}
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium inline-flex items-center gap-1.5">
                    {t("hc_routesAppAdminCourses.examAttempts")}
                    <HelpHint>{t("help.maxExamAttemptsHelp")}</HelpHint>
                  </p>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    className="w-20 text-right"
                    value={editing.max_exam_attempts ?? 1}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        max_exam_attempts: Math.max(1, Number(e.target.value) || 1),
                      })
                    }
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("hc_routesAppAdminCourses.cancel")}
            </Button>
            <Button onClick={save}>{t("hc_routesAppAdminCourses.save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Student Enrollment Dialog ── */}
      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("hc_routesAppAdminCourses.studentsDialogTitle", {
                course: enrollCourse?.name ?? "",
              })}
            </DialogTitle>
          </DialogHeader>
          <AssignSelector
            items={allProfiles}
            selectedIds={enrolledIds}
            onToggle={toggleEnroll}
            onSelectAll={enrollMany}
            onDeselectAll={unenrollMany}
            selectedLabel={t("hc_routesAppAdminCourses.enrolledLabel")}
            countNoun={t("hc_routesAppAdminCourses.enrolledNoun")}
          />
        </DialogContent>
      </Dialog>

      {/* ── Teacher Assignment Dialog ── */}
      <Dialog open={teacherOpen} onOpenChange={setTeacherOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t("hc_routesAppAdminCourses.teachersDialogTitle", {
                course: teacherCourse?.name ?? "",
              })}
            </DialogTitle>
          </DialogHeader>
          <AssignSelector
            // Un Docente no puede auto-asignarse: filtramos su propia fila del
            // listado. Gate por ROL ACTIVO (no por roles poseídos): un usuario
            // multi-rol Admin+Docente actuando COMO Docente tampoco debe poder
            // auto-agregarse aquí. Sólo cuando actúa como Admin/SuperAdmin ve la
            // lista completa (el Admin gestiona docentes, incluido él mismo).
            // Para Docente puro, además, la RLS bloquea el self-insert
            // (course_teachers_docente_manage_others: user_id <> auth.uid()).
            items={
              activeRole === "Admin" || activeRole === "SuperAdmin"
                ? teachers
                : teachers.filter((tch) => tch.id !== user?.id)
            }
            selectedIds={assignedTeacherIds}
            onToggle={toggleTeacher}
            onSelectAll={assignTeachersMany}
            onDeselectAll={unassignTeachersMany}
            emptyText={
              isAdmin
                ? t("hc_routesAppAdminCourses.noTeacherUsers")
                : t("hc_routesAppAdminCourses.noOtherTeachers")
            }
            countNoun={t("hc_routesAppAdminCourses.assignedNoun")}
          />
          {!isAdmin && (
            <p className="text-[11px] text-muted-foreground">
              {t("hc_routesAppAdminCourses.cannotSelfAssign")}
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Duplicate Course Dialog ── */}
      <Dialog open={dupOpen} onOpenChange={setDupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("hc_routesAppAdminCourses.duplicateDialogTitle")}</DialogTitle>
          </DialogHeader>
          {dupSource && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t("hc_routesAppAdminCourses.duplicateIntroBefore")}{" "}
                <strong>{dupSource.name}</strong>{" "}
                {t("hc_routesAppAdminCourses.duplicateIntroAfter")}
              </p>
              <div>
                <Label required>{t("hc_routesAppAdminCourses.newCourseName")}</Label>
                <Input value={dupName} onChange={(e) => setDupName(e.target.value)} />
              </div>
              <div>
                <Label required>{t("hc_routesAppAdminCourses.duplicatePeriod")}</Label>
                <Input
                  value={dupPeriod}
                  onChange={(e) => setDupPeriod(e.target.value)}
                  placeholder={t("hc_routesAppAdminCourses.placeholderDuplicatePeriod")}
                />
              </div>
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">{t("hc_routesAppAdminCourses.whatToCopy")}</p>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">
                      {t("hc_routesAppAdminCourses.copyExamsTitle")}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("hc_routesAppAdminCourses.copyExamsHint")}
                    </div>
                  </div>
                  <Switch checked={dupCopyExams} onCheckedChange={setDupCopyExams} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">
                      {t("hc_routesAppAdminCourses.copyWorkshopsTitle")}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("hc_routesAppAdminCourses.copyWorkshopsHint")}
                    </div>
                  </div>
                  <Switch checked={dupCopyWorkshops} onCheckedChange={setDupCopyWorkshops} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">
                      {t("hc_routesAppAdminCourses.copyBoardTitle")}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("hc_routesAppAdminCourses.copyBoardHint")}
                    </div>
                  </div>
                  <Switch checked={dupCopyBoard} onCheckedChange={setDupCopyBoard} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">
                      {t("hc_routesAppAdminCourses.copyStudentsTitle")}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("hc_routesAppAdminCourses.copyStudentsHint")}
                    </div>
                  </div>
                  <Switch checked={dupCopyStudents} onCheckedChange={setDupCopyStudents} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">
                      {t("hc_routesAppAdminCourses.copyTeachersTitle")}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("hc_routesAppAdminCourses.copyTeachersHint")}
                    </div>
                  </div>
                  <Switch checked={dupCopyTeachers} onCheckedChange={setDupCopyTeachers} />
                </label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDupOpen(false)}>
              {t("hc_routesAppAdminCourses.cancel")}
            </Button>
            <Button onClick={doDuplicate} disabled={dupLoading}>
              {dupLoading ? (
                <Spinner size="md" className="mr-1" />
              ) : (
                <Copy className="h-4 w-4 mr-1" />
              )}
              {t("hc_routesAppAdminCourses.duplicateButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={selectedCourseItems}
        entityNameSingular={t("hc_routesAppAdminCourses.entityCourseSingular")}
        entityNamePlural={t("hc_routesAppAdminCourses.entityCoursePlural")}
        extraWarning={t("hc_routesAppAdminCourses.bulkDeleteWarning")}
        onConfirm={handleBulkDelete}
      />

      <CourseCertificateSettingsDialog
        course={certForCourse}
        onClose={() => setCertForCourse(null)}
      />
      {scheduleForCourse && (
        <CourseScheduleEditor
          open={!!scheduleForCourse}
          onOpenChange={(o) => !o && setScheduleForCourse(null)}
          courseId={scheduleForCourse.id}
          courseName={scheduleForCourse.name}
        />
      )}
      {diagnosticForCourse && (
        <CourseDiagnosticDialog
          open={!!diagnosticForCourse}
          onOpenChange={(o) => !o && setDiagnosticForCourse(null)}
          courseId={diagnosticForCourse.id}
          courseName={diagnosticForCourse.name}
        />
      )}
    </div>
  );
}
