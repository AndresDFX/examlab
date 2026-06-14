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
import { Stethoscope, AlertTriangle, MessageSquare, CheckCircle2, RefreshCw, ExternalLink, Lock, ClipboardList, CalendarCheck, FileText, Hammer, FolderKanban } from "lucide-react";
import {
  summarizePendingGrades,
  summarizeMatrix,
  summarizeAttendance,
  diagCellSeverity,
  type DiagItem,
  type DiagStudent,
  type DiagSubmission,
  type DiagPendingRow,
  type DiagAttendanceSession,
} from "@/modules/courses/diagnostic";

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

  // Pestaña 2: jobs IA failed.
  const [aiFailedJobs, setAiFailedJobs] = useState<AiFailedJob[]>([]);
  const [retryingJobIds, setRetryingJobIds] = useState<Set<string>>(new Set());

  // Pestaña 3: conversaciones abiertas.
  const [openThreads, setOpenThreads] = useState<OpenThread[]>([]);
  const [closingThreadIds, setClosingThreadIds] = useState<Set<string>>(new Set());

  // Pestaña 4: asistencia.
  const [attendanceRows, setAttendanceRows] = useState<DiagAttendanceSession[]>([]);

  const loadAll = useCallback(async () => {
    if (!courseId) return;
    setLoading(true);
    setLoadError(null);
    try {
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
          .select("id, full_name, institutional_email")
          .in("id", userIds)
          .order("full_name");
        studentsList = (profs ?? []) as DiagStudent[];
      }
      setStudents(studentsList);

      // 2) Exámenes / talleres / proyectos del curso (excluyendo papelera).
      // Talleres y proyectos son M:N → vamos por workshop_courses / project_courses.
      const [{ data: exams }, { data: wcRows }, { data: pcRows }] = await Promise.all([
        db
          .from("exams")
          .select("id, title")
          .eq("course_id", courseId)
          .is("deleted_at", null)
          .is("parent_exam_id", null),
        db
          .from("workshop_courses")
          .select("workshop:workshops(id, title, deleted_at)")
          .eq("course_id", courseId),
        db
          .from("project_courses")
          .select("project:projects(id, title, deleted_at)")
          .eq("course_id", courseId),
      ]);

      const examItems: DiagItem[] = ((exams ?? []) as Array<{ id: string; title: string }>).map(
        (e) => ({ id: e.id, title: e.title, kind: "exam" as const }),
      );
      const workshopItems: DiagItem[] = ((wcRows ?? []) as Array<{
        workshop: { id: string; title: string; deleted_at: string | null } | null;
      }>)
        .filter((r) => r.workshop && !r.workshop.deleted_at)
        .map((r) => ({
          id: r.workshop!.id,
          title: r.workshop!.title,
          kind: "workshop" as const,
        }));
      const projectItems: DiagItem[] = ((pcRows ?? []) as Array<{
        project: { id: string; title: string; deleted_at: string | null } | null;
      }>)
        .filter((r) => r.project && !r.project.deleted_at)
        .map((r) => ({
          id: r.project!.id,
          title: r.project!.title,
          kind: "project" as const,
        }));
      const allItems: DiagItem[] = [...examItems, ...workshopItems, ...projectItems];
      setItems(allItems);

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
              .select("id, project_id, user_id, ai_grade, final_grade, status")
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
      }>) {
        const hasGrade = s.final_grade != null || s.ai_grade != null;
        subs.push({
          user_id: s.user_id,
          item_id: s.project_id,
          item_kind: "project",
          status: s.status,
          has_final_grade: hasGrade,
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
    } catch (e) {
      setLoadError(friendlyError(e, "No se pudo cargar el diagnóstico del curso."));
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
      setMatrixSearch("");
    }
  }, [open, courseId, loadAll]);

  // Matriz consolidada — derivada vía helper puro.
  const matrixRows: DiagPendingRow[] = useMemo(
    () => summarizePendingGrades(students, submissions, items, aiFailedRefs),
    [students, submissions, items, aiFailedRefs],
  );
  const matrixSummary = useMemo(() => summarizeMatrix(matrixRows), [matrixRows]);

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

  const retryAiJob = async (jobId: string) => {
    setRetryingJobIds((prev) => new Set(prev).add(jobId));
    try {
      const { error } = await db.rpc("requeue_ai_grading_job", { _job_id: jobId });
      if (error) throw error;
      toast.success("Job re-encolado. La IA lo procesará en el próximo tick.");
      // Refresh para que la fila desaparezca de la lista de failed.
      void loadAll();
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo re-encolar el job."));
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
      title: "Cerrar conversación",
      description:
        "La conversación quedará marcada como cerrada. El estudiante NO podrá responder hasta que la reabras.",
      confirmLabel: "Cerrar conversación",
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
      toast.success("Conversación cerrada.");
      setOpenThreads((prev) => prev.filter((t) => t.id !== threadId));
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo cerrar la conversación."));
    } finally {
      setClosingThreadIds((prev) => {
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
    }
  };

  // Navega al módulo de calificación correcto según el tipo de actividad.
  const goToGrading = (kind: "exam" | "workshop" | "project", itemId: string) => {
    if (!canNavigateTeacherRoutes) {
      toast.error("No tenés permisos para navegar a este módulo.");
      return;
    }
    if (kind === "exam") {
      onOpenChange(false);
      void navigate({
        to: "/app/teacher/exams/$examId",
        params: { examId: itemId },
      });
    } else if (kind === "workshop") {
      // No hay una ruta /app/teacher/workshops/$id — el listado de
      // talleres abre el detalle inline. Mandamos al listado con un
      // search param que la pantalla puede leer (best-effort).
      onOpenChange(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void navigate({
        to: "/app/teacher/workshops",
        search: { edit: itemId },
      } as any);
    } else {
      onOpenChange(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void navigate({
        to: "/app/teacher/projects",
        search: { edit: itemId },
      } as any);
    }
  };

  // Para "Ver entrega" en errores IA / conversaciones — abre el monitor
  // del examen (cuando aplica) o el listado del módulo.
  const goToSubmissionContext = (kind: "exam" | "workshop" | "project", itemId: string) => {
    if (kind === "exam") {
      onOpenChange(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void navigate({
        to: "/app/teacher/monitor/$examId",
        params: { examId: itemId },
        search: {},
      } as any);
    } else {
      goToGrading(kind, itemId);
    }
  };

  // Iconos por tipo de actividad.
  const itemKindIcon = (kind: "exam" | "workshop" | "project") => {
    if (kind === "exam") return <FileText className="h-3.5 w-3.5 text-blue-600" />;
    if (kind === "workshop") return <Hammer className="h-3.5 w-3.5 text-amber-600" />;
    return <FolderKanban className="h-3.5 w-3.5 text-violet-600" />;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[90dvh] flex flex-col gap-3 p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Stethoscope className="h-5 w-5 text-emerald-600" />
            Diagnóstico del curso
            <span className="text-sm font-normal text-muted-foreground truncate">
              · {courseName}
            </span>
          </DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="md" />
            Escaneando el curso...
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
              <RefreshCw className="h-3.5 w-3.5 mr-1" /> Reintentar
            </Button>
          </div>
        )}

        {!loading && !loadError && (
          <Tabs defaultValue="grades" className="flex-1 min-h-0 flex flex-col">
            <TabsList className="self-start flex-wrap h-auto">
              <TabsTrigger value="grades" className="gap-1.5">
                <ClipboardList className="h-3.5 w-3.5" />
                Calificaciones
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
                Errores IA
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
                Conversaciones
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
                Asistencia
                {attendanceRows.length > 0 && (
                  <Badge
                    variant="outline"
                    className="ml-1 text-[10px] px-1.5 py-0 h-4 leading-none"
                  >
                    {attendanceRows.length}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>

            <div className="flex-1 min-h-0 overflow-y-auto mt-2">
              {/* ── TAB 1: Calificaciones pendientes ─────────────────── */}
              <TabsContent value="grades" className="m-0 space-y-3">
                {/* Stats compactos */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <StatPill
                    color="emerald"
                    icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                    label="Calificadas"
                    value={matrixSummary.calificado}
                  />
                  <StatPill
                    color="amber"
                    icon={<ClipboardList className="h-3.5 w-3.5" />}
                    label="Sin calificar"
                    value={matrixSummary.entregadoSinCalificar}
                  />
                  <StatPill
                    color="red"
                    icon={<AlertTriangle className="h-3.5 w-3.5" />}
                    label="Errores IA"
                    value={matrixSummary.errorIa}
                  />
                  <StatPill
                    color="slate"
                    icon={<ClipboardList className="h-3.5 w-3.5" />}
                    label="Sin entregar"
                    value={matrixSummary.sinEntregar}
                  />
                </div>

                <SearchInput
                  value={matrixSearch}
                  onChange={setMatrixSearch}
                  placeholder="Buscar estudiante o actividad..."
                />

                {items.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    Este curso no tiene actividades evaluativas activas todavía.
                  </p>
                ) : students.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    Este curso no tiene estudiantes matriculados.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Estudiante</TableHead>
                        <TableHead>Actividad</TableHead>
                        <TableHead>Tipo</TableHead>
                        <TableHead>Estado</TableHead>
                        <TableHead className="text-right">Acciones</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredMatrixRows.length === 0 ? (
                        <TableEmpty colSpan={5} text="Sin resultados." />
                      ) : (
                        filteredMatrixRows.slice(0, 200).map((r, idx) => (
                          <TableRow
                            key={`${r.student.id}-${r.item.kind}-${r.item.id}-${idx}`}
                            className={
                              r.status === "error_ia"
                                ? "bg-destructive/5"
                                : r.status === "entregado_sin_calificar"
                                  ? "bg-amber-50/40 dark:bg-amber-950/10"
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
                                {r.item.kind === "exam"
                                  ? "Examen"
                                  : r.item.kind === "workshop"
                                    ? "Taller"
                                    : "Proyecto"}
                              </span>
                            </TableCell>
                            <TableCell>
                              {r.status === "calificado" && (
                                <Badge variant="secondary" className="text-[10px]">
                                  <CheckCircle2 className="h-3 w-3 mr-0.5" /> Calificado
                                </Badge>
                              )}
                              {r.status === "entregado_sin_calificar" && (
                                <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-700 dark:text-amber-300">
                                  Entregado · sin calificar
                                </Badge>
                              )}
                              {r.status === "error_ia" && (
                                <Badge variant="destructive" className="text-[10px]">
                                  <AlertTriangle className="h-3 w-3 mr-0.5" /> Error IA
                                </Badge>
                              )}
                              {r.status === "sin_entregar" && (
                                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                                  Sin entregar
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
                                  onClick={() => goToGrading(r.item.kind, r.item.id)}
                                >
                                  Calificar
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
                    Mostrando 200 filas (de {filteredMatrixRows.length}). Refiná la búsqueda para
                    ver menos.
                  </p>
                )}
              </TabsContent>

              {/* ── TAB 2: Errores IA ──────────────────────────────────── */}
              <TabsContent value="ai" className="m-0 space-y-3">
                {aiFailedJobs.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">
                    No hay jobs de IA con errores en este curso. ✨
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Entrega</TableHead>
                        <TableHead>Estudiante</TableHead>
                        <TableHead>Error</TableHead>
                        <TableHead>Intentos</TableHead>
                        <TableHead>Creado</TableHead>
                        <TableHead className="text-right">Acciones</TableHead>
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
                              Reintentar
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
                    No hay conversaciones abiertas en este curso.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Estudiante</TableHead>
                        <TableHead>Actividad</TableHead>
                        <TableHead>Tipo</TableHead>
                        <TableHead>Mensajes</TableHead>
                        <TableHead>Iniciada</TableHead>
                        <TableHead className="text-right">Acciones</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {openThreads.map((t) => (
                        <TableRow key={t.id}>
                          <TableCell className="text-xs truncate max-w-[160px]">
                            {t.studentLabel ?? "—"}
                          </TableCell>
                          <TableCell className="text-xs truncate max-w-[180px]">
                            {t.parentLabel ?? "—"}
                          </TableCell>
                          <TableCell>
                            <span className="inline-flex items-center gap-1 text-xs">
                              {itemKindIcon(t.parent_kind)}
                              {t.parent_kind === "exam"
                                ? "Examen"
                                : t.parent_kind === "workshop"
                                  ? "Taller"
                                  : "Proyecto"}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs tabular-nums">
                            {t.commentCount ?? 0}
                          </TableCell>
                          <TableCell>
                            <DateCell value={t.created_at} variant="datetime" />
                          </TableCell>
                          <TableCell className="text-right space-x-1 whitespace-nowrap">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => goToSubmissionContext(t.parent_kind, getItemIdForThread(t, items))}
                            >
                              <ExternalLink className="h-3 w-3 mr-1" />
                              Ver
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              disabled={closingThreadIds.has(t.id)}
                              onClick={() => void closeThread(t.id)}
                            >
                              {closingThreadIds.has(t.id) ? (
                                <Spinner size="xs" className="mr-1" />
                              ) : (
                                <Lock className="h-3 w-3 mr-1" />
                              )}
                              Cerrar
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
                    Este curso no tiene sesiones de asistencia registradas.
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Fecha</TableHead>
                        <TableHead>Sesión</TableHead>
                        <TableHead className="text-right">Presentes</TableHead>
                        <TableHead className="text-right">Ausentes</TableHead>
                        <TableHead className="text-right">Pendientes</TableHead>
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
  color: "emerald" | "amber" | "red" | "slate";
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
