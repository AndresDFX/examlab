/**
 * CourseDiagnosticDialog — escaneo COMPLETO del estado de un curso.
 *
 * Cuatro pestañas:
 *   1. Calificaciones pendientes — matriz estudiante × actividad
 *      (examen/taller/proyecto) con estado. Resalta lo accionable
 *      (sin calificar, errores IA) y permite "Calificar manualmente"
 *      con un click que navega al módulo respectivo.
 *   2. Errores de IA — jobs `ai_grading_queue` con status='failed' del
 *      curso. Botón "Reintentar" por fila vía RPC requeue_ai_grading_job.
 *   3. Conversaciones abiertas — feedback_threads con closed=false del
 *      curso. Acciones: ir a la entrega + Cerrar (UPDATE directo).
 *   4. Asistencia — sesiones del curso con conteo de presentes /
 *      ausentes / pendientes (sin registro).
 *
 * Diseño:
 *   - Datos se cargan en PARALELO al abrir (5 queries + agregaciones).
 *   - Toda navegación usa `to + params` de TanStack (NO URLs hand-built).
 *   - Acciones destructivas pasan por useConfirm().
 *   - Mobile-friendly (max-w calc + dvh + flex-col).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { TableEmpty } from "@/components/ui/empty-state";
import { DateCell } from "@/components/ui/date-cell";
import { SearchInput } from "@/components/ui/search-input";
import { Stethoscope, AlertTriangle, MessageSquare, CheckCircle2, RefreshCw, ExternalLink, Lock, ClipboardList, CalendarCheck, FileText, Hammer, FolderKanban, Gavel, Sparkles, Users, Scale, CalendarCheck2 } from "lucide-react";
import {
  summarizePendingGrades,
  summarizeMatrix,
  summarizeAttendance,
  summarizeCohortCoverage,
  summarizeWeightCoverage,
  diagCellSeverity,
  type DiagItem,
  type DiagStudent,
  type DiagSubmission,
  type DiagPendingRow,
  type DiagAttendanceSession,
  type DiagCohortCoverage,
  type DiagWeightCoverage,
  type DiagCut,
  type DiagWeightedItem,
  type DiagBucketKind,
  type DiagCutCoverage,
} from "@/modules/courses/diagnostic";
import { enqueueAiGradeForSubmission } from "@/modules/ai/grade-submission";

// Casts estilo db cuando los types auto-generados no traen una tabla / RPC.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: string;
  courseName: string;
}

type AiFailedJob = {
  id: string;
  target_table: string;
  target_row_id: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  /** Info derivada (cuando se puede resolver): título del examen/taller/proyecto. */
  itemLabel?: string;
  /** Nombre del estudiante dueño de la submission. */
  studentLabel?: string;
};

type OpenThread = {
  id: string;
  parent_kind: "exam" | "workshop" | "project";
  question_id: string;
  submission_id: string;
  created_at: string;
  /** Etiqueta humana del padre (título del examen/taller/proyecto). */
  parentLabel?: string;
  /** Nombre del estudiante. */
  studentLabel?: string;
  /** Conteo de comentarios + último envío (heurística "le toca al docente"). */
  commentCount?: number;
};

export function CourseDiagnosticDialog({ open, onOpenChange, courseId, courseName }: Props) {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const isAdminOrSa = roles.includes("Admin") || roles.includes("SuperAdmin");
  const isTeacher = roles.includes("Docente");
  const canNavigateTeacherRoutes = isAdminOrSa || isTeacher;

  // ── Estado de cada pestaña ──────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Pestaña 1: matriz de calificaciones.
  const [students, setStudents] = useState<DiagStudent[]>([]);
  const [items, setItems] = useState<DiagItem[]>([]);
  const [submissions, setSubmissions] = useState<DiagSubmission[]>([]);
  const [aiFailedRefs, setAiFailedRefs] = useState<Set<string>>(new Set());
  const [matrixSearch, setMatrixSearch] = useState("");
  const [courseLanguage, setCourseLanguage] = useState<"es" | "en">("es");
  const [gradingAll, setGradingAll] = useState(false);

  // Pestaña 2: jobs IA failed.
  const [aiFailedJobs, setAiFailedJobs] = useState<AiFailedJob[]>([]);
  const [retryingJobIds, setRetryingJobIds] = useState<Set<string>>(new Set());

  // Pestaña 3: conversaciones abiertas.
  const [openThreads, setOpenThreads] = useState<OpenThread[]>([]);
  const [closingThreadIds, setClosingThreadIds] = useState<Set<string>>(new Set());

  // Pestaña 4: asistencia.
  const [attendanceRows, setAttendanceRows] = useState<DiagAttendanceSession[]>([]);

  // Cobertura por cohorte: actividades sin asignar a alguna cohorte del curso.
  const [cohortCoverage, setCohortCoverage] = useState<DiagCohortCoverage>({
    hasCohorts: false,
    cohorts: [],
    gaps: [],
  });

  // Cobertura de pesos de evaluación: % del 100% del curso sin asignar
  // (a nivel curso y por bucket dentro de cada corte).
  const [weightCoverage, setWeightCoverage] = useState<DiagWeightCoverage>({
    hasCuts: false,
    courseTotalAssigned: 0,
    courseTotalGap: 0,
    courseCutsNotHundred: false,
    cuts: [],
    orphanItems: { exam: 0, workshop: 0, project: 0 },
    hasGaps: false,
  });

  const loadAll = useCallback(async () => {
    if (!courseId) return;
    setLoading(true);
    setLoadError(null);
    try {
      // Idioma del curso (para el body de calificación IA). Best-effort.
      const { data: courseRow } = await db
        .from("courses")
        .select("language")
        .eq("id", courseId)
        .maybeSingle();
      setCourseLanguage(courseRow?.language === "en" ? "en" : "es");

      // 1) Matriculados (filtramos por institutional_email para ordenar).
      const { data: enr } = await db
        .from("course_enrollments")
        .select("user_id")
        .eq("course_id", courseId);
      const userIds: string[] = ((enr ?? []) as Array<{ user_id: string }>).map((e) => e.user_id);
      let studentsList: DiagStudent[] = [];
      if (userIds.length) {
        const { data: profs } = await db
          .from("profiles")
          .select("id, full_name, institutional_email, cohorte")
          .in("id", userIds)
          .order("full_name");
        studentsList = (profs ?? []) as DiagStudent[];
      }
      setStudents(studentsList);

      // 2) Exámenes / talleres / proyectos del curso (excluyendo papelera).
      // Talleres y proyectos son M:N → vamos por workshop_courses / project_courses.
      // Traemos también weight + cut_id para la cobertura de pesos. OJO: el
      // peso/corte canónico por curso vive en exams.cut_id/weight directo,
      // pero en workshop_courses.{cut_id,weight} / project_courses.{cut_id,weight}
      // para talleres/proyectos (NO en la tabla global) — ver gradebook.
      const [{ data: exams }, { data: wcRows }, { data: pcRows }] = await Promise.all([
        db
          .from("exams")
          .select("id, title, weight, cut_id")
          .eq("course_id", courseId)
          .is("deleted_at", null)
          .is("parent_exam_id", null),
        db
          .from("workshop_courses")
          .select("weight, cut_id, workshop:workshops(id, title, deleted_at, weight)")
          .eq("course_id", courseId),
        db
          .from("project_courses")
          .select("weight, cut_id, project:projects(id, title, deleted_at)")
          .eq("course_id", courseId),
      ]);

      // Items con peso/corte para la cobertura (paralelo a allItems).
      const weightedItems: DiagWeightedItem[] = [];

      const examItems: DiagItem[] = ((exams ?? []) as Array<{
        id: string;
        title: string;
        weight: number | null;
        cut_id: string | null;
      }>).map((e) => {
        weightedItems.push({ kind: "exam", cut_id: e.cut_id, weight: e.weight });
        return { id: e.id, title: e.title, kind: "exam" as const };
      });
      const workshopItems: DiagItem[] = ((wcRows ?? []) as Array<{
        weight: number | null;
        cut_id: string | null;
        workshop: { id: string; title: string; deleted_at: string | null; weight: number | null } | null;
      }>)
        .filter((r) => r.workshop && !r.workshop.deleted_at)
        .map((r) => {
          // workshop_courses.weight es el canónico; si es NULL cae al legacy
          // workshops.weight (curso primario).
          const w = r.weight != null ? r.weight : r.workshop!.weight;
          weightedItems.push({ kind: "workshop", cut_id: r.cut_id, weight: w });
          return {
            id: r.workshop!.id,
            title: r.workshop!.title,
            kind: "workshop" as const,
          };
        });
      const projectItems: DiagItem[] = ((pcRows ?? []) as Array<{
        weight: number | null;
        cut_id: string | null;
        project: { id: string; title: string; deleted_at: string | null } | null;
      }>)
        .filter((r) => r.project && !r.project.deleted_at)
        .map((r) => {
          weightedItems.push({ kind: "project", cut_id: r.cut_id, weight: r.weight });
          return {
            id: r.project!.id,
            title: r.project!.title,
            kind: "project" as const,
          };
        });
      const allItems: DiagItem[] = [...examItems, ...workshopItems, ...projectItems];
      setItems(allItems);

      // 2b) Cortes del curso (con sus 4 buckets) → cobertura de pesos.
      const { data: cutsData } = await db
        .from("grade_cuts")
        .select(
          "id, name, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
        )
        .eq("course_id", courseId)
        .order("position");
      setWeightCoverage(
        summarizeWeightCoverage((cutsData ?? []) as DiagCut[], weightedItems),
      );

      // 3) Submissions de cada tipo.
      const examIds = examItems.map((e) => e.id);
      const workshopIds = workshopItems.map((w) => w.id);
      const projectIds = projectItems.map((p) => p.id);

      const [examSubsRes, wsSubsRes, prjSubsRes] = await Promise.all([
        examIds.length
          ? db
              .from("submissions")
              .select("id, exam_id, user_id, ai_grade, final_override_grade, status")
              .in("exam_id", examIds)
          : Promise.resolve({ data: [] }),
        workshopIds.length
          ? db
              .from("workshop_submissions")
              .select("id, workshop_id, user_id, ai_grade, final_grade, status")
              .in("workshop_id", workshopIds)
          : Promise.resolve({ data: [] }),
        projectIds.length
          ? db
              .from("project_submissions")
              .select(
                "id, project_id, user_id, ai_grade, final_grade, status, submission_grade, defense_factor, defense_at",
              )
              .in("project_id", projectIds)
          : Promise.resolve({ data: [] }),
      ]);

      const subs: DiagSubmission[] = [];
      // Mapa submission.id → user_id::kind::item_id (para resolver
      // aiFailedRefs desde target_row_id).
      const submissionIdToRef = new Map<string, { ref: string; tableKind: string }>();

      for (const s of (examSubsRes.data ?? []) as Array<{
        id: string;
        exam_id: string;
        user_id: string;
        ai_grade: number | null;
        final_override_grade: number | null;
        status: string;
      }>) {
        const hasGrade = s.final_override_grade != null || s.ai_grade != null;
        subs.push({
          user_id: s.user_id,
          item_id: s.exam_id,
          item_kind: "exam",
          status: s.status,
          has_final_grade: hasGrade,
          submission_id: s.id,
        });
        submissionIdToRef.set(s.id, {
          ref: `${s.user_id}::exam::${s.exam_id}`,
          tableKind: "submissions",
        });
      }
      for (const s of (wsSubsRes.data ?? []) as Array<{
        id: string;
        workshop_id: string;
        user_id: string;
        ai_grade: number | null;
        final_grade: number | null;
        status: string;
      }>) {
        const hasGrade = s.final_grade != null || s.ai_grade != null;
        subs.push({
          user_id: s.user_id,
          item_id: s.workshop_id,
          item_kind: "workshop",
          status: s.status,
          has_final_grade: hasGrade,
          submission_id: s.id,
        });
        submissionIdToRef.set(s.id, {
          ref: `${s.user_id}::workshop::${s.workshop_id}`,
          tableKind: "workshop_submissions",
        });
      }
      for (const s of (prjSubsRes.data ?? []) as Array<{
        id: string;
        project_id: string;
        user_id: string;
        ai_grade: number | null;
        final_grade: number | null;
        status: string;
        submission_grade: number | null;
        defense_factor: number | null;
        defense_at: string | null;
      }>) {
        const hasGrade = s.final_grade != null || s.ai_grade != null;
        // Sin sustentación: la entrega ya tiene nota (de entrega o IA) pero la
        // nota FINAL no cierra porque falta registrar la sustentación
        // (final_grade null + defense_at null). Acción del docente, no IA.
        const defensePending =
          (s.submission_grade != null || s.ai_grade != null) &&
          s.final_grade == null &&
          s.defense_at == null;
        subs.push({
          user_id: s.user_id,
          item_id: s.project_id,
          item_kind: "project",
          status: s.status,
          has_final_grade: hasGrade,
          submission_id: s.id,
          defense_pending: defensePending,
        });
        submissionIdToRef.set(s.id, {
          ref: `${s.user_id}::project::${s.project_id}`,
          tableKind: "project_submissions",
        });
      }
      setSubmissions(subs);

      // 4) Jobs IA failed del curso.
      const { data: aiFailed } = await db
        .from("ai_grading_queue")
        .select("id, target_table, target_row_id, attempts, last_error, created_at")
        .eq("course_id", courseId)
        .eq("status", "failed")
        .order("created_at", { ascending: false });

      const failedRefs = new Set<string>();
      const enrichedFailedJobs: AiFailedJob[] = [];
      const studentLabelByUserId = new Map<string, string>(
        studentsList.map((s) => [s.id, s.full_name ?? s.institutional_email ?? s.id]),
      );
      const itemLabelByKindId = new Map<string, string>(
        allItems.map((i) => [`${i.kind}::${i.id}`, i.title]),
      );
      for (const j of (aiFailed ?? []) as Array<{
        id: string;
        target_table: string;
        target_row_id: string;
        attempts: number;
        last_error: string | null;
        created_at: string;
      }>) {
        // Resolución: target_row_id → submission row → user/item.
        const meta = submissionIdToRef.get(j.target_row_id);
        if (meta) {
          failedRefs.add(meta.ref);
          // Extraer kind del ref string "user::kind::id"
          const parts = meta.ref.split("::");
          const kind = parts[1] as "exam" | "workshop" | "project";
          const itemId = parts[2];
          const userId = parts[0];
          enrichedFailedJobs.push({
            ...j,
            itemLabel: itemLabelByKindId.get(`${kind}::${itemId}`),
            studentLabel: studentLabelByUserId.get(userId),
          });
        } else {
          // project_submission_files apunta a archivos individuales:
          // no podemos resolver el (user,item) sin otra query — los
          // listamos sin enriched info.
          enrichedFailedJobs.push(j);
        }
      }
      setAiFailedRefs(failedRefs);
      setAiFailedJobs(enrichedFailedJobs);

      // 5) Conversaciones abiertas.
      // feedback_threads.closed = false. Filtramos al curso resolviendo
      // por submission_id → exam/workshop/project del curso. La forma
      // más eficiente: traer todos los threads abiertos cuyos
      // submission_id estén en el set de submissions del curso.
      const allSubIds = Array.from(submissionIdToRef.keys());
      let openThreadList: OpenThread[] = [];
      if (allSubIds.length) {
        const { data: threads } = await db
          .from("feedback_threads")
          .select("id, parent_kind, question_id, submission_id, created_at")
          .eq("closed", false)
          .in("submission_id", allSubIds)
          .order("created_at", { ascending: false });
        openThreadList = ((threads ?? []) as Array<{
          id: string;
          parent_kind: "exam" | "workshop" | "project";
          question_id: string;
          submission_id: string;
          created_at: string;
        }>).map((t) => {
          const meta = submissionIdToRef.get(t.submission_id);
          if (meta) {
            const parts = meta.ref.split("::");
            const kind = parts[1] as "exam" | "workshop" | "project";
            const itemId = parts[2];
            const userId = parts[0];
            return {
              ...t,
              parentLabel: itemLabelByKindId.get(`${kind}::${itemId}`),
              studentLabel: studentLabelByUserId.get(userId),
            };
          }
          return t;
        });

        // Cargar comment counts en una sola query agrupada.
        if (openThreadList.length) {
          const threadIds = openThreadList.map((t) => t.id);
          const { data: comments } = await db
            .from("feedback_comments")
            .select("thread_id")
            .in("thread_id", threadIds);
          const counts = new Map<string, number>();
          for (const c of (comments ?? []) as Array<{ thread_id: string }>) {
            counts.set(c.thread_id, (counts.get(c.thread_id) ?? 0) + 1);
          }
          openThreadList = openThreadList.map((t) => ({
            ...t,
            commentCount: counts.get(t.id) ?? 0,
          }));
        }
      }
      setOpenThreads(openThreadList);

      // 6) Asistencia.
      const { data: sessions } = await db
        .from("attendance_sessions")
        .select("id, session_date, title")
        .eq("course_id", courseId)
        .is("deleted_at", null)
        .order("session_date", { ascending: false });
      const sessionIds: string[] = ((sessions ?? []) as Array<{ id: string }>).map((s) => s.id);
      let records: Array<{ session_id: string; user_id: string; status: string }> = [];
      if (sessionIds.length) {
        const { data: ar } = await db
          .from("attendance_records")
          .select("session_id, user_id, status")
          .in("session_id", sessionIds);
        records = (ar ?? []) as Array<{ session_id: string; user_id: string; status: string }>;
      }
      const attRows = summarizeAttendance(
        (sessions ?? []) as Array<{ id: string; session_date: string; title: string | null }>,
        records,
        studentsList.length,
      );
      setAttendanceRows(attRows);

      // 7) Cobertura por cohorte. Traemos las asignaciones de cada tipo y
      // detectamos actividades que olvidaron asignarse a alguna cohorte.
      const assignedByKey = new Map<string, Set<string>>();
      const [examAsg, wsAsg, prjAsg] = await Promise.all([
        examIds.length
          ? db.from("exam_assignments").select("exam_id, user_id").in("exam_id", examIds)
          : Promise.resolve({ data: [] }),
        workshopIds.length
          ? db
              .from("workshop_assignments")
              .select("workshop_id, user_id")
              .in("workshop_id", workshopIds)
          : Promise.resolve({ data: [] }),
        projectIds.length
          ? db
              .from("project_assignments")
              .select("project_id, user_id")
              .in("project_id", projectIds)
          : Promise.resolve({ data: [] }),
      ]);
      const addAssign = (key: string, userId: string) => {
        const set = assignedByKey.get(key);
        if (set) set.add(userId);
        else assignedByKey.set(key, new Set([userId]));
      };
      for (const a of (examAsg.data ?? []) as Array<{ exam_id: string; user_id: string }>)
        addAssign(`exam::${a.exam_id}`, a.user_id);
      for (const a of (wsAsg.data ?? []) as Array<{ workshop_id: string; user_id: string }>)
        addAssign(`workshop::${a.workshop_id}`, a.user_id);
      for (const a of (prjAsg.data ?? []) as Array<{ project_id: string; user_id: string }>)
        addAssign(`project::${a.project_id}`, a.user_id);
      setCohortCoverage(summarizeCohortCoverage(studentsList, allItems, assignedByKey));
    } catch (e) {
      setLoadError(friendlyError(e, t("courseDiagnostic.loadError")));
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    if (open && courseId) {
      void loadAll();
    } else if (!open) {
      // Reset al cerrar para no mostrar datos del curso anterior la próxima vez.
      setStudents([]);
      setItems([]);
      setSubmissions([]);
      setAiFailedRefs(new Set());
      setAiFailedJobs([]);
      setOpenThreads([]);
      setAttendanceRows([]);
      setCohortCoverage({ hasCohorts: false, cohorts: [], gaps: [] });
      setWeightCoverage({
        hasCuts: false,
        courseTotalAssigned: 0,
        courseTotalGap: 0,
        courseCutsNotHundred: false,
        cuts: [],
        orphanItems: { exam: 0, workshop: 0, project: 0 },
        hasGaps: false,
      });
      setMatrixSearch("");
    }
  }, [open, courseId, loadAll]);

  // Matriz consolidada — derivada vía helper puro.
  const matrixRows: DiagPendingRow[] = useMemo(
    () => summarizePendingGrades(students, submissions, items, aiFailedRefs),
    [students, submissions, items, aiFailedRefs],
  );
  const matrixSummary = useMemo(() => summarizeMatrix(matrixRows), [matrixRows]);

  // Conteo de "huecos" de cobertura para el badge de la tab: gap de curso +
  // cada bucket con gap + cada corte con intra-corte gap + items huérfanos.
  const coverageGapCount = useMemo(() => {
    const wc = weightCoverage;
    let n = 0;
    if (wc.courseTotalGap > 0 || wc.courseCutsNotHundred) n += 1;
    for (const c of wc.cuts) {
      if (c.intraCutGap > 0) n += 1;
      for (const b of c.buckets) if (b.gap > 0) n += 1;
    }
    n += wc.orphanItems.exam + wc.orphanItems.workshop + wc.orphanItems.project;
    return n;
  }, [weightCoverage]);

  // Filtramos por search + ordenamos por severidad: errores y pendientes primero.
  const filteredMatrixRows = useMemo(() => {
    const q = matrixSearch.trim().toLowerCase();
    const filtered = q
      ? matrixRows.filter(
          (r) =>
            r.student.full_name?.toLowerCase().includes(q) ||
            r.student.institutional_email?.toLowerCase().includes(q) ||
            r.item.title.toLowerCase().includes(q),
        )
      : matrixRows;
    return [...filtered].sort((a, b) => {
      const sevA = diagCellSeverity(a.status);
      const sevB = diagCellSeverity(b.status);
      if (sevA !== sevB) return sevA - sevB;
      // Mismo severity: ordenar por nombre del estudiante para estabilidad.
      const nameA = a.student.full_name ?? "";
      const nameB = b.student.full_name ?? "";
      return nameA.localeCompare(nameB);
    });
  }, [matrixRows, matrixSearch]);

  // ── Acciones de remediación ─────────────────────────────────────────

  // "Calificar todos": encola con IA TODAS las entregas accionables
  // (entregadas sin calificar o con error de IA) reusando la lógica
  // canónica de encolado por tipo (enqueueAiGradeForSubmission). Las
  // celdas "sin sustentación" NO entran — esas las cierra el docente
  // manualmente (factor de sustentación), no la IA.
  const gradeAll = async () => {
    if (gradingAll) return;
    const targets = matrixRows.filter(
      (r) =>
        (r.status === "entregado_sin_calificar" || r.status === "error_ia") && r.submissionId,
    );
    if (targets.length === 0) {
      toast.info(t("courseDiagnostic.gradeAllNone"));
      return;
    }
    const ok = await confirm({
      title: t("courseDiagnostic.gradeAllTitle"),
      description: t("courseDiagnostic.gradeAllConfirmDesc", { count: targets.length }),
      confirmLabel: t("courseDiagnostic.gradeAllConfirm"),
      tone: "default",
    });
    if (!ok) return;
    setGradingAll(true);
    try {
      let okCount = 0;
      let enqueued = 0;
      let failCount = 0;
      let firstError: string | undefined;
      for (const r of targets) {
        const res = await enqueueAiGradeForSubmission({
          kind: r.item.kind,
          submissionId: r.submissionId!,
          itemId: r.item.id,
          courseId,
          courseLanguage,
        });
        if (res.ok) {
          okCount += 1;
          enqueued += res.enqueued;
        } else {
          failCount += 1;
          firstError ??= res.error;
        }
      }
      if (failCount > 0) {
        toast.warning(
          t("courseDiagnostic.gradeAllPartial", {
            ok: okCount,
            enqueued,
            failed: failCount,
            reason: friendlyError(firstError ?? ""),
          }),
          { duration: 12000 },
        );
      } else {
        toast.success(
          t("courseDiagnostic.gradeAllDone", { ok: okCount, enqueued }),
          { duration: 8000 },
        );
      }
      void loadAll();
    } finally {
      setGradingAll(false);
    }
  };

  const retryAiJob = async (jobId: string) => {
    setRetryingJobIds((prev) => new Set(prev).add(jobId));
    try {
      const { error } = await db.rpc("requeue_ai_grading_job", { _job_id: jobId });
      if (error) throw error;
      toast.success(t("courseDiagnostic.jobRequeued"));
      // Refresh para que la fila desaparezca de la lista de failed.
      void loadAll();
    } catch (e) {
      toast.error(friendlyError(e, t("courseDiagnostic.jobRequeueError")));
    } finally {
      setRetryingJobIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const closeThread = async (threadId: string) => {
    const ok = await confirm({
      title: t("courseDiagnostic.closeThreadTitle"),
      description: t("courseDiagnostic.closeThreadDesc"),
      confirmLabel: t("courseDiagnostic.closeThreadConfirm"),
      tone: "warning",
    });
    if (!ok) return;
    setClosingThreadIds((prev) => new Set(prev).add(threadId));
    try {
      const { error } = await db
        .from("feedback_threads")
        .update({ closed: true, closed_at: new Date().toISOString() })
        .eq("id", threadId);
      if (error) throw error;
      toast.success(t("courseDiagnostic.threadClosed"));
      setOpenThreads((prev) => prev.filter((th) => th.id !== threadId));
    } catch (e) {
      toast.error(friendlyError(e, t("courseDiagnostic.threadCloseError")));
    } finally {
      setClosingThreadIds((prev) => {
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
    }
  };

  // Abre la calificación/sustentación de la ENTREGA específica (no el
  // listado/edición del módulo). Cada ruta soporta deep-link a la entrega:
  //   examen   → monitor con ?student=&submission= (abre la vista de respuestas)
  //   taller   → /workshops con ?workshop=&submission= (abre el diálogo de
  //              calificación y resalta la entrega del estudiante)
  //   proyecto → /projects con ?project=&submission= (abre el diálogo de
  //              calificación/sustentación y resalta la entrega)
  // submissionId/userId son opcionales: sin ellos igual abre el diálogo de
  // calificación del item (mejor que el formulario de edición).
  const goToSubmissionGrading = (
    kind: "exam" | "workshop" | "project",
    itemId: string,
    submissionId?: string | null,
    userId?: string | null,
  ) => {
    if (!canNavigateTeacherRoutes) {
      toast.error(t("courseDiagnostic.noNavPermission"));
      return;
    }
    const submission = submissionId ?? undefined;
    onOpenChange(false);
    if (kind === "exam") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void navigate({
        to: "/app/teacher/monitor/$examId",
        params: { examId: itemId },
        search: { student: userId ?? undefined, submission },
      } as any);
    } else if (kind === "workshop") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void navigate({
        to: "/app/teacher/workshops",
        search: { workshop: itemId, submission },
      } as any);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void navigate({
        to: "/app/teacher/projects",
        search: { project: itemId, submission },
      } as any);
    }
  };

  // Para "Ver entrega" en conversaciones — abre la entrega específica.
  const goToSubmissionContext = (
    kind: "exam" | "workshop" | "project",
    itemId: string,
    submissionId?: string | null,
  ) => {
    goToSubmissionGrading(kind, itemId, submissionId);
  };

  // Iconos por tipo de actividad.
  const itemKindIcon = (kind: "exam" | "workshop" | "project") => {
    if (kind === "exam") return <FileText className="h-3.5 w-3.5 text-blue-600" />;
    if (kind === "workshop") return <Hammer className="h-3.5 w-3.5 text-amber-600" />;
    return <FolderKanban className="h-3.5 w-3.5 text-violet-600" />;
  };
  // Label por tipo de actividad (i18n).
  const kindLabel = (kind: "exam" | "workshop" | "project") =>
    kind === "exam"
      ? t("courseDiagnostic.kindExam")
      : kind === "workshop"
        ? t("courseDiagnostic.kindWorkshop")
        : t("courseDiagnostic.kindProject");

  // Label e ícono por bucket de cobertura (incluye asistencia, que no es
  // un tipo de actividad de la matriz pero sí un bucket del corte).
  const bucketLabel = (kind: DiagBucketKind) =>
    kind === "attendance"
      ? t("courseDiagnostic.bucketAttendance")
      : kindLabel(kind === "workshop" ? "workshop" : kind === "exam" ? "exam" : "project");
  const bucketIcon = (kind: DiagBucketKind) => {
    if (kind === "exam") return <FileText className="h-3.5 w-3.5 text-blue-600" />;
    if (kind === "workshop") return <Hammer className="h-3.5 w-3.5 text-amber-600" />;
    if (kind === "project") return <FolderKanban className="h-3.5 w-3.5 text-violet-600" />;
    return <CalendarCheck2 className="h-3.5 w-3.5 text-sky-600" />;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[90dvh] flex flex-col gap-3 p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-5 w-5 text-emerald-600" />
            {t("courseDiagnostic.title")}
            <span className="text-sm font-normal text-muted-foreground truncate">
              · {courseName}
            </span>
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="md" />
            {t("courseDiagnostic.scanning")}
          </div>
        )}
        {loadError && !loading && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {loadError}
            <Button
              variant="outline"
              size="sm"
              className="ml-2"
              onClick={() => void loadAll()}
            >
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> {t("courseDiagnostic.retry")}
            </Button>
          </div>
        )}

        {!loading && !loadError && (
          <Tabs defaultValue="grades" className="flex-1 min-h-0 flex flex-col">
            <TabsList className="self-start flex-wrap h-auto">
              <TabsTrigger value="grades" className="gap-1.5">
                <ClipboardList className="h-3.5 w-3.5" />
                {t("courseDiagnostic.tabGrades")}
                {matrixSummary.entregadoSinCalificar + matrixSummary.errorIa > 0 && (
                  <Badge
                    variant="destructive"
                    className="ml-1 text-[10px] px-1.5 py-0 h-4 leading-none"
                  >
                    {matrixSummary.entregadoSinCalificar + matrixSummary.errorIa}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="ai" className="gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                {t("courseDiagnostic.tabAiErrors")}
                {aiFailedJobs.length > 0 && (
                  <Badge
                    variant="destructive"
                    className="ml-1 text-[10px] px-1.5 py-0 h-4 leading-none"
                  >
                    {aiFailedJobs.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="threads" className="gap-1.5">
                <MessageSquare className="h-3.5 w-3.5" />
                {t("courseDiagnostic.tabThreads")}
                {openThreads.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="ml-1 text-[10px] px-1.5 py-0 h-4 leading-none"
                  >
                    {openThreads.length}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="attendance" className="gap-1.5">
                <CalendarCheck className="h-3.5 w-3.5" />
                {t("courseDiagnostic.tabAttendance")}
                {attendanceRows.length > 0 && (
                  <Badge
                    variant="outline"
                    className="ml-1 text-[10px] px-1.5 py-0 h-4 leading-none"
                  >
                    {attendanceRows.length}
                  </Badge>
                )}
              </TabsTrigger>
              {cohortCoverage.hasCohorts && (
                <TabsTrigger value="cohorts" className="gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  {t("courseDiagnostic.tabCohorts")}
                  {cohortCoverage.gaps.length > 0 && (
                    <Badge
                      variant="destructive"
                      className="ml-1 text-[10px] px-1.5 py-0 h-4 leading-none"
                    >
                      {cohortCoverage.gaps.length}
                    </Badge>
                  )}
                </TabsTrigger>
              )}
              {weightCoverage.hasCuts && (
                <TabsTrigger value="coverage" className="gap-1.5">
                  <Scale className="h-3.5 w-3.5" />
                  {t("courseDiagnostic.tabCoverage")}
                  {coverageGapCount > 0 && (
                    <Badge
                      variant="destructive"
                      className="ml-1 text-[10px] px-1.5 py-0 h-4 leading-none"
                    >
                      {coverageGapCount}
                    </Badge>
                  )}
                </TabsTrigger>
              )}
            </TabsList>

            <div className="flex-1 min-h-0 overflow-y-auto mt-2">
              {/* ── TAB 1: Calificaciones pendientes ─────────────────── */}
              <TabsContent value="grades" className="m-0 space-y-3">
                {/* Stats compactos */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 text-xs">
                  <StatPill
                    color="emerald"
                    icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                    label={t("courseDiagnostic.statGraded")}
                    value={matrixSummary.calificado}
                  />
                  <StatPill
                    color="amber"
                    icon={<ClipboardList className="h-3.5 w-3.5" />}
                    label={t("courseDiagnostic.statUngraded")}
                    value={matrixSummary.entregadoSinCalificar}
                  />
                  <StatPill
                    color="red"
                    icon={<AlertTriangle className="h-3.5 w-3.5" />}
                    label={t("courseDiagnostic.statAiErrors")}
                    value={matrixSummary.errorIa}
                  />
                  <StatPill
                    color="violet"
                    icon={<Gavel className="h-3.5 w-3.5" />}
                    label={t("courseDiagnostic.statNoDefense")}
                    value={matrixSummary.sinSustentacion}
                  />
                  <StatPill
                    color="slate"
                    icon={<ClipboardList className="h-3.5 w-3.5" />}
                    label={t("courseDiagnostic.statNotSubmitted")}
                    value={matrixSummary.sinEntregar}
                  />
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  <div className="flex-1 min-w-[180px]">
                    <SearchInput
                      value={matrixSearch}
                      onChange={setMatrixSearch}
                      placeholder={t("courseDiagnostic.searchPlaceholder")}
                    />
                  </div>
                  {(matrixSummary.entregadoSinCalificar + matrixSummary.errorIa > 0) && (
                    <Button
                      size="sm"
                      className="h-9 shrink-0"
                      disabled={gradingAll}
                      onClick={() => void gradeAll()}
                    >
                      {gradingAll ? (
                        <Spinner size="xs" className="mr-1" />
                      ) : (
                        <Sparkles className="h-3.5 w-3.5 mr-1" />
                      )}
                      {t("courseDiagnostic.gradeAllBtn", {
                        count: matrixSummary.entregadoSinCalificar + matrixSummary.errorIa,
                      })}
                    </Button>
                  )}
                </div>

                {items.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    {t("courseDiagnostic.noActivities")}
                  </p>
                ) : students.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    {t("courseDiagnostic.noStudents")}
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("courseDiagnostic.colStudent")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colActivity")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colType")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colStatus")}</TableHead>
                        <TableHead className="text-right">{t("courseDiagnostic.colActions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredMatrixRows.length === 0 ? (
                        <TableEmpty colSpan={5} text={t("courseDiagnostic.noResults")} />
                      ) : (
                        filteredMatrixRows.slice(0, 200).map((r, idx) => (
                          <TableRow
                            key={`${r.student.id}-${r.item.kind}-${r.item.id}-${idx}`}
                            className={
                              r.status === "error_ia"
                                ? "bg-destructive/5"
                                : r.status === "entregado_sin_calificar"
                                  ? "bg-amber-50/40 dark:bg-amber-950/10"
                                  : r.status === "sin_sustentacion"
                                    ? "bg-violet-50/40 dark:bg-violet-950/10"
                                    : ""
                            }
                          >
                            <TableCell className="text-xs">
                              <div className="font-medium truncate max-w-[160px]">
                                {r.student.full_name ?? "—"}
                              </div>
                              <div className="text-muted-foreground truncate max-w-[160px]">
                                {r.student.institutional_email}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs truncate max-w-[180px]">
                              {r.item.title}
                            </TableCell>
                            <TableCell>
                              <span className="inline-flex items-center gap-1 text-xs">
                                {itemKindIcon(r.item.kind)}
                                {kindLabel(r.item.kind)}
                              </span>
                            </TableCell>
                            <TableCell>
                              {r.status === "calificado" && (
                                <Badge variant="secondary" className="text-[10px]">
                                  <CheckCircle2 className="h-3 w-3 mr-0.5" /> {t("courseDiagnostic.stCalificado")}
                                </Badge>
                              )}
                              {r.status === "entregado_sin_calificar" && (
                                <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-300">
                                  {t("courseDiagnostic.stUngraded")}
                                </Badge>
                              )}
                              {r.status === "error_ia" && (
                                <Badge variant="destructive" className="text-[10px]">
                                  <AlertTriangle className="h-3 w-3 mr-0.5" /> {t("courseDiagnostic.stAiError")}
                                </Badge>
                              )}
                              {r.status === "sin_sustentacion" && (
                                <Badge variant="outline" className="text-[10px] border-violet-500/40 text-violet-700 dark:text-violet-300">
                                  <Gavel className="h-3 w-3 mr-0.5" /> {t("courseDiagnostic.stNoDefense")}
                                </Badge>
                              )}
                              {r.status === "sin_entregar" && (
                                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                  {t("courseDiagnostic.stNotSubmitted")}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {(r.status === "entregado_sin_calificar" ||
                                r.status === "error_ia") && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs"
                                  onClick={() =>
                                    goToSubmissionGrading(
                                      r.item.kind,
                                      r.item.id,
                                      r.submissionId,
                                      r.student.id,
                                    )
                                  }
                                >
                                  {t("courseDiagnostic.btnGrade")}
                                </Button>
                              )}
                              {r.status === "sin_sustentacion" && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs"
                                  onClick={() =>
                                    goToSubmissionGrading(
                                      r.item.kind,
                                      r.item.id,
                                      r.submissionId,
                                      r.student.id,
                                    )
                                  }
                                >
                                  <Gavel className="h-3 w-3 mr-1" /> {t("courseDiagnostic.btnDefend")}
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                )}
                {filteredMatrixRows.length > 200 && (
                  <p className="text-xs text-muted-foreground text-center">
                    {t("courseDiagnostic.showingCapped", { total: filteredMatrixRows.length })}
                  </p>
                )}
              </TabsContent>

              {/* ── TAB 2: Errores IA ──────────────────────────────────── */}
              <TabsContent value="ai" className="m-0 space-y-3">
                {aiFailedJobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    {t("courseDiagnostic.noAiErrors")}
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("courseDiagnostic.colSubmission")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colStudent")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colError")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colAttempts")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colCreated")}</TableHead>
                        <TableHead className="text-right">{t("courseDiagnostic.colActions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {aiFailedJobs.map((j) => (
                        <TableRow key={j.id}>
                          <TableCell className="text-xs">
                            <div className="font-medium truncate max-w-[180px]">
                              {j.itemLabel ?? j.target_table}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {j.target_table}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs truncate max-w-[140px]">
                            {j.studentLabel ?? "—"}
                          </TableCell>
                          <TableCell className="text-xs max-w-[260px]">
                            <span className="line-clamp-2 text-destructive">
                              {j.last_error ?? "—"}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs tabular-nums">{j.attempts}</TableCell>
                          <TableCell>
                            <DateCell value={j.created_at} variant="datetime" />
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={retryingJobIds.has(j.id)}
                              onClick={() => void retryAiJob(j.id)}
                            >
                              {retryingJobIds.has(j.id) ? (
                                <Spinner size="xs" className="mr-1" />
                              ) : (
                                <RefreshCw className="h-3 w-3 mr-1" />
                              )}
                              {t("courseDiagnostic.btnRetry")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>

              {/* ── TAB 3: Conversaciones abiertas ─────────────────────── */}
              <TabsContent value="threads" className="m-0 space-y-3">
                {openThreads.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    {t("courseDiagnostic.noThreads")}
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("courseDiagnostic.colStudent")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colActivity")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colType")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colMessages")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colStarted")}</TableHead>
                        <TableHead className="text-right">{t("courseDiagnostic.colActions")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {openThreads.map((th) => (
                        <TableRow key={th.id}>
                          <TableCell className="text-xs truncate max-w-[160px]">
                            {th.studentLabel ?? "—"}
                          </TableCell>
                          <TableCell className="text-xs truncate max-w-[180px]">
                            {th.parentLabel ?? "—"}
                          </TableCell>
                          <TableCell>
                            <span className="inline-flex items-center gap-1 text-xs">
                              {itemKindIcon(th.parent_kind)}
                              {kindLabel(th.parent_kind)}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs tabular-nums">
                            {th.commentCount ?? 0}
                          </TableCell>
                          <TableCell>
                            <DateCell value={th.created_at} variant="datetime" />
                          </TableCell>
                          <TableCell className="text-right space-x-1 whitespace-nowrap">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => goToSubmissionContext(th.parent_kind, getItemIdForThread(th, items), th.submission_id)}
                            >
                              <ExternalLink className="h-3 w-3 mr-1" />
                              {t("courseDiagnostic.btnView")}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={closingThreadIds.has(th.id)}
                              onClick={() => void closeThread(th.id)}
                            >
                              {closingThreadIds.has(th.id) ? (
                                <Spinner size="xs" className="mr-1" />
                              ) : (
                                <Lock className="h-3 w-3 mr-1" />
                              )}
                              {t("courseDiagnostic.btnClose")}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>

              {/* ── TAB 4: Asistencia ──────────────────────────────────── */}
              <TabsContent value="attendance" className="m-0 space-y-3">
                {attendanceRows.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    {t("courseDiagnostic.noAttendance")}
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("courseDiagnostic.colDate")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colSession")}</TableHead>
                        <TableHead className="text-right">{t("courseDiagnostic.colPresent")}</TableHead>
                        <TableHead className="text-right">{t("courseDiagnostic.colAbsent")}</TableHead>
                        <TableHead className="text-right">{t("courseDiagnostic.colPending")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {attendanceRows.map((s) => (
                        <TableRow
                          key={s.id}
                          className={
                            s.pending > 0
                              ? "bg-amber-50/40 dark:bg-amber-950/10"
                              : ""
                          }
                        >
                          <TableCell>
                            <DateCell value={s.session_date} />
                          </TableCell>
                          <TableCell className="text-xs">{s.title ?? "—"}</TableCell>
                          <TableCell className="text-right tabular-nums text-xs">
                            <span className="text-emerald-700 dark:text-emerald-400 font-medium">
                              {s.present}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-xs">
                            <span className="text-red-700 dark:text-red-400 font-medium">
                              {s.absent}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums text-xs">
                            <span
                              className={
                                s.pending > 0
                                  ? "text-amber-700 dark:text-amber-400 font-medium"
                                  : "text-muted-foreground"
                              }
                            >
                              {s.pending}
                            </span>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>

              {/* ── TAB 5: Cohortes (solo si el curso usa cohortes) ────── */}
              {cohortCoverage.hasCohorts && (
                <TabsContent value="cohorts" className="m-0 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {t("courseDiagnostic.cohortsIntro", {
                      count: cohortCoverage.cohorts.length,
                      cohorts: cohortCoverage.cohorts.join(", "),
                    })}
                  </p>
                  {cohortCoverage.gaps.length === 0 ? (
                    <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20 dark:border-emerald-900 p-3 text-sm text-emerald-800 dark:text-emerald-300">
                      <CheckCircle2 className="h-4 w-4" />
                      {t("courseDiagnostic.cohortsAllOk")}
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("courseDiagnostic.colActivity")}</TableHead>
                          <TableHead>{t("courseDiagnostic.colType")}</TableHead>
                          <TableHead>{t("courseDiagnostic.colMissingCohorts")}</TableHead>
                          <TableHead className="text-right">{t("courseDiagnostic.colAffected")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {cohortCoverage.gaps.map((g) => (
                          <TableRow
                            key={`${g.item.kind}-${g.item.id}`}
                            className="bg-amber-50/40 dark:bg-amber-950/10"
                          >
                            <TableCell className="text-xs truncate max-w-[200px]">
                              {g.item.title}
                            </TableCell>
                            <TableCell>
                              <span className="inline-flex items-center gap-1 text-xs">
                                {itemKindIcon(g.item.kind)}
                                {kindLabel(g.item.kind)}
                              </span>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-wrap gap-1">
                                {g.missingCohorts.map((c) => (
                                  <Badge
                                    key={c}
                                    variant="outline"
                                    className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-300"
                                  >
                                    {c}
                                  </Badge>
                                ))}
                              </div>
                            </TableCell>
                            <TableCell className="text-right text-xs tabular-nums">
                              {g.affectedStudents}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </TabsContent>
              )}

              {/* ── TAB 6: Cobertura de evaluación (solo con cortes) ───── */}
              {weightCoverage.hasCuts && (
                <TabsContent value="coverage" className="m-0 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {t("courseDiagnostic.coverageIntro")}
                  </p>

                  {/* Resumen a nivel curso */}
                  {weightCoverage.courseTotalGap > 0 ? (
                    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900 p-3 text-sm text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <span>
                        {t("courseDiagnostic.coverageCourseGap", {
                          assigned: formatPct(weightCoverage.courseTotalAssigned),
                          gap: formatPct(weightCoverage.courseTotalGap),
                        })}
                      </span>
                    </div>
                  ) : weightCoverage.courseCutsNotHundred ? (
                    <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900 p-3 text-sm text-red-800 dark:text-red-300">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <span>
                        {t("courseDiagnostic.coverageCourseOver", {
                          assigned: formatPct(weightCoverage.courseTotalAssigned),
                        })}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/50 dark:bg-emerald-950/20 dark:border-emerald-900 p-3 text-sm text-emerald-800 dark:text-emerald-300">
                      <CheckCircle2 className="h-4 w-4 shrink-0" />
                      {t("courseDiagnostic.coverageCourseOk")}
                    </div>
                  )}

                  {/* Items sin corte asignado (huérfanos). */}
                  {weightCoverage.orphanItems.exam +
                    weightCoverage.orphanItems.workshop +
                    weightCoverage.orphanItems.project >
                    0 && (
                    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-900 p-3 text-sm text-amber-800 dark:text-amber-300">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <span>
                        {t("courseDiagnostic.coverageOrphans", {
                          count:
                            weightCoverage.orphanItems.exam +
                            weightCoverage.orphanItems.workshop +
                            weightCoverage.orphanItems.project,
                        })}
                      </span>
                    </div>
                  )}

                  {/* Detalle por corte y por bucket. */}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("courseDiagnostic.colCut")}</TableHead>
                        <TableHead>{t("courseDiagnostic.colBucket")}</TableHead>
                        <TableHead className="text-right">
                          {t("courseDiagnostic.colAssigned")}
                        </TableHead>
                        <TableHead className="text-right">
                          {t("courseDiagnostic.colAvailable")}
                        </TableHead>
                        <TableHead>{t("courseDiagnostic.colStatus")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {weightCoverage.cuts.map((c) => (
                        <CutCoverageRows
                          key={c.id}
                          cut={c}
                          bucketLabel={bucketLabel}
                          bucketIcon={bucketIcon}
                          t={t}
                        />
                      ))}
                    </TableBody>
                  </Table>
                </TabsContent>
              )}
            </div>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Componente local: pill de stats compacto para el header de la tab.
// No vale crear un nuevo componente del design system para esto — el
// patrón solo aplica al diagnóstico.
// ─────────────────────────────────────────────────────────────────────
function StatPill({
  color,
  icon,
  label,
  value,
}: {
  color: "emerald" | "amber" | "red" | "slate" | "violet";
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  const colorClass = {
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/30 dark:border-emerald-900 dark:text-emerald-300",
    amber:
      "bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/30 dark:border-amber-900 dark:text-amber-300",
    red: "bg-red-50 border-red-200 text-red-800 dark:bg-red-950/30 dark:border-red-900 dark:text-red-300",
    slate: "bg-slate-50 border-slate-200 text-slate-700 dark:bg-slate-900/30 dark:border-slate-700 dark:text-slate-300",
    violet: "bg-violet-50 border-violet-200 text-violet-800 dark:bg-violet-950/30 dark:border-violet-900 dark:text-violet-300",
  }[color];
  return (
    <div className={`rounded-md border p-2 ${colorClass}`}>
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="font-medium tabular-nums">{value}</span>
        <span className="text-[10px] uppercase tracking-wide opacity-80 truncate">{label}</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Componente local: filas de cobertura de UN corte (cabecera + 4 buckets).
// El intra-corte gap (los buckets no llenan el peso del corte) se muestra
// en la fila cabecera del corte.
// ─────────────────────────────────────────────────────────────────────
function CutCoverageRows({
  cut,
  bucketLabel,
  bucketIcon,
  t,
}: {
  cut: DiagCutCoverage;
  bucketLabel: (kind: DiagBucketKind) => string;
  bucketIcon: (kind: DiagBucketKind) => React.ReactNode;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  return (
    <>
      {/* Cabecera del corte. */}
      <TableRow className="bg-muted/40">
        <TableCell colSpan={2} className="text-xs font-medium">
          {cut.name ?? t("courseDiagnostic.coverageUnnamedCut")}
          <span className="ml-1 font-normal text-muted-foreground">
            ({formatPct(cut.cutWeight)}%)
          </span>
        </TableCell>
        <TableCell className="text-right text-xs tabular-nums">
          {formatPct(cut.bucketsTotal)}%
        </TableCell>
        <TableCell className="text-right text-xs tabular-nums">
          {formatPct(cut.cutWeight)}%
        </TableCell>
        <TableCell>
          {cut.intraCutGap > 0 ? (
            <Badge
              variant="outline"
              className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-300"
            >
              {t("courseDiagnostic.coverageGapBadge", { gap: formatPct(cut.intraCutGap) })}
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-[10px] border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
            >
              {t("courseDiagnostic.coverageOkBadge")}
            </Badge>
          )}
        </TableCell>
      </TableRow>
      {/* Una fila por bucket. */}
      {cut.buckets.map((b) => {
        // Buckets en 0 (sin peso) no aportan información — los ocultamos
        // para que la tabla muestre solo los buckets activos del corte.
        if (b.bucketWeight === 0) return null;
        const hasGap = b.gap > 0;
        return (
          <TableRow
            key={`${cut.id}-${b.kind}`}
            className={hasGap ? "bg-amber-50/40 dark:bg-amber-950/10" : ""}
          >
            <TableCell />
            <TableCell>
              <span className="inline-flex items-center gap-1 text-xs">
                {bucketIcon(b.kind)}
                {bucketLabel(b.kind)}
              </span>
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">
              {formatPct(b.assignedToItems)}%
            </TableCell>
            <TableCell className="text-right text-xs tabular-nums">
              {formatPct(b.bucketWeight)}%
            </TableCell>
            <TableCell>
              {hasGap ? (
                <Badge
                  variant="outline"
                  className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-300"
                >
                  {t("courseDiagnostic.coverageGapBadge", { gap: formatPct(b.gap) })}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="text-[10px] border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                >
                  {t("courseDiagnostic.coverageOkBadge")}
                </Badge>
              )}
            </TableCell>
          </TableRow>
        );
      })}
    </>
  );
}

// Formatea un porcentaje del modelo de pesos (0..100, hasta 2 decimales)
// con coma decimal es-CO y SIN ceros finales (5 → "5", 12.5 → "12,5").
// Se usa solo para DISPLAY (la fn pura devuelve números crudos).
function formatPct(n: number): string {
  const rounded = Math.round(n * 100) / 100; // 2 decimales máx, mata ruido flotante
  return new Intl.NumberFormat("es-CO", { maximumFractionDigits: 2 }).format(rounded);
}

// Helper: resolver item_id de un thread mirando la submission_id contra
// el mapa de submissions del caller. Es heurística porque acá solo
// tenemos el parentLabel — pero el `parentLabel` está resuelto vía
// itemLabelByKindId al cargar, así que un thread con `parentLabel` ya
// implica que conocemos el item. Si no, devolvemos un placeholder
// (el botón "Ver" se queda en el listado del módulo).
function getItemIdForThread(t: OpenThread, items: DiagItem[]): string {
  const match = items.find((i) => i.kind === t.parent_kind && i.title === t.parentLabel);
  return match?.id ?? "";
}
