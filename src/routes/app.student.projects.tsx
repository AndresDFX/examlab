/**
 * Student Projects — list assigned projects, deliver via per-file text boxes.
 *
 * Refactor del flujo ZIP previo: ahora cada proyecto muestra N cajas de
 * texto (una por `project_files` row); el estudiante pega el contenido de
 * cada archivo y al enviar la IA califica caja por caja. La calificación final se
 * calcula sobre `max_score` del proyecto.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useReloadOnVisible } from "@/shared/hooks/use-reload-on-visible";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ListFilters } from "@/components/ui/list-filters";
import { ErrorState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { friendlyError } from "@/shared/lib/db-errors";
import { isAiGradePending } from "@/modules/ai/ai-grading";
import { PendingAiGradeBanner } from "@/modules/ai/PendingAiGradeBanner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  MessageSquareText,
  ListChecks,
  Trash2,
  FolderKanban,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { toast } from "sonner";
import { StudentProjectTaker } from "@/modules/projects/ProjectFiles";
import { formatDateTime } from "@/shared/lib/format";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { DatePicker } from "@/components/ui/date-picker";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/student/projects")({ component: StudentProjects });

type ProjectRow = {
  project: {
    id: string;
    title: string;
    description: string | null;
    instructions: string | null;
    start_date: string | null;
    due_date: string | null;
    max_files: number;
    max_score: number;
    is_external?: boolean | null;
    status: string;
    group_mode?: "individual" | "teacher_assigned" | "self_signup" | "group_required";
    /** Override de intentos del proyecto. NULL → usa default global. */
    max_attempts?: number | null;
    /** Necesario para el filtro por curso del listado del estudiante. */
    course_id: string;
    course: {
      id: string;
      name: string;
      grade_scale_min: number;
      grade_scale_max: number;
      language?: string | null;
    };
  };
  /** Si el proyecto es grupal y el estudiante tiene grupo, ID del grupo. */
  groupId?: string | null;
  submission?: {
    id: string;
    ai_grade: number | null;
    ai_feedback: string | null;
    final_grade: number | null;
    teacher_feedback: string | null;
    status: string;
    submitted_at: string | null;
    /** Cuántas veces ya entregó el alumno/grupo. Migración 20260607000000. */
    attempt_count?: number;
  };
};

/** Estado visible del proyecto para el filtro UI. Mismo enum + lógica
 *  que workshops (los flujos son análogos). */
type ProjectDisplayStatus =
  | "available"
  | "upcoming"
  | "submitted"
  | "graded"
  | "overdue"
  | "closed";

/** Comparador de fechas usado por el sort del listado. Tratamos `null`
 *  como "infinito al final" para ascendente y "menos infinito" para
 *  descendente — así los ítems sin fecha quedan agrupados al final en
 *  "próximos primero" / al inicio cuando ordenas al revés. */
function cmpDate(a: Date | null, b: Date | null, asc: boolean): number {
  if (!a && !b) return 0;
  if (!a) return asc ? 1 : -1;
  if (!b) return asc ? -1 : 1;
  return asc ? a.getTime() - b.getTime() : b.getTime() - a.getTime();
}

function getProjectDisplayStatus(row: ProjectRow, now: number): ProjectDisplayStatus {
  const s = row.submission?.status;
  if (s === "calificado") return "graded";
  if (s === "entregado") return "submitted";
  const isOverdue = row.project.due_date && new Date(row.project.due_date).getTime() < now;
  const isUpcoming = row.project.start_date && new Date(row.project.start_date).getTime() > now;
  if (isOverdue) return "overdue";
  if (isUpcoming) return "upcoming";
  if (row.project.status === "published") return "available";
  return "closed";
}

function StudentProjects() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ProjectDisplayStatus | "all">("all");
  // Filtros adicionales: rango de fechas (sobre `due_date`) y orden.
  // Defaults no afectan la UX vieja: dateFrom="" y dateTo="" no filtran
  // nada; sortBy="due_asc" replica el orden cronológico natural.
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [sortBy, setSortBy] = useState<
    "due_asc" | "due_desc" | "start_asc" | "start_desc" | "title_asc"
  >("due_asc");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ProjectRow | null>(null);
  // Estado de error explícito para que un fallo en la query base
  // (course_enrollments) no se renderice como "sin proyectos".
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  /** Borra la entrega del estudiante (RLS restringe a dentro del plazo).
   *  Los archivos asociados caen por CASCADE (FK en project_submission_files).
   *  En modo grupal afecta a la entrega del grupo. */
  const deleteSubmission = async (projectTitle: string, submissionId: string, isGroup: boolean) => {
    const ok = await confirm({
      title: t("project.deleteMySubmissionTitle"),
      description: isGroup
        ? t("project.deleteMySubmissionBodyGroup", { title: projectTitle })
        : t("project.deleteMySubmissionBodyIndividual", { title: projectTitle }),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("project_submissions").delete().eq("id", submissionId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Entrega eliminada");
    if (user) await reload(user.id);
  };

  const reload = async (uid: string) => {
    // Cada paso loguea su error a consola para que el diagnóstico sea
    // posible cuando "no aparece nada". No usamos Promise.all porque la
    // fase 2/3 dependen de la 1.
    let enrolledCourseIds: string[] = [];
    try {
      const { data, error } = await db
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", uid);
      if (error) throw new Error(`course_enrollments: ${error.message}`);
      enrolledCourseIds = ((data ?? []) as { course_id: string }[]).map((e) => e.course_id);
      setLoadError(null);
    } catch (e) {
      console.error("[student-projects] enrollments load failed", e);
      // Si la query base falla, marcamos loadError para que el render
      // muestre ErrorState con "Reintentar" en vez de "Sin proyectos"
      // (que sería un falso positivo).
      setLoadError(friendlyError(e, "No pudimos cargar tus proyectos."));
      return;
    }

    let linkedProjectIds: string[] = [];
    if (enrolledCourseIds.length) {
      try {
        const { data, error } = await db
          .from("project_courses")
          .select("project_id")
          .in("course_id", enrolledCourseIds);
        if (error) throw new Error(`project_courses: ${error.message}`);
        linkedProjectIds = ((data ?? []) as { project_id: string }[]).map((r) => r.project_id);
      } catch (e) {
        console.error("[student-projects] project_courses load failed", e);
      }
    }

    let assignedProjectIds: string[] = [];
    try {
      const { data, error } = await db
        .from("project_assignments")
        .select("project_id")
        .eq("user_id", uid);
      if (error) throw new Error(`project_assignments: ${error.message}`);
      assignedProjectIds = ((data ?? []) as { project_id: string }[]).map((r) => r.project_id);
    } catch (e) {
      console.error("[student-projects] project_assignments load failed", e);
    }

    const allIds = Array.from(new Set([...linkedProjectIds, ...assignedProjectIds]));
    console.info(
      `[student-projects] enrolled=${enrolledCourseIds.length} linked=${linkedProjectIds.length} assigned=${assignedProjectIds.length} → ${allIds.length} project(s)`,
    );
    if (!allIds.length) {
      setRows([]);
      return;
    }

    let projects: ProjectRow["project"][] = [];
    try {
      // Reintenta sin el JOIN si la columna `language` no existe en la BD.
      let res = await db
        .from("projects")
        .select(
          "id, title, description, instructions, start_date, due_date, max_files, max_score, is_external, status, group_mode, max_attempts, course_id, course:courses(id, name, grade_scale_min, grade_scale_max, language)",
        )
        .in("id", allIds)
        .neq("status", "draft");
      if (res.error) {
        console.warn("[student-projects] projects+join failed, retrying without join", res.error);
        res = await db
          .from("projects")
          .select(
            "id, title, description, instructions, start_date, due_date, max_files, max_score, status, group_mode, max_attempts, course_id",
          )
          .in("id", allIds)
          .neq("status", "draft");
      }
      if (res.error) throw new Error(`projects: ${res.error.message}`);
      projects = (res.data ?? []) as ProjectRow["project"][];
    } catch (e) {
      console.error("[student-projects] projects load failed", e);
    }

    const ids = projects.map((p) => p.id);

    // Para proyectos grupales: el estudiante puede tener un grupo, y la
    // submission pertenece al grupo (no al user). Mapeamos project_id
    // → group_id y la query de submissions cambia entre user_id y group_id
    // según el caso.
    const groupProjectIds = projects
      .filter((p) => p.group_mode && p.group_mode !== "individual")
      .map((p) => p.id);
    const groupIdByProject = new Map<string, string>();
    if (groupProjectIds.length > 0) {
      const { data: myGroups } = await db
        .from("project_group_members")
        .select("group:project_groups!inner(id, project_id)")
        .eq("user_id", uid);
      for (const m of (myGroups ?? []) as {
        group: { id: string; project_id: string };
      }[]) {
        if (m.group && groupProjectIds.includes(m.group.project_id)) {
          groupIdByProject.set(m.group.project_id, m.group.id);
        }
      }
    }

    // Splitting: individuales (incluye grupales sin grupo asignado, modo mixto)
    // se buscan por user_id; los grupales con grupo asignado por group_id.
    const indivIds = ids.filter((id) => !groupIdByProject.has(id));
    const myGroupIds = Array.from(groupIdByProject.values());

    let subs: Array<ProjectRow["submission"] & { project_id: string }> = [];
    if (indivIds.length || myGroupIds.length) {
      try {
        const [{ data: indivSubs }, { data: groupSubs }] = await Promise.all([
          indivIds.length
            ? db
                .from("project_submissions")
                .select(
                  "id, project_id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at, group_id, attempt_count",
                )
                .in("project_id", indivIds)
                .eq("user_id", uid)
            : Promise.resolve({ data: [] as any[] }),
          myGroupIds.length
            ? db
                .from("project_submissions")
                .select(
                  "id, project_id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at, group_id, attempt_count",
                )
                .in("group_id", myGroupIds)
            : Promise.resolve({ data: [] as any[] }),
        ]);
        subs = [...((indivSubs ?? []) as typeof subs), ...((groupSubs ?? []) as typeof subs)];
      } catch (e) {
        console.error("[student-projects] project_submissions load failed", e);
      }
    }

    setRows(
      projects.map((p) => ({
        project: p,
        submission: subs.find((s) => s.project_id === p.id) as ProjectRow["submission"],
        groupId: groupIdByProject.get(p.id) ?? null,
      })),
    );
  };

  useEffect(() => {
    if (!user) return;
    void reload(user.id);
    // retryNonce: bumpeado por ErrorState "Reintentar". Patrón canonical
    // (reload no está memoizada — ver CLAUDE.md sección useEffect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce]);

  // Refetch al volver al tab — si el docente extendió el due_date del
  // proyecto mientras el alumno tenía la pestaña en background, el
  // `isOverdue` se recalcula con los datos nuevos. Antes el cliente se
  // quedaba con el snapshot del mount inicial y seguía marcando
  // "vencido" aunque el due_date ya hubiera cambiado.
  useReloadOnVisible(() => {
    if (user) void reload(user.id);
  });

  const now = Date.now();

  // Cursos disponibles para el filtro <Select>. Deduplicado por id.
  const availableCourses = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.project.course_id) {
        map.set(r.project.course_id, r.project.course?.name ?? "—");
      }
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  // Stats estables (no se mueven al filtrar).
  const stats = useMemo(() => {
    let available = 0;
    let submitted = 0;
    let graded = 0;
    let overdue = 0;
    for (const r of rows) {
      const s = getProjectDisplayStatus(r, now);
      if (s === "available") available++;
      else if (s === "submitted") submitted++;
      else if (s === "graded") graded++;
      else if (s === "overdue") overdue++;
    }
    return { available, submitted, graded, overdue };
  }, [rows, now]);

  // Filtros combinados: búsqueda + curso + estado + rango de fechas, y
  // luego ordenamiento. Items sin `due_date` no se filtran fuera por el
  // rango — siguen visibles incluso con dateFrom/dateTo activos.
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (courseFilter && r.project.course_id !== courseFilter) return false;
      if (statusFilter !== "all" && getProjectDisplayStatus(r, now) !== statusFilter) return false;
      // Rango de fechas — filtra por due_date (deadline). Vacío = sin
      // tope en ese lado.
      const dueAt = r.project.due_date ? new Date(r.project.due_date) : null;
      if (dueAt) {
        if (dateFrom && dueAt < new Date(dateFrom)) return false;
        if (dateTo && dueAt > new Date(`${dateTo}T23:59:59.999`)) return false;
      }
      if (!q) return true;
      return (
        r.project.title.toLowerCase().includes(q) ||
        (r.project.course?.name?.toLowerCase().includes(q) ?? false)
      );
    });
    const sorted = [...filtered].sort((a, b) => {
      const aDue = a.project.due_date ? new Date(a.project.due_date) : null;
      const bDue = b.project.due_date ? new Date(b.project.due_date) : null;
      const aStart = a.project.start_date ? new Date(a.project.start_date) : null;
      const bStart = b.project.start_date ? new Date(b.project.start_date) : null;
      const aTitle = a.project.title.toLowerCase();
      const bTitle = b.project.title.toLowerCase();
      switch (sortBy) {
        case "due_asc":
          return cmpDate(aDue, bDue, true);
        case "due_desc":
          return cmpDate(aDue, bDue, false);
        case "start_asc":
          return cmpDate(aStart, bStart, true);
        case "start_desc":
          return cmpDate(aStart, bStart, false);
        case "title_asc":
          return aTitle.localeCompare(bTitle, "es");
      }
    });
    return sorted;
  }, [rows, search, courseFilter, statusFilter, now, dateFrom, dateTo, sortBy]);

  // Paginación client-side: las cards son grandes; 12 cabe en ~3 filas
  // del grid de 2 columnas. resetKey concatena TODOS los filtros activos
  // para que aplicar cualquiera vuelva a página 1.
  const pagination = usePagination(visibleRows, {
    defaultPageSize: 12,
    pageSizes: [6, 12, 24, 48],
    storageKey: "examlab_pag:student_projects",
    resetKey: `${search}|${courseFilter}|${statusFilter}|${dateFrom}|${dateTo}|${sortBy}`,
  });

  const hasActiveFilters =
    search.trim().length > 0 || courseFilter !== null || statusFilter !== "all";

  // Si la query base falló (course_enrollments), no queremos mostrar
  // "Sin proyectos" como falso negativo. El usuario debe poder reintentar.
  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<FolderKanban className="h-6 w-6" />} title="Proyectos" />
        <ErrorState
          message="No pudimos cargar tus proyectos"
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
        title="Proyectos"
        subtitle={
          search.trim()
            ? `${visibleRows.length} de ${rows.length} proyectos`
            : `${rows.length} proyectos asignados`
        }
      />

      {/* Quick-stats — métricas estables del listado completo. Mismo
          patrón visual que el dashboard admin + listados de exámenes/
          talleres del estudiante. */}
      {rows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatTile
            label="Disponibles"
            value={stats.available}
            color="text-sky-600 dark:text-sky-400"
            bg="bg-sky-500/10"
          />
          <StatTile
            label="Entregados"
            value={stats.submitted}
            color="text-amber-600 dark:text-amber-400"
            bg="bg-amber-500/10"
          />
          <StatTile
            label="Calificados"
            value={stats.graded}
            color="text-emerald-600 dark:text-emerald-400"
            bg="bg-emerald-500/10"
          />
          <StatTile
            label="Vencidos"
            value={stats.overdue}
            color="text-destructive"
            bg="bg-destructive/10"
          />
        </div>
      )}

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por proyecto o curso…"
        courseId={courseFilter}
        onCourseChange={setCourseFilter}
        courses={availableCourses}
        onClearExtra={() => {
          setStatusFilter("all");
          setDateFrom("");
          setDateTo("");
          setSortBy("due_asc");
        }}
        extra={
          <>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as ProjectDisplayStatus | "all")}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los estados</SelectItem>
                <SelectItem value="available">Disponible</SelectItem>
                <SelectItem value="upcoming">Próximo</SelectItem>
                <SelectItem value="submitted">Entregado</SelectItem>
                <SelectItem value="graded">Calificado</SelectItem>
                <SelectItem value="overdue">Vencido</SelectItem>
                <SelectItem value="closed">Cerrado</SelectItem>
              </SelectContent>
            </Select>
            <div className="w-full sm:w-44">
              <DatePicker value={dateFrom} onChange={setDateFrom} placeholder="Desde…" />
            </div>
            <div className="w-full sm:w-44">
              <DatePicker value={dateTo} onChange={setDateTo} placeholder="Hasta…" />
            </div>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="due_asc">Próximos primero (fecha)</SelectItem>
                <SelectItem value="due_desc">Más lejanos primero</SelectItem>
                <SelectItem value="start_asc">Inicio: ascendente</SelectItem>
                <SelectItem value="start_desc">Inicio: descendente</SelectItem>
                <SelectItem value="title_asc">Título A→Z</SelectItem>
              </SelectContent>
            </Select>
          </>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {visibleRows.length === 0 && (
          <div className="md:col-span-2 rounded-md border border-dashed bg-muted/20 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {hasActiveFilters ? "Sin coincidencias con los filtros actuales." : t("common.empty")}
            </p>
            {hasActiveFilters && (
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => {
                  setSearch("");
                  setCourseFilter(null);
                  setStatusFilter("all");
                  setDateFrom("");
                  setDateTo("");
                  setSortBy("due_asc");
                }}
              >
                Limpiar filtros
              </Button>
            )}
          </div>
        )}
        {pagination.paginatedItems.map(({ project, submission, groupId }) => {
          const isOverdue = project.due_date && new Date(project.due_date).getTime() < now;
          const isUpcoming = project.start_date && new Date(project.start_date).getTime() > now;
          const grade = submission?.final_grade ?? submission?.ai_grade;
          const isGraded = submission?.status === "calificado";
          const isOpen = project.status === "published" && !isOverdue && !isUpcoming;
          // Modo grupal estricto: si el estudiante no esta en un grupo,
          // no puede entregar. En modo mixto (teacher_assigned) si.
          const blockedNoGroup = project.group_mode === "group_required" && !groupId;

          return (
            <Card key={project.id}>
              <CardContent className="p-5 space-y-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{project.course?.name}</div>
                    <h3 className="font-semibold truncate">{project.title}</h3>
                  </div>
                  {isGraded ? (
                    <Badge className="shrink-0">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      {grade != null
                        ? `${project.is_external ? grade : +(project.course.grade_scale_min + (grade / (project.max_score || 100)) * (project.course.grade_scale_max - project.course.grade_scale_min)).toFixed(2)}/${project.course.grade_scale_max}`
                        : t("project.submitted")}
                    </Badge>
                  ) : submission?.status === "entregado" ? (
                    <Badge variant="secondary" className="shrink-0">
                      {t("project.submitted")}
                    </Badge>
                  ) : isOverdue ? (
                    <Badge variant="destructive" className="shrink-0">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {t("dashboard.overdue")}
                    </Badge>
                  ) : isOpen ? (
                    <Badge className="bg-success text-success-foreground shrink-0">
                      {t("project.available")}
                    </Badge>
                  ) : isUpcoming ? (
                    <Badge variant="outline" className="shrink-0">
                      {t("project.upcoming")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">
                      {t("project.closed")}
                    </Badge>
                  )}
                </div>

                {project.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {project.description}
                  </p>
                )}

                <div className="text-xs text-muted-foreground space-y-0.5">
                  {project.start_date && isUpcoming && (
                    <div className="flex items-center gap-1.5 tabular-nums">
                      <Clock className="h-3 w-3" />
                      Disponible desde: {formatDateTime(project.start_date)}
                    </div>
                  )}
                  {project.due_date && (
                    <div className="flex items-center gap-1.5 tabular-nums">
                      <Clock className="h-3 w-3" />
                      {t("dashboard.dueLabel")}: {formatDateTime(project.due_date)}
                    </div>
                  )}
                </div>

                {/* Banner pendiente: igual que en talleres. Cuando la
                    entrega quedó encolada (modo async sin override),
                    avisa al estudiante que la nota llegará después. */}
                {submission?.status === "entregado" &&
                  submission?.final_grade == null &&
                  isAiGradePending({
                    ai_grade: submission?.ai_grade,
                    ai_feedback: submission?.ai_feedback,
                  }) && <PendingAiGradeBanner variant="compact" />}

                {(submission?.teacher_feedback || submission?.ai_feedback) && (
                  <div className="bg-muted/50 p-2 rounded text-sm">
                    <div className="text-xs font-medium flex items-center gap-1 mb-1">
                      <MessageSquare className="h-3 w-3" />
                      {t("project.review.feedback")}
                    </div>
                    <div className="whitespace-pre-wrap">
                      {[
                        ...new Set(
                          [submission?.teacher_feedback, submission?.ai_feedback].filter(
                            Boolean,
                          ) as string[],
                        ),
                      ].join("\n\n")}
                    </div>
                  </div>
                )}

                {/* Modo grupal estricto SIN grupo: bloqueo de entrega. */}
                {isOpen && blockedNoGroup && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                    <div className="font-medium mb-1">Modo grupal — sin grupo asignado</div>
                    Tu docente configuró este proyecto como grupal. Aún no perteneces a ningún
                    grupo, así que no puedes entregar. Pídele al docente que te asigne a uno.
                  </div>
                )}

                {/* Mientras esté abierto el plazo, el estudiante puede
                    actualizar su entrega aunque ya tenga calificación de
                    IA — al re-entregar se vuelve a calificar. */}
                {isOpen && !blockedNoGroup && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setActive({ project, submission, groupId });
                      setOpen(true);
                    }}
                  >
                    <ListChecks className="h-4 w-4 mr-1" />
                    {submission ? t("project.update") : t("project.start")}
                  </Button>
                )}

                {submission && (
                  <Link to="/app/student/project/$projectId" params={{ projectId: project.id }}>
                    <Button variant="secondary" size="sm" className="w-full">
                      <MessageSquareText className="h-4 w-4 mr-1" />
                      {t("project.viewDetail")}
                    </Button>
                  </Link>
                )}

                {/* Eliminar mi entrega — solo dentro del plazo Y solo si
                    todavía hay intentos disponibles. Si el alumno ya
                    consumió todos sus intentos, no permitimos delete:
                    sino podría borrar y re-entregar bypasseando el cap
                    (la submission cuenta el intento, pero al borrar la
                    fila se perdería el contador). RLS valida también en
                    BD (migración 20260508140000). */}
                {isOpen &&
                  submission &&
                  Number(submission.attempt_count ?? 0) < Number(project.max_attempts ?? 1) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full text-destructive hover:text-destructive"
                      onClick={() => deleteSubmission(project.title, submission.id, !!groupId)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Eliminar mi entrega
                    </Button>
                  )}
                {isOpen &&
                  submission &&
                  Number(submission.attempt_count ?? 0) >= Number(project.max_attempts ?? 1) && (
                    <p className="text-[11px] text-muted-foreground text-center italic">
                      Ya consumiste todos tus intentos — la entrega no se puede borrar.
                    </p>
                  )}

                {project.status === "published" && isOverdue && !submission && (
                  <p className="text-xs text-destructive text-center">
                    {t("project.windowClosedHelp")}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Pagination — fuera del grid de cards. Visible solo si hay items
          (la barra se oculta sola con totalItems=0). */}
      <div className="px-1">
        <DataPagination state={pagination} entityNamePlural="proyectos" />
      </div>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o && user) void reload(user.id);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{active?.project.title}</DialogTitle>
          </DialogHeader>
          {active && (
            <>
              {active.project.description && (
                <div className="rounded-md bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                  {active.project.description}
                </div>
              )}
              <StudentProjectTaker
                projectId={active.project.id}
                projectTitle={active.project.title}
                maxScore={active.project.max_score}
                courseLanguage={active.project.course?.language === "en" ? "en" : "es"}
                groupId={active.groupId ?? null}
                onGraded={() => {
                  if (user) void reload(user.id);
                }}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Mismo helper inline que workshops/exams. Réplica del `EmailStatTile`
 *  del dashboard admin para que los tres listados del estudiante usen
 *  el mismo vocabulario visual (bg tintado + número grande + label). */
function StatTile({
  label,
  value,
  color,
  bg,
}: {
  label: string;
  value: number;
  color: string;
  bg: string;
}) {
  return (
    <div className={`rounded-md p-2.5 ${bg}`}>
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
