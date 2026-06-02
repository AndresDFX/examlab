/**
 * AiJobsHistoryPanel — vista de SOLO LECTURA del historial de jobs IA.
 *
 * Por qué módulo separado del `AiQueuePanel`:
 *  - La cola activa y el historial responden preguntas distintas. La
 *    cola es accionable ("¿qué está pendiente y qué hago?"). El
 *    historial es trazabilidad ("¿qué pasó con la nota IA del taller X
 *    del estudiante Y la semana pasada?").
 *  - Mezclar ambos en un Select de filtros dentro del mismo panel
 *    enterraba el historial: el default era "Activos" y los usuarios no
 *    descubrían que había un filtro "Historial" más abajo. Promover
 *    historial a tab dedicado lo hace explícito.
 *  - El historial necesita controles propios (rango de fechas, búsqueda
 *    por título) que en la cola activa son ruido — ahí lo crítico es
 *    inmediatez.
 *
 * Scopes:
 *  - **Admin / SuperAdmin**: ven el historial completo del tenant
 *    (RLS `ai_grading_queue_select` ya autoriza por Admin del tenant).
 *  - **Docente**: ve solo jobs que él encoló (`created_by = auth.uid()`)
 *    o de cursos que dicta (RLS via `course_teachers`). El mismo
 *    predicado RLS, sin filtros extra del cliente.
 *  - **SuperAdmin cross-tenant**: filtro adicional por institución
 *    (mismo patrón que el panel de la cola — 2-step `courses.id` →
 *    `.in('course_id', ids)`).
 *
 * Estados que incluye el historial:
 *  - `done`         — calificado por IA exitosamente.
 *  - `cancelled`    — cancelado a mano (admin/teacher/superadmin).
 *  - `rejected` acusado por el docente (`acknowledged_at IS NOT NULL`).
 *    Si no fue acusado todavía, el rechazo sigue siendo conversación
 *    abierta y vive en el panel activo, no acá.
 *
 * Lo que NO hace:
 *  - No tiene acciones de cancelar / reintentar / procesar. El historial
 *    es archivo, no cola.
 *  - No tiene realtime — eventos sobre `ai_grading_queue` raramente
 *    afectan al histórico (un job entra al historial cuando termina, y
 *    de ahí no se mueve salvo cleanup del target row). Refresh manual.
 *  - No tiene bulk actions. Los jobs ya están cerrados.
 *
 * Paginación: cargamos los últimos PAGE_LIMIT (200) por defecto + filtro
 * de fechas. Con tope de 200 + buscador + rango cubrimos los casos de
 * uso típicos sin paginar de a chunks (que complicaría el patrón). Si
 * el tenant crece y esto no escala, agregar "Cargar más" arriba.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Archive,
  CheckCircle2,
  Ban,
  XCircle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Search,
  X,
  Filter,
} from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type HistoryStatus = "done" | "cancelled" | "rejected";

interface Props {
  /** Si true, el caller actúa como Admin del tenant (ve histórico
   *  completo). Si false, opera como docente — RLS acota a sus jobs. */
  isAdmin?: boolean;
}

interface HistoryJob {
  id: string;
  kind: string;
  status: HistoryStatus;
  target_table: string;
  target_row_id: string;
  course_id: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
  attempts: number | null;
  last_error: string | null;
  rejection_reason: string | null;
  rejected_at: string | null;
  acknowledged_at: string | null;
  // Enriquecimiento (mismo patrón que AiCronPage):
  examTitle?: string;
  projectTitle?: string;
  workshopTitle?: string;
  studentName?: string;
  courseName?: string;
}

const KIND_LABELS: Record<string, string> = {
  exam_submission: "Examen",
  exam_question: "Pregunta de examen",
  workshop_submission: "Taller",
  workshop_question: "Pregunta de taller",
  workshop_full: "Taller (batch)",
  project_submission: "Proyecto",
  project_file: "Archivo de proyecto",
  project_full: "Proyecto (batch)",
  project_codigo_zip: "Código ZIP de proyecto",
};

const STATUS_LABELS: Record<HistoryStatus, string> = {
  done: "Completado",
  cancelled: "Cancelado",
  rejected: "Rechazado (cerrado)",
};

/** Tope amplio de carga. La UI scrollea internamente. */
const PAGE_LIMIT = 200;

export function AiJobsHistoryPanel({ isAdmin = false }: Props) {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const isSuperAdminCaller = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");

  const [jobs, setJobs] = useState<HistoryJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // Filtros — todos opt-in salvo el de estado que default "todos los
  // estados cerrados". Date range vacío = todo el rango disponible.
  const [statusFilter, setStatusFilter] = useState<HistoryStatus | "all">("all");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  // Tenant filter (SuperAdmin) — mismo patrón que AiQueuePanel.
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (!isSuperAdminCaller) return;
    let cancelled = false;
    void (async () => {
      const { data } = await db.from("tenants").select("id, slug, name").order("name");
      if (cancelled) return;
      setTenants((data ?? []) as Array<{ id: string; slug: string; name: string }>);
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdminCaller]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Filtro tenant (SuperAdmin): mismo patrón 2-step del panel
      // activo. Si el tenant no tiene cursos, cortamos antes para evitar
      // el comportamiento de PostgREST `.in('col', [])` → todo.
      let courseIdsFilter: string[] | null = null;
      if (isSuperAdminCaller && tenantFilter !== "all") {
        const { data: courseRows } = await db
          .from("courses")
          .select("id")
          .eq("tenant_id", tenantFilter);
        courseIdsFilter = ((courseRows ?? []) as Array<{ id: string }>).map((r) => r.id);
        if (courseIdsFilter.length === 0) {
          setJobs([]);
          setLoading(false);
          return;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = db
        .from("ai_grading_queue")
        .select(
          "id, kind, status, target_table, target_row_id, course_id, created_by, created_at, completed_at, attempts, last_error, rejection_reason, rejected_at, acknowledged_at",
        )
        // Ordenamos por `completed_at` (cuándo se cerró el job) en lugar
        // de `created_at`. Para historial lo relevante es CUÁNDO terminó,
        // no cuándo se encoló. Fallback a created_at vía COALESCE para
        // jobs raros que no tuvieran completed_at por algún bug.
        .order("completed_at", { ascending: false, nullsFirst: false })
        .limit(PAGE_LIMIT);

      if (courseIdsFilter) {
        query = query.in("course_id", courseIdsFilter);
      }

      // Estado: si el filtro es 'all', incluimos los 3 estados cerrados.
      // Rejected solo si fue ACUSADO por el docente — los rejected no
      // acusados siguen siendo conversación abierta en el panel activo.
      if (statusFilter === "all") {
        query = query.or(
          "status.in.(done,cancelled),and(status.eq.rejected,acknowledged_at.not.is.null)",
        );
      } else if (statusFilter === "rejected") {
        query = query.eq("status", "rejected").not("acknowledged_at", "is", null);
      } else {
        query = query.eq("status", statusFilter);
      }

      // Rango de fechas — sobre `completed_at` para mantener consistencia
      // con el ordenamiento. Si el usuario solo elige `dateFrom`, se
      // aplica `>= from`; solo `dateTo` → `<= to + 1d`. Ambos → rango.
      if (dateFrom) {
        query = query.gte("completed_at", `${dateFrom}T00:00:00`);
      }
      if (dateTo) {
        // Sumamos 1 día y restamos 1ms para incluir TODO el día seleccionado
        // (sino dateTo='2026-06-02' excluiría jobs de 2026-06-02 16:00).
        query = query.lte("completed_at", `${dateTo}T23:59:59.999`);
      }

      const { data: rows, error } = await query;
      if (error) {
        setLoadError(friendlyError(error, "No pudimos cargar el historial de IA."));
        return;
      }
      const baseJobs = ((rows ?? []) as HistoryJob[]).map((r) => ({ ...r }));

      // Enriquecimiento — mismo patrón que AiQueuePanel para tener
      // examTitle/projectTitle/workshopTitle/studentName/courseName.
      const examIds = baseJobs
        .filter((j) => j.target_table === "submissions")
        .map((j) => j.target_row_id);
      const projectFileIds = baseJobs
        .filter((j) => j.target_table === "project_submission_files")
        .map((j) => j.target_row_id);
      const wsAnswerIds = baseJobs
        .filter((j) => j.target_table === "workshop_submission_answers")
        .map((j) => j.target_row_id);
      const directWsSubIds = baseJobs
        .filter((j) => j.target_table === "workshop_submissions")
        .map((j) => j.target_row_id);
      const directProjectSubIds = baseJobs
        .filter((j) => j.target_table === "project_submissions")
        .map((j) => j.target_row_id);
      const courseIds = Array.from(
        new Set(baseJobs.map((j) => j.course_id).filter((c): c is string => !!c)),
      );

      const [submissionsLookup, projectFilesLookup, courseLookup, wsAnswersLookup] =
        await Promise.all([
          examIds.length > 0
            ? db.from("submissions").select("id, user_id, exam_id").in("id", examIds)
            : Promise.resolve({ data: [] as unknown[] }),
          projectFileIds.length > 0
            ? db
                .from("project_submission_files")
                .select("id, submission_id")
                .in("id", projectFileIds)
            : Promise.resolve({ data: [] as unknown[] }),
          courseIds.length > 0
            ? db.from("courses").select("id, name").in("id", courseIds)
            : Promise.resolve({ data: [] as unknown[] }),
          wsAnswerIds.length > 0
            ? db
                .from("workshop_submission_answers")
                .select("id, submission_id")
                .in("id", wsAnswerIds)
            : Promise.resolve({ data: [] as unknown[] }),
        ]);

      const wsAnswerToSub = new Map<string, string>();
      for (const a of (wsAnswersLookup.data ?? []) as Array<{
        id: string;
        submission_id: string;
      }>) {
        wsAnswerToSub.set(a.id, a.submission_id);
      }

      const submissionsRows = (submissionsLookup.data ?? []) as Array<{
        id: string;
        user_id: string;
        exam_id: string;
      }>;
      const projectFileRows = (projectFilesLookup.data ?? []) as Array<{
        id: string;
        submission_id: string;
      }>;
      const courseMap = new Map<string, string>();
      for (const c of (courseLookup.data ?? []) as Array<{ id: string; name: string }>) {
        courseMap.set(c.id, c.name);
      }

      const projectSubmissionIds = Array.from(
        new Set([...projectFileRows.map((r) => r.submission_id), ...directProjectSubIds]),
      );
      const allUserIds = new Set<string>();
      for (const s of submissionsRows) allUserIds.add(s.user_id);
      const examIdsForLookup = Array.from(new Set(submissionsRows.map((s) => s.exam_id)));

      const wsSubIds = Array.from(
        new Set([...directWsSubIds, ...Array.from(wsAnswerToSub.values())]),
      );

      const [projectSubsLookup, examsLookup, wsSubsLookup] = await Promise.all([
        projectSubmissionIds.length > 0
          ? db
              .from("project_submissions")
              .select("id, user_id, project_id")
              .in("id", projectSubmissionIds)
          : Promise.resolve({ data: [] as unknown[] }),
        examIdsForLookup.length > 0
          ? db.from("exams").select("id, title").in("id", examIdsForLookup)
          : Promise.resolve({ data: [] as unknown[] }),
        wsSubIds.length > 0
          ? db.from("workshop_submissions").select("id, user_id, workshop_id").in("id", wsSubIds)
          : Promise.resolve({ data: [] as unknown[] }),
      ]);

      const projectSubsRows = (projectSubsLookup.data ?? []) as Array<{
        id: string;
        user_id: string;
        project_id: string;
      }>;
      for (const s of projectSubsRows) allUserIds.add(s.user_id);

      const wsSubsRows = (wsSubsLookup.data ?? []) as Array<{
        id: string;
        user_id: string;
        workshop_id: string;
      }>;
      const wsSubMap = new Map<string, { user_id: string; workshop_id: string }>();
      for (const s of wsSubsRows) {
        wsSubMap.set(s.id, s);
        allUserIds.add(s.user_id);
      }
      const workshopIdsForLookup = Array.from(new Set(wsSubsRows.map((s) => s.workshop_id)));
      const projectIdsForLookup = Array.from(new Set(projectSubsRows.map((s) => s.project_id)));

      const [profilesLookup, projectsLookup, workshopsLookup] = await Promise.all([
        allUserIds.size > 0
          ? db.from("profiles").select("id, full_name").in("id", Array.from(allUserIds))
          : Promise.resolve({ data: [] as unknown[] }),
        projectIdsForLookup.length > 0
          ? db.from("projects").select("id, title").in("id", projectIdsForLookup)
          : Promise.resolve({ data: [] as unknown[] }),
        workshopIdsForLookup.length > 0
          ? db.from("workshops").select("id, title").in("id", workshopIdsForLookup)
          : Promise.resolve({ data: [] as unknown[] }),
      ]);

      const workshopTitleMap = new Map<string, string>();
      for (const w of (workshopsLookup.data ?? []) as Array<{ id: string; title: string }>) {
        workshopTitleMap.set(w.id, w.title);
      }
      const profileMap = new Map<string, string>();
      for (const p of (profilesLookup.data ?? []) as Array<{ id: string; full_name: string }>) {
        profileMap.set(p.id, p.full_name);
      }
      const examTitleMap = new Map<string, string>();
      for (const e of (examsLookup.data ?? []) as Array<{ id: string; title: string }>) {
        examTitleMap.set(e.id, e.title);
      }
      const projectTitleMap = new Map<string, string>();
      for (const p of (projectsLookup.data ?? []) as Array<{ id: string; title: string }>) {
        projectTitleMap.set(p.id, p.title);
      }
      const submissionMap = new Map<string, { user_id: string; exam_id: string }>();
      for (const s of submissionsRows) submissionMap.set(s.id, s);
      const projectSubMap = new Map<string, { user_id: string; project_id: string }>();
      for (const s of projectSubsRows) projectSubMap.set(s.id, s);
      const projectFileToSub = new Map<string, string>();
      for (const f of projectFileRows) projectFileToSub.set(f.id, f.submission_id);

      const enriched = baseJobs.map((j) => {
        const out: HistoryJob = { ...j };
        if (j.course_id) out.courseName = courseMap.get(j.course_id);
        if (j.target_table === "submissions") {
          const sub = submissionMap.get(j.target_row_id);
          if (sub) {
            out.examTitle = examTitleMap.get(sub.exam_id);
            out.studentName = profileMap.get(sub.user_id);
          }
        } else if (
          j.target_table === "project_submission_files" ||
          j.target_table === "project_submissions"
        ) {
          const subId =
            j.target_table === "project_submission_files"
              ? projectFileToSub.get(j.target_row_id)
              : j.target_row_id;
          const ps = subId ? projectSubMap.get(subId) : undefined;
          if (ps) {
            out.projectTitle = projectTitleMap.get(ps.project_id);
            out.studentName = profileMap.get(ps.user_id);
          }
        } else if (
          j.target_table === "workshop_submission_answers" ||
          j.target_table === "workshop_submissions"
        ) {
          const subId =
            j.target_table === "workshop_submission_answers"
              ? wsAnswerToSub.get(j.target_row_id)
              : j.target_row_id;
          const ws = subId ? wsSubMap.get(subId) : undefined;
          if (ws) {
            out.workshopTitle = workshopTitleMap.get(ws.workshop_id);
            out.studentName = profileMap.get(ws.user_id);
          }
        }
        return out;
      });
      setJobs(enriched);
    } catch (e) {
      setLoadError(friendlyError(e, "No pudimos cargar el historial de IA."));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, isSuperAdminCaller, tenantFilter, dateFrom, dateTo]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, retryNonce]);

  // Búsqueda — filtro CLIENT-side sobre el set ya cargado. Para PAGE_LIMIT
  // (200) es trivial y nos evita un ILIKE en server por título derivado
  // de 3 tablas distintas (no podemos filtrar por title en la query
  // principal porque title no vive en ai_grading_queue).
  const filteredJobs = useMemo(() => {
    if (!search.trim()) return jobs;
    const q = search.trim().toLowerCase();
    return jobs.filter((j) => {
      const haystack = [
        j.examTitle,
        j.projectTitle,
        j.workshopTitle,
        j.studentName,
        j.courseName,
        KIND_LABELS[j.kind] ?? j.kind,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [jobs, search]);

  // Stats agregados sobre el set FILTRADO (lo que el usuario ve), no
  // sobre la cola entera. Útil para "de los 47 jobs que filtré, 30 son
  // done, 12 cancelados, 5 rechazos".
  const stats = useMemo(() => {
    let done = 0,
      cancelled = 0,
      rejected = 0;
    for (const j of filteredJobs) {
      if (j.status === "done") done++;
      else if (j.status === "cancelled") cancelled++;
      else if (j.status === "rejected") rejected++;
    }
    return { done, cancelled, rejected, total: filteredJobs.length };
  }, [filteredJobs]);

  const hasActiveFilters =
    statusFilter !== "all" ||
    dateFrom !== "" ||
    dateTo !== "" ||
    search.trim() !== "" ||
    tenantFilter !== "all";

  const clearFilters = () => {
    setStatusFilter("all");
    setDateFrom("");
    setDateTo("");
    setSearch("");
    setTenantFilter("all");
  };

  return (
    <div className="space-y-4">
      {/* Stats agregados — útiles cuando el usuario está usando filtros
          para ver "cuántos casos de este tipo hubo". */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Archive className="h-3 w-3" /> Total
            </div>
            <div className="text-2xl font-semibold tabular-nums mt-1">{stats.total}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" /> Completados
            </div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-emerald-600 dark:text-emerald-400">
              {stats.done}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <XCircle className="h-3 w-3" /> Cancelados
            </div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-muted-foreground">
              {stats.cancelled}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Ban className="h-3 w-3 text-orange-500" /> Rechazados (cerrados)
            </div>
            <div className="text-2xl font-semibold tabular-nums mt-1 text-orange-600 dark:text-orange-400">
              {stats.rejected}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Aviso de scope — explícito sobre QUÉ está viendo el usuario. La
          regla viene de RLS (Admin = tenant entero, Docente = sus jobs)
          pero ponerlo en UI evita que el docente se pregunte "¿por qué no
          veo el job de mi colega?". */}
      <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
        <Filter className="h-3 w-3 shrink-0" />
        {isAdmin ? (
          <span>
            Estás viendo el historial completo de jobs IA{" "}
            {isSuperAdminCaller && tenantFilter !== "all"
              ? "de la institución seleccionada"
              : isSuperAdminCaller
                ? "de todas las instituciones"
                : "de tu institución"}
            . Incluye lo que encolaron todos los docentes.
          </span>
        ) : (
          <span>
            Estás viendo los jobs IA que <strong>tú</strong> encolaste o que pertenecen a tus
            cursos. Los jobs de otros docentes no son visibles desde acá.
          </span>
        )}
      </div>

      {/* Filtros + listado */}
      <Card>
        <CardHeader className="pb-3 space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Archive className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Historial</CardTitle>
              <Badge variant="secondary" className="text-[10px]">
                {filteredJobs.length}
                {filteredJobs.length !== jobs.length && (
                  <span className="ml-1 text-muted-foreground">/ {jobs.length}</span>
                )}
              </Badge>
            </div>
            <div className="flex items-center gap-2">
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={clearFilters}
                  title="Limpiar todos los filtros"
                >
                  <X className="h-3.5 w-3.5 mr-1" />
                  Limpiar
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => void load()}
                title="Refrescar"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>

          {/* Toolbar de filtros — grid responsive. Search ocupa 2 cols en
              md+, los demás 1 col. En mobile cae a 1 columna. */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
            <div className="md:col-span-2 relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por título, estudiante o curso…"
                className="h-8 pl-7 text-xs"
              />
            </div>
            {isSuperAdminCaller && tenants.length > 0 ? (
              <Select value={tenantFilter} onValueChange={setTenantFilter}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder={t("tenant.filterTenantPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("tenant.filterAllTenants")}</SelectItem>
                  {tenants.map((tn) => (
                    <SelectItem key={tn.id} value={tn.id}>
                      {tn.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="hidden md:block" aria-hidden="true" />
            )}
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as HistoryStatus | "all")}
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los cerrados</SelectItem>
                <SelectItem value="done">Solo completados</SelectItem>
                <SelectItem value="cancelled">Solo cancelados</SelectItem>
                <SelectItem value="rejected">Solo rechazos cerrados</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Date range — fila aparte, da espacio para los pickers que
              son más anchos. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <DatePicker
                value={dateFrom}
                onChange={setDateFrom}
                placeholder="Desde…"
                className="h-8 text-xs"
              />
            </div>
            <div>
              <DatePicker
                value={dateTo}
                onChange={setDateTo}
                placeholder="Hasta…"
                className="h-8 text-xs"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
              <Spinner size="sm" /> Cargando…
            </div>
          ) : loadError ? (
            <ErrorState
              message="No pudimos cargar el historial"
              hint={loadError}
              onRetry={() => setRetryNonce((n) => n + 1)}
            />
          ) : filteredJobs.length === 0 ? (
            <TableEmpty
              icon={Archive}
              title="Sin jobs en el historial"
              description={
                hasActiveFilters
                  ? "Ningún job cerrado coincide con los filtros aplicados. Ajusta los criterios o limpia los filtros."
                  : isAdmin
                    ? "Aún no hay jobs cerrados en esta institución. Cuando se completen o cancelen jobs IA, aparecerán acá."
                    : "Aún no tienes jobs cerrados. Cuando se completen o cancelen tus jobs IA, aparecerán acá."
              }
            />
          ) : (
            <div className="divide-y">
              {filteredJobs.map((j) => {
                const kindLabel = KIND_LABELS[j.kind] ?? j.kind;
                const expanded = expandedId === j.id;
                const label = j.examTitle ?? j.projectTitle ?? j.workshopTitle ?? kindLabel;
                const subtitleParts = [j.studentName, j.courseName].filter(Boolean) as string[];

                return (
                  <div key={j.id} className="text-sm">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : j.id)}
                      className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-muted/40 transition-colors"
                      title={expanded ? "Ocultar detalle" : "Ver detalle"}
                    >
                      {expanded ? (
                        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <StatusDot status={j.status} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium truncate">{label}</span>
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            {kindLabel}
                          </Badge>
                          <Badge
                            variant={
                              j.status === "done"
                                ? "default"
                                : j.status === "rejected"
                                  ? "destructive"
                                  : "secondary"
                            }
                            className={`text-[10px] shrink-0 ${
                              j.status === "done"
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20"
                                : j.status === "rejected"
                                  ? "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30 hover:bg-orange-500/20"
                                  : ""
                            }`}
                          >
                            {STATUS_LABELS[j.status]}
                          </Badge>
                        </div>
                        {subtitleParts.length > 0 && (
                          <div className="text-xs text-muted-foreground truncate">
                            {subtitleParts.join(" · ")}
                          </div>
                        )}
                      </div>
                      <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                        {j.completed_at ? formatDateTime(j.completed_at) : "—"}
                      </span>
                    </button>
                    {expanded && (
                      <div className="px-8 pr-3 pb-3 text-xs space-y-1 bg-muted/20 border-t">
                        <DetailRow k="ID" v={j.id} mono />
                        <DetailRow k="Tipo" v={kindLabel} />
                        <DetailRow k="Estado" v={STATUS_LABELS[j.status]} />
                        <DetailRow k="Tabla destino" v={j.target_table} mono />
                        <DetailRow k="ID destino" v={j.target_row_id} mono />
                        {j.courseName && <DetailRow k="Curso" v={j.courseName} />}
                        {j.studentName && <DetailRow k="Estudiante" v={j.studentName} />}
                        {j.examTitle && <DetailRow k="Examen" v={j.examTitle} />}
                        {j.projectTitle && <DetailRow k="Proyecto" v={j.projectTitle} />}
                        {j.workshopTitle && <DetailRow k="Taller" v={j.workshopTitle} />}
                        <DetailRow k="Creado" v={formatDateTime(j.created_at)} />
                        {j.completed_at && (
                          <DetailRow k="Finalizado" v={formatDateTime(j.completed_at)} />
                        )}
                        {typeof j.attempts === "number" && (
                          <DetailRow k="Intentos" v={String(j.attempts)} />
                        )}
                        {j.last_error && (
                          <div className="pt-1">
                            <div className="text-muted-foreground mb-0.5">Último error</div>
                            <pre className="text-[11px] bg-destructive/10 text-destructive border border-destructive/30 rounded p-2 whitespace-pre-wrap break-all">
                              {j.last_error}
                            </pre>
                          </div>
                        )}
                        {j.status === "rejected" && j.rejection_reason && (
                          <div className="pt-1">
                            <div className="text-muted-foreground mb-0.5">Razón del rechazo</div>
                            <pre className="text-[11px] bg-orange-500/10 text-orange-700 dark:text-orange-400 border border-orange-500/30 rounded p-2 whitespace-pre-wrap break-words">
                              {j.rejection_reason}
                            </pre>
                            {j.rejected_at && (
                              <DetailRow k="Rechazado" v={formatDateTime(j.rejected_at)} />
                            )}
                            {j.acknowledged_at && (
                              <DetailRow k="Acusado" v={formatDateTime(j.acknowledged_at)} />
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {jobs.length === PAGE_LIMIT && (
        <p className="text-[11px] text-muted-foreground text-center">
          Mostrando los últimos {PAGE_LIMIT} jobs. Usa el rango de fechas para acotar más atrás.
        </p>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: HistoryStatus }) {
  const color =
    status === "done"
      ? "bg-emerald-500"
      : status === "rejected"
        ? "bg-orange-500"
        : "bg-muted-foreground/50";
  return <span className={`h-2 w-2 rounded-full shrink-0 ${color}`} />;
}

function DetailRow({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-28 shrink-0">{k}</span>
      <span className={`flex-1 break-all ${mono ? "font-mono text-[11px]" : ""}`}>{v}</span>
    </div>
  );
}
