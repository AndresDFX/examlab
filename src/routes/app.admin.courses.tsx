import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { friendlyError, friendlyUniqueViolation } from "@/shared/lib/db-errors";
import { toCSV, downloadCSV } from "@/shared/lib/csv";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { DateCell } from "@/components/ui/date-cell";
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
} from "@/components/ui/table";
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
  FileText,
  Hammer,
  FolderKanban,
  Link2,
  Upload,
  Download,
  MessageSquareText,
  Award,
} from "lucide-react";
import { CourseCertificateSettingsDialog } from "@/modules/certificates/CourseCertificateSettingsDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const confirm = useConfirm();
  const [courses, setCourses] = useState<Course[]>([]);
  /** Mapa courseId → stats. Vacío al inicio; se llena después del primer
   *  load de cursos. Si falla la carga (RLS / network), simplemente la
   *  columna "Actividad" muestra "—" — el grid no se rompe. */
  const [courseStats, setCourseStats] = useState<Map<string, CourseStats>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // Filtro de institución (solo SuperAdmin). 'all' = ve cross-tenant
  // (default). Cuando elige una, la query se restringe con `.eq('tenant_id', X)`.
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Course> | null>(null);
  // Curso cuyo "Tablero del estudiante" estamos viendo/editando. Cuando
  // está poblado, mostramos un dialog con la misma vista que verá el
  // alumno (sesiones por fecha + contenido asignado + items vinculados),
  // y el docente puede asignar contenido a cada sesión inline.
  const [boardForCourse, setBoardForCourse] = useState<Course | null>(null);
  const [certForCourse, setCertForCourse] = useState<Course | null>(null);
  // Editor de horarios — dialog independiente abierto desde el menú
  // de acciones de fila. Mantener fuera del editing principal evita
  // sobrecargar el dialog del form de curso.
  const [scheduleForCourse, setScheduleForCourse] = useState<Course | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Search params: `subjectFilter` viene del flujo 'Ver cursos asociados'
  // desde el panel de asignaturas. Filtra el grid a una sola asignatura.
  const routeSearch = Route.useSearch();
  const subjectFilter = routeSearch.subjectFilter ?? null;
  const fromSubject = routeSearch.fromSubject ?? null;

  // Filtramos por nombre + período + descripción. Case-insensitive,
  // includes. El multi-select trabaja sobre la lista visible. Si hay
  // subjectFilter (URL search), también acotamos.
  const filteredCourses = useMemo(() => {
    let result = courses;
    if (subjectFilter) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = result.filter((c: any) => c.subject_id === subjectFilter);
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
  }, [courses, search, subjectFilter]);
  const sel = useMultiSelect(filteredCourses);

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
    // ON DELETE CASCADE arrastra examenes/talleres/proyectos/etc.
    const { error } = await supabase.from("courses").delete().in("id", ids);
    if (error) throw new Error(error.message);
    toast.success(`${ids.length} curso(s) eliminado(s) correctamente`);
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
  const [dupCopyStudents, setDupCopyStudents] = useState(false);
  // Por defecto NO copiar docentes (opt-in).
  const [dupCopyTeachers, setDupCopyTeachers] = useState(false);
  const [dupLoading, setDupLoading] = useState(false);

  const isAdmin = roles.includes("Admin");
  const isTeacher = roles.includes("Docente");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isSuperAdminCaller = (roles as any[]).includes("SuperAdmin");
  // Docente tiene los mismos privilegios que Admin para gestionar
  // cursos, EXCEPTO auto-asignarse en course_teachers (lo bloquea
  // tanto la RLS como el filtro del dialog de docentes más abajo).
  const canManage = isAdmin || isTeacher;

  const load = async () => {
    // SuperAdmin con filtro de institución activo: aplicamos
    // `.eq('tenant_id', X)` a la query principal. Para Admin normal el
    // filtro no se renderiza (solo ve su tenant via RLS), así que
    // tenantFilter queda en 'all' y la query no se restringe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = supabase
      .from("courses")
      .select("*")
      .order("period", { ascending: false, nullsFirst: false })
      .order("name");
    if (isSuperAdminCaller && tenantFilter !== "all") {
      q = q.eq("tenant_id", tenantFilter);
    }
    const { data, error } = await q;
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar la lista de cursos."));
      return;
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
      .order("name");
    setTenants((tens ?? []) as Array<{ id: string; slug: string; name: string }>);
    setCourses((data ?? []) as unknown as Course[]);

    // Stats por curso (Actividad): cargamos en paralelo 5 queries
    // ligeras (solo course_id) y agrupamos en memoria. Evita N+1 y RPCs.
    // Talleres y proyectos son M:N (workshop_courses / project_courses);
    // exámenes son 1:N directo. course_students y course_teachers son
    // tablas de relación directas.
    const courseIds = (data ?? []).map((c: { id: string }) => c.id);
    if (courseIds.length > 0) {
      try {
        const [
          { data: studs },
          { data: teaches },
          { data: exs },
          { data: wks },
          { data: prs },
        ] = await Promise.all([
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase as any)
            .from("course_students")
            .select("course_id")
            .in("course_id", courseIds),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase as any)
            .from("course_teachers")
            .select("course_id")
            .in("course_id", courseIds),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (supabase as any).from("exams").select("course_id").in("course_id", courseIds),
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
    // solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantFilter]);

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
      grade_scale_min: 0,
      grade_scale_max: 5,
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
      grade_scale_min: 0,
      grade_scale_max: 5,
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
    name: `Corte ${position + 1}`,
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
      toast.error("Nombre requerido");
      return;
    }
    const startInput = toDateInput(editing.start_date);
    const endInput = toDateInput(editing.end_date);
    if (startInput && endInput && startInput > endInput) {
      toast.error("La fecha de fin debe ser posterior a la fecha de inicio");
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
        toast.error(`Los pesos del curso deben sumar 100% (suma actual: ${formatPercent(total)}%)`);
        return;
      }
    } else {
      // Con cortes: (a) la suma de cut.weight debe ser 100; (b) en cada
      // corte, los sub-pesos deben sumar exactamente cut.weight.
      const sumCuts = editingCuts.reduce((a, c) => a + Number(c.weight || 0), 0);
      if (Math.abs(sumCuts - 100) >= TOL) {
        toast.error(
          `Los pesos de los cortes deben sumar 100% (suma actual: ${formatPercent(sumCuts)}%)`,
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
          const label = c.name?.trim() || `Corte ${i + 1}`;
          offending.push(
            `${label}: sub-pesos ${formatPercent(subSum)}% ≠ ${formatPercent(target)}%`,
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
        toast.error(`Sub-pesos no cuadran con el peso del corte:\n${offending.join("\n")}`);
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
      if (error || !created) return toast.error(friendlyError(error, "Error creando curso"));
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
          name: c.name?.trim() || `Corte ${i + 1}`,
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
      toast.error(`Curso guardado, pero falló la sincronización de cortes: ${msg}`);
      setOpen(false);
      setEditing(null);
      setEditingCuts([]);
      setOriginalCutIds(new Set());
      load();
      return;
    }

    toast.success("Curso guardado correctamente");
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
    const { error } = await supabase.from("courses").delete().eq("id", id);
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
      toast.success("Estudiante matriculado correctamente");
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
      toast.success("Estudiante desmatriculado correctamente");
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
    toast.success(`${toAdd.length} estudiante(s) matriculados correctamente`);
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
    toast.success(`${toRemove.length} estudiante(s) desmatriculados correctamente`);
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
      toast.success("Docente asignado correctamente");
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
      toast.success("Docente desasignado correctamente");
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
    toast.success(`${toAdd.length} docente(s) asignados correctamente`);
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
    toast.success(`${toRemove.length} docente(s) desasignados correctamente`);
  };

  // ── Duplicate Course ─────────────────────────────────────

  const openDuplicate = (c: Course) => {
    setDupSource(c);
    setDupName(`${c.name} (copia)`);
    setDupPeriod(c.period ?? "");
    setDupCopyExams(true);
    setDupCopyWorkshops(true);
    setDupCopyStudents(true);
    setDupCopyTeachers(false); // opt-in
    setDupOpen(true);
  };

  const doDuplicate = async () => {
    if (!dupSource || !dupName.trim()) {
      toast.error("Nombre requerido");
      return;
    }
    setDupLoading(true);
    let copiedStudents = 0;
    try {
      // 1. Create new course
      const { data: newCourse, error: cErr } = await supabase
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
      if (cErr || !newCourse) throw new Error(cErr?.message ?? "Error creando curso");

      // 2. Copy students (CRÍTICO: replicar todas las matrículas)
      if (dupCopyStudents) {
        const { data: enr, error: enrErr } = await supabase
          .from("course_enrollments")
          .select("user_id")
          .eq("course_id", dupSource.id);
        if (enrErr) console.error("read enrollments:", enrErr);
        if (enr?.length) {
          const rows = enr.map((e: any) => ({ course_id: newCourse.id, user_id: e.user_id }));
          const { error: insErr, count } = await supabase
            .from("course_enrollments")
            .insert(rows, { count: "exact" });
          if (insErr) {
            console.error("copy enrollments:", insErr);
            toast.error(`No se pudieron copiar las matrículas: ${friendlyError(insErr)}`);
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
          await supabase
            .from("course_teachers")
            .insert(ct.map((t: any) => ({ course_id: newCourse.id, user_id: t.user_id })));
        }
      }

      // 4. Copy exams (without submissions/assignments)
      if (dupCopyExams) {
        const { data: exams } = await supabase
          .from("exams")
          .select("*")
          .eq("course_id", dupSource.id);
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
          .eq("course_id", dupSource.id);
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

      const studentsMsg = dupCopyStudents
        ? ` (${copiedStudents} estudiante${copiedStudents === 1 ? "" : "s"} copiado${copiedStudents === 1 ? "" : "s"})`
        : "";
      toast.success(`Curso duplicado correctamente${studentsMsg}`);
      setDupOpen(false);
      load();
    } catch (e: any) {
      toast.error(friendlyError(e, "Error al duplicar"));
    } finally {
      setDupLoading(false);
    }
  };

  if (!canManage) return <p className="text-muted-foreground">Necesitas rol Admin o Docente.</p>;

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<BookOpen className="h-6 w-6" />} title="Cursos" />
        <ErrorState
          message="No pudimos cargar la lista de cursos"
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
        title="Cursos"
        subtitle={
          search.trim()
            ? `${filteredCourses.length} de ${courses.length} cursos`
            : `${courses.length} cursos registrados`
        }
        actions={
          <>
            <ImportExportMenu resourceName="cursos" onExport={exportCoursesCsv} />
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4 mr-1" /> Nuevo curso
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex-1 min-w-[200px]">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Buscar por nombre, período o descripción…"
          />
        </div>
        {/* Filtro de institución (solo SuperAdmin con >1 tenant visible).
            Antes /app/admin/courses no tenía filtro funcional por tenant
            — el SuperAdmin veía cursos cross-tenant sin poder acotar a
            una institución específica. Ahora aplica .eq('tenant_id', X)
            a la query principal. */}
        {isSuperAdminCaller && tenants.length > 1 && (
          <Select value={tenantFilter} onValueChange={setTenantFilter}>
            {/* En mobile: w-full para que después del wrap ocupe todo el
                ancho disponible (sin un dropdown chiquito a la izquierda
                y whitespace a la derecha). Desde sm: ancho fijo 192px
                pegado al search. Mismo patrón que app.admin.users.tsx. */}
            <SelectTrigger className="w-full sm:w-48 h-9 text-xs">
              <SelectValue placeholder="Institución" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las instituciones</SelectItem>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
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
        entityNameSingular="curso"
        entityNamePlural="cursos"
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
                <TableHead className="max-w-[320px]">{t("common.name")}</TableHead>
                <TableHead className="hidden sm:table-cell w-32">{t("common.period")}</TableHead>
                <TableHead className="hidden sm:table-cell w-24">{t("common.scale")}</TableHead>
                <TableHead className="hidden md:table-cell w-28">{t("common.start")}</TableHead>
                <TableHead className="hidden md:table-cell w-28">{t("common.end")}</TableHead>
                <TableHead className="hidden lg:table-cell w-44" title="Estudiantes / Docentes / Items">
                  Actividad
                </TableHead>
                <TableHead className="text-right w-28">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCourses.length === 0 && (
                <TableEmpty
                  colSpan={8}
                  icon={BookOpen}
                  text={
                    search.trim() && courses.length > 0
                      ? "Sin coincidencias"
                      : t("course.emptyTitle")
                  }
                  hint={
                    search.trim() && courses.length > 0
                      ? "Ajusta el buscador para ver más resultados."
                      : t("course.emptyHint")
                  }
                  action={
                    search.trim() && courses.length > 0 ? undefined : (
                      <Button size="sm" onClick={openNew}>
                        <Plus className="h-4 w-4 mr-1" />
                        {t("course.createFirst")}
                      </Button>
                    )
                  }
                />
              )}
              {filteredCourses.map((c) => (
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
                        title={
                          c.description
                            ? `${c.name}\n\n${c.description}`
                            : c.name
                        }
                      >
                        {c.name}
                      </span>
                      {c.period && (
                        <Badge variant="outline" className="text-[10px] w-fit sm:hidden">
                          {c.period}
                        </Badge>
                      )}
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
                            title={`${s.students} estudiante(s) matriculado(s)`}
                          >
                            <Users className="h-3 w-3" />
                            <span className="font-medium text-foreground">{s.students}</span>
                          </span>
                          <span
                            className="inline-flex items-center gap-0.5 text-muted-foreground"
                            title={`${s.teachers} docente(s) asignado(s)`}
                          >
                            <UserCog className="h-3 w-3" />
                            <span className="font-medium text-foreground">{s.teachers}</span>
                          </span>
                          <span
                            className="inline-flex items-center gap-0.5 text-muted-foreground"
                            title={`${items} item(s) total: ${s.exams} examen(es), ${s.workshops} taller(es), ${s.projects} proyecto(s)`}
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
                          label: t("course.boardShort"),
                          icon: CalendarRange,
                          onClick: () => setBoardForCourse(c),
                        },
                        {
                          label: "Foro",
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
                          label: "Certificaciones",
                          icon: Award,
                          onClick: () => setCertForCourse(c),
                        },
                        {
                          // Editor de horario semanal (días + horas + aula
                          // + modalidad). Dialog separado para no
                          // sobrecargar el form principal del curso.
                          label: "Horario",
                          icon: CalendarClock,
                          onClick: () => setScheduleForCourse(c),
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
        </CardContent>
      </Card>

      {/* ── Create/Edit Dialog ── */}
      <Dialog open={open} onOpenChange={courseDirty.guardOpenChange(setOpen)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Editar" : "Nuevo"} curso</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label required>Nombre</Label>
                <Input
                  value={editing.name ?? ""}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="Ej: Programación II"
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
              <div>
                <Label required>Periodo académico</Label>
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
                    <SelectValue placeholder="Selecciona un periodo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__manual__">Texto libre (sin asociar)</SelectItem>
                    {periods.map((p) => (
                      <SelectItem key={p.id} value={p.id} disabled={p.status === "cerrado"}>
                        {p.code}
                        {p.name ? ` — ${p.name}` : ""}
                        {p.status === "cerrado" ? " (cerrado)" : ""}
                        {p.status === "planificado" ? " (planificado)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!editing.period_id && (
                  <Input
                    className="mt-2"
                    value={editing.period ?? ""}
                    onChange={(e) => setEditing({ ...editing, period: e.target.value })}
                    placeholder="Ej: 2026-1 (texto libre)"
                  />
                )}
              </div>
              {/* Programa académico (opcional, pero recomendado). Define
                  la carrera/pregrado al que pertenece el curso — alimenta
                  los headers de informes institucionales y analytics
                  agregados por programa. La lista la mantiene el Admin
                  desde Configuración → Académico. */}
              <div>
                <Label>Programa / Nivel</Label>
                <Select
                  value={editing.program_id ?? "__none__"}
                  onValueChange={(v) =>
                    setEditing({ ...editing, program_id: v === "__none__" ? null : v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Sin programa asociado" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Sin programa asociado</SelectItem>
                    {programs.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* Asignatura del plan (opcional). Asociar el curso a una
                  asignatura abstracta permite agrupar todos los grupos
                  de "Programación II" en reportes. Al seleccionar una
                  asignatura, si tiene programa fijo, lo sincronizamos
                  para evitar inconsistencias. */}
              <div>
                <Label>Asignatura del plan</Label>
                <Select
                  value={editing.subject_id ?? "__none__"}
                  onValueChange={(v) => {
                    if (v === "__none__") {
                      setEditing({ ...editing, subject_id: null });
                      return;
                    }
                    const subj = subjects.find((s) => s.id === v);
                    setEditing({
                      ...editing,
                      subject_id: v,
                      // Sync defensivo: si la asignatura tiene programa
                      // fijo y el curso no, lo heredamos.
                      program_id: editing.program_id ?? subj?.program_id ?? null,
                      // Y si la asignatura tiene semestre del plan,
                      // sugerirlo cuando el curso no lo tiene.
                      semestre: editing.semestre ?? subj?.semestre ?? null,
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Sin asignatura asociada" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Sin asignatura asociada</SelectItem>
                    {subjects
                      // Filtrar por programa elegido si lo hay — relevancia.
                      .filter(
                        (s) =>
                          !editing.program_id ||
                          s.program_id === editing.program_id ||
                          s.program_id == null,
                      )
                      .map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                          {s.code ? ` (${s.code})` : ""}
                          {s.semestre ? ` · Sem ${s.semestre}` : ""}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              {/* Campos opcionales que alimentan los headers de los informes
                  institucionales (Diagnóstico, Acuerdo Pedagógico). Si el
                  docente no los completa quedan vacíos en el reporte —
                  preferible a forzar a inventar valores. */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <Label>Código</Label>
                  <Input
                    value={editing.code ?? ""}
                    onChange={(e) => setEditing({ ...editing, code: e.target.value || null })}
                    placeholder="Ej: ProgII"
                  />
                </div>
                <div>
                  <Label>Grado / Semestre</Label>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    value={editing.semestre ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        semestre: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    placeholder="1–12"
                  />
                </div>
                <div>
                  <Label>Grupo</Label>
                  <Input
                    value={editing.grupo ?? ""}
                    onChange={(e) => setEditing({ ...editing, grupo: e.target.value || null })}
                    placeholder="Ej: 341-C"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label required>Fecha inicio</Label>
                  <DatePicker
                    value={toDateInput(editing.start_date) ?? ""}
                    onChange={(v) => setEditing({ ...editing, start_date: v || null })}
                  />
                </div>
                <div>
                  <Label required>Fecha fin</Label>
                  <DatePicker
                    value={toDateInput(editing.end_date) ?? ""}
                    onChange={(v) => setEditing({ ...editing, end_date: v || null })}
                  />
                </div>
              </div>
              <div>
                <Label>Descripción</Label>
                <Textarea
                  value={editing.description ?? ""}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </div>

              <div className="rounded-md border p-3 space-y-3">
                <p className="text-sm font-medium">Escala de calificación</p>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">Calificación mínima</Label>
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
                    <Label className="text-xs">Calificación máxima</Label>
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
                    <Label className="text-xs">Aprobar ≥</Label>
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
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                      <div>
                        <Label className="text-xs">Peso exámenes (%)</Label>
                        <DecimalInput
                          min={0}
                          max={100}
                          value={editing.exam_weight ?? null}
                          onChange={(v) => setEditing({ ...editing, exam_weight: v ?? 0 })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Peso talleres (%)</Label>
                        <DecimalInput
                          min={0}
                          max={100}
                          value={editing.workshop_weight ?? null}
                          onChange={(v) => setEditing({ ...editing, workshop_weight: v ?? 0 })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Peso asistencia (%)</Label>
                        <DecimalInput
                          min={0}
                          max={100}
                          value={editing.attendance_weight ?? null}
                          onChange={(v) => setEditing({ ...editing, attendance_weight: v ?? 0 })}
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Peso proyecto (%)</Label>
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
                            Total de pesos: debe sumar 100%
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
                <div className="rounded-md border p-3 space-y-3">
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <Label className="text-xs">
                        Cantidad de cortes{" "}
                        <HelpHint>
                          Define cuántos cortes evaluativos tiene este curso. <strong>0</strong> =
                          sin cortes (los pesos por tipo se editan en este mismo dialog). Si pones
                          1+, los pesos por tipo (exámenes / talleres / proyectos / asistencia) se
                          configuran dentro de cada corte abajo.
                        </HelpHint>
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
                              Total: {formatPercent(sumCuts)}%
                            </Badge>
                          );
                        })()}
                    </div>
                  </div>

                  {editingCuts.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">Sin cortes configurados.</p>
                  )}

                  {editingCuts.length > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      Pulsa el ícono <ChevronRight className="inline h-3 w-3 align-text-bottom" />{" "}
                      de cada corte para configurar los sub-pesos por tipo.
                    </p>
                  )}

                  <div
                    className={`space-y-2 ${editingCuts.length > 3 ? "max-h-[40vh] overflow-y-auto pr-1" : ""}`}
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
                              title={isOpen ? "Ocultar sub-pesos" : "Ver sub-pesos"}
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
                              placeholder={`Corte ${idx + 1}`}
                              className="min-w-0 flex-1"
                            />
                          </div>
                          {/* Fila 2: fechas + peso (3 columnas desde sm) */}
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 min-w-0">
                            <div className="min-w-0">
                              <Label className="text-[10px] text-muted-foreground">Inicio</Label>
                              <DatePicker
                                value={cut.start_date ?? ""}
                                onChange={(v) => updateDraftCut(idx, { start_date: v || null })}
                                className="min-w-0 w-full"
                              />
                            </div>
                            <div className="min-w-0">
                              <Label className="text-[10px] text-muted-foreground">Fin</Label>
                              <DatePicker
                                value={cut.end_date ?? ""}
                                onChange={(v) => updateDraftCut(idx, { end_date: v || null })}
                                className="min-w-0 w-full"
                              />
                            </div>
                            <div className="min-w-0">
                              <Label className="text-[10px] text-muted-foreground">Peso %</Label>
                              <DecimalInput
                                min={0}
                                max={100}
                                value={cut.weight ?? null}
                                onChange={(v) => updateDraftCut(idx, { weight: v ?? 0 })}
                                placeholder="0-100"
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
                                  <Label className="text-xs">Talleres %</Label>
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
                                  <Label className="text-xs">Exámenes %</Label>
                                  <DecimalInput
                                    min={0}
                                    max={100}
                                    value={cut.exam_weight ?? null}
                                    onChange={(v) => updateDraftCut(idx, { exam_weight: v ?? 0 })}
                                    className="h-8 min-w-0 w-full"
                                  />
                                </div>
                                <div className="min-w-0">
                                  <Label className="text-xs">Proyectos %</Label>
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
                                  <Label className="text-xs">Asistencia %</Label>
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
                                      Sub-pesos: {formatPercent(subSum)}% / {formatPercent(target)}%
                                      del corte
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
                    Intentos por examen
                    <HelpHint>
                      Número máximo de veces que un estudiante puede presentar un examen de este
                      curso (útil para quices). Al superar el límite, el último intento queda
                      registrado y el examen se marca como suspendido. Cada examen del curso hereda
                      este valor por defecto y puede ajustarse individualmente desde el editor del
                      examen.
                    </HelpHint>
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
              Cancelar
            </Button>
            <Button onClick={save}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Student Enrollment Dialog ── */}
      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Estudiantes — {enrollCourse?.name}</DialogTitle>
          </DialogHeader>
          <AssignSelector
            items={allProfiles}
            selectedIds={enrolledIds}
            onToggle={toggleEnroll}
            onSelectAll={enrollMany}
            onDeselectAll={unenrollMany}
            selectedLabel="Matriculado"
            countNoun="matriculados"
          />
        </DialogContent>
      </Dialog>

      {/* ── Teacher Assignment Dialog ── */}
      <Dialog open={teacherOpen} onOpenChange={setTeacherOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Docentes — {teacherCourse?.name}</DialogTitle>
          </DialogHeader>
          <AssignSelector
            // Un Docente no puede auto-asignarse: filtramos su propia
            // fila del listado. La RLS lo bloquearía igual, esto solo
            // evita ver un checkbox que se tropieza con error.
            items={isAdmin ? teachers : teachers.filter((t) => t.id !== user?.id)}
            selectedIds={assignedTeacherIds}
            onToggle={toggleTeacher}
            onSelectAll={assignTeachersMany}
            onDeselectAll={unassignTeachersMany}
            emptyText={
              isAdmin
                ? "No hay usuarios con rol Docente."
                : "No hay otros docentes para asignar a este curso."
            }
            countNoun="asignados"
          />
          {!isAdmin && (
            <p className="text-[11px] text-muted-foreground">
              No puedes asignarte a ti mismo a un curso. Si necesitas estar en este curso, pídele a
              un Admin que te agregue.
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Duplicate Course Dialog ── */}
      <Dialog open={dupOpen} onOpenChange={setDupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Duplicar curso</DialogTitle>
          </DialogHeader>
          {dupSource && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Creará una copia de <strong>{dupSource.name}</strong> con la configuración
                seleccionada.
              </p>
              <div>
                <Label required>Nombre del nuevo curso</Label>
                <Input value={dupName} onChange={(e) => setDupName(e.target.value)} />
              </div>
              <div>
                <Label required>Periodo</Label>
                <Input
                  value={dupPeriod}
                  onChange={(e) => setDupPeriod(e.target.value)}
                  placeholder="Ej: 2026-2"
                />
              </div>
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">¿Qué copiar?</p>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Exámenes y preguntas</div>
                    <div className="text-xs text-muted-foreground">
                      Se copian como borrador sin asignaciones
                    </div>
                  </div>
                  <Switch checked={dupCopyExams} onCheckedChange={setDupCopyExams} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Talleres</div>
                    <div className="text-xs text-muted-foreground">
                      Se copian como borrador sin entregas
                    </div>
                  </div>
                  <Switch checked={dupCopyWorkshops} onCheckedChange={setDupCopyWorkshops} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Estudiantes matriculados</div>
                    <div className="text-xs text-muted-foreground">
                      Copia las matrículas al nuevo curso
                    </div>
                  </div>
                  <Switch checked={dupCopyStudents} onCheckedChange={setDupCopyStudents} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Docentes asignados</div>
                    <div className="text-xs text-muted-foreground">
                      Por defecto desactivado — habilita para clonar también el equipo docente
                    </div>
                  </div>
                  <Switch checked={dupCopyTeachers} onCheckedChange={setDupCopyTeachers} />
                </label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDupOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={doDuplicate} disabled={dupLoading}>
              {dupLoading ? (
                <Spinner size="md" className="mr-1" />
              ) : (
                <Copy className="h-4 w-4 mr-1" />
              )}
              Duplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={selectedCourseItems}
        entityNameSingular="curso"
        entityNamePlural="cursos"
        extraWarning="Se eliminarán también todos los exámenes, talleres, proyectos, matrículas, cortes y registros de asistencia asociados (cascade)."
        onConfirm={handleBulkDelete}
      />

      <CourseBoardDialog course={boardForCourse} onClose={() => setBoardForCourse(null)} />
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
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// CourseBoardDialog: misma vista que el tablero del estudiante
// (/app/student/courses → seleccionar curso) + capacidad inline de
// asignar contenido a cada sesión. Reúne en un solo modal todo lo
// relevante para el docente: cronograma del curso, qué material verá
// el alumno cada día, qué entregas vencen cerca de cada clase.
// ──────────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  course_id: string;
  session_date: string;
  /** Hora local Bogotá HH:MM:SS (TIME). Null = legacy, la edge function
   *  cae al fallback 09:00 al sincronizar con Google Calendar. */
  start_time: string | null;
  /** Minutos. Null = fallback 90. */
  duration_minutes: number | null;
  title: string | null;
  content_id: string | null;
  content_class_index: number | null;
  /** URL de Meet/Teams/Zoom para la sesión. Validado a `https?://`
   *  por CHECK en BD. Aparece como botón "Unirse" en el tablero del
   *  estudiante y como ícono link en el tablero del docente. */
  meeting_url: string | null;
}

interface AvailableContent {
  id: string;
  topic: string;
  mode: "curso_completo" | "material_individual";
  classes: number[];
}

/**
 * Selector de asignación de contenido en 2 pasos:
 *   1. Primer Select → ¿qué contenido? (un curso puede tener varios).
 *   2. Segundo Select → ¿qué clase dentro de ese contenido?
 *      Si el contenido es `material_individual` (sin clases), el 2do
 *      select se oculta y se asigna directo con classIndex=null.
 * Las opciones de "Sin asignar" se concentran en el 1er select para
 * que el caller no tenga que limpiar dos cosas a mano.
 */
function ContentAssignmentSelector({
  contents,
  contentId,
  classIndex,
  onChange,
  assignedClassesByContent,
}: {
  contents: AvailableContent[];
  contentId: string | null;
  classIndex: number | null;
  onChange: (contentId: string | null, classIndex: number | null) => void;
  /** Map de clases ya asignadas a OTRAS sesiones del mismo curso
   *  (excluye la sesión actual). El selector oculta esas clases para
   *  evitar que el docente asigne dos veces la misma clase. */
  assignedClassesByContent?: Map<string, Set<number>>;
}) {
  const { t } = useTranslation();
  const selected = contents.find((c) => c.id === contentId) ?? null;
  // Filtramos del listado de clases las que ya estan asignadas a otra
  // sesion. La clase actual (classIndex) se preserva — sin esto, el
  // dropdown se vacia cuando ya hay una asignacion valida.
  const blockedForSelected = selected
    ? (assignedClassesByContent?.get(selected.id) ?? new Set<number>())
    : new Set<number>();
  const availableClasses = selected
    ? selected.classes.filter((n) => n === classIndex || !blockedForSelected.has(n))
    : [];
  const hasClasses = selected && availableClasses.length > 0;
  return (
    <div className="flex items-center gap-1.5">
      {/* 1) Contenido */}
      <Select
        value={contentId ?? "__none"}
        onValueChange={(v) => {
          if (v === "__none") {
            onChange(null, null);
            return;
          }
          // Al cambiar de contenido, reseteamos la clase. Si el nuevo
          // contenido tiene clases, escogemos la primera DISPONIBLE
          // (no asignada a otra sesión). Si todas estan tomadas
          // dejamos classIndex en null y el segundo select muestra el
          // placeholder "todas las clases asignadas".
          const next = contents.find((c) => c.id === v);
          if (next && next.classes.length > 0) {
            const taken = assignedClassesByContent?.get(v) ?? new Set<number>();
            const firstFree = next.classes.find((n) => !taken.has(n)) ?? null;
            onChange(v, firstFree);
          } else {
            onChange(v, null);
          }
        }}
      >
        <SelectTrigger className="w-44 h-8 text-xs">
          <SelectValue placeholder={t("contents.assignNone")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none">{t("contents.assignNone")}</SelectItem>
          {contents.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.topic}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* 2) Clase — solo si el contenido elegido tiene clases. */}
      {hasClasses && (
        <Select
          value={classIndex != null ? String(classIndex) : ""}
          onValueChange={(v) => onChange(contentId, Number(v))}
        >
          <SelectTrigger className="w-28 h-8 text-xs">
            <SelectValue placeholder={t("contents.classPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {availableClasses.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {t("contents.classNumber")} {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

type ScheduledItem = {
  kind: "exam" | "workshop" | "project";
  id: string;
  title: string;
  due: string;
};

function CourseBoardDialog({ course, onClose }: { course: Course | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [contents, setContents] = useState<AvailableContent[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Mapa de (content_id → set de class_index ya asignados en este curso).
  // Sirve para que el selector de contenido oculte las clases tomadas
  // y obligar la regla "una clase del contenido = una sesion". El selector
  // preserva internamente la clase de la sesion actual aunque este en el
  // set, asi el dropdown no se "vacia" cuando ya hay asignacion valida.
  const assignedClassesByContent = useMemo(() => {
    const map = new Map<string, Set<number>>();
    for (const s of sessions) {
      if (!s.content_id || s.content_class_index == null) continue;
      let set = map.get(s.content_id);
      if (!set) {
        set = new Set();
        map.set(s.content_id, set);
      }
      set.add(s.content_class_index);
    }
    return map;
  }, [sessions]);
  // Borrador para creación + edición inline. Cuando `editingId` es
  // null el form de la card-borrador crea una sesión nueva; cuando es
  // un id, edita esa fila. La fila editada queda con un anillo
  // primary para señalizar el modo edición.
  const [draftDate, setDraftDate] = useState("");
  // Hora de inicio (HH:MM) y duración en minutos — usados por la
  // sincronización con Google Calendar (edge function `calendar`) para
  // crear el evento a la hora real en vez de hardcodear 09:00/90min.
  // Defaults sugeridos para clase universitaria; el docente los puede
  // ajustar por sesión.
  const [draftStartTime, setDraftStartTime] = useState("09:00");
  const [draftDuration, setDraftDuration] = useState(90);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftMeetingUrl, setDraftMeetingUrl] = useState("");
  // CSV import: bandera que muestra spinner mientras procesa, y un
  // contador de filas insertadas vs omitidas para el toast final.
  const [importing, setImporting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!course) {
      setSessions([]);
      setContents([]);
      setScheduled([]);
      return;
    }
    setLoading(true);
    void (async () => {
      // Sesiones del curso + contenidos del docente disponibles + items
      // (exams/workshops/projects) calendarizados — en paralelo.
      const [sesRes, contentsRes, examsRes, wsRes, projRes] = await Promise.all([
        db
          .from("attendance_sessions")
          .select(
            "id, course_id, session_date, start_time, duration_minutes, title, content_id, content_class_index, meeting_url",
          )
          .eq("course_id", course.id)
          .order("session_date", { ascending: true }),
        // status='done' del propio docente; "available" se filtra por
        // RLS al teacher_id. Incluimos contenidos del curso O sin curso
        // asociado (genéricos reutilizables).
        db
          .from("generated_contents")
          .select("id, topic, mode, course_id, files")
          .eq("status", "done")
          .or(`course_id.eq.${course.id},course_id.is.null`),
        supabase.from("exams").select("id, title, end_time").eq("course_id", course.id),
        supabase.from("workshops").select("id, title, due_date").eq("course_id", course.id),
        supabase.from("projects").select("id, title, due_date").eq("course_id", course.id),
      ]);

      setSessions((sesRes.data ?? []) as SessionRow[]);
      // Aplana files[] → classes[] para no recalcular regex en cada Select.
      setContents(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((contentsRes.data ?? []) as any[]).map((g) => {
          const files = (g.files ?? []) as Array<{ name: string }>;
          const set = new Set<number>();
          for (const f of files) {
            const m = f.name.match(/(?:CLASE|CLASS|SESION|SESSION)[_\s-]*(\d+)/i);
            if (m) set.add(Number(m[1]));
          }
          return {
            id: g.id,
            topic: g.topic,
            mode: g.mode,
            classes: Array.from(set).sort((a, b) => a - b),
          };
        }),
      );

      const items: ScheduledItem[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const e of (examsRes.data ?? []) as any[]) {
        if (e.end_time) items.push({ kind: "exam", id: e.id, title: e.title, due: e.end_time });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const w of (wsRes.data ?? []) as any[]) {
        if (w.due_date) items.push({ kind: "workshop", id: w.id, title: w.title, due: w.due_date });
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const p of (projRes.data ?? []) as any[]) {
        if (p.due_date) items.push({ kind: "project", id: p.id, title: p.title, due: p.due_date });
      }
      setScheduled(items);
      setLoading(false);
    })();
  }, [course]);

  /** Items vinculados a una sesión: dentro de ±3 días de la fecha.
   *  Misma heurística que el tablero del estudiante. */
  const itemsForSession = (s: SessionRow): ScheduledItem[] => {
    const sessTs = new Date(s.session_date + "T12:00:00").getTime();
    return scheduled.filter((it) => {
      const dueTs = new Date(it.due).getTime();
      return Math.abs(dueTs - sessTs) <= 3 * 24 * 60 * 60 * 1000;
    });
  };

  /** Persiste el cambio de contenido para UNA sesión. Optimista —
   *  actualiza el state local en cuanto la BD responde OK. */
  const updateAssignment = async (sessionId: string, raw: string) => {
    let content_id: string | null = null;
    let content_class_index: number | null = null;
    if (raw !== "__none") {
      const [cid, idx] = raw.split(":");
      content_id = cid;
      const n = Number(idx);
      content_class_index = Number.isFinite(n) && n > 0 ? n : null;
    }
    const { error } = await db
      .from("attendance_sessions")
      .update({ content_id, content_class_index })
      .eq("id", sessionId);
    if (error) {
      // 23505 = unique_violation. La constraint `attendance_sessions_unique_content_class`
      // se dispara si alguien (o una race condition) intenta asignar la
      // misma (content_id, class_index) a dos sesiones del mismo curso.
      // El selector ya filtra clases tomadas, pero por defensa en
      // profundidad mostramos un mensaje claro en lugar del raw del CLI.
      if (error.code === "23505") {
        toast.error(t("course.classAlreadyAssignedToAnotherSession"));
      } else {
        toast.error(friendlyError(error));
      }
      return;
    }
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, content_id, content_class_index } : s)),
    );
  };

  /** Crea una sesión nueva. Inserta en attendance_sessions con
   *  course_id + session_date + title (opcional) + created_by. */
  const createSession = async () => {
    if (!course || !user) return;
    if (!draftDate) {
      toast.error(t("course.boardDateRequired"));
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await db
        .from("attendance_sessions")
        .insert({
          course_id: course.id,
          session_date: draftDate,
          // start_time como TIME "HH:MM:00" (Postgres acepta tanto HH:MM
          // como HH:MM:SS pero normalizamos para ser explícitos).
          start_time: draftStartTime ? `${draftStartTime}:00` : null,
          duration_minutes: draftDuration > 0 ? draftDuration : 90,
          title: draftTitle.trim() || null,
          meeting_url: draftMeetingUrl.trim() || null,
          created_by: user.id,
        })
        .select(
          "id, course_id, session_date, start_time, duration_minutes, title, content_id, content_class_index, meeting_url",
        )
        .single();
      if (error || !data) {
        toast.error(friendlyUniqueViolation(error) ?? error?.message ?? "insert failed");
        return;
      }
      // Insertamos manteniendo el orden por session_date asc.
      setSessions((prev) =>
        [...prev, data as SessionRow].sort((a, b) => a.session_date.localeCompare(b.session_date)),
      );
      setDraftDate("");
      setDraftStartTime("09:00");
      setDraftDuration(90);
      setDraftTitle("");
      setDraftMeetingUrl("");
      toast.success(t("course.boardSessionCreated"));
    } finally {
      setSaving(false);
    }
  };

  /**
   * Importa sesiones desde un CSV. Formato esperado por header:
   *   session_date,title,meeting_url
   * Solo session_date es requerido (formato YYYY-MM-DD). Las filas
   * inválidas se cuentan como "skipped" en el toast — no abortamos el
   * batch entero por una fila mala. Insertamos en una sola pasada con
   * `.insert(rows[])` para reducir round-trips.
   */
  /**
   * Descarga un template CSV con filas de ejemplo para el bulk-import
   * de sesiones. Reusa los helpers `toCSV` + `downloadCSV` de
   * `@/lib/csv` (mismo patrón que el template de Usuarios). Solo
   * `session_date` es obligatoria; `title` y `meeting_url` quedan
   * vacíos en algunas filas para mostrar que son opcionales.
   *
   * Las fechas de ejemplo son relativas a hoy (próximos miércoles y
   * viernes a una semana) — no hardcodeadas — para que el docente
   * vea fechas válidas sin tener que editar el template antes de
   * personalizarlo.
   */
  const downloadTemplate = () => {
    const today = new Date();
    const fmt = (d: Date) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    };
    const next = (offsetDays: number) => {
      const d = new Date(today);
      d.setDate(d.getDate() + offsetDays);
      return fmt(d);
    };
    const csv = toCSV([
      {
        session_date: next(7),
        title: "Clase 1 — Introducción",
        meeting_url: "https://meet.google.com/abc-defg-hij",
      },
      {
        session_date: next(9),
        title: "Clase 2 — Variables y tipos",
        meeting_url: "",
      },
      {
        session_date: next(14),
        title: "",
        meeting_url: "https://teams.microsoft.com/l/meetup-join/...",
      },
    ]);
    downloadCSV("template-sesiones.csv", csv);
    toast.success(t("course.boardTemplateDoneToast"));
  };

  const importCsv = async (file: File) => {
    if (!course || !user) return;
    setImporting(true);
    try {
      const text = await file.text();
      // Parser simple: split por línea + comma. NO soportamos comillas
      // anidadas con commas dentro — el caso de uso son títulos cortos
      // y URLs que no llevan commas. Si llega a ser problema, migramos
      // a `papaparse`.
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length < 2) {
        toast.error(t("course.boardImportEmpty"));
        return;
      }
      const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
      const idxDate = header.indexOf("session_date");
      const idxTitle = header.indexOf("title");
      const idxMeet = header.indexOf("meeting_url");
      if (idxDate < 0) {
        toast.error(t("course.boardImportNoDate"));
        return;
      }

      type Row = {
        course_id: string;
        session_date: string;
        title: string | null;
        meeting_url: string | null;
        created_by: string;
      };
      const rows: Row[] = [];
      let skipped = 0;
      for (let i = 1; i < lines.length; i += 1) {
        const cols = lines[i].split(",").map((c) => c.trim());
        const date = cols[idxDate];
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          skipped += 1;
          continue;
        }
        const url = idxMeet >= 0 ? cols[idxMeet] : "";
        if (url && !/^https?:\/\//i.test(url)) {
          skipped += 1;
          continue;
        }
        rows.push({
          course_id: course.id,
          session_date: date,
          title: idxTitle >= 0 && cols[idxTitle] ? cols[idxTitle] : null,
          meeting_url: url || null,
          created_by: user.id,
        });
      }
      if (rows.length === 0) {
        toast.error(t("course.boardImportNoValid", { skipped }));
        return;
      }
      const { data, error } = await db
        .from("attendance_sessions")
        .insert(rows)
        .select("id, course_id, session_date, title, content_id, content_class_index, meeting_url");
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      setSessions((prev) =>
        [...prev, ...((data ?? []) as SessionRow[])].sort((a, b) =>
          a.session_date.localeCompare(b.session_date),
        ),
      );
      toast.success(t("course.boardImportDone", { created: rows.length, skipped }));
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setImporting(false);
    }
  };

  /** Activa el modo edición de una sesión. Carga sus valores actuales
   *  en el borrador para que el docente los modifique. */
  const startEdit = (s: SessionRow) => {
    setEditingId(s.id);
    setDraftDate(s.session_date);
    // Postgres devuelve TIME como "HH:MM:SS"; el <input type="time">
    // espera "HH:MM". Cortamos al primer ":" desde el final.
    setDraftStartTime(s.start_time ? s.start_time.slice(0, 5) : "09:00");
    setDraftDuration(s.duration_minutes ?? 90);
    setDraftTitle(s.title ?? "");
    setDraftMeetingUrl(s.meeting_url ?? "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setDraftDate("");
    setDraftStartTime("09:00");
    setDraftDuration(90);
    setDraftTitle("");
    setDraftMeetingUrl("");
  };

  /** Persiste cambios de fecha/hora/título/duración de la sesión en
   *  edición. La hora + duración alimentan la sincronización a
   *  Google Calendar (edge function `calendar`). */
  const saveEdit = async () => {
    if (!editingId || !draftDate) return;
    setSaving(true);
    try {
      const newStartTime = draftStartTime ? `${draftStartTime}:00` : null;
      const newDuration = draftDuration > 0 ? draftDuration : 90;
      const { error } = await db
        .from("attendance_sessions")
        .update({
          session_date: draftDate,
          start_time: newStartTime,
          duration_minutes: newDuration,
          title: draftTitle.trim() || null,
          meeting_url: draftMeetingUrl.trim() || null,
        })
        .eq("id", editingId);
      if (error) {
        toast.error(friendlyUniqueViolation(error) ?? error.message);
        return;
      }
      setSessions((prev) =>
        prev
          .map((s) =>
            s.id === editingId
              ? {
                  ...s,
                  session_date: draftDate,
                  start_time: newStartTime,
                  duration_minutes: newDuration,
                  title: draftTitle.trim() || null,
                  meeting_url: draftMeetingUrl.trim() || null,
                }
              : s,
          )
          .sort((a, b) => a.session_date.localeCompare(b.session_date)),
      );
      cancelEdit();
      toast.success(t("course.boardSessionSaved"));
    } finally {
      setSaving(false);
    }
  };

  /** Elimina una sesión. Cascade en BD también borra los registros
   *  de asistencia (FK con ON DELETE CASCADE). El docente acepta
   *  esto en el confirm dialog. */
  const removeSession = async (s: SessionRow) => {
    const ok = await confirm({
      title: t("course.boardSessionDeleteTitle"),
      description: t("course.boardSessionDeleteBody", {
        date: s.session_date,
        title: s.title || t("contents.assignSessionUntitled"),
      }),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("attendance_sessions").delete().eq("id", s.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setSessions((prev) => prev.filter((x) => x.id !== s.id));
    toast.success(t("course.boardSessionDeleted"));
  };

  if (!course) return null;

  return (
    <Dialog open={!!course} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" hideCloseButton>
        <DialogHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <DialogTitle className="flex items-center gap-2">
                <CalendarRange className="h-5 w-5 text-primary" />
                {t("course.boardDialogTitle", { name: course.name })}
              </DialogTitle>
              <p className="text-xs text-muted-foreground">{t("course.boardSubtitle")}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {/* Plantilla CSV: descarga un archivo con encabezados +
                  3 filas de ejemplo para que el docente sepa qué
                  formato usar antes de subir el suyo. Mismo patrón que
                  Admin → Usuarios → "Template CSV". */}
              <Button
                variant="outline"
                size="sm"
                onClick={downloadTemplate}
                title={t("course.boardTemplateTooltip")}
                className="h-8 text-xs"
              >
                <Download className="h-3.5 w-3.5 mr-1" />
                {t("course.boardTemplate")}
              </Button>
              {/* Importar CSV: usamos el patrón de un input file oculto +
                  Label como botón. Esto evita necesitar un Dialog adicional
                  y usa el file picker nativo del browser. */}
              <Label
                className="inline-flex items-center gap-1 h-8 px-2 text-xs rounded-md border border-input bg-background hover:bg-muted/40 cursor-pointer"
                title={t("course.boardImportTooltip")}
              >
                {importing ? (
                  <Spinner size="sm" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                {t("course.boardImportCsv")}
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importCsv(f);
                    // Reset para permitir importar el mismo file dos veces.
                    e.target.value = "";
                  }}
                  disabled={importing}
                />
              </Label>
            </div>
          </div>
        </DialogHeader>

        {/* Form de creación rápida — siempre visible arriba del listado.
            Una sola fecha + título permite al docente programar sesiones
            sin saltar a /teacher/attendance. La validación dura en
            createSession exige fecha. */}
        <div className="rounded-md border bg-muted/30 p-3 space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            {t("course.boardNewSession")}
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label className="text-[11px]">{t("common.date")}</Label>
              <Input
                type="date"
                value={editingId ? "" : draftDate}
                onChange={(e) => {
                  if (editingId) setEditingId(null);
                  setDraftDate(e.target.value);
                }}
                className="h-8 text-xs w-44"
              />
            </div>
            {/* Hora inicio + duración — alimentan la sincronización a
                Google Calendar para crear el evento a la hora real en
                vez de hardcodear 09:00/90min. */}
            <div className="space-y-1">
              <Label className="text-[11px]">{t("course.boardStartTime")}</Label>
              <Input
                type="time"
                value={editingId ? "" : draftStartTime}
                onChange={(e) => {
                  if (editingId) setEditingId(null);
                  setDraftStartTime(e.target.value);
                }}
                // w-36 (144px) — antes era w-28 (112px) y truncaba el
                // "09:00 a. m." + icono picker que renderiza Chrome en
                // locale es. Suficiente espacio sin ser desproporcionado.
                className="h-8 text-xs w-36"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-[11px]">{t("course.boardDuration")}</Label>
              <Input
                type="number"
                min={15}
                max={480}
                step={5}
                value={editingId ? "" : draftDuration}
                onChange={(e) => {
                  if (editingId) setEditingId(null);
                  setDraftDuration(Number(e.target.value) || 90);
                }}
                // w-24 (96px) — antes w-20 (80px). El spinner nativo del
                // input number consume ~20px del lado derecho; w-20 deja
                // valores de 3 dígitos (ej. 240, 360) sin espacio visible.
                className="h-8 text-xs w-24"
              />
            </div>
            <div className="space-y-1 flex-1 min-w-[160px] sm:min-w-48">
              <Label className="text-[11px]">{t("common.title")}</Label>
              <Input
                value={editingId ? "" : draftTitle}
                onChange={(e) => {
                  if (editingId) setEditingId(null);
                  setDraftTitle(e.target.value);
                }}
                placeholder={t("course.boardSessionTitlePlaceholder")}
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1 flex-1 min-w-[160px] sm:min-w-48">
              <Label className="text-[11px]">{t("course.boardMeetingUrl")}</Label>
              <Input
                type="url"
                value={editingId ? "" : draftMeetingUrl}
                onChange={(e) => {
                  if (editingId) setEditingId(null);
                  setDraftMeetingUrl(e.target.value);
                }}
                placeholder="https://meet.google.com/…"
                className="h-8 text-xs"
              />
            </div>
            <Button
              size="sm"
              onClick={createSession}
              disabled={!draftDate || saving || !!editingId}
              className="h-8"
            >
              {saving ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Plus className="h-3.5 w-3.5 mr-1" />
              )}
              {t("course.boardCreateSession")}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Spinner size="xl" className="text-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
            {t("course.boardNoSessions")}
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => {
              const items = itemsForSession(s);
              const isEditing = editingId === s.id;
              return (
                <Card key={s.id} className={isEditing ? "ring-2 ring-primary/60" : undefined}>
                  <CardContent className="p-3 space-y-2">
                    {isEditing ? (
                      // Modo edición inline: reemplaza la fila de display por
                      // dos inputs (fecha + título) + Save/Cancel. La asignación
                      // de contenido y los items vinculados se ocultan en este
                      // modo para que el docente se concentre en metadata.
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="space-y-1">
                          <Label className="text-[11px]">{t("common.date")}</Label>
                          <Input
                            type="date"
                            value={draftDate}
                            onChange={(e) => setDraftDate(e.target.value)}
                            className="h-8 text-xs w-44"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[11px]">{t("course.boardStartTime")}</Label>
                          <Input
                            type="time"
                            value={draftStartTime}
                            onChange={(e) => setDraftStartTime(e.target.value)}
                            className="h-8 text-xs w-36"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-[11px]">{t("course.boardDuration")}</Label>
                          <Input
                            type="number"
                            min={15}
                            max={480}
                            step={5}
                            value={draftDuration}
                            onChange={(e) => setDraftDuration(Number(e.target.value) || 90)}
                            className="h-8 text-xs w-24"
                          />
                        </div>
                        <div className="space-y-1 flex-1 min-w-[160px] sm:min-w-48">
                          <Label className="text-[11px]">{t("common.title")}</Label>
                          <Input
                            value={draftTitle}
                            onChange={(e) => setDraftTitle(e.target.value)}
                            placeholder={t("course.boardSessionTitlePlaceholder")}
                            className="h-8 text-xs"
                          />
                        </div>
                        <div className="space-y-1 flex-1 min-w-[160px] sm:min-w-48">
                          <Label className="text-[11px]">{t("course.boardMeetingUrl")}</Label>
                          <Input
                            type="url"
                            value={draftMeetingUrl}
                            onChange={(e) => setDraftMeetingUrl(e.target.value)}
                            placeholder="https://meet.google.com/…"
                            className="h-8 text-xs"
                          />
                        </div>
                        <Button
                          size="sm"
                          onClick={saveEdit}
                          disabled={!draftDate || saving}
                          className="h-8"
                        >
                          {saving ? (
                            <Spinner size="sm" className="mr-1" />
                          ) : (
                            <CheckSquare className="h-3.5 w-3.5 mr-1" />
                          )}
                          {t("common.save")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={cancelEdit}
                          disabled={saving}
                          className="h-8"
                        >
                          {t("common.cancel")}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-start gap-3">
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="text-[11px] tabular-nums">
                              {s.session_date}
                            </Badge>
                            {s.start_time && (
                              <Badge variant="outline" className="text-[11px] tabular-nums">
                                {s.start_time.slice(0, 5)}
                                {s.duration_minutes ? ` · ${s.duration_minutes}m` : ""}
                              </Badge>
                            )}
                            {s.title && <span className="text-sm font-medium">{s.title}</span>}
                            {s.meeting_url && (
                              <a
                                href={s.meeting_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20"
                                title={s.meeting_url}
                              >
                                <Link2 className="h-3 w-3" />
                                {t("course.boardJoinMeeting")}
                              </a>
                            )}
                          </div>
                        </div>
                        {/* Asignación de contenido en 2 pasos: primero
                            elige el contenido (tema), luego la clase
                            dentro de ese contenido. Mejor que un único
                            select gigante cuando el curso tiene varios
                            contenidos con varias clases cada uno. */}
                        <ContentAssignmentSelector
                          contents={contents}
                          contentId={s.content_id}
                          classIndex={s.content_class_index}
                          assignedClassesByContent={assignedClassesByContent}
                          onChange={(cid, idx) => {
                            const raw = cid == null ? "__none" : `${cid}:${idx ?? 0}`;
                            void updateAssignment(s.id, raw);
                          }}
                        />
                        {/* Acciones de la sesión: editar metadata + eliminar.
                            Iconos discretos pero accesibles — el menú "tres
                            puntos" no aplica acá porque la fila ya tiene
                            varios controles inline (Select de contenido). */}
                        <div className="flex items-center gap-1">
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            onClick={() => startEdit(s)}
                            title={t("common.edit")}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8 text-destructive hover:bg-destructive/10"
                            onClick={() => removeSession(s)}
                            title={t("common.delete")}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    )}
                    {!isEditing && items.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-1.5 border-t">
                        {items.map((it) => (
                          <Badge
                            key={`${it.kind}-${it.id}`}
                            variant="outline"
                            className="text-[10px] flex items-center gap-1"
                          >
                            {it.kind === "exam" ? (
                              <FileText className="h-3 w-3" />
                            ) : it.kind === "workshop" ? (
                              <Hammer className="h-3 w-3" />
                            ) : (
                              <FolderKanban className="h-3 w-3" />
                            )}
                            {it.title}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
