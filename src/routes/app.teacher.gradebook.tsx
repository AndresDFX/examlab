import { createFileRoute } from "@tanstack/react-router";
import { formatNumber } from "@/shared/lib/format";
import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import i18next from "i18next";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { NoAssignedCoursesNotice } from "@/modules/courses/NoAssignedCoursesNotice";
import { notaEfectivaDeTaller } from "@/modules/grading/nota-efectiva";
import { useActiveRole } from "@/hooks/use-active-role";
import { scopedCourseIds } from "@/modules/courses/course-scope";
import { isStaffRole } from "@/shared/lib/roles";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { SearchInput } from "@/components/ui/search-input";
import { RowAction } from "@/components/ui/row-action";
import { DecimalInput } from "@/components/ui/decimal-input";
import { friendlyError } from "@/shared/lib/db-errors";
import { ErrorState, EmptyState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { ClipboardList, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
  Download,
  GitBranch,
  FileText,
  FileSpreadsheet,
  Hammer,
  Save,
  Scale,
  AlertTriangle,
  Eye,
  Inbox,
  FolderKanban,
  CalendarCheck,
  Award,
  RotateCcw,
  ChevronDown,
  UsersRound,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { downloadCSV, toCSV } from "@/shared/lib/csv";
import { toXLSX, downloadXLSX } from "@/shared/lib/xlsx";
import { computeWeightedGrade } from "@/modules/grading/grade";
import { corteYPesoEnCurso, sesionesDadas } from "@/modules/grading/nota-relativa";
import { todasLasFilas } from "@/shared/lib/todas-las-filas";
import { integrantesPorEntrega, unaVezPorEntrega } from "@/modules/grading/nota-de-grupo";
import {
  actividadesConNota,
  notaDelEstudianteEnCurso,
  type DatosParaNota,
  type DetalleDeItem,
  type NotaCompleta,
} from "@/modules/grading/nota-del-curso";
import { CourseSelect } from "@/modules/courses/CourseSelect";
import { courseIdsInScope } from "@/modules/courses/course-filter-scope";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  notaDeExamenParaEstudiante,
  notaDeTallerConRecuperaciones,
  type FilaDeTaller,
  type TipoRecuperacion,
} from "@/modules/grading/nota-con-recuperacion";
import { entregaHecha } from "@/modules/submissions/entrega-hecha";
import {
  downloadCertificate,
  downloadCertificatesZip,
  buildVerifyUrl,
} from "@/modules/certificates/certificate-pdf";

// grade_cuts/projects pueden no estar en types.ts auto-generados
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/**
 * Tinte por CORTE, para que el ojo siga la columna correcta en una matriz de
 * 93 alumnos × N actividades.
 *
 * Eran 4 tonos y se reciclaban: con 5 cortes, el primero y el quinto salían
 * IGUALES, que es peor que no tener tinte —dos cortes distintos que se ven
 * iguales invitan a capturar la nota en la columna equivocada—. Son 6, que
 * cubre el rango realista (lo habitual son 3-4 cortes; más de 6 en un semestre
 * es raro). Más allá de 6 sigue ciclando: en algún punto tiene que hacerlo.
 *
 * Acá los hues crudos de Tailwind son legítimos y NO violan el principio P3:
 * el color ES el dato (distingue cortes), no decoración de pantalla — la misma
 * excepción que los dots por tipo de evento del calendario.
 *
 * Vive a nivel de módulo y no dentro del `map` para no recrear el array en cada
 * render de cada encabezado.
 */
const CUT_TINTS = [
  "bg-indigo-500/5 dark:bg-indigo-500/10 border-l-2 border-indigo-500/30",
  "bg-emerald-500/5 dark:bg-emerald-500/10 border-l-2 border-emerald-500/30",
  "bg-amber-500/5 dark:bg-amber-500/10 border-l-2 border-amber-500/30",
  "bg-cyan-500/5 dark:bg-cyan-500/10 border-l-2 border-cyan-500/30",
  "bg-fuchsia-500/5 dark:bg-fuchsia-500/10 border-l-2 border-fuchsia-500/30",
  "bg-lime-500/5 dark:bg-lime-500/10 border-l-2 border-lime-500/30",
];

export const Route = createFileRoute("/app/teacher/gradebook")({ component: Gradebook });

type Course = {
  id: string;
  name: string;
  grade_scale_min: number;
  grade_scale_max: number;
  passing_grade: number;
  exam_weight: number;
  workshop_weight: number;
  status?: string | null;
  period?: string | null;
  /** Embed `academic_subjects:subject_id(name)` — solo alimenta el filtro de
   *  nivel superior (periodo/asignatura) del selector de curso. */
  academic_subjects?: { name: string | null } | null;
};
type Exam = {
  id: string;
  title: string;
  parent_exam_id: string | null;
  course_id: string;
  cut_id?: string | null;
  weight?: number | null;
  retry_mode?: string | null;
  status?: string | null;
  /** Cierre de la ventana: decide si el examen «ya se dio» (nota relativa). */
  end_time?: string | null;
  is_external?: boolean | null;
  /** Solo en recuperaciones: supletorio | recuperatorio (mig 20262650000000). */
  makeup_kind?: string | null;
  recovery_rule?: string | null;
  created_at?: string | null;
};
/**
 * Taller o proyecto tal como viene de SU fila: `cut_id`/`weight` son los del
 * curso ancla. El corte y el peso en ESTE curso los resuelve
 * `corteYPesoEnCurso` con la fila de unión (y quedan en la columna).
 */
type Workshop = {
  id: string;
  title: string;
  course_id: string;
  max_score: number;
  cut_id?: string | null;
  weight?: number | null;
  due_date?: string | null;
  is_external?: boolean | null;
  status?: string | null;
  requires_defense?: boolean | null;
  /** Recuperación de otro taller (mig 20262660000000). */
  parent_workshop_id?: string | null;
  makeup_kind?: string | null;
  recovery_rule?: string | null;
  created_at?: string | null;
};
type Project = {
  id: string;
  title: string;
  course_id: string;
  max_score: number;
  cut_id: string | null;
  weight?: number | null;
  due_date?: string | null;
  is_external?: boolean | null;
  status?: string | null;
};
/** Fila de `workshop_courses` / `project_courses`: corte y peso en este curso. */
type FilaDeUnion = { cut_id: string | null; weight: number | null };
type Asignaciones = { examenes: Set<string>; talleres: Set<string>; proyectos: Set<string> };
const SIN_ASIGNACIONES: Asignaciones = {
  examenes: new Set(),
  talleres: new Set(),
  proyectos: new Set(),
};
type Cut = {
  id: string;
  name: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
  weight: number;
  workshop_weight: number;
  exam_weight: number;
  project_weight: number;
  attendance_weight: number;
};
type AttSession = { id: string; session_date: string; cut_id?: string | null };
type AttRecord = { session_id: string; user_id: string; status: string };
type ProjectSub = {
  project_id: string;
  user_id: string;
  group_id: string | null;
  ai_grade: number | null;
  final_grade: number | null;
  status: string;
};
type Student = {
  id: string;
  full_name: string;
  institutional_email: string;
  personal_email: string | null;
  cohorte: string | null;
};
type ExamSub = {
  id: string;
  exam_id: string;
  user_id: string;
  ai_grade: number | null;
  final_override_grade: number | null;
  status: string;
  created_at: string;
};
type WsSub = {
  id: string;
  workshop_id: string;
  user_id: string;
  group_id: string | null;
  ai_grade: number | null;
  final_grade: number | null;
  status: string;
};

/**
 * El grupo de la entrega que da la nota de una celda. Solo existe cuando la
 * entrega es GRUPAL: es una fila compartida, así que esa nota es la de todos
 * sus integrantes y editarla en una celda la cambia en todas.
 */
type GrupoDeCelda = { nombre: string; integrantes: number };

/** A column in the grid — examen, taller o proyecto */
type GradeColumn = {
  id: string;
  title: string;
  kind: "exam" | "workshop" | "project";
  parentExamId?: string | null;
  maxScore?: number;
  isExternal?: boolean;
  /** Peso del item como % de la nota final (cap = su bucket en el corte).
   *  Se muestra en los encabezados del export para que la columna sea tan
   *  clara como el grid (igual que los cortes muestran su %). */
  weight?: number | null;
  /** Corte al que pertenece el item (exam.cut_id / workshop_courses.cut_id /
   *  project_courses.cut_id). null = sin corte. Usado por el export Excel para
   *  la fila de grupo que agrupa cada entregable bajo su corte. */
  cutId?: string | null;
};

/** Editable grade cell keyed by `${studentId}::${columnId}` */
type EditMap = Record<string, string>;

function Gradebook() {
  const { t } = useTranslation();

  const { user, roles, loading: authLoading } = useAuth();
  const activeRole = useActiveRole();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  // Filtros de nivel superior periodo/asignatura sobre el Select de curso —
  // mismo patrón que Asistencia/Estadísticas (course-filter-scope.ts).
  const [periodFilter, setPeriodFilter] = useState<string | null>(null);
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);
  const gbCoursesForFilter = useMemo(
    () =>
      courses.map((c) => ({
        id: c.id,
        period: c.period ?? null,
        subject: c.academic_subjects?.name ?? null,
      })),
    [courses],
  );
  const gbFilterScope = useMemo(
    () => courseIdsInScope(gbCoursesForFilter, periodFilter, subjectFilter),
    [gbCoursesForFilter, periodFilter, subjectFilter],
  );
  const gbCoursesInScope = useMemo(
    () => (gbFilterScope === null ? courses : courses.filter((c) => gbFilterScope.has(c.id))),
    [courses, gbFilterScope],
  );
  const gbFilterPeriods = useMemo(
    () =>
      Array.from(
        new Set(gbCoursesForFilter.map((c) => c.period).filter((p): p is string => !!p)),
      ).sort((a, b) => b.localeCompare(a, "es-CO", { numeric: true })),
    [gbCoursesForFilter],
  );
  const gbFilterSubjects = useMemo(
    () =>
      Array.from(
        new Set(gbCoursesForFilter.map((c) => c.subject).filter((s): s is string => !!s)),
      ).sort((a, b) => a.localeCompare(b, "es-CO", { sensitivity: "base" })),
    [gbCoursesForFilter],
  );
  const gbShowPeriodFilter = gbFilterPeriods.length > 1;
  const gbShowSubjectFilter = gbFilterSubjects.length > 1;
  /** Al cambiar periodo/asignatura, si el curso elegido queda fuera del
   *  alcance se salta al primero del nuevo alcance (el gradebook siempre tiene
   *  un curso activo). */
  const gbCambiarAlcance = (nuevo: { period?: string | null; subject?: string | null }) => {
    const p = nuevo.period !== undefined ? nuevo.period : periodFilter;
    const sj = nuevo.subject !== undefined ? nuevo.subject : subjectFilter;
    if (nuevo.period !== undefined) setPeriodFilter(nuevo.period);
    if (nuevo.subject !== undefined) setSubjectFilter(nuevo.subject);
    if (courseId) {
      const sigue = courses.some(
        (c) =>
          c.id === courseId &&
          (!p || c.period === p) &&
          (!sj || (c.academic_subjects?.name ?? null) === sj),
      );
      if (!sigue) {
        const next = courses.find(
          (c) =>
            (!p || c.period === p) && (!sj || (c.academic_subjects?.name ?? null) === sj),
        );
        setCourseId(next?.id ?? "");
      }
    }
  };
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [columns, setColumns] = useState<GradeColumn[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [studentSearch, setStudentSearch] = useState("");
  const [examSubs, setExamSubs] = useState<ExamSub[]>([]);
  const [wsSubs, setWsSubs] = useState<WsSub[]>([]);
  const [allExams, setAllExams] = useState<Exam[]>([]);
  const [allWorkshops, setAllWorkshops] = useState<Workshop[]>([]);
  const [cuts, setCuts] = useState<Cut[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  // Filas de unión por actividad (corte y peso EN ESTE curso).
  const [wsUnion, setWsUnion] = useState<Map<string, FilaDeUnion>>(new Map());
  const [prjUnion, setPrjUnion] = useState<Map<string, FilaDeUnion>>(new Map());
  const [projectSubs, setProjectSubs] = useState<ProjectSub[]>([]);
  // Membresía de grupo por usuario (taller/proyecto): userId → set de group_ids.
  // Necesario porque una entrega grupal tiene user_id = solo el "último editor";
  // los demás miembros se resuelven por su pertenencia al group_id de la submission.
  const [wsGroupsByUser, setWsGroupsByUser] = useState<Map<string, Set<string>>>(new Map());
  const [prjGroupsByUser, setPrjGroupsByUser] = useState<Map<string, Set<string>>>(new Map());
  /** Nombre de cada grupo (talleres y proyectos), para decir de quién es la nota. */
  const [nombresDeGrupos, setNombresDeGrupos] = useState<Map<string, string>>(new Map());
  const [attSessions, setAttSessions] = useState<AttSession[]>([]);
  const [attRecords, setAttRecords] = useState<AttRecord[]>([]);
  // Lo asignado a cada estudiante: sin asignación no ve la actividad, así que
  // sin entrega no le cuenta como 0 (nota-relativa.ts).
  const [asignaciones, setAsignaciones] = useState<Map<string, Asignaciones>>(new Map());
  const [edits, setEdits] = useState<EditMap>({});
  const [saving, setSaving] = useState(false);
  // Progreso de "Guardar cambios": el guardado es un loop SECUENCIAL de
  // updates (puede ser 90+ alumnos × N columnas). Sin contador el docente
  // no distingue "está trabajando" de "se colgó".
  const [saveProgress, setSaveProgress] = useState<{ done: number; total: number } | null>(null);
  // Carga de los datos del curso (grilla + consolidado). Antes NO existía:
  // mientras `loadCourse` corría (14 queries) la pantalla quedaba vacía sin
  // spinner, y si una query fallaba quedaba vacía PARA SIEMPRE sin error.
  // Distingue "todavía no cargó" de "no tiene cursos": sin esta bandera el
  // aviso de "no tenés cursos asignados" parpadea un instante en cada carga.
  const [coursesLoaded, setCoursesLoaded] = useState(false);
  const [loadingCourse, setLoadingCourse] = useState(false);
  // Error de la carga de datos del curso. Separado de `loadError` (que es el
  // de la LISTA de cursos y pinta la página completa): así el docente
  // conserva el selector de curso y puede reintentar o cambiar de curso.
  const [courseDataError, setCourseDataError] = useState<string | null>(null);
  // Progreso de la emisión masiva de certificados (loop secuencial de RPCs).
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  // Cuál corte tiene abierto el modal de "Ver detalle"
  const [detailCutId, setDetailCutId] = useState<string | null>(null);
  // Cuál estudiante tiene abierto el modal anidado "detalle por estudiante"
  // (se abre desde el ojo en cada fila del modal de corte).
  const [detailStudentId, setDetailStudentId] = useState<string | null>(null);
  // Certificados emitidos en este curso, indexados por user_id (solo el activo).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [certByUserId, setCertByUserId] = useState<Record<string, any>>({});
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [bulkIssuing, setBulkIssuing] = useState(false);
  const confirm = useConfirm();
  // SA accede a pantallas Docente para soporte / diagnóstico — sin SA
  // en el set, recibía "Necesitas rol Docente" silencioso al entrar.
  const isTeacher = isStaffRole(roles);

  // Carga certificados activos del curso (refresh tras emitir)
  const reloadCertificates = useCallback(async () => {
    if (!courseId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let error: any = null;
    try {
      const res = await db
        .from("certificates")
        .select("*")
        .eq("course_id", courseId)
        .is("revoked_at", null);
      data = res.data;
      error = res.error;
    } catch (e) {
      error = e;
    }
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map: Record<string, any> = {};
    for (const c of (data ?? []) as Array<{ user_id: string }>) {
      map[c.user_id] = c;
    }
    setCertByUserId(map);
  }, [courseId]);

  useEffect(() => {
    void reloadCertificates();
  }, [reloadCertificates]);

  // Load courses. Guard `cancelled` + catch: antes era un `.then()` suelto,
  // así que un rechazo de la promesa (red caída, sesión expirada) no entraba
  // por la rama `error` y la pantalla quedaba sin cursos y sin mensaje.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Acotado por ROL ACTIVO: un docente ve SOLO los cursos que dicta. La
        // RLS de `courses` deja ver TODO el tenant a cualquier autenticado, así
        // que el filtro no lo puede dar la base — ver course-scope.ts. Reporte:
        // "desde el rol docente puede ver cursos de los que no es docente".
        const ids = await scopedCourseIds(activeRole, roles, user?.id);
        if (cancelled) return;
        if (ids && ids.length === 0) {
          // Sin cursos asignados: lista vacía SIN consultar (un `.in("id", [])`
          // en PostgREST devuelve TODAS las filas).
          setCourses([]);
          setLoadError(null);
          setCoursesLoaded(true);
          return;
        }
        let q = supabase
          .from("courses")
          .select(
            "id, name, grade_scale_min, grade_scale_max, passing_grade, exam_weight, workshop_weight, status, period, academic_subjects:subject_id(name)",
          )
          .is("deleted_at", null)
          .order("name");
        if (ids) q = q.in("id", ids);
        const { data, error } = await q;
        if (cancelled) return;
        if (error) {
          setLoadError(friendlyError(error, t("hc_routesAppTeacherGradebook.couldNotLoadCourses")));
          return;
        }
        setLoadError(null);
        // `as unknown as`: types.ts generado aún no incluye `courses.status`.
        const rows = (data ?? []) as unknown as Course[];
        setCourses(rows);
        setCoursesLoaded(true);
        if (rows[0]) setCourseId(rows[0].id);
      } catch (e) {
        if (cancelled) return;
        setLoadError(friendlyError(e, t("hc_routesAppTeacherGradebook.couldNotLoadCourses")));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce, activeRole, roles, user?.id]);

  // Guard de staleness/desmontaje: el docente cambia de curso rápido y
  // `loadCourse` también se llama imperativamente (tras guardar notas). Sin
  // el seq/mounted check una carga vieja podía pisar los datos de la nueva
  // o hacer setState sobre un componente desmontado.
  const loadSeqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    // Se vuelve a poner en true al montar: en desarrollo StrictMode monta,
    // desmonta y vuelve a montar, y sin esto el ref quedaba en false para
    // siempre — toda carga se descartaba por «vieja» y el libro se quedaba en
    // «Cargando calificaciones…».
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Load data for selected course
  const loadCourse = useCallback(async () => {
    if (!courseId) return;
    const seq = ++loadSeqRef.current;
    const stale = () => !mountedRef.current || loadSeqRef.current !== seq;

    // TODA query de esta carga pasa por `must`: si falla, LANZA. Antes cada
    // una destructuraba solo `{ data }` e IGNORABA `error`, así que un fallo
    // de RLS / red / columna inexistente dejaba la grilla vacía sin spinner
    // y sin mensaje ("intentó cargar las calificaciones pero no lo hizo ni
    // me dio el error"). Ahora sube al catch → ErrorState con el motivo.
    const must = async <T,>(
      label: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: PromiseLike<{ data: T[] | null; error: any }>,
    ): Promise<T[]> => {
      const { data, error } = await query;
      if (error) {
        throw Object.assign(new Error(`${label}: ${error.message ?? String(error)}`), {
          code: error.code,
          details: error.details,
        });
      }
      return data ?? [];
    };

    setLoadingCourse(true);
    try {
    // Exams (incluye cut_id para el consolidado de cortes)
    const examsRaw = await must<Exam>(
      "exams",
      (supabase as any)
        .from("exams")
        // `*` y no la lista de columnas: `makeup_kind`/`recovery_rule` llegan con
        // la mig 20262650000000, y el frontend puede desplegarse ANTES que ella.
        // Pedirlas por nombre haría fallar la consulta entera; sin ellas la regla
        // cae al supletorio de siempre.
        .select("*")
        .eq("course_id", courseId)
        .is("deleted_at", null)
        .order("start_time"),
    );
    // Excluir borradores (status='draft') — igual que app.student.grades.tsx.
    // Un examen en borrador no tiene entregas → score null → computeWeightedGrade
    // lo cuenta como 0 con su peso, arrastrando la nota final HACIA ABAJO. El
    // alumno NO lo ve, así que sin este filtro el consolidado docente + los
    // certificados divergían de la nota real del estudiante. Invariante
    // gradebook ↔ app.student.grades (ver CLAUDE.md): ambos deben excluir draft.
    const exams = ((examsRaw ?? []) as Exam[]).filter((e) => (e.status ?? "published") !== "draft");

    // Talleres del curso: los que tienen fila en workshop_courses (M:N, incluye
    // los COMPARTIDOS a este curso como secundario) MÁS los anclados a este
    // curso que no la tienen. Solo por la fila de unión, un taller duplicado o
    // importado sin ella quedaba INVISIBLE: sin columna y fuera de la nota
    // (medido en UNIAJ el 2026-09-30: tres talleres del corte 2 al 10 %).
    // La fila del taller se guarda TAL CUAL; el corte y el peso en este curso
    // los resuelve `corteYPesoEnCurso` (manda la de unión si tiene corte).
    const [wcData, wsAncla] = await Promise.all([
      must<any>(
        "workshop_courses",
        db
          .from("workshop_courses")
          // `workshop:workshops(*)` y no la lista: `parent_workshop_id` y las
          // columnas de recuperación (mig 20262660000000) pueden llegar después
          // que el frontend; pedirlas por nombre haría fallar la consulta entera.
          .select("workshop_id, cut_id, weight, workshop:workshops(*)")
          .eq("course_id", courseId),
      ),
      must<Workshop>(
        "workshops",
        db.from("workshops").select("*").eq("course_id", courseId).is("deleted_at", null),
      ),
    ]);
    const wcMap = new Map<string, FilaDeUnion>(
      (wcData ?? []).map((wc: any) => [
        wc.workshop_id ?? wc.workshop?.id,
        { cut_id: wc.cut_id ?? null, weight: wc.weight ?? null },
      ]),
    );
    const workshops = [
      ...new Map<string, Workshop>(
        [...(wcData ?? []).map((wc: any) => wc.workshop), ...(wsAncla ?? [])]
          .filter(
            (w: any) =>
              w &&
              !w.deleted_at && // en papelera → excluido
              (w.status ?? "published") !== "draft", // borrador → no cuenta (paridad estudiante)
          )
          .map((w: any) => [w.id, w as Workshop]),
      ).values(),
    ];

    // Cortes evaluativos
    const cutsData = await must<Cut>(
      "grade_cuts",
      db
        .from("grade_cuts")
        .select(
          "id, name, position, start_date, end_date, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
        )
        .eq("course_id", courseId)
        .order("position"),
    );

    // Proyectos: igual que los talleres — por project_courses (secundarios
    // incluidos) más los anclados a este curso. Una fila de unión SIN corte
    // (la que crea el auto-reparo de la pantalla de proyectos, con el peso por
    // defecto de 1) no manda: el corte y el peso salen de la fila del proyecto.
    const PRJ_COLS =
      "id, title, course_id, max_score, is_external, deleted_at, status, cut_id, weight, due_date";
    const [pcData, prjAncla] = await Promise.all([
      must<any>(
        "project_courses",
        db
          .from("project_courses")
          .select(`project_id, cut_id, weight, project:projects(${PRJ_COLS})`)
          .eq("course_id", courseId),
      ),
      must<Project>(
        "projects",
        db.from("projects").select(PRJ_COLS).eq("course_id", courseId).is("deleted_at", null),
      ),
    ]);
    const pcMap = new Map<string, FilaDeUnion>(
      (pcData ?? []).map((pc: any) => [
        pc.project_id ?? pc.project?.id,
        { cut_id: pc.cut_id ?? null, weight: pc.weight ?? null },
      ]),
    );
    const projectsData = [
      ...new Map<string, Project>(
        [...(pcData ?? []).map((pc: any) => pc.project), ...(prjAncla ?? [])]
          .filter(
            (p: any) =>
              p &&
              !p.deleted_at && // en papelera → excluido
              (p.status ?? "published") !== "draft", // borrador → no cuenta (paridad estudiante)
          )
          .map((p: any) => [p.id, p as Project]),
      ).values(),
    ];

    // Sesiones de asistencia. cut_id es el FK explícito al corte
    // (migración 20260509020000). Si llega null, la sesión no aporta a
    // ningún corte — comportamiento intencional del docente.
    const sessions = await must<AttSession>(
      "attendance_sessions",
      db
        .from("attendance_sessions")
        .select("id, session_date, cut_id")
        .eq("course_id", courseId)
        .is("deleted_at", null),
    );

    if (stale()) return;
    setAllExams((exams ?? []) as Exam[]);
    setAllWorkshops(workshops);
    setWsUnion(wcMap);
    setCuts((cutsData ?? []) as Cut[]);
    setProjects(projectsData);
    setPrjUnion(pcMap);
    setAttSessions((sessions ?? []) as AttSession[]);

    // Build columns: original exams (no parent) + workshops + projects
    const examCols: GradeColumn[] = ((exams ?? []) as Exam[])
      .filter((e) => !e.parent_exam_id)
      .map((e) => ({
        id: e.id,
        title: e.title,
        kind: "exam" as const,
        parentExamId: null,
        weight: e.weight ?? null,
        cutId: e.cut_id ?? null,
      }));

    // Solo talleres ORIGINALES tienen columna: la nota de una recuperación se
    // pliega en la del original (getGrade), con la insignia S/R. El corte y el
    // peso de la columna son los que usa la nota (`corteYPesoEnCurso`): si no
    // coincidieran, el detalle del corte mostraría un taller que no suma, o
    // «Sin corte» uno que sí.
    const wsCols: GradeColumn[] = workshops
      .filter((w) => !w.parent_workshop_id)
      .map((w) => {
        const r = corteYPesoEnCurso(wcMap.get(w.id), w, courseId);
        return {
          id: w.id,
          title: w.title,
          kind: "workshop" as const,
          maxScore: w.max_score,
          isExternal: !!w.is_external,
          weight: r.cutId ? r.weight : null,
          cutId: r.cutId,
        };
      });

    const prjCols: GradeColumn[] = projectsData.map((p) => {
      const r = corteYPesoEnCurso(pcMap.get(p.id), p, courseId);
      return {
        id: p.id,
        title: p.title,
        kind: "project" as const,
        maxScore: p.max_score,
        isExternal: !!p.is_external,
        weight: r.cutId ? r.weight : null,
        cutId: r.cutId,
      };
    });

    setColumns([...examCols, ...wsCols, ...prjCols]);

    // Students
    const enr = await must<any>(
      "course_enrollments",
      supabase.from("course_enrollments").select("user_id").eq("course_id", courseId),
    );
    const userIds = (enr ?? []).map((r: any) => r.user_id);

    if (userIds.length) {
      const profs = await must<any>(
        "profiles",
        supabase
          .from("profiles")
          .select("id, full_name, institutional_email, personal_email, cohorte")
          .in("id", userIds)
          .order("full_name"),
      );
      if (stale()) return;
      setStudents((profs ?? []) as Student[]);
    } else {
      setStudents([]);
    }

    // Exam submissions
    const examIds = (exams ?? []).map((e: any) => e.id);
    if (examIds.length) {
      // Paginado (`todasLasFilas`): PostgREST corta en 1000 filas sin avisar,
      // y de estas tablas por estudiante sale la nota — ver el helper.
      const es = await must<any>(
        "submissions",
        todasLasFilas((desde, hasta) =>
          supabase
            .from("submissions")
            .select("id, exam_id, user_id, ai_grade, final_override_grade, status, created_at")
            .in("exam_id", examIds)
            .order("id")
            .range(desde, hasta),
        ),
      );
      if (stale()) return;
      setExamSubs((es ?? []) as ExamSub[]);
    } else {
      setExamSubs([]);
    }

    // Nombres de los grupos de talleres y proyectos (se llenan abajo).
    const nombres: Array<{ id: string; name: string }> = [];

    // Workshop submissions
    const wsIds = (workshops ?? []).map((w: any) => w.id);
    if (wsIds.length) {
      const ws = await must<any>(
        "workshop_submissions",
        todasLasFilas((desde, hasta) =>
          supabase
            .from("workshop_submissions")
            .select("id, workshop_id, user_id, group_id, ai_grade, final_grade, status")
            .in("workshop_id", wsIds)
            .order("id")
            .range(desde, hasta),
        ),
      );
      if (stale()) return;
      setWsSubs((ws ?? []) as WsSub[]);
      // Membresía de grupos de estos talleres → userId → set(group_id).
      const wsMap = new Map<string, Set<string>>();
      const wgroups = await must<any>(
        "workshop_groups",
        (supabase as any).from("workshop_groups").select("id, name").in("workshop_id", wsIds),
      );
      const wgIds = ((wgroups ?? []) as Array<{ id: string }>).map((g) => g.id);
      nombres.push(...((wgroups ?? []) as Array<{ id: string; name: string }>));
      if (wgIds.length) {
        const wmembers = await must<any>(
          "workshop_group_members",
          todasLasFilas((desde, hasta) =>
            (supabase as any)
              .from("workshop_group_members")
              .select("group_id, user_id")
              .in("group_id", wgIds)
              .order("group_id")
              .order("user_id")
              .range(desde, hasta),
          ),
        );
        for (const m of (wmembers ?? []) as Array<{ group_id: string; user_id: string }>) {
          if (!wsMap.has(m.user_id)) wsMap.set(m.user_id, new Set());
          wsMap.get(m.user_id)!.add(m.group_id);
        }
      }
      if (stale()) return;
      setWsGroupsByUser(wsMap);
    } else {
      setWsSubs([]);
      setWsGroupsByUser(new Map());
    }

    // Project submissions (todos los estudiantes)
    const prjIds = ((projectsData ?? []) as Project[]).map((p) => p.id);
    if (prjIds.length && userIds.length) {
      const ps = await must<ProjectSub>(
        "project_submissions",
        todasLasFilas((desde, hasta) =>
          db
            .from("project_submissions")
            .select("project_id, user_id, group_id, ai_grade, final_grade, status")
            .in("project_id", prjIds)
            .order("id")
            .range(desde, hasta),
        ),
      );
      if (stale()) return;
      setProjectSubs((ps ?? []) as ProjectSub[]);
      const prjMap = new Map<string, Set<string>>();
      const pgroups = await must<any>(
        "project_groups",
        (db as any).from("project_groups").select("id, name").in("project_id", prjIds),
      );
      const pgIds = ((pgroups ?? []) as Array<{ id: string }>).map((g) => g.id);
      nombres.push(...((pgroups ?? []) as Array<{ id: string; name: string }>));
      if (pgIds.length) {
        const pmembers = await must<any>(
          "project_group_members",
          todasLasFilas((desde, hasta) =>
            (db as any)
              .from("project_group_members")
              .select("group_id, user_id")
              .in("group_id", pgIds)
              .order("group_id")
              .order("user_id")
              .range(desde, hasta),
          ),
        );
        for (const m of (pmembers ?? []) as Array<{ group_id: string; user_id: string }>) {
          if (!prjMap.has(m.user_id)) prjMap.set(m.user_id, new Set());
          prjMap.get(m.user_id)!.add(m.group_id);
        }
      }
      if (stale()) return;
      setPrjGroupsByUser(prjMap);
    } else {
      setProjectSubs([]);
      setPrjGroupsByUser(new Map());
    }
    setNombresDeGrupos(new Map(nombres.map((g) => [g.id, g.name])));

    // Attendance records (todas las sesiones del curso)
    const sessIds = ((sessions ?? []) as AttSession[]).map((s) => s.id);
    if (sessIds.length && userIds.length) {
      const ar = await must<AttRecord>(
        "attendance_records",
        todasLasFilas((desde, hasta) =>
          db
            .from("attendance_records")
            .select("session_id, user_id, status")
            .in("session_id", sessIds)
            .order("id")
            .range(desde, hasta),
        ),
      );
      if (stale()) return;
      setAttRecords((ar ?? []) as AttRecord[]);
    } else {
      setAttRecords([]);
    }

    // Asignaciones de las actividades del curso, por estudiante.
    const [asigEx, asigWs, asigPrj] = await Promise.all([
      examIds.length
        ? must<{ exam_id: string; user_id: string }>(
            "exam_assignments",
            todasLasFilas((desde, hasta) =>
              db
                .from("exam_assignments")
                .select("exam_id, user_id")
                .in("exam_id", examIds)
                .order("id")
                .range(desde, hasta),
            ),
          )
        : Promise.resolve([]),
      wsIds.length
        ? must<{ workshop_id: string; user_id: string }>(
            "workshop_assignments",
            todasLasFilas((desde, hasta) =>
              db
                .from("workshop_assignments")
                .select("workshop_id, user_id")
                .in("workshop_id", wsIds)
                .order("id")
                .range(desde, hasta),
            ),
          )
        : Promise.resolve([]),
      prjIds.length
        ? must<{ project_id: string; user_id: string }>(
            "project_assignments",
            todasLasFilas((desde, hasta) =>
              db
                .from("project_assignments")
                .select("project_id, user_id")
                .in("project_id", prjIds)
                .order("id")
                .range(desde, hasta),
            ),
          )
        : Promise.resolve([]),
    ]);
    const asig = new Map<string, Asignaciones>();
    const de = (uid: string) => {
      let a = asig.get(uid);
      if (!a) {
        a = { examenes: new Set(), talleres: new Set(), proyectos: new Set() };
        asig.set(uid, a);
      }
      return a;
    };
    for (const r of asigEx) de(r.user_id).examenes.add(r.exam_id);
    for (const r of asigWs) de(r.user_id).talleres.add(r.workshop_id);
    for (const r of asigPrj) de(r.user_id).proyectos.add(r.project_id);
    if (stale()) return;
    setAsignaciones(asig);

    if (stale()) return;
    setCourseDataError(null);
    setEdits({});
    } catch (e) {
      if (stale()) return;
      // El motivo real (tabla + mensaje de Postgres) va al `hint` del
      // ErrorState; el título lleva la traducción amigable. Antes esto no
      // existía: el fallo se descartaba y el área de notas quedaba en blanco.
      const friendly = friendlyError(e, t("hc_routesAppTeacherGradebook.loadErrorMessage"));
      const detail = (e as Error)?.message;
      setCourseDataError(detail && detail !== friendly ? `${friendly} — ${detail}` : friendly);
      // Sin datos consistentes es peor mostrar una grilla a medias: el
      // docente creería que esas SON las notas reales del curso.
      setColumns([]);
      setStudents([]);
    } finally {
      if (!stale()) setLoadingCourse(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, retryNonce]);

  useEffect(() => {
    void loadCourse();
  }, [loadCourse]);

  // Cuántos estudiantes de la lista hay en cada grupo (talleres y proyectos).
  const integrantesPorGrupo = useMemo(() => {
    const m = new Map<string, number>();
    for (const st of students) {
      for (const gid of wsGroupsByUser.get(st.id) ?? []) m.set(gid, (m.get(gid) ?? 0) + 1);
      for (const gid of prjGroupsByUser.get(st.id) ?? []) m.set(gid, (m.get(gid) ?? 0) + 1);
    }
    return m;
  }, [students, wsGroupsByUser, prjGroupsByUser]);
  const grupoDeCelda = (groupId: string | null | undefined): GrupoDeCelda | undefined =>
    groupId
      ? { nombre: nombresDeGrupos.get(groupId) ?? "", integrantes: integrantesPorGrupo.get(groupId) ?? 0 }
      : undefined;
  // Entrega de grupo de un taller → estudiantes de la lista que la comparten.
  // Es lo que hace que editar la celda de uno cambie la de todo su grupo.
  const integrantesDeEntrega = useMemo(
    () => integrantesPorEntrega(wsSubs, wsGroupsByUser, students.map((st) => st.id)),
    [wsSubs, wsGroupsByUser, students],
  );

  // Get the effective grade for a student + column
  const getGrade = (
    studentId: string,
    col: GradeColumn,
  ): {
    grade: number | null;
    isMakeup: boolean;
    makeupKind?: TipoRecuperacion;
    status?: string;
    subId?: string;
    grupo?: GrupoDeCelda;
  } => {
    if (col.kind === "exam") {
      const examMeta = allExams.find((e) => e.id === col.id);
      if (!examMeta) return { grade: null, isMakeup: false };
      const propios = examSubs.filter((s) => s.user_id === studentId);
      // Supletorio y recuperatorio: la regla es UNA y vive en
      // nota-con-recuperacion.ts (con su espejo SQL para el acta).
      const r = notaDeExamenParaEstudiante(examMeta, allExams, propios);
      // Para editar la celda, el intento del examen de donde salió la nota; sin
      // nota, el más reciente del original (aunque esté en curso), como antes.
      const examenDelIntento = r.examIdFuente ?? col.id;
      const latest = propios
        .filter((s) => s.exam_id === examenDelIntento)
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
      const esRecuperacion = r.fuente === "supletorio" || r.fuente === "recuperatorio";
      return {
        grade: r.nota,
        isMakeup: esRecuperacion,
        makeupKind: esRecuperacion ? (r.fuente as TipoRecuperacion) : undefined,
        status: latest?.status,
        subId: latest?.id,
      };
    } else if (col.kind === "workshop") {
      const wMeta = allWorkshops.find((w) => w.id === col.id);
      if (!wMeta) return { grade: null, isMakeup: false };
      // Precedencia de GRUPO sobre la entrega individual obsoleta (modo mixto):
      // si el alumno entregó individual ANTES de ser agrupado, esa fila vieja
      // coexiste con la del grupo. La vista del estudiante ya prioriza la grupal
      // (app.student.grades.tsx); acá replicamos para no divergir docente↔alumno.
      const subDe = (wid: string) =>
        wsSubs.find(
          (s) => s.workshop_id === wid && !!s.group_id && !!wsGroupsByUser.get(studentId)?.has(s.group_id),
        ) ?? wsSubs.find((s) => s.workshop_id === wid && s.user_id === studentId);
      const wById = new Map(allWorkshops.map((w) => [w.id, w]));
      // Supletorio y recuperatorio: la regla es UNA (nota-con-recuperacion.ts),
      // con su espejo SQL para el acta (`workshop_effective_raw_grade`). La nota
      // usa `notaEfectivaDeTaller` (respeta la sustentación).
      const notaDe = (wid: string) => {
        const w = wById.get(wid);
        const sub = subDe(wid);
        return {
          id: wid,
          presento: entregaHecha(sub ?? null),
          nota: notaEfectivaDeTaller(sub ?? null, w?.requires_defense),
        };
      };
      const filas: FilaDeTaller[] = allWorkshops.map((w) => ({
        id: w.id,
        parent_workshop_id: w.parent_workshop_id ?? null,
        makeup_kind: w.makeup_kind ?? null,
        recovery_rule: w.recovery_rule ?? null,
        created_at: w.created_at ?? null,
        status: w.status ?? null,
        deleted_at: null,
      }));
      const r = notaDeTallerConRecuperaciones(
        { id: col.id, parent_workshop_id: null },
        filas,
        notaDe,
      );
      const subFuente = subDe(r.idFuente ?? col.id);
      const esRecuperacion = r.fuente === "supletorio" || r.fuente === "recuperatorio";
      return {
        grade: r.nota,
        isMakeup: esRecuperacion,
        makeupKind: esRecuperacion ? (r.fuente as TipoRecuperacion) : undefined,
        status: subFuente?.status,
        subId: subFuente?.id,
        grupo: grupoDeCelda(subFuente?.group_id),
      };
    } else {
      // project — misma precedencia de GRUPO sobre individual que en talleres.
      const sub =
        projectSubs.find(
          (s) =>
            s.project_id === col.id &&
            !!s.group_id &&
            !!prjGroupsByUser.get(studentId)?.has(s.group_id),
        ) ?? projectSubs.find((s) => s.project_id === col.id && s.user_id === studentId);
      if (sub)
        return {
          grade: sub.final_grade ?? sub.ai_grade,
          isMakeup: false,
          status: sub.status,
          // project_submissions no expone `id` en la query actual; sin
          // subId no podemos editar inline. Se considera follow-up
          // separado si se quiere editar proyectos desde aquí.
          subId: undefined,
          grupo: grupoDeCelda(sub.group_id),
        };
      return { grade: null, isMakeup: false };
    }
  };

  // Edit handler
  const cellKey = (studentId: string, colId: string) => `${studentId}::${colId}`;

  /**
   * Una celda cuya nota sale de una entrega de GRUPO edita esa entrega, que es
   * la misma para todos sus integrantes: el valor se copia a las celdas de sus
   * compañeros para que se vea lo que de verdad va a cambiar. Antes cambiaba
   * solo la celda tocada y, al guardar, las de los demás «saltaban» solas — o,
   * si se escribía distinto en dos integrantes, ganaba el último sin aviso.
   */
  const handleEdit = (studentId: string, colId: string, value: string) => {
    const col = columns.find((c) => c.id === colId);
    const g = col ? getGrade(studentId, col) : undefined;
    const companeros =
      col && col.kind === "workshop" && g?.subId && g.grupo
        ? (integrantesDeEntrega.get(g.subId) ?? []).filter(
            (sid) => sid !== studentId && getGrade(sid, col).subId === g.subId,
          )
        : [];
    setEdits((prev) => {
      const next = { ...prev, [cellKey(studentId, colId)]: value };
      for (const sid of companeros) next[cellKey(sid, colId)] = value;
      return next;
    });
  };

  // Save all edits
  const saveAll = async () => {
    // Anti doble-submit: el loop es secuencial y puede tardar; un segundo
    // click arrancaba una segunda pasada sobre los mismos `edits`.
    if (saving) return;
    // Las celdas de un mismo grupo apuntan a la misma entrega: se guarda una vez.
    const entries = unaVezPorEntrega(
      Object.entries(edits).filter(([, v]) => v !== ""),
      ([key]) => {
        const [studentId, colId] = key.split("::");
        const col = columns.find((c) => c.id === colId);
        if (!col || col.kind !== "workshop") return null;
        const g = getGrade(studentId, col);
        return g.subId && g.grupo ? g.subId : null;
      },
    );
    if (!entries.length) {
      toast.info(
        i18n.t("toast.routes_app_teacher_gradebook.noChangesToSave", {
          defaultValue: "No hay cambios para guardar",
        }),
      );
      return;
    }

    setSaving(true);
    setSaveProgress({ done: 0, total: entries.length });
    let saved = 0;
    let errors = 0;
    // Guardamos el PRIMER error real: antes solo se contaba `errors++` y el
    // objeto se descartaba, así que el toast atribuía TODO a "solo se pueden
    // editar entregas existentes" incluso cuando la causa era RLS (42501),
    // un CHECK o la red.
    let firstError: unknown = null;
    let processed = 0;
    // Distingue "terminó (con o sin errores por fila)" de "lanzó y quedó a
    // mitad". Solo en el segundo caso conservamos los `edits` y NO recargamos.
    let threw = false;
    try {
    for (const [key, value] of entries) {
      processed++;
      setSaveProgress({ done: processed, total: entries.length });
      const [studentId, colId] = key.split("::");
      const col = columns.find((c) => c.id === colId);
      if (!col) continue;

      const numValue = Number(value);
      if (isNaN(numValue)) {
        errors++;
        continue;
      }

      if (col.kind === "exam") {
        const g = getGrade(studentId, col);
        if (g.subId) {
          const { error } = await supabase
            .from("submissions")
            .update({ final_override_grade: numValue })
            .eq("id", g.subId);
          if (error) {
            errors++;
            if (!firstError) firstError = error;
          } else {
            saved++;
            void logEvent({
              action: "grade.manual_override",
              category: "grading",
              severity: "warning",
              entityType: "submission",
              entityId: g.subId,
              courseId: courseId ?? null,
              metadata: {
                source: "gradebook",
                kind: "exam",
                exam_id: col.id,
                student_id: studentId,
                new: numValue,
              },
            });
          }
        } else {
          errors++; // No submission to update
        }
      } else if (col.kind === "workshop") {
        const g = getGrade(studentId, col);
        if (g.subId) {
          const { error } = await supabase
            .from("workshop_submissions")
            .update({ final_grade: numValue, status: "calificado" })
            .eq("id", g.subId);
          if (error) {
            errors++;
            if (!firstError) firstError = error;
          } else {
            saved++;
            void logEvent({
              action: "grade.manual_override",
              category: "grading",
              severity: "warning",
              entityType: "workshop_submission",
              entityId: g.subId,
              courseId: courseId ?? null,
              metadata: {
                source: "gradebook",
                kind: "workshop",
                workshop_id: col.id,
                student_id: studentId,
                new: numValue,
              },
            });
          }
        } else {
          errors++; // No submission to update
        }
      } else {
        // project — la cell muestra read-only en la grilla porque
        // projectSubs no carga `id`; saltamos. Si se quiere editar
        // desde aquí, hay que extender projectSubs select y getGrade.
        errors++;
      }
    }

    } catch (e) {
      // Un throw a mitad del loop (red caída, sesión expirada) dejaba
      // `saving=true` PARA SIEMPRE — el botón "Guardar cambios" quedaba
      // trabado con el spinner y sin ningún mensaje. Ahora se reporta y el
      // finally libera el botón.
      threw = true;
      toast.error(
        friendlyError(
          e,
          i18n.t("toast.routes_app_teacher_gradebook.gradesSaveFailed", {
            defaultValue: "No pudimos guardar las calificaciones",
          }),
        ),
        { duration: 12000 },
      );
    } finally {
      // Los toasts de resultado van en el `finally`, no al final del `try`: si
      // el loop lanza en la nota 12 de 20, las 11 que SÍ se guardaron tienen
      // que reportarse igual. Antes el throw las saltaba y el docente no sabía
      // cuáles habían quedado.
      if (saved > 0)
        toast.success(
          i18n.t("toast.routes_app_teacher_gradebook.gradesSaved", {
            defaultValue: "{{count}} calificación(es) guardada(s) correctamente",
            count: saved,
          }),
        );
      if (errors > 0)
        toast.error(
          firstError
            ? i18n.t("toast.routes_app_teacher_gradebook.gradesSaveErrorsWithCause", {
                defaultValue: "{{count}} error(es). Primero: {{error}}",
                count: errors,
                error: friendlyError(firstError),
              })
            : i18n.t("toast.routes_app_teacher_gradebook.gradesSaveErrors", {
                defaultValue: "{{count}} error(es) — solo se pueden editar entregas existentes",
                count: errors,
              }),
          { duration: 12000 },
        );
      // Los valores tipeados se limpian SOLO si el guardado no lanzó. En el
      // camino de excepción se conservan a propósito: son trabajo del docente
      // que todavía no está en la base, y limpiarlos lo hace desaparecer de la
      // pantalla sin forma de recuperarlo.
      if (!threw) setEdits({});
      setSaving(false);
      setSaveProgress(null);
    }
    // Recargar SOLO en el camino feliz: `loadCourse` termina llamando
    // `setEdits({})`, así que en el camino de excepción borraba ~1-2s después
    // las notas que acabamos de decidir conservar.
    if (!threw) void loadCourse();
  };

  // Export CSV / Excel. `exportCourse` es el wrapper con manejo de error:
  // la generación del XLSX (toXLSX) y la descarga pueden lanzar, y sin este
  // try/catch el click no producía NI archivo NI mensaje.
  const exportCourse = (format: "csv" | "xlsx" = "csv") => {
    try {
      buildAndDownloadExport(format);
    } catch (e) {
      toast.error(friendlyError(e, t("hc_routesAppTeacherGradebook.bulkGenerateError")), {
        duration: 12000,
      });
    }
  };

  const buildAndDownloadExport = (format: "csv" | "xlsx" = "csv") => {
    if (!students.length || !columns.length) {
      toast.info(
        i18n.t("toast.routes_app_teacher_gradebook.noDataToExport", {
          defaultValue: "No hay datos para exportar",
        }),
      );
      return;
    }

    // Mapa user_id → calificaciones consolidadas por corte + final
    // ponderada. Usa la misma lógica del consolidado en pantalla, así
    // el CSV refleja exactamente lo que ve el docente.
    const consolidatedByUser = new Map<
      string,
      {
        cutGrades: Array<{ cutId: string; grade: number | null }>;
        finalGrade: number | null;
        attByCut: Array<{ cutId: string; score: number | null }>;
      }
    >();
    if (consolidated) {
      for (const r of consolidated) {
        consolidatedByUser.set(r.student.id, {
          cutGrades: r.cutGrades,
          finalGrade: r.finalGrade,
          attByCut: r.attByCut,
        });
      }
    }
    const fmt = (n: number | null | undefined) => (n != null ? n.toFixed(2) : "");

    // ¿El curso usa cohortes? Si al menos un estudiante tiene cohorte,
    // agregamos una columna "Cohorte" y AGRUPAMOS las filas por cohorte
    // (orden es-CO; sin cohorte al final) para que el export sea legible
    // por grupo. Si no hay cohortes, se mantiene el orden por nombre.
    const anyCohort = students.some((s) => !!s.cohorte?.trim());
    const cohortHeader = t("hc_routesAppTeacherGradebook.csvCohort", { defaultValue: "Cohorte" });
    const exportStudents = anyCohort
      ? [...students].sort((a, b) => {
          const ca = (a.cohorte ?? "").trim();
          const cb = (b.cohorte ?? "").trim();
          if (ca !== cb) {
            if (!ca) return 1; // sin cohorte al final
            if (!cb) return -1;
            return ca.localeCompare(cb, "es-CO", { numeric: true, sensitivity: "base" });
          }
          return a.full_name.localeCompare(b.full_name, "es-CO", {
            numeric: true,
            sensitivity: "base",
          });
        })
      : students;

    // Etiqueta de columna de item — debe ser IDÉNTICA tanto en el row de datos
    // como en la fila de grupo del Excel (es la KEY del objeto que ambos usan),
    // así que la centralizamos para que no diverjan.
    const itemLabel = (col: GradeColumn) => {
      const prefix =
        col.kind === "workshop"
          ? t("hc_routesAppTeacherGradebook.csvWorkshopPrefix")
          : col.kind === "project"
            ? t("hc_routesAppTeacherGradebook.csvProjectPrefix")
            : "";
      const pct = col.weight != null ? ` (${col.weight}%)` : "";
      return `${prefix}${col.title}${pct}`;
    };

    // Orden de columnas de item AGRUPADO POR CORTE para que el merge de la fila
    // de grupo (Excel) tenga celdas contiguas. Vamos corte por corte (en el
    // orden de `cuts`, que ya viene por `position`), emitiendo los items del
    // corte y luego — si aplica — una columna de "Asistencia" del corte; al
    // final los items sin corte ("Sin corte"). NO reordenamos el `columns`
    // state (la grilla en pantalla depende de su orden por tipo): este orden
    // es exclusivo del export.
    const attendanceLabel = t("hc_routesAppTeacherGradebook.csvAttendance", {
      defaultValue: "Asistencia",
    });
    // ¿Algún estudiante tiene asistencia computable en este corte? (mismo
    // criterio que el consolidado: hay sesiones en el corte → score != null).
    const cutHasAttendance = (cutId: string) =>
      // > 0, no `!= null`: un corte con attendance_weight = 0 (bucket sin
      // peso) no aporta a la nota → no debe agregar una columna espuria
      // "Asistencia (0%)" al export. Alineado con el filtro > 0 del cálculo.
      Number(cuts.find((c) => c.id === cutId)?.attendance_weight ?? 0) > 0 &&
      (consolidated?.some((r) => r.attByCut.find((a) => a.cutId === cutId)?.score != null) ??
        false);

    // Cada entrada describe una columna del export: cómo se llama (key del
    // objeto = encabezado), a qué corte pertenece (para el group header del
    // Excel) y cómo sacar el valor por estudiante.
    type ExportCol =
      | { key: string; group: string | null; kind: "item"; col: GradeColumn }
      | { key: string; group: string | null; kind: "attendance"; cutId: string };

    const exportCols: ExportCol[] = [];
    cuts.forEach((cut) => {
      const groupLabel = `${cut.name} (${cut.weight}%)`;
      const items = columnsByCut.get(cut.id) ?? [];
      items.forEach((col) => {
        exportCols.push({ key: itemLabel(col), group: groupLabel, kind: "item", col });
      });
      if (cutHasAttendance(cut.id)) {
        // Key única por corte (asistencia incluye el % del bucket del corte +
        // el nombre del corte) para que dos cortes no colapsen su "Asistencia"
        // en la misma key del objeto.
        const attKey = `${attendanceLabel} (${cut.attendance_weight}%) · ${cut.name}`;
        exportCols.push({ key: attKey, group: groupLabel, kind: "attendance", cutId: cut.id });
      }
    });
    // Items sin corte → grupo "Sin corte" (sin %). Quedan al final.
    const uncut = columnsByCut.get(null) ?? [];
    if (uncut.length) {
      const uncutGroup = t("hc_routesAppTeacherGradebook.csvNoCut", { defaultValue: "Sin corte" });
      uncut.forEach((col) => {
        exportCols.push({ key: itemLabel(col), group: uncutGroup, kind: "item", col });
      });
    }

    const csvRows = exportStudents.map((s) => {
      const stuConsolidated = consolidatedByUser.get(s.id);
      const row: Record<string, string> = {
        [t("hc_routesAppTeacherGradebook.csvName")]: s.full_name,
      };
      // Columna Cohorte (2ª, junto al nombre) sólo si el curso usa cohortes.
      if (anyCohort) row[cohortHeader] = s.cohorte?.trim() ?? "";
      row[t("hc_routesAppTeacherGradebook.csvInstitutionalEmail")] = s.institutional_email;
      row[t("hc_routesAppTeacherGradebook.csvPersonalEmail")] = s.personal_email ?? "";
      // Detalle item por item (exámenes/talleres/proyectos con su nota cruda) +
      // la asistencia del corte, agrupados por corte. El encabezado de cada item
      // incluye su % (peso sobre la nota final) — igual que los cortes muestran
      // su % (ej. "Parcial 1 (15%)").
      exportCols.forEach((ec) => {
        if (ec.kind === "item") {
          const g = getGrade(s.id, ec.col);
          row[ec.key] =
            g.grade != null
              ? `${g.grade}${
                  g.isMakeup
                    ? g.makeupKind === "recuperatorio"
                      ? t("recuperaciones.csvRecuperatorioSuffix")
                      : t("hc_routesAppTeacherGradebook.csvMakeupSuffix")
                    : ""
                }`
              : "";
        } else {
          const score = stuConsolidated?.attByCut.find((a) => a.cutId === ec.cutId)?.score ?? null;
          row[ec.key] = fmt(score);
        }
      });
      // Calificación por corte + final ponderada al final del row, en
      // orden de los cortes para que sea fácil de leer en Excel.
      cuts.forEach((cut) => {
        const cg = stuConsolidated?.cutGrades.find((c) => c.cutId === cut.id);
        row[`${cut.name} (${cut.weight}%)`] = fmt(cg?.grade ?? null);
      });
      row[t("hc_routesAppTeacherGradebook.csvFinalGrade")] = fmt(
        stuConsolidated?.finalGrade ?? null,
      );
      return row;
    });

    const courseName =
      courses.find((c) => c.id === courseId)?.name ??
      t("hc_routesAppTeacherGradebook.courseFallback");
    const fileBase = `${t("hc_routesAppTeacherGradebook.csvFilePrefix")}-${courseName.replace(
      /\s+/g,
      "_",
    )}-${Date.now()}`;
    if (format === "xlsx") {
      // Fila de grupo EXCLUSIVA de Excel: mapea la etiqueta de cada columna de
      // item/asistencia a su grupo de corte "Corte N (peso%)" (peso = % de la
      // nota global del curso) — o "Sin corte" para los items sin corte. Las
      // columnas de nombre/cohorte/email/cortes/final quedan en blanco (no se
      // mapean). Como las columnas del mismo corte van CONTIGUAS (orden de
      // exportCols), toXLSX auto-combina sus celdas en la fila de grupo.
      const groupHeader: Record<string, string> = {};
      exportCols.forEach((ec) => {
        if (ec.group) groupHeader[ec.key] = ec.group;
      });

      // ── Color tipo grilla de notas ── Pintamos el Excel como el grid en
      // pantalla: encabezado de columnas en negrita + fill gris; fila de grupo
      // de corte con un tono suave; y cada celda de NOTA verde si aprueba
      // (≥ passing_grade del curso) o roja si reprueba (< passing_grade). Las
      // celdas vacías ("—") quedan sin color. Nombre/cohorte/email sin pintar.
      //
      // El índice en `styles` (1-based) es el que devolvemos en cellStyle /
      // headerStyle / groupHeaderStyle (cellXfs 0 = sin estilo).
      const styles = [
        { fill: "FFE7E6E6", bold: true }, // 1 encabezado (gris + negrita)
        { fill: "FFF2F2F2", bold: true, align: "center" as const }, // 2 fila de grupo de corte (gris suave, centrado en la celda combinada)
        { fill: "FFD9EAD3" }, // 3 nota aprobada (verde suave)
        { fill: "FFF4CCCC" }, // 4 nota reprobada (rojo suave)
      ];
      const HEADER_STYLE = 1;
      const GROUP_STYLE = 2;
      const PASS_STYLE = 3;
      const FAIL_STYLE = 4;

      // Columnas que se colorean por aprobado/reprobado. SOLO las que están en la
      // escala del curso [min,max]: asistencia por corte, notas de corte y final.
      // Las columnas de ITEM (kind='item') llevan la nota CRUDA en escala max_score
      // (un taller 40/100 se escribe "40"); compararla contra passing_grade (0..5)
      // pintaba casi todo VERDE (40>=3) aunque 40/100 = 2.0 reprobó. No las
      // coloreamos: el crudo no es comparable con passing_grade y su reescalado
      // correcto depende de max_score/is_external por columna.
      const gradeKeys = new Set<string>();
      exportCols.forEach((ec) => {
        if (ec.kind === "attendance") gradeKeys.add(ec.key);
      });
      cuts.forEach((cut) => gradeKeys.add(`${cut.name} (${cut.weight}%)`));
      gradeKeys.add(t("hc_routesAppTeacherGradebook.csvFinalGrade"));

      const passingGrade = courses.find((c) => c.id === courseId)?.passing_grade;
      // Las notas se escribieron como string ("4.50", "4★" con sufijo de
      // habilitación); parseFloat extrae el número y descarta el sufijo. ""
      // (sin nota) → NaN → sin color.
      const cellStyle = (colKey: string, _rowIndex: number, value: unknown) => {
        if (passingGrade == null || !gradeKeys.has(colKey)) return undefined;
        const n = parseFloat(String(value ?? ""));
        if (!Number.isFinite(n)) return undefined;
        return n >= passingGrade ? PASS_STYLE : FAIL_STYLE;
      };

      // Si ningún item tiene corte, no agregamos la fila de grupo (evita una
      // fila inicial en blanco): omitimos groupHeader del objeto de opciones.
      const hasGroup = Object.keys(groupHeader).length > 0;
      downloadXLSX(
        `${fileBase}.xlsx`,
        toXLSX(csvRows, undefined, "Datos", {
          ...(hasGroup ? { groupHeader, groupHeaderStyle: GROUP_STYLE } : {}),
          styles,
          headerStyle: HEADER_STYLE,
          cellStyle,
        }),
      );
    } else {
      downloadCSV(`${fileBase}.csv`, toCSV(csvRows));
    }
    toast.success(
      i18n.t("toast.routes_app_teacher_gradebook.fileExported", {
        defaultValue: "Archivo exportado correctamente",
      }),
    );
  };

  const hasEdits = Object.values(edits).some((v) => v !== "");
  const selectedCourse = courses.find((c) => c.id === courseId);

  // Filtra estudiantes por nombre o correo. Aplica al consolidado, a la
  // sub-grid de "Sin corte asignado" y al modal de detalle. Tabular nums
  // y exports siguen usando `students` (la lista completa) para que el
  // CSV traiga TODO aunque haya un filtro activo en pantalla.
  const filteredStudents = useMemo(() => {
    if (!studentSearch.trim()) return students;
    const q = studentSearch.toLowerCase();
    return students.filter((s) => {
      const name = s.full_name.toLowerCase();
      const email = s.institutional_email.toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [students, studentSearch]);

  // Agrupa columnas (exámenes + talleres) por corte para que la grilla
  // editable se separe en "items dentro de un corte" (visibles solo en
  // el modal de Ver detalle) vs "items sin corte" (visibles en su
  // propia card debajo del consolidado).
  const columnsByCut = useMemo(() => {
    const map = new Map<string | null, GradeColumn[]>();
    for (const col of columns) {
      // `col.cutId` ya viene resuelto al construir las columnas en loadCourse
      // (exam.cut_id / workshop.cut_id / project_courses.cut_id) — única fuente
      // de verdad, compartida con la fila de grupo del export Excel.
      const cutId = col.cutId ?? null;
      const arr = map.get(cutId) ?? [];
      arr.push(col);
      map.set(cutId, arr);
    }
    return map;
  }, [columns]);

  const uncutColumns = columnsByCut.get(null) ?? [];
  const detailCutColumns = detailCutId ? (columnsByCut.get(detailCutId) ?? []) : [];
  const detailCut = detailCutId ? cuts.find((c) => c.id === detailCutId) : null;

  // ───────── La nota de cada estudiante (peso = % de la nota final)
  // El cálculo es el de nota-del-curso.ts, el MISMO de «Mis notas» y del
  // boletín: la nota es RELATIVA a lo que ya se dio. Una sesión cuenta si
  // alguien quedó marcado en ella; una actividad abierta todavía no le baja la
  // nota a nadie; una entregada sin calificar espera al docente. Antes este
  // archivo tenía su propia copia, y las sesiones futuras entraban como faltas
  // de todo el curso.
  const datosParaNota = useMemo<DatosParaNota | null>(() => {
    if (!selectedCourse) return null;
    return {
      courseId: selectedCourse.id,
      escala: {
        min: Number(selectedCourse.grade_scale_min),
        max: Number(selectedCourse.grade_scale_max),
      },
      cursoFinalizado: selectedCourse.status === "finalizado",
      cortes: cuts,
      examenes: allExams,
      talleres: allWorkshops,
      unionTalleres: wsUnion,
      proyectos: projects,
      unionProyectos: prjUnion,
      sesiones: attSessions,
      sesionesDadas: sesionesDadas(attRecords),
      conNota: actividadesConNota({
        intentos: examSubs,
        entregasTaller: wsSubs,
        talleres: allWorkshops,
        entregasProyecto: projectSubs,
      }),
    };
  }, [
    selectedCourse,
    cuts,
    allExams,
    allWorkshops,
    wsUnion,
    projects,
    prjUnion,
    attSessions,
    attRecords,
    examSubs,
    wsSubs,
    projectSubs,
  ]);

  const notaPorEstudiante = useMemo(() => {
    const porEstudiante = new Map<string, NotaCompleta>();
    if (!datosParaNota) return porEstudiante;
    const ahora = Date.now();
    const estadoAsistencia = new Map<string, string>();
    for (const r of attRecords) estadoAsistencia.set(`${r.session_id}::${r.user_id}`, r.status);
    const intentosDe = new Map<string, ExamSub[]>();
    for (const s of examSubs) {
      const lista = intentosDe.get(s.user_id);
      if (lista) lista.push(s);
      else intentosDe.set(s.user_id, [s]);
    }
    for (const stu of students) {
      // La entrega del GRUPO gana a una individual vieja (modo mixto), igual
      // que la celda (getGrade) y que «Mis notas».
      const entregaTaller = (wid: string) =>
        wsSubs.find(
          (s) =>
            s.workshop_id === wid && !!s.group_id && !!wsGroupsByUser.get(stu.id)?.has(s.group_id),
        ) ?? wsSubs.find((s) => s.workshop_id === wid && s.user_id === stu.id);
      const entregaProyecto = (pid: string) =>
        projectSubs.find(
          (s) =>
            s.project_id === pid && !!s.group_id && !!prjGroupsByUser.get(stu.id)?.has(s.group_id),
        ) ?? projectSubs.find((s) => s.project_id === pid && s.user_id === stu.id);
      porEstudiante.set(
        stu.id,
        notaDelEstudianteEnCurso(
          datosParaNota,
          {
            intentos: intentosDe.get(stu.id) ?? [],
            entregaTaller,
            entregaProyecto,
            estadoAsistencia: (sid) => estadoAsistencia.get(`${sid}::${stu.id}`),
            // Sin ninguna fila, nada asignado (no `undefined`, que es «todo»).
            asignaciones: asignaciones.get(stu.id) ?? SIN_ASIGNACIONES,
          },
          ahora,
        ),
      );
    }
    return porEstudiante;
  }, [
    datosParaNota,
    students,
    attRecords,
    examSubs,
    wsSubs,
    wsGroupsByUser,
    projectSubs,
    prjGroupsByUser,
    asignaciones,
  ]);

  // Consolidado por cortes: lo que muestran la tabla, el export y los
  // certificados. `parcial` = todavía hay algo por darse o por calificar.
  const consolidated = useMemo(() => {
    if (!selectedCourse || !cuts.length || !students.length) return null;
    return students.map((stu) => {
      const n = notaPorEstudiante.get(stu.id);
      return {
        student: stu,
        cutGrades: n?.cutGrades ?? cuts.map((c) => ({ cutId: c.id, grade: null })),
        finalGrade: n?.finalGrade ?? null,
        attByCut: n?.attByCut ?? cuts.map((c) => ({ cutId: c.id, score: null })),
        parcial: n?.parcial ?? true,
      };
    });
  }, [selectedCourse, cuts, students, notaPorEstudiante]);
  const hayNotaParcial = consolidated?.some((r) => r.parcial) ?? false;

  // ── Certificados: emitir individual + bulk + descargar ──

  const issueCertForStudent = useCallback(
    async (studentId: string, finalGrade: number | null) => {
      if (!courseId || finalGrade == null) return;
      if (!selectedCourse) return;
      if (finalGrade < selectedCourse.passing_grade) {
        toast.error(
          i18n.t("toast.routes_app_teacher_gradebook.finalGradeBelowPassing", {
            defaultValue: "La nota final es menor al mínimo de aprobación.",
          }),
        );
        return;
      }
      if (issuingId) return; // anti doble-submit
      setIssuingId(studentId);
      try {
        const { error } = await db.rpc("issue_certificate", {
          _user_id: studentId,
          _course_id: courseId,
          _final_grade: finalGrade,
        });
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
        toast.success(
          i18n.t("toast.routes_app_teacher_gradebook.certificateIssued", {
            defaultValue: "Certificado emitido",
          }),
        );
        await reloadCertificates();
      } catch (e) {
        // Sin este catch, un throw de la RPC (red / sesión) solo apagaba el
        // spinner de la fila y no mostraba NADA.
        toast.error(friendlyError(e));
      } finally {
        setIssuingId(null);
      }
    },
    [courseId, issuingId, reloadCertificates, selectedCourse],
  );

  /**
   * Regenera el certificado de un estudiante: revoca el vigente y emite
   * uno nuevo con la nota actual. Útil cuando la nota cambió, el snapshot
   * de settings cambió (logo/firma/mensaje) o el docente quiere forzar
   * una nueva emisión.
   *
   * El proceso es atómico-ish: si la emisión nueva falla después de
   * revocar la vieja, mostramos el error y el alumno queda sin
   * certificado vigente (puede re-intentarse).
   */
  const regenerateCertForStudent = useCallback(
    async (studentId: string, finalGrade: number | null) => {
      if (!courseId || finalGrade == null || !selectedCourse) return;
      if (finalGrade < selectedCourse.passing_grade) {
        toast.error(
          i18n.t("toast.routes_app_teacher_gradebook.finalGradeBelowPassing", {
            defaultValue: "La nota final es menor al mínimo de aprobación.",
          }),
        );
        return;
      }
      const existing = certByUserId[studentId];
      if (!existing) {
        toast.info(
          i18n.t("toast.routes_app_teacher_gradebook.noActiveCertToRegenerate", {
            defaultValue: "No hay certificado vigente para regenerar — usa Emitir.",
          }),
        );
        return;
      }
      const ok = await confirm({
        title: t("hc_routesAppTeacherGradebook.regenerateCertTitle"),
        description: t("hc_routesAppTeacherGradebook.regenerateCertDescription", {
          grade: finalGrade.toFixed(2),
        }),
        tone: "warning",
        confirmLabel: t("hc_routesAppTeacherGradebook.regenerate"),
      });
      if (!ok) return;
      setIssuingId(studentId);
      try {
        // 1) Revocar el vigente. DEBE ir por la RPC SECURITY DEFINER: la tabla
        // certificates NO tiene policy de UPDATE (todas las escrituras van por
        // RPC), así que un UPDATE directo del cliente afecta 0 filas SIN error
        // → la revocación no ocurría y la re-emisión fallaba con "Ya existe un
        // certificado vigente". Mismo patrón que app.certificates.tsx.
        const { error: revErr } = await db.rpc("revoke_certificate", {
          _certificate_id: existing.id,
          _reason: "regenerado",
        });
        if (revErr) {
          toast.error(
            i18n.t("toast.routes_app_teacher_gradebook.revocationFailed", {
              defaultValue: "Revocación falló: {{error}}",
              error: friendlyError(revErr),
            }),
          );
          return;
        }
        // 2) Emitir uno nuevo.
        const { error: issueErr } = await db.rpc("issue_certificate", {
          _user_id: studentId,
          _course_id: courseId,
          _final_grade: finalGrade,
        });
        if (issueErr) {
          toast.error(
            i18n.t("toast.routes_app_teacher_gradebook.newIssuanceFailed", {
              defaultValue: "Emisión nueva falló: {{error}}",
              error: friendlyError(issueErr),
            }),
          );
          return;
        }
        toast.success(
          i18n.t("toast.routes_app_teacher_gradebook.certificateRegenerated", {
            defaultValue: "Certificado regenerado",
          }),
        );
        await reloadCertificates();
      } catch (e) {
        // Idem `issueCertForStudent`: sin catch un throw de la RPC dejaba la
        // fila sin certificado y sin mensaje de por qué.
        toast.error(friendlyError(e));
      } finally {
        setIssuingId(null);
      }
    },
    [confirm, courseId, certByUserId, reloadCertificates, selectedCourse],
  );

  const bulkIssueAll = useCallback(async () => {
    if (!selectedCourse || !consolidated) return;
    const aprobados = consolidated.filter((r) => {
      if (r.finalGrade == null) return false;
      if (r.finalGrade < selectedCourse.passing_grade) return false;
      if (certByUserId[r.student.id]) return false;
      return true;
    });
    // Con la nota PARCIAL no se emite: es la de lo que ya pasó, y a mitad de
    // semestre casi todos «aprueban» un curso que no terminó.
    const candidates = aprobados.filter((r) => !r.parcial);
    const omitidos = aprobados.length - candidates.length;
    if (candidates.length === 0) {
      toast.info(
        omitidos > 0
          ? t("notaRelativa.certificadosParciales", { count: omitidos })
          : i18n.t("toast.routes_app_teacher_gradebook.noPendingStudents", {
              defaultValue: "Sin estudiantes pendientes: todos los aprobados ya tienen certificado.",
            }),
        { duration: 10000 },
      );
      return;
    }
    const ok = await confirm({
      title: t("hc_routesAppTeacherGradebook.bulkIssueTitle", { count: candidates.length }),
      description: `${t("hc_routesAppTeacherGradebook.bulkIssueDescription", {
        course: selectedCourse.name,
      })}${omitidos > 0 ? ` ${t("notaRelativa.certificadosOmitidos", { count: omitidos })}` : ""}`,
      confirmLabel: t("hc_routesAppTeacherGradebook.issueAll"),
      tone: "warning",
    });
    if (!ok) return;
    if (bulkIssuing) return; // anti doble-submit
    setBulkIssuing(true);
    setBulkProgress({ done: 0, total: candidates.length });
    try {
      let issued = 0;
      let failed = 0;
      // El error de cada RPC se DESCARTABA (`failed++` a secas): el docente
      // veía "Emitidos 0 · 93 fallaron" sin ninguna pista del motivo.
      let firstError: unknown = null;
      let done = 0;
      for (const r of candidates) {
        const { error } = await db.rpc("issue_certificate", {
          _user_id: r.student.id,
          _course_id: courseId,
          _final_grade: r.finalGrade,
        });
        if (error) {
          failed++;
          if (!firstError) firstError = error;
        } else {
          issued++;
        }
        done++;
        setBulkProgress({ done, total: candidates.length });
      }
      const summary = i18n.t("toast.routes_app_teacher_gradebook.certificatesIssuedBulk", {
        defaultValue: "Emitidos {{issued}}{{failedSuffix}}",
        issued,
        failedSuffix:
          failed > 0
            ? i18n.t("toast.routes_app_teacher_gradebook.certificatesIssuedBulkFailedSuffix", {
                defaultValue: " · {{count}} fallaron",
                count: failed,
              })
            : "",
      });
      // Si TODO falló, un toast.success verde era engañoso.
      if (failed > 0) {
        toast.error(
          `${summary}${
            firstError
              ? i18n.t("toast.routes_app_teacher_gradebook.bulkFirstErrorSuffix", {
                  defaultValue: ". Primero: {{error}}",
                  error: friendlyError(firstError),
                })
              : ""
          }`,
          { duration: 12000 },
        );
      } else {
        toast.success(summary);
      }
      await reloadCertificates();
    } catch (e) {
      // Antes solo había `finally`: un throw de la RPC apagaba el spinner y
      // no decía nada — silencio total sobre 93 alumnos sin certificado.
      toast.error(friendlyError(e), { duration: 12000 });
    } finally {
      setBulkIssuing(false);
      setBulkProgress(null);
    }
  }, [
    bulkIssuing,
    confirm,
    consolidated,
    courseId,
    certByUserId,
    reloadCertificates,
    selectedCourse,
  ]);

  /**
   * Genera + descarga TODOS los certificados del curso en un ZIP único.
   *
   * Dos modos:
   *  - `regenerate = false` (default, "Generar y descargar"): emite los
   *    pendientes y descarga el ZIP con todos los vigentes. NO toca a
   *    los ya emitidos.
   *  - `regenerate = true` ("Regenerar todos"): REVOCA todos los
   *    vigentes y emite uno nuevo por cada aprobado, refrescando el
   *    snapshot (nuevo logo/firma/mensaje + nota actual). Útil cuando
   *    cambió la configuración del curso o las notas finales.
   *
   * El docente confirma una sola vez. Si solo quiere emitir sin descargar
   * (flujo asíncrono), usa el botón "Emitir certificados".
   */
  const bulkGenerateAndDownload = useCallback(
    async (regenerate = false) => {
      if (!selectedCourse || !consolidated) return;
      // Universo de aprobados (válidos para emisión, con o sin cert vigente).
      // Quien tiene la nota PARCIAL queda afuera: ni se le emite ni —al
      // regenerar— se le revoca el que tiene, porque se reemplazaría un
      // certificado definitivo por uno con la nota de medio semestre.
      const aprobadosTodos = consolidated.filter((r) => {
        if (r.finalGrade == null) return false;
        if (r.finalGrade < selectedCourse.passing_grade) return false;
        return true;
      });
      const approved = aprobadosTodos.filter((r) => !r.parcial);
      const omitidos = aprobadosTodos.length - approved.length;
      const parcialDe = new Map(consolidated.map((r) => [r.student.id, r.parcial]));
      // En modo regenerar, todos los aprobados se vuelven a emitir.
      // En modo normal, solo los pendientes (sin cert vigente activo).
      const targets = regenerate ? approved : approved.filter((r) => !certByUserId[r.student.id]);
      const existingCount = Object.keys(certByUserId).length;
      if (targets.length === 0 && existingCount === 0) {
        toast.info(
          omitidos > 0
            ? t("notaRelativa.certificadosParciales", { count: omitidos })
            : i18n.t("toast.routes_app_teacher_gradebook.noApprovedIssuable", {
                defaultValue: "No hay aprobados con certificado emitible en este curso.",
              }),
          { duration: 10000 },
        );
        return;
      }
      if (regenerate && approved.length === 0) {
        toast.info(
          omitidos > 0
            ? t("notaRelativa.certificadosParciales", { count: omitidos })
            : i18n.t("toast.routes_app_teacher_gradebook.noApprovedStudents", {
                defaultValue: "No hay estudiantes aprobados en este curso.",
              }),
          { duration: 10000 },
        );
        return;
      }
      const avisoOmitidos =
        omitidos > 0 ? ` ${t("notaRelativa.certificadosOmitidos", { count: omitidos })}` : "";
      const ok = await confirm({
        title: regenerate
          ? t("hc_routesAppTeacherGradebook.bulkRegenerateTitle", { count: approved.length })
          : t("hc_routesAppTeacherGradebook.bulkGenerateTitle", {
              count: targets.length + existingCount,
            }),
        description: `${
          regenerate
            ? t("hc_routesAppTeacherGradebook.bulkRegenerateDescription", {
                count: approved.length,
                course: selectedCourse.name,
              })
            : targets.length > 0
              ? t("hc_routesAppTeacherGradebook.bulkGenerateDescriptionWithIssue", {
                  count: targets.length,
                  course: selectedCourse.name,
                  total: targets.length + existingCount,
                })
              : t("hc_routesAppTeacherGradebook.bulkGenerateDescriptionDownloadOnly", {
                  count: existingCount,
                  course: selectedCourse.name,
                })
        }${avisoOmitidos}`,
        confirmLabel: regenerate
          ? t("hc_routesAppTeacherGradebook.regenerateAll")
          : t("hc_routesAppTeacherGradebook.generateAndDownload"),
        tone: "warning",
      });
      if (!ok) return;
      if (bulkIssuing) return; // anti doble-submit
      setBulkIssuing(true);
      setBulkProgress({ done: 0, total: targets.length });
      try {
        // 1a) En modo regenerar, revocar todos los vigentes primero. DEBE ir por
        // la RPC SECURITY DEFINER `revoke_certificate` fila por fila: la tabla
        // certificates NO tiene policy de UPDATE (todas las escrituras van por
        // RPC), así que un UPDATE directo del cliente afectaba 0 filas SIN error
        // → la revocación masiva no ocurría y la re-emisión fallaba con "Ya
        // existe un certificado vigente". Mismo patrón que el regenerar
        // individual (arriba). certByUserId ya solo contiene vigentes
        // (reloadCertificates filtra .is("revoked_at", null)).
        if (regenerate && existingCount > 0) {
          const vigentes = (
            Object.values(certByUserId) as Array<{ id?: string; user_id?: string }>
          ).filter((c) => c && c.id && !(c.user_id && parcialDe.get(c.user_id)));
          let firstRevErr: unknown = null;
          for (const cert of vigentes) {
            const { error: revErr } = await db.rpc("revoke_certificate", {
              _certificate_id: cert.id,
              _reason: "regenerado en lote",
            });
            if (revErr && !firstRevErr) firstRevErr = revErr;
          }
          if (firstRevErr) {
            toast.error(
              i18n.t("toast.routes_app_teacher_gradebook.bulkRevocationFailed", {
                defaultValue: "Revocación masiva falló: {{error}}",
                error: friendlyError(firstRevErr),
              }),
            );
            return;
          }
          // Refrescamos certByUserId — los vigentes ya no están vigentes.
          await reloadCertificates();
        }
        // 1) Emitir los targets.
        let issued = 0;
        let failed = 0;
        // Primer error real de la emisión: el sufijo " · N falló al emitir"
        // del toast final no decía POR QUÉ.
        let firstIssueError: unknown = null;
        let doneIssuing = 0;
        for (const r of targets) {
          const { error } = await db.rpc("issue_certificate", {
            _user_id: r.student.id,
            _course_id: courseId,
            _final_grade: r.finalGrade,
          });
          if (error) {
            failed++;
            if (!firstIssueError) firstIssueError = error;
          } else issued++;
          doneIssuing++;
          setBulkProgress({ done: doneIssuing, total: targets.length });
        }
        if (firstIssueError) {
          toast.error(
            i18n.t("toast.routes_app_teacher_gradebook.bulkIssueFirstError", {
              defaultValue: "{{count}} certificado(s) no se pudieron emitir. Primero: {{error}}",
              count: failed,
              error: friendlyError(firstIssueError),
            }),
            { duration: 12000 },
          );
        }
        // 2) Recargar la lista de certs para incluir los recién emitidos.
        await reloadCertificates();
        // 3) Leer la lista completa desde DB (state actualizado puede no
        //    estar inmediato — preferimos la fuente de verdad).
        const { data: certs, error: certsErr } = await db
          .from("certificates")
          .select("*")
          .eq("course_id", courseId)
          .is("revoked_at", null)
          .order("student_full_name");
        if (certsErr) {
          toast.error(friendlyError(certsErr));
          return;
        }
        const rows = (certs ?? []) as Array<{
          short_code: string;
          student_full_name: string;
          student_identification: string | null;
          course_name: string;
          course_period: string | null;
          final_grade: number;
          grade_scale_max: number;
          teacher_names: string[];
          university_name: string | null;
          university_logo_url: string | null;
          certificate_message: string | null;
          signature_name: string | null;
          signature_title: string | null;
          signature_image_url: string | null;
          footer_text: string | null;
          issued_at: string;
          payload_hash: string;
          revoked_at: string | null;
        }>;
        if (rows.length === 0) {
          toast.info(
            i18n.t("toast.routes_app_teacher_gradebook.noCertsToDownload", {
              defaultValue: "No quedaron certificados para descargar.",
            }),
          );
          return;
        }
        const items = rows.map((c) => ({
          shortCode: c.short_code,
          studentFullName: c.student_full_name,
          studentIdentification: c.student_identification,
          courseName: c.course_name,
          coursePeriod: c.course_period,
          finalGrade: Number(c.final_grade),
          gradeScaleMax: Number(c.grade_scale_max),
          teacherNames: c.teacher_names ?? [],
          universityName: c.university_name,
          universityLogoUrl: c.university_logo_url,
          certificateMessage: c.certificate_message,
          signatureName: c.signature_name,
          signatureTitle: c.signature_title,
          signatureImageUrl: c.signature_image_url,
          footerText: c.footer_text,
          issuedAt: c.issued_at,
          payloadHash: c.payload_hash,
          revokedAt: c.revoked_at,
        }));
        // 4) Generar PDFs + ZIP + descarga.
        const safeCourse = selectedCourse.name.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
        const today = new Date().toISOString().slice(0, 10);
        await downloadCertificatesZip(items, `Certificados_${safeCourse}_${today}.zip`);
        const issuedMsg =
          issued > 0
            ? i18n.t("toast.routes_app_teacher_gradebook.zipDownloadedIssuedSuffix", {
                defaultValue: " ({{count}} emitido(s))",
                count: issued,
              })
            : "";
        const failedMsg =
          failed > 0
            ? i18n.t("toast.routes_app_teacher_gradebook.zipDownloadedFailedSuffix", {
                defaultValue: " · {{count}} falló al emitir",
                count: failed,
              })
            : "";
        toast.success(
          i18n.t("toast.routes_app_teacher_gradebook.zipDownloaded", {
            defaultValue: "ZIP con {{count}} certificado(s) descargado{{issuedMsg}}{{failedMsg}}",
            count: items.length,
            issuedMsg,
            failedMsg,
          }),
        );
      } catch (e) {
        console.error("[gradebook] bulkGenerateAndDownload failed", e);
        toast.error(friendlyError(e, t("hc_routesAppTeacherGradebook.bulkGenerateError")), {
          duration: 12000,
        });
      } finally {
        setBulkIssuing(false);
        setBulkProgress(null);
      }
    },
    [
      bulkIssuing,
      confirm,
      consolidated,
      courseId,
      certByUserId,
      reloadCertificates,
      selectedCourse,
    ],
  );

  const downloadCertForRow = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (cert: any) => {
      try {
        await downloadCertificate({
          shortCode: cert.short_code,
          studentFullName: cert.student_full_name,
          studentIdentification: cert.student_identification,
          courseName: cert.course_name,
          coursePeriod: cert.course_period,
          finalGrade: Number(cert.final_grade),
          gradeScaleMax: Number(cert.grade_scale_max),
          teacherNames: cert.teacher_names ?? [],
          universityName: cert.university_name,
          universityLogoUrl: cert.university_logo_url,
          certificateMessage: cert.certificate_message,
          signatureName: cert.signature_name,
          signatureTitle: cert.signature_title,
          signatureImageUrl: cert.signature_image_url,
          footerText: cert.footer_text,
          issuedAt: cert.issued_at,
          payloadHash: cert.payload_hash,
          revokedAt: cert.revoked_at,
        });
      } catch (e) {
        toast.error(friendlyError(e, i18n.t("hc_routesAppTeacherGradebook.pdfGenerationError")));
      }
    },
    [],
  );

  // «Ver la plataforma como» vive SOLO en Mis estudiantes (rol Docente).
  // Acá estorbaba: el gradebook es una matriz de notas y su fila es una
  // CALIFICACIÓN, no una persona — entrar a la sesión de alguien desde una
  // celda de nota es una acción de otra naturaleza, y el ojo al lado del
  // nombre competía con lo que se viene a hacer, que es calificar.

  if (authLoading) return null;
  if (!isTeacher)
    return (
      <p className="text-muted-foreground">
        {t("hc_routesAppTeacherGradebook.needTeacherRole")}
      </p>
    );

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<ClipboardList className="h-6 w-6" />}
          title={t("hc_routesAppTeacherGradebook.pageTitle")}
        />
        <ErrorState
          message={t("hc_routesAppTeacherGradebook.loadErrorMessage")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ClipboardList className="h-6 w-6" />}
        title={t("hc_routesAppTeacherGradebook.pageTitle")}
        subtitle={t("hc_routesAppTeacherGradebook.pageSubtitle")}
        actions={
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          {gbShowSubjectFilter && (
            <Select
              value={subjectFilter ?? "__all_subjects__"}
              onValueChange={(v) =>
                gbCambiarAlcance({ subject: v === "__all_subjects__" ? null : v })
              }
            >
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all_subjects__">{t("listFilters.allSubjects")}</SelectItem>
                {gbFilterSubjects.map((sj) => (
                  <SelectItem key={sj} value={sj}>
                    {sj}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {gbShowPeriodFilter && (
            <Select
              value={periodFilter ?? "__all_periods__"}
              onValueChange={(v) =>
                gbCambiarAlcance({ period: v === "__all_periods__" ? null : v })
              }
            >
              <SelectTrigger className="w-full sm:w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all_periods__">{t("listFilters.allPeriods")}</SelectItem>
                {gbFilterPeriods.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <CourseSelect
            courses={gbCoursesInScope}
            value={courseId}
            onChange={(v) => v && setCourseId(v)}
            placeholder={t("hc_routesAppTeacherGradebook.coursePlaceholder")}
            triggerClassName="w-full sm:w-56"
          />
          {hasEdits && (
            <Button size="sm" onClick={() => void saveAll()} disabled={saving}>
              {saving ? (
                <Spinner size="md" className="mr-1" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              {t("hc_routesAppTeacherGradebook.saveChanges")}
              {/* Contador de progreso: el guardado es un loop secuencial de
                  updates y sin esto el docente no sabe si avanza. */}
              {saving && saveProgress && (
                <span className="ml-1.5 tabular-nums text-2xs opacity-90">
                  {saveProgress.done}/{saveProgress.total}
                </span>
              )}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline">
                <Download className="h-4 w-4 mr-1" />
                {t("hc_routesAppTeacherGradebook.exportLabel", { defaultValue: "Exportar" })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportCourse("csv")}>
                <FileText className="h-4 w-4 mr-2" />
                CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportCourse("xlsx")}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Excel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {/* Acciones de certificados — agrupadas en dropdown para no
              saturar la toolbar (en mobile las 3 caían en filas separadas
              y opacaban Guardar/CSV). El icono Award + caret marca que
              hay sub-acciones; el dropdown abre con labels descriptivos. */}
          {selectedCourse && consolidated && consolidated.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={bulkIssuing}>
                  {bulkIssuing ? (
                    <Spinner size="md" className="mr-1" />
                  ) : (
                    <Award className="h-4 w-4 mr-1" />
                  )}
                  {t("hc_routesAppTeacherGradebook.certificates")}
                  {/* Progreso de la emisión/regeneración masiva (loop de RPCs
                      por alumno): sin él el botón solo giraba sin decir cuánto
                      falta ni si sigue vivo. */}
                  {bulkIssuing && bulkProgress && (
                    <span className="ml-1.5 tabular-nums text-2xs opacity-90">
                      {bulkProgress.done}/{bulkProgress.total}
                    </span>
                  )}
                  <ChevronDown className="h-3.5 w-3.5 ml-1 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>
                  {t("hc_routesAppTeacherGradebook.bulkActions")}
                </DropdownMenuLabel>
                <DropdownMenuItem
                  onClick={() => void bulkIssueAll()}
                  disabled={bulkIssuing}
                  title={t("hc_routesAppTeacherGradebook.issueCertsHint")}
                >
                  <Award className="h-4 w-4 mr-2" />
                  <span className="flex-1">
                    {t("hc_routesAppTeacherGradebook.issueCerts")}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void bulkGenerateAndDownload(false)}
                  disabled={bulkIssuing}
                  title={t("hc_routesAppTeacherGradebook.generateDownloadBulkHint")}
                >
                  <Download className="h-4 w-4 mr-2" />
                  <span className="flex-1">
                    {t("hc_routesAppTeacherGradebook.generateDownloadBulk")}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => void bulkGenerateAndDownload(true)}
                  disabled={bulkIssuing || Object.keys(certByUserId).length === 0}
                  title={t("hc_routesAppTeacherGradebook.regenerateAllHint")}
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  <span className="flex-1">
                    {t("hc_routesAppTeacherGradebook.regenerateAll")}
                  </span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          </div>
        }
      />

      <NoAssignedCoursesNotice courseCount={courses.length} loading={!coursesLoaded} />

      {selectedCourse && (
        <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 bg-muted/30">
          <div className="flex items-center gap-1.5 text-sm">
            <Scale className="h-4 w-4 text-primary" />
            <span className="font-medium">{t("hc_routesAppTeacherGradebook.scaleLabel")}</span>
            <span className="tabular-nums">
              {selectedCourse.grade_scale_min} – {selectedCourse.grade_scale_max}
            </span>
          </div>
          <div className="text-sm text-muted-foreground inline-flex items-center gap-1">
            {t("hc_routesAppTeacherGradebook.passLabel")}{" "}
            <span className="font-medium tabular-nums">{selectedCourse.passing_grade}</span>
          </div>
          <div className="text-sm text-muted-foreground inline-flex items-center gap-1">
            {t("hc_routesAppTeacherGradebook.howFinalGradeCalculated")}
            <HelpHint>
              {t("hc_routesAppTeacherGradebook.finalGradeHelpPrefix")}{" "}
              <strong>{t("hc_routesAppTeacherGradebook.evaluativeCuts")}</strong>{" "}
              {t("hc_routesAppTeacherGradebook.finalGradeHelpSuffix")}{" "}
              {t("notaRelativa.explicacion")}
            </HelpHint>
          </div>
          {hayNotaParcial && (
            <div className="text-sm inline-flex items-center gap-1.5">
              <Badge variant="outline" className="text-3xs whitespace-nowrap shrink-0">
                {t("notaRelativa.notaParcial")}
              </Badge>
              <span className="text-muted-foreground">{t("notaRelativa.soloLoQueSeDio")}</span>
            </div>
          )}
        </div>
      )}

      {/* Búsqueda por estudiante — filtra el consolidado, "Sin corte" y
          el modal de detalle. Útil cuando el curso tiene 30-40 alumnos y
          el docente busca uno específico. El CSV exporta TODO igual. */}
      {selectedCourse && students.length > 0 && (
        <SearchInput
          value={studentSearch}
          onChange={setStudentSearch}
          placeholder={t("hc_routesAppTeacherGradebook.searchStudentPlaceholder")}
        />
      )}

      {/* Estado de CARGA del curso. Antes no existía: mientras las ~14
          queries de `loadCourse` corrían, debajo del header no había nada
          (ni spinner ni skeleton), así que "no pasaba nada" era
          indistinguible de "ya cargó y está vacío" o "falló". */}
      {selectedCourse && loadingCourse && (
        <Card>
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Spinner size="sm" />
            <h2 className="text-sm font-semibold">
              {t("hc_routesAppTeacherGradebook.loadingGrades", {
                defaultValue: "Cargando calificaciones del curso…",
              })}
            </h2>
          </div>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableBody>
                <TableSkeleton cols={5} rows={6} />
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Fallo al cargar las notas del curso — con el motivo real y
          Reintentar. Este es el caso que antes quedaba en SILENCIO. */}
      {selectedCourse && !loadingCourse && courseDataError && (
        <ErrorState
          message={t("hc_routesAppTeacherGradebook.loadErrorMessage")}
          hint={courseDataError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      )}

      {/* Curso sin matriculados: `consolidated` es null y NADA se renderizaba
          debajo del header — otra pantalla en blanco sin explicación. */}
      {selectedCourse && !loadingCourse && !courseDataError && students.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title={t("hc_routesAppTeacherGradebook.noStudentsEnrolledTitle", {
            defaultValue: "Este curso no tiene estudiantes matriculados",
          })}
          description={t("hc_routesAppTeacherGradebook.noStudentsEnrolledHint", {
            defaultValue:
              "Matricula estudiantes al curso para poder registrar y consolidar sus notas.",
          })}
        />
      )}

      {/* Curso cargado OK pero sin nada que calificar: mensaje explícito en
          vez de una pantalla vacía que se confunde con un fallo. */}
      {selectedCourse &&
        !loadingCourse &&
        !courseDataError &&
        students.length > 0 &&
        cuts.length === 0 &&
        uncutColumns.length === 0 && (
          <EmptyState
            icon={ClipboardList}
            title={t("hc_routesAppTeacherGradebook.nothingToGradeTitle", {
              defaultValue: "Este curso todavía no tiene nada que calificar",
            })}
            description={t("hc_routesAppTeacherGradebook.nothingToGradeHint", {
              defaultValue:
                "Crea cortes evaluativos y publica exámenes, talleres o proyectos para ver la grilla de notas.",
            })}
          />
        )}

      {/* Consolidado por cortes — solo lectura */}
      {selectedCourse && !loadingCourse && !courseDataError && consolidated && cuts.length > 0 && (
        <Card>
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
              {t("hc_routesAppTeacherGradebook.consolidatedByCuts")}
              <HelpHint>{t("help.consolidatedByCutsExplanation")}</HelpHint>
            </h2>
            <Badge variant="outline" className="text-3xs">
              {t("hc_routesAppTeacherGradebook.readOnly")}
            </Badge>
          </div>
          {/* En el teléfono, una tarjeta por estudiante: la matriz de cortes se
              desplazaba en horizontal (578 px en 356) y no se podía recorrer con
              el pulgar (auditoría móvil 2026-10-10). Desde sm sigue la tabla. */}
          <ul className="sm:hidden divide-y">
            {consolidated
              .filter((r) => filteredStudents.some((s) => s.id === r.student.id))
              .map((row) => {
                const aprueba =
                  row.finalGrade != null ? row.finalGrade >= selectedCourse.passing_grade : null;
                return (
                  <li key={row.student.id} className="px-4 py-3 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <span className="font-medium text-sm min-w-0 break-words">
                        {row.student.full_name}
                      </span>
                      <Badge
                        variant={aprueba === false ? "destructive" : "secondary"}
                        className="shrink-0 tabular-nums"
                      >
                        {t("gradebook.finalColumn")}:{" "}
                        {formatNumber(row.finalGrade, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {cuts.map((c) => {
                        const cg = row.cutGrades.find((g) => g.cutId === c.id);
                        return (
                          <button
                            key={c.id}
                            type="button"
                            className="tabular-nums underline-offset-2 hover:underline min-h-8"
                            onClick={() => {
                              setDetailCutId(c.id);
                              setDetailStudentId(row.student.id);
                            }}
                          >
                            {c.name}:{" "}
                            {formatNumber(cg?.grade ?? null, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
          </ul>
          <CardContent className="hidden sm:block p-0 max-h-[70dvh] overflow-auto">
            <Table>
              <TableHeader sticky>
                <TableRow>
                  <TableHead className="sticky left-0 z-10 bg-card min-w-36 sm:min-w-48">
                    {t("gradebook.studentColumn")}
                  </TableHead>
                  {cuts.map((c, idx) => {
                    const itemCount = (columnsByCut.get(c.id) ?? []).length;
                    const tint = CUT_TINTS[idx % CUT_TINTS.length];
                    return (
                      <TableHead key={c.id} className={`text-center min-w-28 sm:min-w-32 ${tint}`}>
                        <div className="flex flex-col items-center gap-1 py-1">
                          <span
                            className="truncate max-w-28 font-semibold text-foreground"
                            title={c.name}
                          >
                            {c.name}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-3xs py-0 h-4 px-1.5 bg-background/60"
                          >
                            {c.weight}% ·{" "}
                            {t("hc_routesAppTeacherGradebook.itemCount", { count: itemCount })}
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2 text-3xs gap-1"
                            onClick={() => setDetailCutId(c.id)}
                            disabled={itemCount === 0}
                            title={
                              itemCount === 0
                                ? t("hc_routesAppTeacherGradebook.noItemsInCut")
                                : t("hc_routesAppTeacherGradebook.viewCutDetailHint")
                            }
                          >
                            <Eye className="h-3 w-3" />
                            {t("hc_routesAppTeacherGradebook.detail")}
                          </Button>
                        </div>
                      </TableHead>
                    );
                  })}
                  <TableHead className="text-center min-w-24 bg-muted/40">
                    {t("gradebook.finalColumn")}
                  </TableHead>
                  <TableHead className="text-center min-w-28 sm:min-w-32">
                    {t("hc_routesAppTeacherGradebook.certificateColumn")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(() => {
                  // Filtra el consolidado por los IDs visibles. Construir
                  // el Set fuera del map evita O(n²) sobre listas grandes.
                  const visibleIds = new Set(filteredStudents.map((s) => s.id));
                  const visible = consolidated.filter((r) => visibleIds.has(r.student.id));
                  if (visible.length === 0) {
                    return (
                      <TableRow>
                        <TableCell
                          colSpan={cuts.length + 3}
                          className="text-center text-muted-foreground py-6 text-sm"
                        >
                          {studentSearch.trim()
                            ? t("hc_routesAppTeacherGradebook.noMatches")
                            : t("hc_routesAppTeacherGradebook.noStudents")}
                        </TableCell>
                      </TableRow>
                    );
                  }
                  return visible.map((row) => {
                    const passes =
                      row.finalGrade != null
                        ? row.finalGrade >= selectedCourse.passing_grade
                        : null;
                    return (
                      <TableRow key={row.student.id}>
                        <TableCell className="sticky left-0 z-10 bg-card max-w-36 sm:max-w-48">
                          <div
                            className="flex items-baseline gap-2 min-w-0"
                            title={`${row.student.full_name} · ${row.student.institutional_email}`}
                          >
                            <span className="font-medium text-sm truncate shrink">
                              {row.student.full_name}
                            </span>
                            <span className="text-xs text-muted-foreground truncate shrink-[2] hidden sm:inline">
                              {row.student.institutional_email}
                            </span>
                          </div>
                        </TableCell>
                        {row.cutGrades.map((cg, ci) => {
                          // Mismo orden de tintes que el header → la columna
                          // quedar visualmente alineada con su corte.
                          const CELL_TINTS = [
                            "bg-indigo-500/[0.03] dark:bg-indigo-500/[0.06] border-l-2 border-indigo-500/20",
                            "bg-emerald-500/[0.03] dark:bg-emerald-500/[0.06] border-l-2 border-emerald-500/20",
                            "bg-amber-500/[0.03] dark:bg-amber-500/[0.06] border-l-2 border-amber-500/20",
                            "bg-cyan-500/[0.03] dark:bg-cyan-500/[0.06] border-l-2 border-cyan-500/20",
                          ];
                          const cellTint = CELL_TINTS[ci % CELL_TINTS.length];
                          // Estado pasable/no pasable de un corte: usamos la
                          // misma referencia (passing_grade del curso) para
                          // resaltar visualmente cuando una nota individual
                          // está por debajo. NO afecta la lógica, solo color.
                          const passesCut =
                            cg.grade != null && cg.grade >= selectedCourse.passing_grade;
                          return (
                            <TableCell
                              key={cg.cutId}
                              className={`text-center text-sm tabular-nums ${cellTint} ${
                                cg.grade == null
                                  ? "text-muted-foreground"
                                  : passesCut
                                    ? "text-emerald-700 dark:text-emerald-400 font-medium"
                                    : "text-amber-700 dark:text-amber-400"
                              }`}
                            >
                              {cg.grade != null ? cg.grade.toFixed(2) : "—"}
                            </TableCell>
                          );
                        })}
                        <TableCell
                          className={`text-center text-sm font-semibold tabular-nums bg-muted/30 ${
                            passes === true
                              ? "text-success"
                              : passes === false
                                ? "text-destructive"
                                : ""
                          }`}
                        >
                          {row.finalGrade != null ? row.finalGrade.toFixed(2) : "—"}
                        </TableCell>
                        <TableCell className="text-center">
                          {(() => {
                            const cert = certByUserId[row.student.id];
                            if (cert) {
                              return (
                                <div className="flex items-center justify-center gap-1">
                                  <Badge
                                    variant="outline"
                                    className="text-3xs text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
                                  >
                                    {t("hc_routesAppTeacherGradebook.issued")}
                                  </Badge>
                                  <RowAction
                                    label={t("hc_routesAppTeacherGradebook.downloadPdf")}
                                    icon={Download}
                                    onClick={() => void downloadCertForRow(cert)}
                                  />
                                  <RowAction
                                    label={t("hc_routesAppTeacherGradebook.openVerification")}
                                    icon={Eye}
                                    onClick={() => {
                                      window.open(buildVerifyUrl(cert.short_code), "_blank");
                                    }}
                                  />
                                  {/* Regenerar con la nota parcial reemplazaría el
                                      certificado definitivo por uno de medio semestre. */}
                                  {!row.parcial && (
                                    <RowAction
                                      label={t("hc_routesAppTeacherGradebook.regenerateRowAction")}
                                      icon={RefreshCw}
                                      onClick={() =>
                                        void regenerateCertForStudent(row.student.id, row.finalGrade)
                                      }
                                    />
                                  )}
                                </div>
                              );
                            }
                            if (row.parcial) {
                              return (
                                <span className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
                                  {t("notaRelativa.notaParcial")}
                                  <HelpHint side="left">
                                    {t("notaRelativa.certificadoParcialHint")}
                                  </HelpHint>
                                </span>
                              );
                            }
                            if (passes !== true) {
                              return (
                                <span className="text-2xs text-muted-foreground">
                                  {t("hc_routesAppTeacherGradebook.notPassing")}
                                </span>
                              );
                            }
                            return (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 text-2xs"
                                onClick={() =>
                                  void issueCertForStudent(row.student.id, row.finalGrade)
                                }
                                disabled={issuingId === row.student.id}
                              >
                                {issuingId === row.student.id ? (
                                  <Spinner size="xs" className="mr-1" />
                                ) : (
                                  <Award className="h-3 w-3 mr-1" />
                                )}
                                {t("hc_routesAppTeacherGradebook.issue")}
                              </Button>
                            );
                          })()}
                        </TableCell>
                      </TableRow>
                    );
                  });
                })()}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Items sin corte asignado — antes formaban parte del grid grande,
          ahora viven en su propia tarjeta. Items con corte se editan
          desde el modal "Ver detalle" del consolidado. */}
      {!loadingCourse && !courseDataError && uncutColumns.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Inbox className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">
                {t("hc_routesAppTeacherGradebook.noCutAssigned")}
              </h2>
              <p className="text-xs text-muted-foreground">
                {t("hc_routesAppTeacherGradebook.noCutAssignedDescription")}
              </p>
            </div>
          </div>
          {renderEditableGrid({
            columns: uncutColumns,
            students: filteredStudents,
            getGrade,
            edits,
            handleEdit,
            cellKey,
            selectedCourse,
          })}
        </Card>
      )}

      {/* Modal de detalle por corte — abre con "Ver detalle" en el header
          del consolidado. Muestra una sub-tabla por tipo (Talleres /
          Exámenes / Proyectos) + la Asistencia por estudiante sobre las
          sesiones del corte (cut_id) que ya se dieron. Las ediciones comparten
          el state `edits` y se guardan con el botón global "Guardar cambios". */}
      <Dialog
        open={detailCutId != null}
        onOpenChange={(o) => {
          if (!o) setDetailCutId(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t("hc_routesAppTeacherGradebook.cutDetailTitle", { name: detailCut?.name ?? "" })}
              {detailCut && (
                <Badge variant="outline" className="ml-2 text-3xs">
                  {detailCut.weight}%
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          {detailCut &&
            renderCutDetailGrouped({
              cut: detailCut,
              columns: detailCutColumns,
              students: filteredStudents,
              notaDe: (id) => notaPorEstudiante.get(id),
              attSessions,
              onOpenStudent: setDetailStudentId,
            })}
        </DialogContent>
      </Dialog>

      {/* Modal anidado: detalle por estudiante DENTRO de un corte. Se
          abre desde el ojo "Ver detalle" en cada fila del modal del corte.
          Muestra cada item del corte para ESE estudiante (workshops,
          exámenes, proyectos editables; asistencia read-only). */}
      <Dialog
        open={detailStudentId != null && detailCutId != null}
        onOpenChange={(o) => {
          if (!o) setDetailStudentId(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {(() => {
                const stu = students.find((x) => x.id === detailStudentId);
                return (
                  <>
                    {t("hc_routesAppTeacherGradebook.studentDetailTitle", {
                      name: stu?.full_name ?? "—",
                    })}
                    {detailCut && (
                      <span className="text-muted-foreground text-sm font-normal ml-2">
                        · {detailCut.name}
                      </span>
                    )}
                  </>
                );
              })()}
            </DialogTitle>
          </DialogHeader>
          {detailCut &&
            detailStudentId &&
            renderStudentCutDetail({
              cut: detailCut,
              columns: detailCutColumns,
              studentId: detailStudentId,
              getGrade,
              edits,
              handleEdit,
              cellKey,
              selectedCourse,
              attSessions,
              nota: notaPorEstudiante.get(detailStudentId),
            })}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ───────────────────────── Detalle de corte (resumen por bucket) ─────────────────────────
// Vista dentro del modal "Ver detalle del corte X". Resumen de 4 columnas
// (Talleres / Exámenes / Proyectos / Asistencia) por estudiante: cada
// celda es la nota PONDERADA del bucket dentro del corte (en escala del
// curso), con la MISMA regla de la nota del corte — lo que todavía no cuenta
// (abierto, por calificar) tampoco entra acá. Eye button por fila abre un
// segundo modal con el desglose completo (cada item + asistencia).
function renderCutDetailGrouped({
  cut,
  columns,
  students,
  notaDe,
  attSessions,
  onOpenStudent,
}: {
  cut: Cut;
  columns: GradeColumn[];
  students: Student[];
  notaDe: (studentId: string) => NotaCompleta | undefined;
  attSessions: AttSession[];
  onOpenStudent: (studentId: string) => void;
}) {
  // Sesiones PROGRAMADAS en el corte (FK attendance_sessions.cut_id, mig
  // 20260509020000). La nota de asistencia se calcula sobre las que se dieron.
  const sessionsInCut = attSessions.filter((s) => s.cut_id === cut.id);

  const workshopCols = columns.filter((c) => c.kind === "workshop");
  const examCols = columns.filter((c) => c.kind === "exam");
  const projectCols = columns.filter((c) => c.kind === "project");
  const showWorkshops = workshopCols.length > 0 || Number(cut.workshop_weight ?? 0) > 0;
  const showExams = examCols.length > 0 || Number(cut.exam_weight ?? 0) > 0;
  const showProjects = projectCols.length > 0 || Number(cut.project_weight ?? 0) > 0;
  const showAttendance = Number(cut.attendance_weight ?? 0) > 0;

  if (
    workshopCols.length === 0 &&
    examCols.length === 0 &&
    projectCols.length === 0 &&
    !showAttendance
  ) {
    return (
      <p className="text-sm text-muted-foreground py-6 text-center">
        {i18n.t("hc_routesAppTeacherGradebook.cutNoActivities")}
      </p>
    );
  }

  // Subtotal de un bucket = promedio PONDERADO de lo que cuenta de ese tipo en
  // este corte, con las notas ya en la escala del curso. Antes era un promedio
  // simple de lo calificado, así que un taller vencido sin entregar (que en la
  // nota del corte vale 0) no aparecía acá y el bucket decía otra cosa.
  const bucketNota = (studentId: string, tipo: DetalleDeItem["tipo"]): number | null =>
    computeWeightedGrade(
      (notaDe(studentId)?.items ?? [])
        .filter((i) => i.tipo === tipo && i.cutId === cut.id && i.cuenta)
        .map((i) => ({ score: i.score, weight: i.weight })),
    );
  // Cuántas se dieron es del curso, no del estudiante: da igual de quién se lea.
  const dadasEnCorte = students.length
    ? (notaDe(students[0].id)?.asistencia.get(cut.id)?.dadas ?? 0)
    : 0;

  // Chips de resumen de pesos arriba del grid.
  const bucketSummary = [
    {
      label: i18n.t("hc_routesAppTeacherGradebook.workshops"),
      icon: Hammer,
      weight: Number(cut.workshop_weight ?? 0) || 0,
    },
    {
      label: i18n.t("hc_routesAppTeacherGradebook.exams"),
      icon: FileText,
      weight: Number(cut.exam_weight ?? 0) || 0,
    },
    {
      label: i18n.t("hc_routesAppTeacherGradebook.projects"),
      icon: FolderKanban,
      weight: Number(cut.project_weight ?? 0) || 0,
    },
    {
      label: i18n.t("hc_routesAppTeacherGradebook.attendance"),
      icon: CalendarCheck,
      weight: Number(cut.attendance_weight ?? 0) || 0,
    },
  ].filter((b) => b.weight > 0);

  return (
    <div className="space-y-3">
      {bucketSummary.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
          <span className="text-2xs text-muted-foreground">
            {i18n.t("hc_routesAppTeacherGradebook.cutBuckets")}
          </span>
          {bucketSummary.map((b) => (
            <Badge key={b.label} variant="outline" className="text-3xs gap-1 py-0 h-5">
              <b.icon className="h-3 w-3" />
              {b.label}: {b.weight.toFixed(1)}%
            </Badge>
          ))}
        </div>
      )}

      <div className="rounded-md border overflow-hidden">
        <CardContent className="p-0 max-h-[70dvh] overflow-auto">
          <Table>
            <TableHeader sticky>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card min-w-36 sm:min-w-48">
                  {i18next.t("gradebook.studentColumn")}
                </TableHead>
                {showWorkshops && (
                  <TableHead className="text-center min-w-28">
                    <div className="inline-flex items-center gap-1">
                      <Hammer className="h-3 w-3 text-amber-500 dark:text-amber-400" />
                      {i18n.t("hc_routesAppTeacherGradebook.workshops")}
                    </div>
                  </TableHead>
                )}
                {showExams && (
                  <TableHead className="text-center min-w-28">
                    <div className="inline-flex items-center gap-1">
                      <FileText className="h-3 w-3 text-primary" />
                      {i18n.t("hc_routesAppTeacherGradebook.exams")}
                    </div>
                  </TableHead>
                )}
                {showProjects && (
                  <TableHead className="text-center min-w-28">
                    <div className="inline-flex items-center gap-1">
                      <FolderKanban className="h-3 w-3 text-indigo-500 dark:text-indigo-400" />
                      {i18n.t("hc_routesAppTeacherGradebook.projects")}
                    </div>
                  </TableHead>
                )}
                {showAttendance && (
                  <TableHead className="text-center min-w-28 bg-amber-400/5">
                    <div className="inline-flex items-center gap-1">
                      <CalendarCheck className="h-3 w-3 text-primary" />
                      {i18n.t("hc_routesAppTeacherGradebook.attendance")}
                    </div>
                  </TableHead>
                )}
                <TableHead className="text-right w-[1%]">
                  {i18next.t("gradebook.detailColumn")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={
                      1 +
                      (showWorkshops ? 1 : 0) +
                      (showExams ? 1 : 0) +
                      (showProjects ? 1 : 0) +
                      (showAttendance ? 1 : 0) +
                      1
                    }
                    className="text-center text-muted-foreground py-8"
                  >
                    {i18n.t("hc_routesAppTeacherGradebook.noEnrolledStudents")}
                  </TableCell>
                </TableRow>
              )}
              {students.map((s) => {
                const wAvg = bucketNota(s.id, "taller");
                const eAvg = bucketNota(s.id, "examen");
                const pAvg = bucketNota(s.id, "proyecto");
                const att = notaDe(s.id)?.asistencia.get(cut.id);
                return (
                  <TableRow key={s.id}>
                    <TableCell className="sticky left-0 z-10 bg-card max-w-36 sm:max-w-48">
                      <div
                        className="flex items-baseline gap-2 min-w-0"
                        title={`${s.full_name} · ${s.institutional_email}`}
                      >
                        <span className="font-medium text-sm truncate shrink">{s.full_name}</span>
                        <span className="text-xs text-muted-foreground truncate shrink-[2] hidden sm:inline">{s.institutional_email}</span>
                      </div>
                    </TableCell>
                    {showWorkshops && (
                      <TableCell className="text-center text-sm tabular-nums">
                        {wAvg != null ? wAvg.toFixed(2) : "—"}
                      </TableCell>
                    )}
                    {showExams && (
                      <TableCell className="text-center text-sm tabular-nums">
                        {eAvg != null ? eAvg.toFixed(2) : "—"}
                      </TableCell>
                    )}
                    {showProjects && (
                      <TableCell className="text-center text-sm tabular-nums">
                        {pAvg != null ? pAvg.toFixed(2) : "—"}
                      </TableCell>
                    )}
                    {showAttendance && (
                      <TableCell className="text-center bg-amber-400/5">
                        {att && att.dadas > 0 ? (
                          <div className="flex flex-col items-center gap-0.5">
                            <span className="text-sm tabular-nums font-medium">
                              {att.nota != null ? att.nota.toFixed(2) : "—"}
                            </span>
                            <span className="text-3xs text-muted-foreground tabular-nums">
                              {att.presentes}/{att.dadas}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      <RowAction
                        label={i18n.t("hc_routesAppTeacherGradebook.viewStudentDetail")}
                        icon={Eye}
                        onClick={() => onOpenStudent(s.id)}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </div>

      {showAttendance && sessionsInCut.length === 0 && (
        <p className="text-2xs text-muted-foreground italic">
          {i18n.t("hc_routesAppTeacherGradebook.noAttendanceSessionsHint")}
        </p>
      )}
      {showAttendance && sessionsInCut.length > 0 && dadasEnCorte < sessionsInCut.length && (
        <p className="text-2xs text-muted-foreground italic">
          {i18n.t("notaRelativa.asistenciaSesionesDadas", {
            dadas: dadasEnCorte,
            count: sessionsInCut.length,
          })}
        </p>
      )}
    </div>
  );
}

// ───────────────────────── Detalle por estudiante (modal anidado) ─────────────────────────
// Render del modal interno que se abre desde el ojo "Ver detalle" en
// cada fila del modal del corte. Lista CADA item del corte (workshops,
// exámenes, proyectos) para ESE estudiante con su nota editable, más
// la fila de asistencia con presentes/dadas/nota (read-only).
function renderStudentCutDetail({
  cut,
  columns,
  studentId,
  getGrade,
  edits,
  handleEdit,
  cellKey,
  selectedCourse,
  attSessions,
  nota,
}: {
  cut: Cut;
  columns: GradeColumn[];
  studentId: string;
  getGrade: (
    studentId: string,
    col: GradeColumn,
  ) => {
    grade: number | null;
    isMakeup: boolean;
    makeupKind?: TipoRecuperacion;
    status?: string;
    subId?: string;
    grupo?: GrupoDeCelda;
  };
  edits: EditMap;
  handleEdit: (studentId: string, colId: string, value: string) => void;
  cellKey: (studentId: string, colId: string) => string;
  selectedCourse: Course | undefined;
  attSessions: AttSession[];
  /** La nota del estudiante (nota-del-curso.ts): de ahí sale qué cuenta y por qué. */
  nota: NotaCompleta | undefined;
}) {
  // Sesiones PROGRAMADAS en el corte (FK cut_id, mig 20260509020000); la nota
  // de asistencia es sobre las que se DIERON (con al menos una marca).
  const programadas = attSessions.filter((s) => s.cut_id === cut.id).length;
  const asis = nota?.asistencia.get(cut.id);
  const presentCount = asis?.presentes ?? 0;
  const totalSess = asis?.dadas ?? 0;
  const attPct = totalSess > 0 ? presentCount / totalSess : 0;
  const attNota = asis?.nota ?? null;
  const TIPO_DE_COLUMNA = { exam: "examen", workshop: "taller", project: "proyecto" } as const;
  // Por qué una actividad sin nota cuenta o no, dicho con la regla relativa.
  const motivoSinNota = (col: GradeColumn): string | null => {
    const d = nota?.items.find((i) => i.tipo === TIPO_DE_COLUMNA[col.kind] && i.id === col.id);
    if (!d || d.score != null) return null;
    // Con peso 0 no mueve la nota: decir «cuenta 0» confunde.
    if (d.weight <= 0) return i18n.t("notaRelativa.motivoPesoCero");
    if (d.cuenta) return i18n.t("notaRelativa.motivoCuentaCero");
    if (!d.seDio) return i18n.t("notaRelativa.motivoAbierta");
    return d.entrego
      ? i18n.t("notaRelativa.motivoPorCalificar")
      : i18n.t("notaRelativa.motivoNoAsignada");
  };

  const sectionDef: Array<{
    key: "workshop" | "exam" | "project";
    label: string;
    icon: typeof FileText;
    cols: GradeColumn[];
    bucketWeight: number;
  }> = [
    {
      key: "workshop",
      label: i18n.t("hc_routesAppTeacherGradebook.workshops"),
      icon: Hammer,
      cols: columns.filter((c) => c.kind === "workshop"),
      bucketWeight: Number(cut.workshop_weight ?? 0) || 0,
    },
    {
      key: "exam",
      label: i18n.t("hc_routesAppTeacherGradebook.exams"),
      icon: FileText,
      cols: columns.filter((c) => c.kind === "exam"),
      bucketWeight: Number(cut.exam_weight ?? 0) || 0,
    },
    {
      key: "project",
      label: i18n.t("hc_routesAppTeacherGradebook.projects"),
      icon: FolderKanban,
      cols: columns.filter((c) => c.kind === "project"),
      bucketWeight: Number(cut.project_weight ?? 0) || 0,
    },
  ];

  return (
    <div className="space-y-4">
      {sectionDef.map((sec) => {
        if (sec.cols.length === 0) return null;
        return (
          <div key={sec.key} className="rounded-md border overflow-hidden">
            <div className="flex items-center justify-between gap-2 bg-muted/40 px-3 py-2 border-b">
              <div className="flex items-center gap-2">
                <sec.icon className="h-3.5 w-3.5 text-primary" />
                <span className="text-sm font-medium">{sec.label}</span>
                <span className="text-2xs text-muted-foreground">
                  {i18n.t("hc_routesAppTeacherGradebook.activityCount", {
                    count: sec.cols.length,
                  })}
                </span>
              </div>
              <span className="text-2xs text-muted-foreground tabular-nums">
                {i18n.t("hc_routesAppTeacherGradebook.bucketWeight", {
                  weight: sec.bucketWeight.toFixed(1),
                })}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{i18next.t("gradebook.activityColumn")}</TableHead>
                  <TableHead className="text-right w-32">
                    <span className="inline-flex items-center justify-end gap-1">
                      {i18n.t("hc_routesAppTeacherGradebook.grade")}
                      <HelpHint side="top">
                        {i18n.t("hc_routesAppTeacherGradebook.courseScaleLabel")}{" "}
                        <strong>
                          {selectedCourse?.grade_scale_min ?? 0}–
                          {selectedCourse?.grade_scale_max ?? "—"}
                        </strong>
                        . {i18n.t("hc_routesAppTeacherGradebook.gradeHelpWorkshopsProjects")}{" "}
                        <em>{i18n.t("hc_routesAppTeacherGradebook.itemMaxScore")}</em>{" "}
                        {i18n.t("hc_routesAppTeacherGradebook.gradeHelpDecimals")}
                      </HelpHint>
                    </span>
                  </TableHead>
                  <TableHead className="w-24 text-center">
                    {i18n.t("hc_routesAppTeacherGradebook.status")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sec.cols.map((col) => {
                  const g = getGrade(studentId, col);
                  const key = cellKey(studentId, col.id);
                  const isEditing = key in edits;
                  const displayGrade = isEditing
                    ? edits[key]
                    : g.grade != null
                      ? String(g.grade)
                      : "";
                  return (
                    <TableRow key={col.id}>
                      <TableCell className="font-medium text-sm">
                        {col.title}
                        {col.maxScore != null && (
                          <span className="text-3xs text-muted-foreground ml-1">
                            (/{col.maxScore})
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {g.subId ? (
                          <DecimalInput
                            min={selectedCourse?.grade_scale_min ?? 0}
                            max={
                              col.kind === "exam" || col.isExternal
                                ? (selectedCourse?.grade_scale_max ?? 100)
                                : (col.maxScore ?? 100)
                            }
                            value={
                              displayGrade === "" ? null : Number(displayGrade.replace(",", "."))
                            }
                            onChange={(v) =>
                              handleEdit(studentId, col.id, v == null ? "" : String(v))
                            }
                            placeholder="—"
                            className="h-8 w-24 ml-auto text-right text-sm tabular-nums"
                          />
                        ) : g.grade != null ? (
                          <span className="text-sm tabular-nums font-medium">
                            {Number(g.grade).toFixed(2)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-center">
                        <div className="inline-flex items-center justify-center gap-1">
                          {g.isMakeup && (
                            <Badge
                              variant="outline"
                              className="text-3xs py-0 h-4 px-1"
                              title={
                                g.makeupKind === "recuperatorio"
                                  ? i18n.t("recuperaciones.fromRecuperatorio")
                                  : i18n.t("recuperaciones.fromSupletorio")
                              }
                            >
                              <GitBranch className="h-2.5 w-2.5 mr-0.5" />{" "}
                              {g.makeupKind === "recuperatorio" ? "R" : "S"}
                            </Badge>
                          )}
                          {g.status === "sospechoso" && (
                            <span
                              title={i18n.t("hc_routesAppTeacherGradebook.suspicious")}
                              className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive"
                            >
                              <AlertTriangle className="h-3 w-3" />
                            </span>
                          )}
                          {g.grupo && <IndicadorDeGrupo grupo={g.grupo} />}
                          {/* Con el ícono del grupo, el «—» de relleno sobra;
                              el motivo de una nota que falta, no. */}
                          {!g.isMakeup &&
                            g.status !== "sospechoso" &&
                            (!g.grupo || motivoSinNota(col) != null) && (
                              <span className="text-3xs text-muted-foreground">
                                {motivoSinNota(col) ?? "—"}
                              </span>
                            )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        );
      })}

      {Number(cut.attendance_weight ?? 0) > 0 && (
        <div className="rounded-md border overflow-hidden">
          <div className="flex items-center justify-between gap-2 bg-amber-400/5 px-3 py-2 border-b">
            <div className="flex items-center gap-2">
              <CalendarCheck className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm font-medium">
                {i18n.t("hc_routesAppTeacherGradebook.attendance")}
              </span>
              <span className="text-2xs text-muted-foreground">
                {i18n.t("notaRelativa.sesionesDadasDeProgramadas", {
                  dadas: totalSess,
                  count: programadas,
                })}
              </span>
            </div>
            <span className="text-2xs text-muted-foreground tabular-nums">
              {i18n.t("hc_routesAppTeacherGradebook.bucketWeight", {
                weight: Number(cut.attendance_weight ?? 0).toFixed(1),
              })}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">
                  {i18n.t("hc_routesAppTeacherGradebook.sessionsPresent")}
                </TableHead>
                <TableHead className="text-right">
                  {i18n.t("hc_routesAppTeacherGradebook.totalSessions")}
                </TableHead>
                <TableHead className="text-right">
                  {i18n.t("hc_routesAppTeacherGradebook.attendancePct")}
                </TableHead>
                {selectedCourse && (
                  <TableHead className="text-right">
                    {i18n.t("hc_routesAppTeacherGradebook.gradeWithScale", {
                      min: selectedCourse.grade_scale_min,
                      max: selectedCourse.grade_scale_max,
                    })}
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {totalSess === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={selectedCourse ? 4 : 3}
                    className="text-center text-muted-foreground py-4 text-xs italic"
                  >
                    {programadas === 0
                      ? i18n.t("hc_routesAppTeacherGradebook.noAttendanceSessionsInCut")
                      : i18n.t("notaRelativa.ningunaSesionDada")}
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow>
                  <TableCell className="text-right tabular-nums">{presentCount}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {totalSess}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Math.round(attPct * 100)}%
                  </TableCell>
                  {selectedCourse && (
                    <TableCell className="text-right tabular-nums font-medium">
                      {attNota != null ? attNota.toFixed(2) : "—"}
                    </TableCell>
                  )}
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="text-2xs text-muted-foreground italic">
        {i18n.t("hc_routesAppTeacherGradebook.editsAccumulateHint")}
      </p>
    </div>
  );
}

/**
 * «Esta nota es la del grupo»: la celda sale de una entrega grupal, que es UNA
 * fila para todos sus integrantes. Editarla en una celda la copia a las demás
 * (ver `handleEdit`), y este ícono dice por qué.
 */
function IndicadorDeGrupo({ grupo }: { grupo: GrupoDeCelda }) {
  const texto = i18n.t("gradingGroups.gradebookCell", {
    group: grupo.nombre,
    count: grupo.integrantes,
  });
  return (
    <span
      role="img"
      aria-label={texto}
      title={texto}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-primary"
    >
      <UsersRound className="h-3 w-3" aria-hidden />
    </span>
  );
}

// ───────────────────────── Editable grid (compartida) ─────────────────────────
// Antes la grilla estaba inline en el JSX. La extraímos para reutilizar entre
// "Sin corte asignado" y el modal de Ver detalle por corte.
function renderEditableGrid({
  columns,
  students,
  getGrade,
  edits,
  handleEdit,
  cellKey,
  selectedCourse,
}: {
  columns: GradeColumn[];
  students: Student[];
  getGrade: (
    studentId: string,
    col: GradeColumn,
  ) => {
    grade: number | null;
    isMakeup: boolean;
    makeupKind?: TipoRecuperacion;
    status?: string;
    subId?: string;
    grupo?: GrupoDeCelda;
  };
  edits: EditMap;
  handleEdit: (studentId: string, colId: string, value: string) => void;
  cellKey: (studentId: string, colId: string) => string;
  selectedCourse: Course | undefined;
}) {
  return (
    <CardContent className="p-0 max-h-[70dvh] overflow-auto">
      <Table>
        <TableHeader sticky>
          <TableRow>
            <TableHead className="sticky left-0 z-10 bg-card min-w-36 sm:min-w-48">
              <span className="inline-flex items-center gap-1.5">
                {i18n.t("hc_routesAppTeacherGradebook.student")}
                <HelpHint side="bottom" align="start">
                  <strong>{i18n.t("hc_routesAppTeacherGradebook.courseScaleLabel")}</strong>{" "}
                  {selectedCourse?.grade_scale_min ?? 0}–
                  {selectedCourse?.grade_scale_max ?? "—"}.{" "}
                  {i18n.t("hc_routesAppTeacherGradebook.gridHelpExamsPrefix")}{" "}
                  <strong>{i18n.t("hc_routesAppTeacherGradebook.exams")}</strong>{" "}
                  {i18n.t("hc_routesAppTeacherGradebook.gridHelpExamsSuffix")}{" "}
                  <strong>{i18n.t("hc_routesAppTeacherGradebook.workshops")}</strong>{" "}
                  {i18n.t("hc_routesAppTeacherGradebook.gridHelpAnd")}{" "}
                  <strong>{i18n.t("hc_routesAppTeacherGradebook.projects")}</strong>
                  {i18n.t("hc_routesAppTeacherGradebook.gridHelpProjectsSuffix")}{" "}
                  <em>{i18n.t("hc_routesAppTeacherGradebook.itemMaxScore")}</em>{" "}
                  {i18n.t("hc_routesAppTeacherGradebook.gradeHelpDecimals")}
                </HelpHint>
              </span>
            </TableHead>
            {columns.map((col) => (
              <TableHead key={col.id} className="text-center min-w-28">
                <div className="flex flex-col items-center gap-0.5">
                  <div className="flex items-center gap-1">
                    {col.kind === "exam" ? (
                      <FileText className="h-3 w-3 text-primary shrink-0" />
                    ) : col.kind === "workshop" ? (
                      <Hammer className="h-3 w-3 text-amber-500 dark:text-amber-400 shrink-0" />
                    ) : (
                      <FolderKanban className="h-3 w-3 text-indigo-500 dark:text-indigo-400 shrink-0" />
                    )}
                    <span className="truncate max-w-24" title={col.title}>
                      {col.title}
                    </span>
                  </div>
                  <Badge variant="outline" className="text-3xs py-0 h-3.5">
                    {col.kind === "exam"
                      ? i18n.t("hc_routesAppTeacherGradebook.examBadge", {
                          max: selectedCourse?.grade_scale_max ?? 5,
                        })
                      : col.kind === "workshop"
                        ? i18n.t("hc_routesAppTeacherGradebook.workshopBadge", {
                            max: col.maxScore ?? 100,
                          })
                        : i18n.t("hc_routesAppTeacherGradebook.projectBadge", {
                            max: col.maxScore ?? 100,
                          })}
                  </Badge>
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {students.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={columns.length + 1}
                className="text-center text-muted-foreground py-8"
              >
                {i18n.t("hc_routesAppTeacherGradebook.noEnrolledStudents")}
              </TableCell>
            </TableRow>
          )}
          {students.map((s) => (
            <TableRow key={s.id}>
              <TableCell className="sticky left-0 z-10 bg-card max-w-36 sm:max-w-48">
                <div
                  className="flex items-baseline gap-2 min-w-0"
                  title={`${s.full_name} · ${s.institutional_email}`}
                >
                  <span className="font-medium text-sm truncate shrink">{s.full_name}</span>
                  <span className="text-xs text-muted-foreground truncate shrink-[2] hidden sm:inline">{s.institutional_email}</span>
                </div>
              </TableCell>
              {columns.map((col) => {
                const g = getGrade(s.id, col);
                const key = cellKey(s.id, col.id);
                const isEditing = key in edits;
                const displayGrade = isEditing
                  ? edits[key]
                  : g.grade != null
                    ? String(g.grade)
                    : "";

                return (
                  <TableCell key={col.id} className="text-center p-1">
                    {g.subId ? (
                      <div className="relative">
                        <DecimalInput
                          min={selectedCourse?.grade_scale_min ?? 0}
                          max={
                            // Los items externos guardan la nota en la ESCALA DEL
                            // CURSO (no en max_score), igual que en el consolidado.
                            col.kind === "workshop" && !col.isExternal
                              ? (col.maxScore ?? 100)
                              : (selectedCourse?.grade_scale_max ?? 100)
                          }
                          value={
                            displayGrade === "" ? null : Number(displayGrade.replace(",", "."))
                          }
                          onChange={(v) => handleEdit(s.id, col.id, v == null ? "" : String(v))}
                          placeholder="—"
                          className="h-8 w-20 mx-auto text-center text-sm tabular-nums"
                        />
                        <div className="flex min-h-[1.125rem] items-center justify-center gap-1 mt-0.5">
                          {g.isMakeup && (
                            <Badge
                              variant="outline"
                              className="text-3xs py-0 h-4 px-1 inline-flex items-center gap-0.5"
                              title={
                                g.makeupKind === "recuperatorio"
                                  ? i18n.t("recuperaciones.fromRecuperatorio")
                                  : i18n.t("recuperaciones.fromSupletorio")
                              }
                            >
                              <GitBranch className="h-2.5 w-2.5 shrink-0" aria-hidden />
                              {g.makeupKind === "recuperatorio" ? "R" : "S"}
                            </Badge>
                          )}
                          {g.status === "sospechoso" && (
                            <span
                              title={i18n.t("hc_routesAppTeacherGradebook.suspiciousAttemptHint")}
                              className="inline-flex size-5 shrink-0 items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 text-destructive"
                            >
                              <AlertTriangle className="h-3 w-3" strokeWidth={2} aria-hidden />
                            </span>
                          )}
                          {g.grupo && <IndicadorDeGrupo grupo={g.grupo} />}
                        </div>
                      </div>
                    ) : g.grade != null ? (
                      // Sin entrega editable (los proyectos no se editan acá):
                      // la nota se muestra igual, como en el detalle del corte.
                      // Antes la celda decía «—» aunque la nota contara.
                      <div>
                        <span className="text-sm tabular-nums font-medium">
                          {Number(g.grade).toFixed(2)}
                        </span>
                        {g.grupo && (
                          <div className="flex min-h-[1.125rem] items-center justify-center mt-0.5">
                            <IndicadorDeGrupo grupo={g.grupo} />
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </CardContent>
  );
}
