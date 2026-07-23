/**
 * Student-side workshop list.
 *
 * UX (vigente desde el refactor de talleres):
 *  - El estudiante NO sube archivos ni envía links. El único flujo de entrega
 *    es responder cada pregunta del taller.
 *  - "Responder y enviar" abre el `StudentWorkshopTaker`, que muestra las
 *    preguntas (abierta / cerrada / código / diagrama) y, al enviar, llama al
 *    edge function `ai-grade-submission` por cada pregunta y consolida la
 *    calificación final automáticamente.
 *  - El idioma del curso se pasa al Taker para que la IA responda en el
 *    idioma configurado (default español).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useReloadOnVisible } from "@/shared/hooks/use-reload-on-visible";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Clock,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  MessageSquareText,
  ListChecks,
  Trash2,
  Hammer,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { useMaximized } from "@/hooks/use-maximized";
import { cn } from "@/shared/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { StudentWorkshopTaker } from "@/modules/workshops/WorkshopQuestions";
import { formatDateTime } from "@/shared/lib/format";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { isAiGradePending } from "@/modules/ai/ai-grading";
import { PendingAiGradeBanner } from "@/modules/ai/PendingAiGradeBanner";
import { DatePicker } from "@/components/ui/date-picker";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";

export const Route = createFileRoute("/app/student/workshops")({ component: StudentWorkshops });

type WorkshopRow = {
  workshop: {
    id: string;
    title: string;
    description: string | null;
    instructions: string | null;
    external_link: string | null;
    due_date: string | null;
    start_date: string | null;
    max_score: number;
    is_external?: boolean | null;
    status: string;
    group_mode?: "individual" | "teacher_assigned" | "self_signup" | "group_required";
    /** Override de intentos del taller. NULL → usa default global. */
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
  /** Si el taller es grupal y el estudiante tiene grupo, ID del grupo. */
  groupId?: string | null;
  submission?: {
    id: string;
    ai_grade: number | null;
    ai_feedback: string | null;
    final_grade: number | null;
    teacher_feedback: string | null;
    status: string;
    submitted_at: string | null;
    /** Cuántas veces ya entregó el alumno/grupo. Migración 20260607010000. */
    attempt_count?: number;
  };
};

/** Estados visibles en el filtro del listado del estudiante. Mapean
 *  combinaciones (submission.status + due_date) a un único enum simple
 *  para que el filtro UI no se infle con todas las permutaciones reales. */
type WorkshopDisplayStatus =
  | "available" // publicado, dentro de plazo, sin entregar
  | "upcoming" // start_date en el futuro
  | "submitted" // entregado pero sin calificar
  | "graded" // calificado
  | "overdue" // vencido sin entregar
  | "closed"; // status closed del docente

/** Comparador de fechas usado por el sort del listado. Tratamos `null`
 *  como "infinito al final" para ascendente y "menos infinito" para
 *  descendente — así los ítems sin fecha quedan agrupados al final en
 *  "próximos primero" / al inicio cuando ordenas al revés, en lugar de
 *  mezclarse con los cronológicos válidos. */
function cmpDate(a: Date | null, b: Date | null, asc: boolean): number {
  if (!a && !b) return 0;
  if (!a) return asc ? 1 : -1;
  if (!b) return asc ? -1 : 1;
  return asc ? a.getTime() - b.getTime() : b.getTime() - a.getTime();
}

/** Resuelve el "estado visible" de una fila para el filtro. Espeja la
 *  lógica de los badges en la card — si esto cambia, los badges deben
 *  cambiar también para que el filtro y la UI no diverjan. */
function getWorkshopDisplayStatus(row: WorkshopRow, now: number): WorkshopDisplayStatus {
  const s = row.submission?.status;
  if (s === "calificado") return "graded";
  if (s === "entregado") return "submitted";
  const isOverdue = row.workshop.due_date && new Date(row.workshop.due_date).getTime() < now;
  const isUpcoming = row.workshop.start_date && new Date(row.workshop.start_date).getTime() > now;
  if (isOverdue) return "overdue";
  if (isUpcoming) return "upcoming";
  if (row.workshop.status === "published") return "available";
  return "closed";
}

const ALL_STATUSES = "__all_status__";

function StudentWorkshops() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [rows, setRows] = useState<WorkshopRow[]>([]);
  // Arranca en true para no mostrar el empty ("no hay talleres") antes del fetch.
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  // Default "available" (publicado, dentro de plazo, sin entregar) = "lo que
  // está en curso/accionable ahora". El estudiante puede ver lo cerrado/vencido
  // o todo cambiando el filtro a su opción o a "Todos". Valor determinista
  // (no lee storage) → seguro para hidratación SSR.
  const [statusFilter, setStatusFilter] = useState<WorkshopDisplayStatus | "all">("available");
  // Filtros adicionales: rango de fechas (sobre `due_date` del taller) y
  // orden. Defaults no afectan la UX vieja: dateFrom="" y dateTo="" no
  // filtran nada; sortBy="due_asc" replica el orden cronológico natural.
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [sortBy, setSortBy] = useState<
    "due_asc" | "due_desc" | "start_asc" | "start_desc" | "title_asc"
  >("due_asc");
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [questionsWs, setQuestionsWs] = useState<WorkshopRow | null>(null);
  // Preferencia "tamaño completo" del modal de resolución (compartida con el
  // examen via la misma clave de localStorage).
  const [maximized, toggleMaximized] = useMaximized("examlab_assessment_maximized");
  // Estado de error explícito: si la query principal falla, mostramos
  // ErrorState con botón "Reintentar" en vez de una grilla vacía.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Default global de intentos (app_settings.default_workshop_max_attempts).
  // workshops.max_attempts NULL hereda este valor — igual que el punto de
  // enforcement en WorkshopQuestions. Sin esto el listado usaba `?? 1` y podía
  // marcar "intentos agotados" antes de tiempo, bloqueando el CTA "Actualizar".
  const [globalWorkshopMax, setGlobalWorkshopMax] = useState(1);

  /** Borra la entrega del estudiante (RLS restringe a dentro del plazo).
   *  Las respuestas asociadas caen por CASCADE (FK añadida en
   *  20260508140000). En modo grupal afecta a la entrega del grupo. */
  const deleteSubmission = async (
    workshopTitle: string,
    submissionId: string,
    isGroup: boolean,
  ) => {
    const ok = await confirm({
      title: t("workshop.deleteMySubmissionTitle"),
      description: isGroup
        ? t("workshop.deleteMySubmissionBodyGroup", { title: workshopTitle })
        : t("workshop.deleteMySubmissionBodyIndividual", { title: workshopTitle }),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("workshop_submissions").delete().eq("id", submissionId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(t("hc_routesAppStudentWorkshops.submissionDeleted"));
    if (user) await reload(user.id);
  };

  const reload = async (uid: string) => {
    setLoading(true);
    try {
    // courses.language se introdujo en migraciones recientes; cast hasta que se
    // refresque la tipificación generada de Supabase.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = supabase as any;
    // Default global de intentos (best-effort; si falla, queda en 1).
    const { data: appCfg } = await client
      .from("app_settings")
      .select("default_workshop_max_attempts")
      .limit(1)
      .maybeSingle();
    if (appCfg?.default_workshop_max_attempts != null) {
      setGlobalWorkshopMax(Number(appCfg.default_workshop_max_attempts) || 1);
    }
    const { data: asg, error: asgErr } = await client
      .from("workshop_assignments")
      .select(
        "workshop:workshops(id, title, description, instructions, external_link, due_date, start_date, max_score, status, is_external, group_mode, max_attempts, deleted_at, course_id, course:courses(id, name, grade_scale_min, grade_scale_max, language))",
      )
      .eq("user_id", uid);
    if (asgErr) {
      setLoadError(friendlyError(asgErr, t("hc_routesAppStudentWorkshops.loadWorkshopsError")));
      return;
    }
    setLoadError(null);

    // Externos no se listan: solo se registran notas, el estudiante
    // ve la calificación directo en gradebook.
    // Draft tampoco se lista: el docente aún no lo publicó. Closed sí
    // se muestra (con badge "Cerrado") para que el estudiante vea sus
    // entregas/notas previas — coherente con projects.
    const workshops = (asg ?? [])
      .map((a: any) => a.workshop)
      .filter(
        (w: any) =>
          Boolean(w) && !w.deleted_at && !w.is_external && (w.status ?? "published") !== "draft",
      );
    const ids = workshops.map((w: any) => w.id);

    // Para talleres grupales: el estudiante puede tener un grupo, y la
    // submission pertenece al grupo (no al user). Mapeamos workshop_id
    // → group_id y la query de submission cambia entre user_id y group_id
    // según el caso.
    const groupWorkshopIds = workshops
      .filter((w: any) => w.group_mode && w.group_mode !== "individual")
      .map((w: any) => w.id as string);
    const groupIdByWorkshop = new Map<string, string>();
    if (groupWorkshopIds.length > 0) {
      const { data: myGroups } = await client
        .from("workshop_group_members")
        .select("group:workshop_groups!inner(id, workshop_id)")
        .eq("user_id", uid);
      for (const m of (myGroups ?? []) as {
        group: { id: string; workshop_id: string };
      }[]) {
        if (m.group && groupWorkshopIds.includes(m.group.workshop_id)) {
          groupIdByWorkshop.set(m.group.workshop_id, m.group.id);
        }
      }
    }

    // Splitting de IDs: los individuales se buscan por user_id; los
    // grupales por group_id de mi grupo (si lo tengo).
    const indivIds = ids.filter((id: string) => !groupIdByWorkshop.has(id));
    const myGroupIds = Array.from(groupIdByWorkshop.values());

    const [{ data: indivSubs }, { data: groupSubs }] = await Promise.all([
      indivIds.length > 0
        ? supabase
            .from("workshop_submissions")
            .select(
              "id, workshop_id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at, group_id, attempt_count",
            )
            .in("workshop_id", indivIds)
            .eq("user_id", uid)
        : Promise.resolve({ data: [] as any[] }),
      myGroupIds.length > 0
        ? supabase
            .from("workshop_submissions")
            .select(
              "id, workshop_id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at, group_id, attempt_count",
            )
            .in("group_id", myGroupIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const subs = [...(indivSubs ?? []), ...(groupSubs ?? [])];

    setRows(
      workshops.map((w: any) => ({
        workshop: w,
        submission: subs?.find((s: any) => s.workshop_id === w.id),
        groupId: groupIdByWorkshop.get(w.id) ?? null,
      })),
    );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user) return;
    void reload(user.id);
    // retryNonce: bumpeado por ErrorState "Reintentar". eslint-disable
    // intencional porque `reload` no está memoizada (patrón canonical).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce]);

  // Refetch al volver al tab — si el docente extendió/recortó fechas
  // mientras el alumno tenía la pestaña en background, el `isOverdue`
  // de cada workshop se recalcula al instante con los datos nuevos.
  // Antes el cliente se quedaba con el snapshot del mount inicial y
  // seguía marcando "vencido" aunque el due_date ya hubiera cambiado.
  useReloadOnVisible(() => {
    if (user) void reload(user.id);
  });

  const now = Date.now();

  // Lista deduplicada de cursos con al menos un taller asignado. Se
  // alimenta el filtro <Select> de ListFilters. Si el alumno está en un
  // solo curso, el filtro queda como "Todos" con 1 opción — funcional
  // y no inflado.
  const availableCourses = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.workshop.course_id) {
        map.set(r.workshop.course_id, r.workshop.course?.name ?? "—");
      }
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  // Quick-stats arriba del listado. El conteo se basa en rows
  // completas (NO filtradas) para que sean métricas estables del curso
  // del alumno — independientes de qué tenga escrito en el buscador.
  const stats = useMemo(() => {
    let available = 0;
    let submitted = 0;
    let graded = 0;
    let overdue = 0;
    for (const r of rows) {
      const s = getWorkshopDisplayStatus(r, now);
      if (s === "available") available++;
      else if (s === "submitted") submitted++;
      else if (s === "graded") graded++;
      else if (s === "overdue") overdue++;
    }
    return { available, submitted, graded, overdue };
  }, [rows, now]);

  // Filtros combinados: búsqueda + curso + estado + rango de fechas, y
  // luego ordenamiento. El status se calcula por fila bajo demanda (no
  // se cachea por row) — para 50-100 talleres típicos el costo es
  // negligible. Items sin `due_date` no se filtran fuera por el rango
  // (siguen visibles incluso con dateFrom/dateTo activos).
  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (courseFilter && r.workshop.course_id !== courseFilter) return false;
      if (statusFilter !== "all" && getWorkshopDisplayStatus(r, now) !== statusFilter) return false;
      // Rango de fechas — filtra por due_date (deadline). Vacío = sin
      // tope en ese lado.
      const dueAt = r.workshop.due_date ? new Date(r.workshop.due_date) : null;
      if (dueAt) {
        if (dateFrom && dueAt < new Date(dateFrom)) return false;
        if (dateTo && dueAt > new Date(`${dateTo}T23:59:59.999`)) return false;
      }
      if (!q) return true;
      return (
        r.workshop.title.toLowerCase().includes(q) ||
        (r.workshop.course?.name?.toLowerCase().includes(q) ?? false)
      );
    });
    const sorted = [...filtered].sort((a, b) => {
      const aDue = a.workshop.due_date ? new Date(a.workshop.due_date) : null;
      const bDue = b.workshop.due_date ? new Date(b.workshop.due_date) : null;
      const aStart = a.workshop.start_date ? new Date(a.workshop.start_date) : null;
      const bStart = b.workshop.start_date ? new Date(b.workshop.start_date) : null;
      const aTitle = a.workshop.title.toLowerCase();
      const bTitle = b.workshop.title.toLowerCase();
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
    storageKey: "examlab_pag:student_workshops",
    resetKey: `${search}|${courseFilter}|${statusFilter}|${dateFrom}|${dateTo}|${sortBy}`,
  });

  const hasActiveFilters =
    search.trim().length > 0 || courseFilter !== null || statusFilter !== "all";

  // Si la query principal falló, render explícito con botón Reintentar
  // en vez de una grilla vacía silenciosa.
  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<Hammer className="h-6 w-6" />} title={t("nav.workshops")} />
        <ErrorState
          message={t("hc_routesAppStudentWorkshops.loadWorkshopsErrorTitle")}
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
        title={t("nav.workshops")}
        subtitle={`${visibleRows.length} ${t("nav.workshops").toLowerCase()}`}
      />

      {/* Stats 4-card — siempre visible, patrón compartido. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Hammer}
          label={t("hc_routesAppStudentWorkshops.statAvailable")}
          value={stats.available}
          tone={stats.available > 0 ? "success" : "default"}
        />
        <StatCard
          icon={Send}
          label={t("hc_routesAppStudentWorkshops.statSubmitted")}
          value={stats.submitted}
        />
        <StatCard
          icon={CheckCircle2}
          label={t("hc_routesAppStudentWorkshops.statGraded")}
          value={stats.graded}
        />
        <StatCard
          icon={AlertTriangle}
          label={t("hc_routesAppStudentWorkshops.statOverdue")}
          value={stats.overdue}
          tone={stats.overdue > 0 ? "destructive" : "default"}
        />
      </div>

      {/* Búsqueda + curso + estado. ListFilters provee búsqueda + curso;
          el filtro de estado va en el slot `extra` para conservar la
          alineación responsive sin envolver el componente. */}
      <ListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={t("hc_routesAppStudentWorkshops.searchPlaceholder")}
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
              onValueChange={(v) => setStatusFilter(v as WorkshopDisplayStatus | "all")}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("hc_routesAppStudentWorkshops.statusAll")}
                </SelectItem>
                <SelectItem value="available">
                  {t("hc_routesAppStudentWorkshops.statusAvailable")}
                </SelectItem>
                <SelectItem value="upcoming">
                  {t("hc_routesAppStudentWorkshops.statusUpcoming")}
                </SelectItem>
                <SelectItem value="submitted">
                  {t("hc_routesAppStudentWorkshops.statusSubmitted")}
                </SelectItem>
                <SelectItem value="graded">
                  {t("hc_routesAppStudentWorkshops.statusGraded")}
                </SelectItem>
                <SelectItem value="overdue">
                  {t("hc_routesAppStudentWorkshops.statusOverdue")}
                </SelectItem>
                <SelectItem value="closed">
                  {t("hc_routesAppStudentWorkshops.statusClosed")}
                </SelectItem>
              </SelectContent>
            </Select>
            <div className="w-full sm:w-44">
              <DatePicker
                value={dateFrom}
                onChange={setDateFrom}
                placeholder={t("hc_routesAppStudentWorkshops.dateFromPlaceholder")}
              />
            </div>
            <div className="w-full sm:w-44">
              <DatePicker
                value={dateTo}
                onChange={setDateTo}
                placeholder={t("hc_routesAppStudentWorkshops.dateToPlaceholder")}
              />
            </div>
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
              <SelectTrigger className="w-full sm:w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="due_asc">
                  {t("hc_routesAppStudentWorkshops.sortDueAsc")}
                </SelectItem>
                <SelectItem value="due_desc">
                  {t("hc_routesAppStudentWorkshops.sortDueDesc")}
                </SelectItem>
                <SelectItem value="start_asc">
                  {t("hc_routesAppStudentWorkshops.sortStartAsc")}
                </SelectItem>
                <SelectItem value="start_desc">
                  {t("hc_routesAppStudentWorkshops.sortStartDesc")}
                </SelectItem>
                <SelectItem value="title_asc">
                  {t("hc_routesAppStudentWorkshops.sortTitleAsc")}
                </SelectItem>
              </SelectContent>
            </Select>
          </>
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {loading && (
          <div className="md:col-span-2 flex justify-center py-10">
            <Spinner size="md" />
          </div>
        )}
        {!loading && visibleRows.length === 0 && (
          <div className="md:col-span-2 rounded-md border border-dashed bg-muted/20 p-6 text-center">
            <p className="text-sm text-muted-foreground">
              {hasActiveFilters
                ? t("hc_routesAppStudentWorkshops.noMatches")
                : t("common.empty")}
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
                {t("hc_routesAppStudentWorkshops.clearFilters")}
              </Button>
            )}
          </div>
        )}
        {pagination.paginatedItems.map(({ workshop, submission, groupId }) => {
          const isOverdue = workshop.due_date && new Date(workshop.due_date).getTime() < now;
          const isUpcoming = workshop.start_date && new Date(workshop.start_date).getTime() > now;
          const grade = submission?.final_grade ?? submission?.ai_grade;
          const isGraded = submission?.status === "calificado";
          const isOpen = workshop.status === "published" && !isOverdue && !isUpcoming;
          // Modo mixto (teacher_assigned): coexisten estudiantes con grupo y sin
          // grupo — los segundos entregan individual. Modo grupal estricto
          // (group_required): los estudiantes sin grupo NO pueden entregar.
          const isGroupWorkshop = workshop.group_mode && workshop.group_mode !== "individual";
          const requiresGroup = workshop.group_mode === "group_required";
          const blockedNoGroup = requiresGroup && !groupId;
          void isGroupWorkshop;
          // Intentos agotados = consumió el cap de intentos Y la entrega previa
          // YA fue calificada. En ese estado no puede re-entregar (el submit de
          // WorkshopQuestions lo bloquea) ni borrar — así que tampoco mostramos
          // el CTA "Actualizar": ofrecer actualizar algo que ya no admite más
          // intentos es confuso. Si está `entregado` SIN nota sigue en el MISMO
          // intento (puede re-editar) → no se considera agotado.
          const attemptsExhausted =
            !!submission &&
            Number(submission.attempt_count ?? 0) >=
              Number(workshop.max_attempts ?? globalWorkshopMax ?? 1) &&
            (submission.status === "calificado" || submission.final_grade != null);
          return (
            <Card key={workshop.id}>
              <CardContent className="p-5 space-y-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{workshop.course?.name}</div>
                    <h3 className="font-semibold truncate">{workshop.title}</h3>
                  </div>
                  {isGraded ? (
                    <Badge className="shrink-0">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      {grade != null
                        ? workshop.course
                          ? `${workshop.is_external ? grade : +(workshop.course.grade_scale_min + (grade / (workshop.max_score || 100)) * (workshop.course.grade_scale_max - workshop.course.grade_scale_min)).toFixed(2)}/${workshop.course.grade_scale_max}`
                          : `${grade}`
                        : t("exam.submitted")}
                    </Badge>
                  ) : submission?.status === "entregado" ? (
                    <Badge variant="secondary" className="shrink-0">
                      {t("exam.submitted")}
                    </Badge>
                  ) : isOverdue ? (
                    <Badge variant="destructive" className="shrink-0">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {t("dashboard.overdue")}
                    </Badge>
                  ) : isOpen ? (
                    <Badge className="bg-success text-success-foreground shrink-0">
                      {t("exam.available")}
                    </Badge>
                  ) : isUpcoming ? (
                    <Badge variant="outline" className="shrink-0">
                      {t("exam.upcoming")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">
                      {t("exam.closed")}
                    </Badge>
                  )}
                </div>

                {workshop.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {workshop.description}
                  </p>
                )}

                <div className="text-xs text-muted-foreground space-y-0.5">
                  {workshop.start_date && isUpcoming && (
                    <div className="flex items-center gap-1.5 tabular-nums">
                      <Clock className="h-3 w-3" />
                      {t("hc_routesAppStudentWorkshops.availableFromLabel")}:{" "}
                      {formatDateTime(workshop.start_date)}
                    </div>
                  )}
                  {workshop.due_date && (
                    <div className="flex items-center gap-1.5 tabular-nums">
                      <Clock className="h-3 w-3" />
                      {t("dashboard.dueLabel")}: {formatDateTime(workshop.due_date)}
                    </div>
                  )}
                </div>

                {workshop.external_link && (
                  <a
                    href={workshop.external_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary flex items-center gap-1 hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" /> {t("dashboard.cards.workshopsStudent")}
                  </a>
                )}

                {/* Banner pendiente: cuando la submission ya está
                    entregada pero la IA aún no calificó (modo async sin
                    override). Variante compact para no inflar la card.
                    Se omite si el docente ya puso final_grade override. */}
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
                      {t("exam.review.feedback")}
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

                {/* Modo grupal estricto SIN grupo: no se puede entregar.
                    Mostramos un aviso en lugar del CTA. */}
                {isOpen && blockedNoGroup && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                    <div className="font-medium mb-1">
                      {t("hc_routesAppStudentWorkshops.groupModeNoGroupTitle")}
                    </div>
                    {t("hc_routesAppStudentWorkshops.groupModeNoGroupBody")}
                  </div>
                )}

                {/* CTA principal: responder/editar entrega. Mientras esté
                    abierto el plazo, el estudiante puede actualizar su
                    entrega aunque ya haya sido calificada por la IA — al
                    re-entregar se vuelve a calificar. En modo mixto: si
                    el estudiante tiene grupo, la entrega es del grupo;
                    si no, entrega individualmente. */}
                {isOpen && !blockedNoGroup && !attemptsExhausted && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setQuestionsWs({ workshop, submission, groupId });
                      setQuestionsOpen(true);
                    }}
                  >
                    <ListChecks className="h-4 w-4 mr-1" />
                    {submission ? t("common.update") : t("workshop.startSubmission")}
                  </Button>
                )}

                {submission && (
                  <Link to="/app/student/workshop/$workshopId" params={{ workshopId: workshop.id }}>
                    <Button variant="secondary" size="sm" className="w-full">
                      <MessageSquareText className="h-4 w-4 mr-1" />
                      {t("exam.viewDetail")}
                    </Button>
                  </Link>
                )}

                {/* Eliminar mi entrega — solo dentro del plazo Y solo si
                    todavía hay intentos disponibles. Borrar después de
                    consumir todos los intentos sería un bypass del cap
                    (la fila guarda attempt_count; al borrarla se perdería
                    el contador). RLS valida también en BD (migración
                    20260508140000). */}
                {/* "Intento gastado" = attempt_count alcanzó el cap Y la
                    entrega previa ya fue calificada. Si está `entregado`
                    sin nota (final_grade=null y status!='calificado'),
                    el alumno sigue en el MISMO intento — puede
                    re-editar y borrar. Misma regla que en el submit
                    de WorkshopQuestions. */}
                {(() => {
                  if (!isOpen || !submission) return null;
                  const canDelete = !attemptsExhausted;
                  return canDelete ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full text-destructive hover:text-destructive"
                      onClick={() => deleteSubmission(workshop.title, submission.id, !!groupId)}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      {t("hc_routesAppStudentWorkshops.deleteMySubmission")}
                    </Button>
                  ) : (
                    <p className="text-[11px] text-muted-foreground text-center italic">
                      {t("hc_routesAppStudentWorkshops.attemptsExhaustedNoDelete")}
                    </p>
                  );
                })()}

                {workshop.status === "published" && isOverdue && !submission && (
                  <p className="text-xs text-destructive text-center">
                    {t("exam.windowClosedHelp")}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Pagination — fuera del grid de cards. Visible solo si hay
          items (la barra se oculta sola con totalItems=0). */}
      <div className="px-1">
        <DataPagination
          state={pagination}
          entityNamePlural={t("hc_routesAppStudentWorkshops.entityNamePlural")}
        />
      </div>

      {/* Workshop Questions Dialog — single entry-point for student delivery.
          On submit the Taker runs AI grading per question and writes the final
          grade back to workshop_submissions; we reload to reflect the new state. */}
      <Dialog
        open={questionsOpen}
        onOpenChange={(open) => {
          setQuestionsOpen(open);
          if (!open && user) void reload(user.id);
        }}
      >
        <DialogContent
          className={cn(
            "overflow-y-auto",
            maximized
              ? "max-w-[calc(100vw-1rem)] sm:max-w-[96vw] w-[96vw] h-[94dvh] max-h-[94dvh]"
              : "max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh]",
          )}
        >
          <DialogHeader>
            {/* Toggle "tamaño completo": el alumno puede expandir el modal
                para tener más espacio al resolver. Persistido. El botón va
                con margen derecho para no chocar con la X de cierre. */}
            <div className="flex items-center justify-between gap-2 pr-7">
              <DialogTitle className="min-w-0 flex-1 truncate">{questionsWs?.workshop.title}</DialogTitle>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={toggleMaximized}
                title={
                  maximized
                    ? t("hc_routesAppStudentWorkshops.restoreSize")
                    : t("hc_routesAppStudentWorkshops.fullSize")
                }
                aria-label={
                  maximized
                    ? t("hc_routesAppStudentWorkshops.restoreSize")
                    : t("hc_routesAppStudentWorkshops.fullSize")
                }
              >
                {maximized ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </Button>
            </div>
          </DialogHeader>
          {questionsWs && (
            <StudentWorkshopTaker
              workshopId={questionsWs.workshop.id}
              maxScore={questionsWs.workshop.max_score}
              courseLanguage={questionsWs.workshop.course?.language === "en" ? "en" : "es"}
              groupId={questionsWs.groupId ?? null}
              onGraded={() => {
                if (user) void reload(user.id);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// StatTile local fue removida — ahora usamos el `<StatCard />` del
// design system (src/components/ui/stat-card.tsx) compartido por
// todos los listados.
