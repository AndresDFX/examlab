/**
 * AiCronPage — vista dedicada del módulo "Cron IA".
 *
 * Disponible para Admin (/app/admin/ai-cron) y Docente (/app/teacher/ai-cron).
 * Reemplaza la experiencia condensada del AiGradingQueueWidget en el
 * dashboard para los casos donde el usuario quiere gestionar la cola:
 *   - Ver TODAS las filas (no solo 8) con filtro por estado.
 *   - Panel de detalle expandible por job sin tener que navegar fuera
 *     (clave para Admin, que no tiene acceso RBAC a /app/teacher/monitor).
 *   - Mismas acciones que el widget: cancelar, reintentar, procesar uno.
 *   - Admin: botón "Procesar ahora" para drenar toda la cola pending.
 *
 * Por qué módulo independiente y no solo widget:
 *   - El widget vivía en el dashboard con altura limitada. La tabla con
 *     >20 jobs no cabía. Aquí podemos paginar / scrollear sin tope.
 *   - El click en "ver detalle" del widget construía la URL a mano
 *     (`/app/teacher/monitor/${id}`) — y eso (a) silenciosamente no
 *     matchea con el patrón TanStack file-route (`$examId`), (b)
 *     redirige a /app/unauthorized si quien clickea es Admin. Tener
 *     un módulo propio elimina esa dependencia.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useMultiSelect,
  MultiSelectCheckbox,
  MultiSelectHeaderCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { SupabaseCronPanel } from "@/modules/admin/SupabaseCronPanel";
import { AiOverrideDialog } from "@/modules/ai/AiOverrideDialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Clock,
  Cpu,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Play,
  X,
  Zap,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  CalendarClock,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/shared/lib/format";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  /** Admin habilita "Procesar ahora" (drain de toda la cola pending) y ve
   *  todos los jobs sin filtro de curso (RLS ya lo permite). */
  isAdmin?: boolean;
}

type Status = "pending" | "processing" | "failed" | "done" | "cancelled";

interface Counts {
  pending: number;
  processing: number;
  failed24h: number;
  lastDoneAt: string | null;
}

interface QueueJob {
  id: string;
  kind: string;
  status: Status;
  target_table: string;
  target_row_id: string;
  course_id: string | null;
  created_at: string;
  completed_at: string | null;
  attempts: number | null;
  last_error: string | null;
  // Resolución best-effort
  examTitle?: string;
  projectTitle?: string;
  studentName?: string;
  courseName?: string;
  examId?: string;
  projectId?: string;
}

const KIND_LABELS: Record<string, string> = {
  exam_submission: "Examen",
  exam_question: "Pregunta de examen",
  workshop_submission: "Taller",
  workshop_question: "Pregunta de taller",
  project_submission: "Proyecto",
  project_file: "Archivo de proyecto",
  project_codigo_zip: "Código ZIP de proyecto",
};

const STATUS_LABELS: Record<Status, string> = {
  pending: "Pendientes",
  processing: "En proceso",
  failed: "Fallados",
  done: "Completados",
  cancelled: "Cancelados",
};

/** Tope amplio — el módulo es para gestión, no para vista compacta. La
 *  tabla scrollea internamente y siempre se cargan los más recientes. */
const PAGE_LIMIT = 100;

function relativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "ahora";
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

/** Resuelve ruta de navegación de detalle externa. Admin no tiene acceso
 *  a /app/teacher/*, así que solo abrimos el link para Docente. Para
 *  Admin el detalle vive inline en el panel expandible. */
function targetRouteForJob(
  j: QueueJob,
  isAdmin: boolean,
): { to: string; params?: Record<string, string> } | null {
  if (isAdmin) return null;
  if (j.target_table === "submissions" && j.examId) {
    return { to: "/app/teacher/monitor/$examId", params: { examId: j.examId } };
  }
  if (j.target_table === "project_submission_files") {
    return { to: "/app/teacher/projects" };
  }
  return null;
}

/**
 * Wrapper exportado. PageHeader + Tabs (IA / Supabase). Solo Admin ve la
 * tab "Supabase" — Docente solo gestiona la cola IA y no debería ver
 * jobs de infraestructura. Para Docente renderizamos sin Tabs para no
 * mostrar un control de un único tab (mala UX).
 */
export function AiCronPage({ isAdmin = false }: Props) {
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Cpu className="h-6 w-6 text-primary" />}
        title="Cron"
        subtitle={
          isAdmin
            ? "Cola de calificación con IA y jobs de infraestructura. Gestiona, pausa o reagenda lo que corre en segundo plano."
            : "Cola de calificación con IA. Aquí puedes ver, cancelar, reintentar o procesar jobs uno a uno."
        }
      />
      {isAdmin ? (
        <Tabs defaultValue="ia">
          <TabsList>
            <TabsTrigger value="ia" className="gap-1.5">
              <Sparkles className="h-3.5 w-3.5" />
              IA
            </TabsTrigger>
            <TabsTrigger value="supabase" className="gap-1.5">
              <CalendarClock className="h-3.5 w-3.5" />
              Supabase
            </TabsTrigger>
          </TabsList>
          <TabsContent value="ia" className="space-y-4 mt-4">
            <AiQueuePanel isAdmin />
          </TabsContent>
          <TabsContent value="supabase" className="space-y-4 mt-4">
            <SupabaseCronPanel />
          </TabsContent>
        </Tabs>
      ) : (
        <AiQueuePanel />
      )}
    </div>
  );
}

/**
 * AiQueuePanel — panel reutilizable con la cola IA. Toda la lógica de
 * fetch + acciones que antes vivía directamente en AiCronPage. Ahora
 * lo wrappea el AiCronPage para combinarlo con la pestaña Supabase.
 */
function AiQueuePanel({ isAdmin = false }: Props) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [counts, setCounts] = useState<Counts>({
    pending: 0,
    processing: 0,
    failed24h: 0,
    lastDoneAt: null,
  });
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [running, setRunning] = useState(false);
  // Filtro por estado. "active" = pending + processing + failed (default,
  // útil para el caso típico "qué hay corriendo"). "all" trae también
  // done y cancelled — útil para auditoría.
  const [statusFilter, setStatusFilter] = useState<"active" | Status | "all">("active");
  // Detalle expandido inline — necesario para Admin (sin acceso a
  // /app/teacher/monitor) y útil para Docente para no perder contexto.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [processingOne, setProcessingOne] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      // Counts agregados — corren en paralelo y siempre se refrescan.
      const [
        { count: pending },
        { count: processing },
        { count: failed24h },
        { data: lastDone },
      ] = await Promise.all([
        db
          .from("ai_grading_queue")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
        db
          .from("ai_grading_queue")
          .select("id", { count: "exact", head: true })
          .eq("status", "processing"),
        db
          .from("ai_grading_queue")
          .select("id", { count: "exact", head: true })
          .eq("status", "failed")
          .gte("completed_at", since24),
        db
          .from("ai_grading_queue")
          .select("completed_at")
          .eq("status", "done")
          .order("completed_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      setCounts({
        pending: pending ?? 0,
        processing: processing ?? 0,
        failed24h: failed24h ?? 0,
        lastDoneAt: lastDone?.completed_at ?? null,
      });

      // Lista de jobs según filtro.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = db
        .from("ai_grading_queue")
        .select(
          "id, kind, status, target_table, target_row_id, course_id, created_at, completed_at, attempts, last_error",
        )
        .order("created_at", { ascending: false })
        .limit(PAGE_LIMIT);
      if (statusFilter === "active") {
        query = query.in("status", ["pending", "processing", "failed"]);
      } else if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }
      const { data: rows } = await query;
      const baseJobs = ((rows ?? []) as QueueJob[]).map((r) => ({ ...r }));

      // Enriquecimiento — mismo patrón que el widget pero sobre el set
      // completo de jobs. Hacemos 3 pasos de lookups para evitar
      // problemas con las FKs (submissions.user_id apunta a auth.users
      // NO a profiles, así que un embed PostgREST falla en silencio).
      const examIds = baseJobs
        .filter((j) => j.target_table === "submissions")
        .map((j) => j.target_row_id);
      const projectFileIds = baseJobs
        .filter((j) => j.target_table === "project_submission_files")
        .map((j) => j.target_row_id);
      const courseIds = Array.from(
        new Set(baseJobs.map((j) => j.course_id).filter((c): c is string => !!c)),
      );

      const [submissionsLookup, projectFilesLookup, courseLookup] = await Promise.all([
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
      ]);

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
        new Set(projectFileRows.map((r) => r.submission_id)),
      );
      const allUserIds = new Set<string>();
      for (const s of submissionsRows) allUserIds.add(s.user_id);
      const examIdsForLookup = Array.from(new Set(submissionsRows.map((s) => s.exam_id)));

      const [projectSubsLookup, examsLookup] = await Promise.all([
        projectSubmissionIds.length > 0
          ? db
              .from("project_submissions")
              .select("id, user_id, project_id")
              .in("id", projectSubmissionIds)
          : Promise.resolve({ data: [] as unknown[] }),
        examIdsForLookup.length > 0
          ? db.from("exams").select("id, title").in("id", examIdsForLookup)
          : Promise.resolve({ data: [] as unknown[] }),
      ]);

      const projectSubsRows = (projectSubsLookup.data ?? []) as Array<{
        id: string;
        user_id: string;
        project_id: string;
      }>;
      for (const s of projectSubsRows) allUserIds.add(s.user_id);

      const projectIdsForLookup = Array.from(new Set(projectSubsRows.map((s) => s.project_id)));

      const [profilesLookup, projectsLookup] = await Promise.all([
        allUserIds.size > 0
          ? db.from("profiles").select("id, full_name").in("id", Array.from(allUserIds))
          : Promise.resolve({ data: [] as unknown[] }),
        projectIdsForLookup.length > 0
          ? db.from("projects").select("id, title").in("id", projectIdsForLookup)
          : Promise.resolve({ data: [] as unknown[] }),
      ]);

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
        const out: QueueJob = { ...j };
        if (j.course_id) out.courseName = courseMap.get(j.course_id);
        if (j.target_table === "submissions") {
          const sub = submissionMap.get(j.target_row_id);
          if (sub) {
            out.examId = sub.exam_id;
            out.examTitle = examTitleMap.get(sub.exam_id);
            out.studentName = profileMap.get(sub.user_id);
          }
        } else if (j.target_table === "project_submission_files") {
          const subId = projectFileToSub.get(j.target_row_id);
          const ps = subId ? projectSubMap.get(subId) : undefined;
          if (ps) {
            out.projectId = ps.project_id;
            out.projectTitle = projectTitleMap.get(ps.project_id);
            out.studentName = profileMap.get(ps.user_id);
          }
        }
        return out;
      });
      setJobs(enriched);
    } catch (e) {
      setLoadError(friendlyError(e, "No pudimos cargar la cola de IA."));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, retryNonce]);

  // Realtime — escucha cambios en `ai_grading_queue`. Misma estrategia
  // que el widget (debounce 800ms) para evitar avalanchas de refresh
  // cuando el worker drena varios jobs seguidos.
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const triggerReload = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void load();
      }, 800);
    };
    const channel = supabase
      .channel("ai_grading_queue_page")
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "ai_grading_queue" },
        triggerReload,
      )
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const runNow = async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-grading-worker", { body: {} });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      if (error || d?.ok === false) {
        const detail = await extractEdgeError(error, data);
        toast.error(detail || "Error en el worker");
        return;
      }
      toast.success(
        `Worker: ${d?.succeeded ?? 0} OK · ${d?.failed ?? 0} fallaron · ${d?.processed ?? 0} totales`,
      );
      await load();
    } finally {
      setRunning(false);
    }
  };

  const cancelJob = async (jobId: string, label: string) => {
    if (cancelling.has(jobId)) return;
    const ok = await confirm({
      title: `¿Cancelar este job de IA?`,
      description:
        `"${label}" — el job no se procesará. Si la entrega del estudiante necesita ` +
        `nota IA después, deberás encolarla manualmente. Esta acción no se puede deshacer.`,
      tone: "destructive",
      confirmLabel: "Cancelar job",
    });
    if (!ok) return;
    setCancelling((prev) => new Set(prev).add(jobId));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("cancel_ai_grading_job", {
        _job_id: jobId,
      });
      if (error) {
        toast.error(friendlyError(error, "No se pudo cancelar el job"));
        return;
      }
      toast.success("Job cancelado");
      await load();
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const processOne = async (jobId: string) => {
    if (processingOne.has(jobId)) return;
    setProcessingOne((prev) => new Set(prev).add(jobId));
    try {
      const { data, error } = await supabase.functions.invoke("ai-grading-worker", {
        body: { jobId },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      if (error || d?.ok === false) {
        const detail = await extractEdgeError(error, data);
        toast.error(detail || "Error procesando el job");
        return;
      }
      if (d?.processed === 0) {
        toast.info("El job ya no estaba pending — quizás el worker lo levantó primero.");
      } else if (d?.failed > 0) {
        toast.error("El job se procesó pero falló — revisa el error en la cola.");
      } else {
        toast.success("Job procesado");
      }
      await load();
    } finally {
      setProcessingOne((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const retryJob = async (jobId: string) => {
    if (retrying.has(jobId)) return;
    setRetrying((prev) => new Set(prev).add(jobId));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("requeue_ai_grading_job", {
        _job_id: jobId,
      });
      if (error) {
        toast.error(friendlyError(error, "No se pudo re-encolar el job"));
        return;
      }
      toast.success("Job re-encolado");
      await load();
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  const filteredCount = useMemo(() => jobs.length, [jobs]);

  // Multi-select sobre los jobs visibles. La cancelación masiva solo
  // tiene sentido para jobs en estados `pending` o `failed` (processing/
  // done/cancelled no se cancelan). El hook deduplica automáticamente —
  // si filtramos solo IDs cancelables al confirmar, el resto se ignora.
  const selectableJobs = useMemo(
    () => jobs.filter((j) => j.status === "pending" || j.status === "failed"),
    [jobs],
  );
  const multi = useMultiSelect(selectableJobs);
  const [bulkOpen, setBulkOpen] = useState(false);
  // Dialog para activar el código override de IA inmediata (pegar
  // código → ventana sincrónica corta). Se movió desde el dashboard
  // del docente para tenerlo junto al resto del flujo de IA.
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);
  const selectedItems = useMemo(
    () =>
      selectableJobs
        .filter((j) => multi.isSelected(j.id))
        .map((j) => {
          const kindLabel = KIND_LABELS[j.kind] ?? j.kind;
          const label = j.examTitle ?? j.projectTitle ?? kindLabel;
          return { id: j.id, label };
        }),
    [selectableJobs, multi],
  );

  /** Cancela en paralelo todos los jobs seleccionados. Usa la misma RPC
   *  `cancel_ai_grading_job` que el botón individual; el SECURITY DEFINER
   *  + audit log por job se preserva. Falla loud si CUALQUIERA falla —
   *  el BulkDeleteDialog hace toast.error y deja el modal abierto para
   *  reintentar. Limpia la selección al final. */
  const bulkCancel = async (ids: string[]) => {
    const results = await Promise.allSettled(
      ids.map((id) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).rpc("cancel_ai_grading_job", { _job_id: id }),
      ),
    );
    const failures = results
      .map((r, i) => ({ r, id: ids[i] }))
      .filter(
        (x) =>
          x.r.status === "rejected" ||
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (x.r.status === "fulfilled" && (x.r.value as any)?.error),
      );
    if (failures.length > 0) {
      throw new Error(
        `No se pudieron cancelar ${failures.length} de ${ids.length} jobs. Reintenta.`,
      );
    }
    toast.success(`${ids.length} job(s) cancelado(s)`);
    multi.clear();
    await load();
  };

  return (
    <div className="space-y-4">
      {/* Stats — full-width 4-col en md+ */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" /> Pendientes
            </div>
            <div className="text-2xl font-semibold tabular-nums mt-1">{counts.pending}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Cpu className="h-3 w-3" /> En proceso
            </div>
            <div className="text-2xl font-semibold tabular-nums mt-1">{counts.processing}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" /> Fallados 24h
            </div>
            <div
              className={`text-2xl font-semibold tabular-nums mt-1 ${
                counts.failed24h > 0 ? "text-destructive" : ""
              }`}
            >
              {counts.failed24h}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" /> Último éxito
            </div>
            <div className="text-sm tabular-nums mt-1">
              {counts.lastDoneAt ? formatDateTime(counts.lastDoneAt) : "—"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* IA inmediata (override) — antes vivía como Card en el dashboard
          del docente. Lo movimos acá porque pertenece al mismo flujo
          que la cola (entender qué hay pendiente → decidir si activar
          una ventana sincrónica para procesar YA). Banner compacto
          en lugar de Card propio para no inflar el alto del panel. */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-amber-50/40 dark:bg-amber-500/5 border-amber-300/40 dark:border-amber-500/20 px-3 py-2">
        <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
        <p className="text-xs text-muted-foreground flex-1 min-w-[200px]">
          Por defecto las calificaciones IA pasan por esta cola async. Si necesitas una nota IA{" "}
          <strong>ahora</strong>, pídele al administrador un código y actívalo aquí — abre una
          ventana sincrónica corta sin tocar la configuración global.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0"
          onClick={() => setOverrideDialogOpen(true)}
        >
          <Sparkles className="h-3.5 w-3.5 mr-1" />
          Activar IA
        </Button>
      </div>

      {/* Toolbar de bulk actions — solo aparece con count>0. Reusa el
          design system (MultiSelectToolbar): texto "N seleccionado(s)"
          + botones "Limpiar selección" + "Eliminar". El handler abre
          el dialog de confirmación que detalla qué jobs caen. */}
      <MultiSelectToolbar
        count={multi.count}
        onClear={multi.clear}
        onDelete={() => setBulkOpen(true)}
        entityNameSingular="job"
        entityNamePlural="jobs"
      />

      {/* Filtro + listado */}
      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between gap-3 space-y-0 flex-wrap">
          <div className="flex items-center gap-2">
            {/* Header checkbox — solo cuando hay al menos un job
                cancelable visible. Toggle all/none de lo cancelable. */}
            {selectableJobs.length > 0 && <MultiSelectHeaderCheckbox state={multi} />}
            <CardTitle className="text-base">Jobs en cola</CardTitle>
            <Badge variant="secondary" className="text-[10px]">
              {filteredCount}
            </Badge>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runNow()}
                disabled={running || counts.pending === 0}
                className="h-8"
              >
                {running ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1" />
                )}
                Procesar ahora ({counts.pending})
              </Button>
            )}
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Activos (P / Pr / F)</SelectItem>
                <SelectItem value="pending">Solo pendientes</SelectItem>
                <SelectItem value="processing">Solo en proceso</SelectItem>
                <SelectItem value="failed">Solo fallados</SelectItem>
                <SelectItem value="done">Solo completados</SelectItem>
                <SelectItem value="cancelled">Solo cancelados</SelectItem>
                <SelectItem value="all">Todos</SelectItem>
              </SelectContent>
            </Select>
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
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
              <Spinner size="sm" /> Cargando…
            </div>
          ) : loadError ? (
            <ErrorState
              message="No pudimos cargar la cola de IA"
              hint={loadError}
              onRetry={() => setRetryNonce((n) => n + 1)}
            />
          ) : jobs.length === 0 ? (
            <TableEmpty
              icon={Cpu}
              title="No hay jobs"
              description={
                statusFilter === "active"
                  ? "No hay jobs activos en la cola. Cuando se encole una calificación con IA aparecerá aquí."
                  : `No hay jobs con el estado "${
                      statusFilter === "all" ? "todos" : STATUS_LABELS[statusFilter as Status]
                    }".`
              }
            />
          ) : (
            <div className="divide-y">
              {jobs.map((j) => {
                const kindLabel = KIND_LABELS[j.kind] ?? j.kind;
                const isProcessing = j.status === "processing";
                const isFailed = j.status === "failed";
                const isPending = j.status === "pending";
                const isDone = j.status === "done";
                const isCancelled = j.status === "cancelled";
                const route = targetRouteForJob(j, isAdmin);
                const isRetrying = retrying.has(j.id);
                const isCancelling = cancelling.has(j.id);
                const isProcessingNow = processingOne.has(j.id);
                const expanded = expandedId === j.id;
                const label = j.examTitle ?? j.projectTitle ?? kindLabel;
                const subtitleParts = [j.studentName, j.courseName].filter(Boolean) as string[];
                const busy = isRetrying || isCancelling || isProcessingNow;

                const isSelectable = isPending || isFailed;
                return (
                  <div key={j.id} className="text-sm">
                    <div
                      className={`px-3 py-2 flex items-center gap-2 ${
                        isFailed ? "bg-destructive/5" : ""
                      } hover:bg-muted/40 transition-colors`}
                    >
                      {/* Checkbox por fila — visible solo para jobs
                          cancelables (pending/failed). Para los demás
                          (processing/done/cancelled) un placeholder de
                          mismo ancho mantiene la alineación de columnas. */}
                      {isSelectable ? (
                        <MultiSelectCheckbox id={j.id} state={multi} />
                      ) : (
                        <div className="w-4 shrink-0" aria-hidden="true" />
                      )}
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : j.id)}
                        className="flex items-center gap-2 flex-1 min-w-0 text-left"
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
                            {(isProcessing || isFailed || isPending) && (
                              <Badge
                                variant={
                                  isFailed
                                    ? "destructive"
                                    : isProcessing
                                      ? "secondary"
                                      : "outline"
                                }
                                className="text-[10px] shrink-0"
                              >
                                {STATUS_LABELS[j.status]}
                              </Badge>
                            )}
                          </div>
                          {subtitleParts.length > 0 && (
                            <div className="text-xs text-muted-foreground truncate">
                              {subtitleParts.join(" · ")}
                            </div>
                          )}
                        </div>
                        <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                          {relativeAge(j.created_at)}
                        </span>
                      </button>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {route && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            onClick={() =>
                              navigate({
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                to: route.to as any,
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                params: route.params as any,
                              })
                            }
                            title="Abrir en monitor / módulo"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {isFailed && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={busy}
                            onClick={() => void retryJob(j.id)}
                            title="Reintentar"
                          >
                            {isRetrying ? (
                              <Spinner size="sm" />
                            ) : (
                              <RefreshCw className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                        {isPending && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={busy}
                            onClick={() => void processOne(j.id)}
                            title="Procesar este job ahora (bypass cron)"
                          >
                            {isProcessingNow ? (
                              <Spinner size="sm" />
                            ) : (
                              <Zap className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                        {(isPending || isFailed) && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                            disabled={busy}
                            onClick={() => void cancelJob(j.id, label)}
                            title="Cancelar"
                          >
                            {isCancelling ? (
                              <Spinner size="sm" />
                            ) : (
                              <X className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                    {expanded && (
                      <div className="px-10 pr-3 pb-3 text-xs space-y-1 bg-muted/20 border-t">
                        <DetailRow k="ID" v={j.id} mono />
                        <DetailRow k="Tipo" v={kindLabel} />
                        <DetailRow k="Estado" v={STATUS_LABELS[j.status]} />
                        <DetailRow k="Tabla destino" v={j.target_table} mono />
                        <DetailRow k="ID destino" v={j.target_row_id} mono />
                        {j.courseName && <DetailRow k="Curso" v={j.courseName} />}
                        {j.studentName && <DetailRow k="Estudiante" v={j.studentName} />}
                        {j.examTitle && <DetailRow k="Examen" v={j.examTitle} />}
                        {j.projectTitle && <DetailRow k="Proyecto" v={j.projectTitle} />}
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
                        {isDone && (
                          <p className="pt-1 text-emerald-600 dark:text-emerald-400">
                            Procesado exitosamente.
                          </p>
                        )}
                        {isCancelled && (
                          <p className="pt-1 text-muted-foreground">
                            Cancelado manualmente — no se procesó.
                          </p>
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

      <p className="text-xs text-muted-foreground">
        Para procesar un job individual ahora usa el ícono{" "}
        <Zap className="inline h-3 w-3 align-text-bottom" />, y para drenar toda la cola (Admin) usa
        el botón "Procesar ahora" arriba a la derecha. Si necesitas IA sincrónica en un flujo del
        docente, pídele al administrador un código override.
      </p>

      {/* Dialog de confirmación para bulk cancel. Reusa BulkDeleteDialog
          del design system — el texto y botón dicen "Eliminar" porque
          conceptualmente cancelar un job lo saca de la cola (mismo
          impacto). El `extraWarning` aclara que la calificación no
          ocurrirá hasta que alguien re-encole. */}
      <BulkDeleteDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        items={selectedItems}
        entityNameSingular="job"
        entityNamePlural="jobs"
        extraWarning="Se cancelarán los jobs seleccionados — la cola IA no los procesará. Si una entrega necesita nota IA después, deberás encolarla manualmente."
        onConfirm={bulkCancel}
      />

      {/* Dialog para activar/gestionar el código override de IA inmediata.
          Antes vivía en el dashboard del docente; lo movimos junto a la
          cola para que el flujo entero (ver cola → decidir → activar
          sync) viva en el mismo módulo. */}
      <AiOverrideDialog open={overrideDialogOpen} onOpenChange={setOverrideDialogOpen} />
    </div>
  );
}

/** Punto de estado a la izquierda de cada fila. Reemplaza el ícono
 *  variable (Cpu animado / AlertTriangle / Clock) por algo más sobrio
 *  para listas largas — el badge de la derecha ya dice el estado. */
function StatusDot({ status }: { status: Status }) {
  const color =
    status === "processing"
      ? "bg-amber-500 animate-pulse"
      : status === "failed"
        ? "bg-destructive"
        : status === "done"
          ? "bg-emerald-500"
          : status === "cancelled"
            ? "bg-muted-foreground/50"
            : "bg-blue-500";
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
