import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { PendingAiGradeBanner } from "@/modules/ai/PendingAiGradeBanner";
import {
  Clock,
  Play,
  CheckCircle2,
  AlertTriangle,
  MessageSquareText,
  ShieldAlert,
  FileText,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { StudentExamNotes } from "@/modules/exams/ExamNotesManager";
import { MAX_WARNINGS } from "@/modules/exams/proctoring";
import { formatDateTime } from "@/shared/lib/format";
import { DatePicker } from "@/components/ui/date-picker";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";

export const Route = createFileRoute("/app/student/exams")({ component: StudentExams });

type ExamRow = {
  exam: {
    id: string;
    title: string;
    description: string | null;
    start_time: string;
    end_time: string;
    time_limit_minutes: number;
    parent_exam_id?: string | null;
    max_attempts?: number | null;
    /** Necesario para el filtro por curso del listado del estudiante. */
    course_id: string;
    course: {
      id: string;
      name: string;
      grade_scale_min: number;
      grade_scale_max: number;
      max_exam_attempts?: number;
    };
  };
  submission?: {
    id: string;
    exam_id: string;
    status: string;
    ai_grade: number | null;
    final_override_grade: number | null;
    focus_warnings: number | null;
  };
  attemptsUsed: number;
  maxAttempts: number;
};

/** Estado visible del examen para el filtro UI del estudiante.
 *  Espeja la lógica de los badges + botones de acción en la card. */
type ExamDisplayStatus =
  | "available" // ventana abierta, sin entrega previa o con intentos restantes
  | "upcoming" // todavía no abre la ventana
  | "in_progress" // submission con status en_progreso
  | "completed" // completado / sospechoso
  | "closed"; // ventana cerrada sin intentos restantes

/** Comparador de fechas usado por el sort del listado. Tratamos `null`
 *  como "infinito al final" para ascendente y "menos infinito" para
 *  descendente — así los ítems sin fecha no se mezclan con los
 *  cronológicos válidos y quedan agrupados al final cuando ordenas por
 *  "próximos primero" / al inicio cuando ordenas al revés. */
function cmpDate(a: Date | null, b: Date | null, asc: boolean): number {
  if (!a && !b) return 0;
  if (!a) return asc ? 1 : -1;
  if (!b) return asc ? -1 : 1;
  return asc ? a.getTime() - b.getTime() : b.getTime() - a.getTime();
}

function getExamDisplayStatus(row: ExamRow, now: number): ExamDisplayStatus {
  const s = row.submission?.status;
  if (s === "en_progreso") return "in_progress";
  if (s === "completado" || s === "sospechoso") return "completed";
  const start = new Date(row.exam.start_time).getTime();
  const end = new Date(row.exam.end_time).getTime();
  if (now < start) return "upcoming";
  if (now > end) return "closed";
  return "available";
}

function StudentExams() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [rows, setRows] = useState<ExamRow[]>([]);
  const [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ExamDisplayStatus | "all">("all");
  // Filtros adicionales: rango de fechas (sobre la fecha relevante de
  // la entidad — end_time/start_time del examen) y orden. Defaults no
  // afectan la UX vieja: dateFrom="" y dateTo="" no filtran nada;
  // sortBy="due_asc" replica el orden cronológico natural (los próximos
  // a cerrar primero).
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [sortBy, setSortBy] = useState<
    "due_asc" | "due_desc" | "start_asc" | "start_desc" | "title_asc"
  >("due_asc");
  // ErrorState: si la query principal falla, mostramos placeholder con
  // "Reintentar" en vez de la grilla vacía (que el alumno interpretaría
  // como "no tengo exámenes asignados").
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  // Carga la lista de exámenes asignados. Extraído como useCallback para
  // poder reutilizarlo en el listener `visibilitychange` — antes el
  // fetch vivía inline en el useEffect y no se podía rellamar.
  const loadExams = useCallback(async () => {
    if (!user) return;
    {
      const { data: asg, error: asgErr } = await supabase
        .from("exam_assignments")
        .select(
          "exam:exams(id, title, description, start_time, end_time, time_limit_minutes, parent_exam_id, max_attempts, max_warnings, is_external, allow_exam_notes, status, course_id, course:courses(id, name, grade_scale_min, grade_scale_max, max_exam_attempts))",
        )
        .eq("user_id", user.id);
      if (asgErr) {
        setLoadError(friendlyError(asgErr, "No pudimos cargar tus exámenes."));
        return;
      }
      setLoadError(null);
      // Filtramos:
      //   - externos: la nota llega por gradebook, no se muestran en la lista
      //   - draft: el docente aún no publicó el examen → oculto
      //   - closed: SÍ se muestra (con badge "Cerrado") para que el alumno
      //     vea sus intentos/notas previas. Coherente con workshops/projects.
      //     La toma queda bloqueada server-side por app.student.take.
      const exams = (asg ?? [])
        .map((a: any) => a.exam)
        .filter((e: any) => Boolean(e) && !e.is_external && (e.status ?? "published") !== "draft");
      const assignedIds = exams.map((e: any) => e.id);
      let makeupRows: { id: string; parent_exam_id: string | null }[] = [];
      if (assignedIds.length) {
        const { data: mr } = await supabase
          .from("exams")
          .select("id, parent_exam_id")
          .in("parent_exam_id", assignedIds);
        makeupRows = mr ?? [];
      }
      const submissionExamIds = [...new Set([...assignedIds, ...makeupRows.map((m) => m.id)])];
      type SubRow = {
        id: string;
        exam_id: string;
        status: string;
        ai_grade: number | null;
        final_override_grade: number | null;
        focus_warnings: number | null;
      };
      const { data: subs } = submissionExamIds.length
        ? await supabase
            .from("submissions")
            .select("id, exam_id, status, ai_grade, final_override_grade, focus_warnings")
            .in("exam_id", submissionExamIds)
            .eq("user_id", user.id)
        : { data: [] as SubRow[] };

      const findSubmission = (examId: string): SubRow | undefined => {
        const list = subs as SubRow[] | undefined;
        let sub = list?.find((s) => s.exam_id === examId);
        if (sub) return sub;
        const makeupIds = makeupRows.filter((m) => m.parent_exam_id === examId).map((m) => m.id);
        return list?.find((s) => makeupIds.includes(s.exam_id));
      };

      const countAttempts = (examId: string): number => {
        // Solo cuenta intentos YA CALIFICADOS. Una entrega `completado`
        // sin nota (ai_grade null y sin override docente) sigue
        // editable — el alumno puede reanudarla y re-entregar antes de
        // que IA/docente la califiquen. Si la contáramos, el botón
        // de "Hacer examen" mostraría "Sin intentos disponibles"
        // injustamente. Misma regla en el cap dentro de take.$examId.
        const list = (subs ?? []) as SubRow[];
        return list.filter(
          (s) =>
            s.exam_id === examId &&
            (s.status === "completado" || s.status === "sospechoso") &&
            (s.ai_grade != null || s.final_override_grade != null),
        ).length;
      };

      setRows(
        exams.map((e: any) => {
          const courseMax = Number(e.course?.max_exam_attempts ?? 1) || 1;
          const examMax = e.max_attempts != null ? Number(e.max_attempts) : courseMax;
          return {
            exam: e,
            submission: findSubmission(e.id),
            attemptsUsed: countAttempts(e.id),
            maxAttempts: Math.max(1, examMax),
          };
        }),
      );
    }
  }, [user]);

  useEffect(() => {
    void loadExams();
  }, [loadExams]);

  // Refetch al volver al tab — si el docente extendió/recortó las
  // fechas de un examen mientras el alumno tenía la pestaña en
  // background, los estados (abierto/próximo/cerrado) se recalculan
  // al instante con los datos nuevos. Antes el cliente se quedaba con
  // el snapshot del mount inicial y seguía marcando "cerrado" aunque
  // el docente hubiera extendido el end_time.
  useReloadOnVisible(loadExams);

  // Cursos disponibles para el filtro <Select>. Deduplicado por id.
  const availableCourses = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.exam.course_id) {
        map.set(r.exam.course_id, r.exam.course?.name ?? "—");
      }
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  // Stats estables del listado completo (no se mueven al filtrar).
  const stats = useMemo(() => {
    let available = 0;
    let inProgress = 0;
    let completed = 0;
    let upcoming = 0;
    for (const r of rows) {
      const s = getExamDisplayStatus(r, now);
      if (s === "available") available++;
      else if (s === "in_progress") inProgress++;
      else if (s === "completed") completed++;
      else if (s === "upcoming") upcoming++;
    }
    return { available, inProgress, completed, upcoming };
  }, [rows, now]);

  // Filtros combinados: búsqueda + curso + estado + rango de fechas, y
  // luego ordenamiento. La "fecha due" del examen es `end_time` (cierre
  // de la ventana) y la "fecha start" es `start_time` (apertura). Ítems
  // sin fecha (nunca debería pasar con exams, pero por defensividad)
  // no se filtran fuera por el rango — siguen visibles incluso con
  // dateFrom/dateTo activos.
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (courseFilter && r.exam.course_id !== courseFilter) return false;
      if (statusFilter !== "all" && getExamDisplayStatus(r, now) !== statusFilter) return false;
      // Rango de fechas — filtra por end_time (deadline). Una fecha
      // vacía significa sin tope en ese lado.
      const dueAt = r.exam.end_time ? new Date(r.exam.end_time) : null;
      if (dueAt) {
        if (dateFrom && dueAt < new Date(dateFrom)) return false;
        if (dateTo && dueAt > new Date(`${dateTo}T23:59:59.999`)) return false;
      }
      if (!q) return true;
      return (
        r.exam.title.toLowerCase().includes(q) ||
        (r.exam.course?.name?.toLowerCase().includes(q) ?? false)
      );
    });
    const sorted = [...filtered].sort((a, b) => {
      const aDue = a.exam.end_time ? new Date(a.exam.end_time) : null;
      const bDue = b.exam.end_time ? new Date(b.exam.end_time) : null;
      const aStart = a.exam.start_time ? new Date(a.exam.start_time) : null;
      const bStart = b.exam.start_time ? new Date(b.exam.start_time) : null;
      const aTitle = a.exam.title.toLowerCase();
      const bTitle = b.exam.title.toLowerCase();
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
  // del grid de 2 columnas (6 filas en mobile). El resetKey concatena
  // TODOS los filtros activos para que aplicar cualquiera vuelva a la
  // página 1.
  const pagination = usePagination(visibleRows, {
    defaultPageSize: 12,
    pageSizes: [6, 12, 24, 48],
    storageKey: "examlab_pag:student_exams",
    resetKey: `${search}|${courseFilter}|${statusFilter}|${dateFrom}|${dateTo}|${sortBy}`,
  });

  const hasActiveFilters =
    search.trim().length > 0 || courseFilter !== null || statusFilter !== "all";

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<FileText className="h-6 w-6" />} title={t("exam.title")} />
        <ErrorState
          message="No pudimos cargar tus exámenes"
          hint={loadError}
          onRetry={() => void loadExams()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<FileText className="h-6 w-6" />}
        title={t("exam.title")}
        subtitle={t("exam.availableSubtitle", { count: visibleRows.length })}
      />

      {/* Quick-stats de exámenes — métricas estables (no se mueven al
          filtrar). 4 tiles tintados al estilo unificado de los demás
          listados del estudiante. */}
      {rows.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatTile
            label="Disponibles"
            value={stats.available}
            color="text-sky-600 dark:text-sky-400"
            bg="bg-sky-500/10"
          />
          <StatTile
            label="En progreso"
            value={stats.inProgress}
            color="text-amber-600 dark:text-amber-400"
            bg="bg-amber-500/10"
          />
          <StatTile
            label="Completados"
            value={stats.completed}
            color="text-emerald-600 dark:text-emerald-400"
            bg="bg-emerald-500/10"
          />
          <StatTile
            label="Próximos"
            value={stats.upcoming}
            color="text-foreground"
            bg="bg-muted/40"
          />
        </div>
      )}

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por examen o curso…"
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
              onValueChange={(v) => setStatusFilter(v as ExamDisplayStatus | "all")}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los estados</SelectItem>
                <SelectItem value="available">Disponible</SelectItem>
                <SelectItem value="upcoming">Próximo</SelectItem>
                <SelectItem value="in_progress">En progreso</SelectItem>
                <SelectItem value="completed">Completado</SelectItem>
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
              {hasActiveFilters
                ? "Sin coincidencias con los filtros actuales."
                : t("exam.noExamsAvailable")}
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
        {pagination.paginatedItems.map(({ exam, submission, attemptsUsed, maxAttempts }) => {
          const start = new Date(exam.start_time).getTime();
          const end = new Date(exam.end_time).getTime();
          const isOpen = now >= start && now <= end;
          const completed =
            submission?.status === "completado" || submission?.status === "sospechoso";
          const grade = submission?.final_override_grade ?? submission?.ai_grade;
          const reviewExamId = completed && submission?.exam_id ? submission.exam_id : exam.id;
          const noAttemptsLeft = attemptsUsed >= maxAttempts;
          return (
            <Card key={exam.id}>
              <CardContent className="p-5 space-y-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{exam.course?.name}</div>
                    <h3 className="font-semibold truncate">{exam.title}</h3>
                  </div>
                  {completed ? (
                    <Badge
                      variant={submission?.status === "sospechoso" ? "destructive" : "default"}
                      className="shrink-0"
                    >
                      {submission?.status === "sospechoso" ? (
                        <AlertTriangle className="h-3 w-3 mr-1" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                      )}
                      {grade != null
                        ? t("exam.gradeLabel", { grade, max: exam.course?.grade_scale_max ?? 5 })
                        : t("exam.submitted")}
                    </Badge>
                  ) : isOpen ? (
                    <Badge className="bg-success text-success-foreground shrink-0">
                      {t("exam.available")}
                    </Badge>
                  ) : now < start ? (
                    <Badge variant="outline" className="shrink-0">
                      {t("exam.upcoming")}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="shrink-0">
                      {t("exam.closed")}
                    </Badge>
                  )}
                </div>
                {/* Banner pendiente IA: examen ya entregado pero sin
                    nota asignada todavía. La query solo trae `ai_grade`
                    + `final_override_grade`; null en ambos === la IA
                    no escribió aún (modo async sin override del docente). */}
                {completed && grade == null && <PendingAiGradeBanner variant="compact" />}

                {exam.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">{exam.description}</p>
                )}
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3 w-3" />
                    {t("exam.availability", {
                      start: formatDateTime(exam.start_time),
                      end: formatDateTime(exam.end_time),
                    })}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>{t("exam.duration", { min: exam.time_limit_minutes })}</span>
                    {maxAttempts > 1 && (
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                        Intento {Math.min(attemptsUsed + (completed ? 0 : 1), maxAttempts)} de{" "}
                        {maxAttempts}
                      </Badge>
                    )}
                  </div>
                  {submission?.status === "en_progreso" && (submission.focus_warnings ?? 0) > 0 && (
                    <div className="flex items-center gap-1 mt-0.5">
                      <ShieldAlert className="h-3 w-3 text-destructive" />
                      <span className="text-destructive font-medium">
                        {submission.focus_warnings}/{(exam as any).max_warnings ?? MAX_WARNINGS}{" "}
                        strikes registrados
                      </span>
                    </div>
                  )}
                </div>
                {/* Solo mostramos el componente de notas de apoyo si
                    el docente las habilitó para este examen. Default
                    true para mantener compat con exámenes pre-toggle. */}
                {!completed &&
                  user &&
                  now < end &&
                  ((exam as { allow_exam_notes?: boolean }).allow_exam_notes ?? true) && (
                    <StudentExamNotes examId={exam.id} userId={user.id} />
                  )}
                {completed && !noAttemptsLeft && isOpen ? (
                  <div className="space-y-2">
                    <Link to="/app/student/take/$examId" params={{ examId: exam.id }}>
                      <Button size="sm" className="w-full">
                        <Play className="h-4 w-4 mr-1" />
                        Reintentar examen
                      </Button>
                    </Link>
                    <Link to="/app/student/review/$examId" params={{ examId: reviewExamId }}>
                      <Button variant="ghost" size="sm" className="w-full">
                        <MessageSquareText className="h-4 w-4 mr-1" />
                        {t("exam.viewDetail")}
                      </Button>
                    </Link>
                  </div>
                ) : completed ? (
                  <Link to="/app/student/review/$examId" params={{ examId: reviewExamId }}>
                    <Button variant="secondary" size="sm" className="w-full">
                      <MessageSquareText className="h-4 w-4 mr-1" />
                      {t("exam.viewDetail")}
                    </Button>
                  </Link>
                ) : submission?.status === "en_progreso" && !isOpen && now > end ? (
                  <div className="space-y-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled
                      className="w-full cursor-not-allowed"
                    >
                      {t("exam.windowClosed")}
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground leading-snug">
                      {t("exam.windowClosedHelp")}
                    </p>
                  </div>
                ) : noAttemptsLeft ? (
                  <div className="space-y-2">
                    <Button size="sm" disabled variant="outline" className="w-full">
                      <Play className="h-4 w-4 mr-1" />
                      Sin intentos disponibles
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground leading-snug">
                      Has agotado los {maxAttempts} intento(s) permitidos para este examen.
                    </p>
                  </div>
                ) : isOpen &&
                  submission?.status === "en_progreso" &&
                  (submission.focus_warnings ?? 0) >=
                    ((exam as any).max_warnings ?? MAX_WARNINGS) ? (
                  <div className="space-y-2">
                    <Button size="sm" disabled variant="outline" className="w-full">
                      <ShieldAlert className="h-4 w-4 mr-1" />
                      Examen suspendido
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground leading-snug">
                      Alcanzaste el máximo de advertencias. El docente puede revisar tu caso.
                    </p>
                  </div>
                ) : isOpen ? (
                  <Link to="/app/student/take/$examId" params={{ examId: exam.id }}>
                    <Button size="sm" className="w-full">
                      <Play className="h-4 w-4 mr-1" />
                      {submission?.status === "en_progreso" ? t("exam.resume") : t("exam.start")}
                    </Button>
                  </Link>
                ) : now < start ? (
                  <div className="space-y-2">
                    <Button size="sm" disabled variant="outline" className="w-full">
                      <Play className="h-4 w-4 mr-1" />
                      Aún no disponible
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground leading-snug">
                      Este examen está próximo a empezar. Podrás acceder cuando abra la ventana.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Button size="sm" disabled variant="outline" className="w-full">
                      <Play className="h-4 w-4 mr-1" />
                      Examen cerrado
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground leading-snug">
                      El periodo de este examen ya finalizó.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Pagination — vive fuera del grid de cards. Visible cuando hay
          al menos un item; se oculta sola si totalItems=0. */}
      <div className="px-1">
        <DataPagination state={pagination} entityNamePlural="exámenes" />
      </div>
    </div>
  );
}

/** Mismo helper que app.student.workshops.tsx. Inline acá porque solo
 *  lo usan los dos listados del estudiante y duplicar 10 líneas es más
 *  barato que mantener un módulo compartido para algo tan trivial. */
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
