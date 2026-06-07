/**
 * UnifiedAiQueuePanel — UNA sola tabla con jobs de calificación
 * (`ai_grading_queue`) Y de generación (`ai_generation_queue`).
 *
 * Reemplaza a `AiQueuePanel` + `AiGenerationQueuePanel`. Antes vivían
 * como dos paneles apilados con divisor; el docente reportó que se
 * veía como dos colas separadas cuando conceptualmente "es todo lo
 * que la IA tiene pendiente". Ahora una sola tabla con badge `Source`
 * (Calificación / Generación) en cada fila.
 *
 * Acciones por fila se ramifican según `source`:
 *   - grading → RPCs `cancel_ai_grading_job`, `requeue_ai_grading_job`,
 *     `reject_ai_grading_job`, `acknowledge_rejected_ai_grading_job`.
 *   - generation → UPDATE directo a `ai_generation_queue.status`.
 *
 * Procesar ahora invoca `ai-grading-worker` o `ai-generation-worker`
 * según el source, con el `jobId` apropiado.
 *
 * Stats agregados arriba: pending / processing / failed / done suman
 * ambas tablas. El badge de cada fila distingue de qué cola viene.
 *
 * Features preservadas del refactor:
 *   - Multi-select + bulk cancel (acción común a ambos sources).
 *   - Rechazo con razón (Admin/SA, SOLO aplicable a grading — el menú
 *     de acción lo oculta en filas de generation).
 *   - Banner inline "te rechazaron tu job" (docente, SOLO grading).
 *   - Override IA dialog (docente).
 *   - SuperAdmin: filtro por tenant.
 *   - Realtime con debounce (escucha cambios en AMBAS tablas).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import {
  useMultiSelect,
  MultiSelectCheckbox,
  MultiSelectHeaderCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { StatCard } from "@/components/ui/stat-card";
import {
  Clock,
  Cpu,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  X,
  Zap,
  Sparkles,
  Wand2,
  Scale,
  Ban,
  CheckCheck,
  MessageSquareWarning,
  ChevronDown,
  ChevronRight,
  Copy,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/shared/lib/format";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { logEvent } from "@/shared/lib/audit";
import { AiOverrideDialog } from "@/modules/ai/AiOverrideDialog";
import { readOverrideExpiry, getProcessingMode } from "@/modules/ai/ai-grading";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Status =
  | "pending"
  | "processing"
  | "failed"
  | "done"
  | "cancelled"
  | "rejected";

type Source = "grading" | "generation";

/** Shape normalizado para render. Cada fila de la tabla unificada es un
 *  UnifiedJob — distinguimos su origen por `source`. */
interface UnifiedJob {
  id: string;
  source: Source;
  kind: string;
  status: Status;
  attempts: number;
  created_at: string;
  completed_at: string | null;
  last_error: string | null;
  course_id: string | null;
  created_by: string | null;
  /** Mejor label que tengamos para mostrar como título de la fila. */
  label: string;
  /** Subtítulo opcional (curso, estudiante, etc.). */
  subtitle: string | null;
  /** Solo grading: campos del workflow de rechazo. Para generation
   *  quedan en null/undefined porque no aplica. */
  rejection_reason?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  acknowledged_at?: string | null;
  /** Solo grading: para resolver detalles del target. */
  target_table?: string;
  target_row_id?: string;
  /** Body del request — solo `generation`. Para grading no se persiste
   *  body (el target_table + target_row_id ya describe la entrada). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: Record<string, any> | null;
}

interface Props {
  /** Admin/SA: muestra "Procesar todos", filtro por tenant, rechazar con razón. */
  isAdmin?: boolean;
}

const GRADING_KIND_LABELS: Record<string, string> = {
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

const GENERATION_KIND_LABELS: Record<string, string> = {
  workshop_questions: "Preguntas de taller",
  exam_questions: "Preguntas de examen",
  project_files: "Archivos de proyecto",
  content_generation: "Contenido didáctico",
};

const STATUS_LABELS: Record<Status, string> = {
  pending: "Pendiente",
  processing: "En proceso",
  failed: "Fallado",
  done: "Completado",
  cancelled: "Cancelado",
  rejected: "Rechazado",
};

function kindLabelFor(j: UnifiedJob): string {
  const map = j.source === "grading" ? GRADING_KIND_LABELS : GENERATION_KIND_LABELS;
  return map[j.kind] ?? j.kind;
}

function relativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "ahora";
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

export function UnifiedAiQueuePanel({ isAdmin = false }: Props) {
  const confirm = useConfirm();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const isSuperAdminCaller = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");

  const [jobs, setJobs] = useState<UnifiedJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  // Filtros.
  const [statusFilter, setStatusFilter] = useState<"active" | "all" | Status>("active");
  const [sourceFilter, setSourceFilter] = useState<"all" | Source>("all");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }>>([]);

  // Estado de acciones in-flight (per-job).
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [draining, setDraining] = useState(false);

  // Dialogs.
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [rejectTarget, setRejectTarget] = useState<UnifiedJob | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  // Filas expandidas — cada job puede expandir un panel inline con
  // body del request (generation), target/attempts (grading) y el
  // mensaje de error completo. Restaurado desde el panel viejo
  // (AiQueuePanel) que se perdió al unificar.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Tenant list (SuperAdmin only).
  useEffect(() => {
    if (!isSuperAdminCaller) return;
    let cancelled = false;
    void (async () => {
      // .is("deleted_at", null): los tenants en papelera no aparecen
      // en filtros del SuperAdmin (mig 20260818000000).
      const { data } = await db
        .from("tenants")
        .select("id, name")
        .is("deleted_at", null)
        .order("name");
      if (cancelled) return;
      setTenants((data ?? []) as Array<{ id: string; name: string }>);
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdminCaller]);

  // Current user id (para detectar "este rechazo es para mí").
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getUser();
      if (cancelled) return;
      setCurrentUserId(data.user?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // SuperAdmin filtro tenant: resolvemos course_ids del tenant
      // elegido una vez y los aplicamos a las dos queries.
      let courseIdsFilter: string[] | null = null;
      if (isSuperAdminCaller && tenantFilter !== "all") {
        const { data: courseRows } = await db
          .from("courses")
          .select("id")
          .eq("tenant_id", tenantFilter);
        courseIdsFilter = ((courseRows ?? []) as Array<{ id: string }>).map((r) => r.id);
        if (courseIdsFilter.length === 0) {
          // Tenant sin cursos: corto antes de pegarle a las colas (un
          // `.in('course_id', [])` en PostgREST devuelve TODO).
          setJobs([]);
          setLoading(false);
          return;
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const applyTenant = (q: any) =>
        courseIdsFilter ? q.in("course_id", courseIdsFilter) : q;

      const [gradingRes, genRes] = await Promise.all([
        applyTenant(
          db
            .from("ai_grading_queue")
            .select(
              "id, kind, status, target_table, target_row_id, course_id, created_by, created_at, completed_at, attempts, last_error, rejection_reason, rejected_by, rejected_at, acknowledged_at",
            )
            .order("created_at", { ascending: false })
            .limit(100),
        ),
        applyTenant(
          db
            .from("ai_generation_queue")
            .select(
              "id, kind, status, source_table, source_id, course_id, created_by, created_at, completed_at, attempts, last_error, body",
            )
            .order("created_at", { ascending: false })
            .limit(100),
        ),
      ]);

      if (gradingRes.error || genRes.error) {
        const err = gradingRes.error ?? genRes.error;
        setLoadError(friendlyError(err, "No pudimos cargar la cola."));
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gradingRaw = (gradingRes.data ?? []) as Array<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const genRaw = (genRes.data ?? []) as Array<any>;

      // Enrichment liviano — UN solo lookup de cursos para ambos
      // sources, y lookups por tabla destino solo cuando hay filas.
      const allCourseIds = Array.from(
        new Set(
          [...gradingRaw, ...genRaw]
            .map((r) => r.course_id)
            .filter((c): c is string => !!c),
        ),
      );
      const wIds = [
        ...gradingRaw
          .filter((j) => j.target_table === "workshop_submissions")
          .map((j) => j.target_row_id),
        ...genRaw.filter((j) => j.source_table === "workshops").map((j) => j.source_id),
      ];
      const eIds = genRaw.filter((j) => j.source_table === "exams").map((j) => j.source_id);
      const pSubIds = gradingRaw
        .filter((j) => j.target_table === "project_submissions")
        .map((j) => j.target_row_id);
      const pIds = genRaw.filter((j) => j.source_table === "projects").map((j) => j.source_id);
      const submissionIds = gradingRaw
        .filter((j) => j.target_table === "submissions")
        .map((j) => j.target_row_id);

      const [coursesL, wL, eL, pL, pSubL, submissionsL] = await Promise.all([
        allCourseIds.length > 0
          ? db.from("courses").select("id, name").in("id", allCourseIds)
          : Promise.resolve({ data: [] }),
        wIds.length > 0
          ? db.from("workshops").select("id, title").in("id", wIds)
          : Promise.resolve({ data: [] }),
        eIds.length > 0
          ? db.from("exams").select("id, title").in("id", eIds)
          : Promise.resolve({ data: [] }),
        pIds.length > 0
          ? db.from("projects").select("id, title").in("id", pIds)
          : Promise.resolve({ data: [] }),
        pSubIds.length > 0
          ? db.from("project_submissions").select("id, project_id").in("id", pSubIds)
          : Promise.resolve({ data: [] }),
        submissionIds.length > 0
          ? db.from("submissions").select("id, exam_id").in("id", submissionIds)
          : Promise.resolve({ data: [] }),
      ]);

      const courseName = new Map<string, string>();
      for (const r of (coursesL.data ?? []) as Array<{ id: string; name: string }>)
        courseName.set(r.id, r.name);
      const titleById = new Map<string, string>();
      for (const r of (wL.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);
      for (const r of (eL.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);
      for (const r of (pL.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);

      // Resolver projects de submissions del grading (project_submissions → project_id).
      const pSubToProj = new Map<string, string>();
      for (const r of (pSubL.data ?? []) as Array<{ id: string; project_id: string }>)
        pSubToProj.set(r.id, r.project_id);
      // Resolver exams de submissions del grading.
      const subToExam = new Map<string, string>();
      for (const r of (submissionsL.data ?? []) as Array<{ id: string; exam_id: string }>)
        subToExam.set(r.id, r.exam_id);
      // Fetch projects + exams referenciados por grading (segundo paso de lookup).
      const projIds = Array.from(new Set(pSubToProj.values()));
      const examIds = Array.from(new Set(subToExam.values()));
      const [projL, examL] = await Promise.all([
        projIds.length > 0
          ? db.from("projects").select("id, title").in("id", projIds)
          : Promise.resolve({ data: [] }),
        examIds.length > 0
          ? db.from("exams").select("id, title").in("id", examIds)
          : Promise.resolve({ data: [] }),
      ]);
      for (const r of (projL.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);
      for (const r of (examL.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);

      // Normalización a UnifiedJob.
      const unified: UnifiedJob[] = [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...gradingRaw.map((r: any) => {
          let label = GRADING_KIND_LABELS[r.kind] ?? r.kind;
          // Mejor label: título del exam/workshop/project asociado.
          if (r.target_table === "submissions") {
            const examId = subToExam.get(r.target_row_id);
            const t = examId ? titleById.get(examId) : undefined;
            if (t) label = t;
          } else if (r.target_table === "workshop_submissions") {
            const t = titleById.get(r.target_row_id);
            if (t) label = t;
          } else if (r.target_table === "project_submissions") {
            const projId = pSubToProj.get(r.target_row_id);
            const t = projId ? titleById.get(projId) : undefined;
            if (t) label = t;
          }
          return {
            id: r.id,
            source: "grading" as const,
            kind: r.kind,
            status: r.status as Status,
            attempts: r.attempts ?? 0,
            created_at: r.created_at,
            completed_at: r.completed_at,
            last_error: r.last_error,
            course_id: r.course_id,
            created_by: r.created_by,
            label,
            subtitle: r.course_id ? (courseName.get(r.course_id) ?? null) : null,
            rejection_reason: r.rejection_reason,
            rejected_by: r.rejected_by,
            rejected_at: r.rejected_at,
            acknowledged_at: r.acknowledged_at,
            target_table: r.target_table,
            target_row_id: r.target_row_id,
          };
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...genRaw.map((r: any) => {
          let label = GENERATION_KIND_LABELS[r.kind] ?? r.kind;
          const sourceTitle = titleById.get(r.source_id);
          if (sourceTitle) label = sourceTitle;
          return {
            id: r.id,
            source: "generation" as const,
            kind: r.kind,
            status: r.status as Status,
            attempts: r.attempts ?? 0,
            created_at: r.created_at,
            completed_at: r.completed_at,
            last_error: r.last_error,
            course_id: r.course_id,
            created_by: r.created_by,
            label,
            subtitle: r.course_id ? (courseName.get(r.course_id) ?? null) : null,
            body: r.body ?? null,
          };
        }),
      ];

      // Sort por created_at desc (más recientes arriba — ambas fuentes
      // mezcladas).
      unified.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      setJobs(unified);
    } catch (e) {
      setLoadError(friendlyError(e, "No pudimos cargar la cola."));
    } finally {
      setLoading(false);
    }
  }, [isSuperAdminCaller, tenantFilter]);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  // Realtime: escucha cambios en AMBAS tablas. Debounce 800ms para que
  // el worker que drena varios jobs no dispare refresh-storm.
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void load(), 800);
    };
    const ch = supabase
      .channel("unified_ai_queue")
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "ai_grading_queue" },
        trigger,
      )
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "ai_generation_queue" },
        trigger,
      )
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      void supabase.removeChannel(ch).catch(() => {});
    };
  }, [load]);

  // Counts agregados (ambos sources).
  const counts = useMemo(() => {
    let pending = 0;
    let processingC = 0;
    let failed = 0;
    let done = 0;
    for (const j of jobs) {
      if (j.status === "pending") pending += 1;
      else if (j.status === "processing") processingC += 1;
      else if (j.status === "failed") failed += 1;
      else if (j.status === "done") done += 1;
    }
    return { pending, processing: processingC, failed, done };
  }, [jobs]);

  // Lista filtrada según UI.
  const filteredJobs = useMemo(() => {
    let out = jobs;
    if (sourceFilter !== "all") out = out.filter((j) => j.source === sourceFilter);
    if (statusFilter === "active") {
      out = out.filter(
        (j) =>
          j.status === "pending" ||
          j.status === "processing" ||
          j.status === "failed" ||
          (j.status === "rejected" && !j.acknowledged_at),
      );
    } else if (statusFilter !== "all") {
      out = out.filter((j) => j.status === statusFilter);
    }
    return out;
  }, [jobs, sourceFilter, statusFilter]);

  // Multi-select: solo jobs cancelables (pending/processing/failed).
  const selectableJobs = useMemo(
    () =>
      filteredJobs.filter(
        (j) => j.status === "pending" || j.status === "processing" || j.status === "failed",
      ),
    [filteredJobs],
  );
  const multi = useMultiSelect(selectableJobs);
  const [bulkOpen, setBulkOpen] = useState(false);
  const selectedItems = useMemo(
    () =>
      selectableJobs
        .filter((j) => multi.isSelected(j.id))
        .map((j) => ({ id: j.id, label: j.label })),
    [selectableJobs, multi],
  );

  // ─── Acciones individuales ─────────────────────────────────────────

  const cancelJob = async (job: UnifiedJob) => {
    if (cancelling.has(job.id)) return;
    const isProcessingNow = job.status === "processing";
    const ok = await confirm({
      title: "¿Cancelar este job de IA?",
      description: isProcessingNow
        ? `"${job.label}" — el job ya está siendo procesado. La llamada IA está en vuelo (el costo no se recupera), pero el resultado NO se persistirá.`
        : `"${job.label}" — el job no se procesará. Si la entrega necesita nota IA después, deberás encolarla manualmente.`,
      tone: "destructive",
      confirmLabel: "Cancelar job",
    });
    if (!ok) return;
    setCancelling((p) => new Set(p).add(job.id));
    try {
      if (job.source === "grading") {
        const { error } = await db.rpc("cancel_ai_grading_job", { _job_id: job.id });
        if (error) throw error;
      } else {
        const { error } = await db
          .from("ai_generation_queue")
          .update({ status: "cancelled", completed_at: new Date().toISOString() })
          .eq("id", job.id);
        if (error) throw error;
      }
      toast.success("Job cancelado");
      void logEvent({
        action:
          job.source === "grading"
            ? "ai_grading.job_cancelled"
            : "ai_generation.job_cancelled",
        category: job.source === "grading" ? "grading" : "generation",
        severity: "warning",
        entityType: job.source === "grading" ? "ai_grading_queue" : "ai_generation_queue",
        entityId: job.id,
        entityName: job.label,
        metadata: { source: "unified_panel", was_processing: isProcessingNow },
      });
      await load();
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo cancelar el job"));
    } finally {
      setCancelling((p) => {
        const n = new Set(p);
        n.delete(job.id);
        return n;
      });
    }
  };

  const retryJob = async (job: UnifiedJob) => {
    if (retrying.has(job.id)) return;
    setRetrying((p) => new Set(p).add(job.id));
    try {
      if (job.source === "grading") {
        const { error } = await db.rpc("requeue_ai_grading_job", { _job_id: job.id });
        if (error) throw error;
      } else {
        const { error } = await db
          .from("ai_generation_queue")
          .update({ status: "pending", last_error: null, started_at: null })
          .eq("id", job.id);
        if (error) throw error;
      }
      toast.success("Job re-encolado");
      await load();
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo re-encolar"));
    } finally {
      setRetrying((p) => {
        const n = new Set(p);
        n.delete(job.id);
        return n;
      });
    }
  };

  const processOne = async (job: UnifiedJob) => {
    if (processing.has(job.id)) return;
    // Docente debe tener código de IA inmediata activo si la cola está
    // en modo async (validación común a ambos sources). Admin queda
    // exento — gestiona la cola.
    if (!isAdmin) {
      const mode = await getProcessingMode();
      if (mode === "async" && !readOverrideExpiry()) {
        toast.info(
          "La cola está en modo async. Activá un código de IA inmediata para procesar jobs al instante.",
        );
        setOverrideOpen(true);
        return;
      }
    }
    setProcessing((p) => new Set(p).add(job.id));
    try {
      const workerName =
        job.source === "grading" ? "ai-grading-worker" : "ai-generation-worker";
      const { data, error } = await supabase.functions.invoke(workerName, {
        body: { jobId: job.id },
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
        toast.error("El job se procesó pero falló — revisá el error en la cola.");
      } else {
        toast.success("Job procesado");
      }
      await load();
    } catch (e) {
      toast.error(friendlyError(e, "Error procesando el job"));
    } finally {
      setProcessing((p) => {
        const n = new Set(p);
        n.delete(job.id);
        return n;
      });
    }
  };

  // Drain mode (Admin only) — invoca AMBOS workers sin jobId.
  const drainAll = async () => {
    if (draining) return;
    setDraining(true);
    try {
      const [gradingRes, genRes] = await Promise.all([
        supabase.functions.invoke("ai-grading-worker", { body: {} }),
        supabase.functions.invoke("ai-generation-worker", { body: {} }),
      ]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const g = gradingRes.data as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gn = genRes.data as any;
      const procG = g?.processed ?? 0;
      const procGn = gn?.processed ?? 0;
      const failG = (g?.failed ?? 0) + (gn?.failed ?? 0);
      toast.success(
        `Drenado: ${procG + procGn} job(s) (${procG} grading + ${procGn} generación)` +
          (failG > 0 ? ` — ${failG} fallaron` : ""),
      );
      await load();
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo drenar la cola"));
    } finally {
      setDraining(false);
    }
  };

  // Rechazo con razón — Admin only, SOLO sobre grading.
  const openReject = (job: UnifiedJob) => {
    setRejectReason("");
    setRejectTarget(job);
  };
  const confirmReject = async () => {
    if (!rejectTarget) return;
    if (rejectReason.trim().length < 5) {
      toast.error("La razón es obligatoria (mínimo 5 caracteres).");
      return;
    }
    setRejecting(true);
    try {
      const { error } = await db.rpc("reject_ai_grading_job", {
        _job_id: rejectTarget.id,
        _reason: rejectReason.trim(),
      });
      if (error) throw error;
      toast.success("Job rechazado. El docente recibió la notificación.");
      setRejectTarget(null);
      await load();
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo rechazar el job"));
    } finally {
      setRejecting(false);
    }
  };

  // Acusar recibo del rechazo (docente cuyo job fue rechazado).
  const acknowledgeReject = async (job: UnifiedJob) => {
    try {
      const { error } = await db.rpc("acknowledge_rejected_ai_grading_job", {
        _job_id: job.id,
      });
      if (error) throw error;
      toast.success("Rechazo cerrado. El job se movió al historial.");
      await load();
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo cerrar el rechazo"));
    }
  };

  // Bulk cancel — usa el dispatch correcto por source.
  const bulkCancel = async (ids: string[]) => {
    const targets = jobs.filter((j) => ids.includes(j.id));
    const results = await Promise.allSettled(
      targets.map((j) => {
        if (j.source === "grading") {
          return db.rpc("cancel_ai_grading_job", { _job_id: j.id });
        }
        return db
          .from("ai_generation_queue")
          .update({ status: "cancelled", completed_at: new Date().toISOString() })
          .eq("id", j.id);
      }),
    );
    const failures = results.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r) => r.status === "rejected" || (r.status === "fulfilled" && (r.value as any)?.error),
    );
    if (failures.length > 0) {
      throw new Error(
        `No se pudieron cancelar ${failures.length} de ${ids.length} jobs. Reintentá.`,
      );
    }
    toast.success(`${ids.length} job(s) cancelado(s)`);
    multi.clear();
    await load();
  };

  return (
    <div className="space-y-4">
      {draining && (
        <LoadingOverlay
          title="Drenando cola IA…"
          subtitle="Invocando los workers de calificación y generación. Puede tardar varios minutos según cuántos jobs estén pendientes. No cierres esta pestaña."
        />
      )}
      {/* Stats 4-card — suman AMBAS colas. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Clock}
          label="Pendientes"
          value={counts.pending + counts.failed}
          tone={counts.failed > 0 ? "warning" : "default"}
        />
        <StatCard icon={Cpu} label="En proceso" value={counts.processing} />
        <StatCard
          icon={AlertTriangle}
          label="Fallados"
          value={counts.failed}
          tone={counts.failed > 0 ? "destructive" : "default"}
        />
        <StatCard
          icon={CheckCircle2}
          label="Completados"
          value={counts.done}
          tone={counts.done > 0 ? "success" : "default"}
        />
      </div>

      {/* IA inmediata (override) — docente. */}
      {!isAdmin && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-amber-50/40 dark:bg-amber-500/5 border-amber-300/40 dark:border-amber-500/20 px-3 py-2">
          <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
          <p className="text-xs text-muted-foreground flex-1 min-w-[200px]">
            Por defecto las acciones de IA (calificación y generación) pasan por esta cola async.
            Si necesitás IA <strong>ahora</strong>, pedile al administrador un código y activalo
            acá — abre una ventana sincrónica corta sin tocar la configuración global.
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0"
            onClick={() => setOverrideOpen(true)}
          >
            <Sparkles className="h-3.5 w-3.5 mr-1" />
            Activar IA
          </Button>
        </div>
      )}

      {/* Bulk cancel toolbar */}
      <MultiSelectToolbar
        count={multi.count}
        onClear={multi.clear}
        onDelete={() => setBulkOpen(true)}
        entityNameSingular="job"
        entityNamePlural="jobs"
        actionLabel="Cancelar"
        actionIcon={X}
      />

      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between gap-3 space-y-0 flex-wrap">
          <div className="flex items-center gap-2">
            {selectableJobs.length > 0 && <MultiSelectHeaderCheckbox state={multi} />}
            <CardTitle className="text-base">Jobs en cola</CardTitle>
            <Badge variant="secondary" className="text-[10px]">
              {filteredJobs.length}
            </Badge>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {isSuperAdminCaller && tenants.length > 0 && (
              <Select value={tenantFilter} onValueChange={setTenantFilter}>
                <SelectTrigger className="h-8 w-48 text-xs">
                  <SelectValue placeholder="Institución" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas las instituciones</SelectItem>
                  {tenants.map((tn) => (
                    <SelectItem key={tn.id} value={tn.id}>
                      {tn.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select
              value={sourceFilter}
              onValueChange={(v) => setSourceFilter(v as typeof sourceFilter)}
            >
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los tipos</SelectItem>
                <SelectItem value="grading">Calificación</SelectItem>
                <SelectItem value="generation">Generación</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Activos + rechazos abiertos</SelectItem>
                <SelectItem value="pending">Solo pendientes</SelectItem>
                <SelectItem value="processing">Solo en proceso</SelectItem>
                <SelectItem value="failed">Solo fallados</SelectItem>
                <SelectItem value="done">Solo completados</SelectItem>
                <SelectItem value="cancelled">Solo cancelados</SelectItem>
                <SelectItem value="all">Todos</SelectItem>
              </SelectContent>
            </Select>
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => void drainAll()}
                disabled={draining}
                title="Drena las dos colas invocando ambos workers"
              >
                {draining ? (
                  <Spinner size="xs" className="mr-1" />
                ) : (
                  <Zap className="h-3.5 w-3.5 mr-1" />
                )}
                Procesar todos
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setRetryNonce((n) => n + 1)}
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
              message="No pudimos cargar la cola"
              hint={loadError}
              onRetry={() => setRetryNonce((n) => n + 1)}
            />
          ) : filteredJobs.length === 0 ? (
            <TableEmpty
              icon={Wand2}
              title="Sin jobs"
              description={
                statusFilter === "active"
                  ? "No hay jobs activos. Cuando se encole una calificación o generación con IA aparecerá acá."
                  : "No hay jobs con ese filtro."
              }
            />
          ) : (
            <div className="divide-y">
              {filteredJobs.map((j) => {
                const isCancelling = cancelling.has(j.id);
                const isRetrying = retrying.has(j.id);
                const isProcessingNow = processing.has(j.id);
                const busy = isCancelling || isRetrying || isProcessingNow;
                const isMyRejection =
                  j.status === "rejected" &&
                  !j.acknowledged_at &&
                  j.created_by === currentUserId;
                const isSelectable =
                  j.status === "pending" ||
                  j.status === "processing" ||
                  j.status === "failed";
                const expanded = expandedId === j.id;
                return (
                  <div key={j.id} className="text-sm">
                    <div
                      className={`px-3 py-2 flex items-center gap-2 ${
                        j.status === "failed"
                          ? "bg-destructive/5"
                          : isMyRejection
                            ? "bg-orange-500/5"
                            : ""
                      } hover:bg-muted/40 transition-colors`}
                    >
                      {isSelectable ? (
                        <MultiSelectCheckbox id={j.id} state={multi} />
                      ) : (
                        <div className="w-4 shrink-0" aria-hidden="true" />
                      )}
                      {/* Chevron toggle: expande el panel inline con body
                          del request + último error completo. Imprescindible
                          para debug — sin esto el docente / admin no podía
                          ver POR QUÉ falló un job. */}
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : j.id)}
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        title={expanded ? "Ocultar detalle" : "Ver detalle"}
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {/* Badge SOURCE — distintivo visual entre calificación
                            y generación. Color sky para grading (Scale icon),
                            ámbar para generación (Wand2 icon). */}
                        <Badge
                          variant="outline"
                          className={`text-[10px] shrink-0 ${
                            j.source === "grading"
                              ? "border-sky-500/40 text-sky-700 dark:text-sky-400"
                              : "border-amber-500/40 text-amber-700 dark:text-amber-400"
                          }`}
                        >
                          {j.source === "grading" ? (
                            <>
                              <Scale className="h-3 w-3 mr-0.5" />
                              Calificación
                            </>
                          ) : (
                            <>
                              <Wand2 className="h-3 w-3 mr-0.5" />
                              Generación
                            </>
                          )}
                        </Badge>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate">{j.label}</span>
                            <Badge variant="outline" className="text-[10px] shrink-0">
                              {kindLabelFor(j)}
                            </Badge>
                            <Badge
                              variant={
                                j.status === "failed" || j.status === "rejected"
                                  ? "destructive"
                                  : j.status === "processing"
                                    ? "secondary"
                                    : "outline"
                              }
                              className="text-[10px] shrink-0"
                            >
                              {STATUS_LABELS[j.status]}
                            </Badge>
                          </div>
                          {j.subtitle && (
                            <div className="text-xs text-muted-foreground truncate">
                              {j.subtitle}
                            </div>
                          )}
                        </div>
                        {/* Edad relativa (5d, 36m, etc.) — oculta en
                            mobile. A 375px chocaba con los 4 botones de
                            acción y rompía el flex-wrap del label,
                            montando "Pendiente" sobre "Proyecto (batch)".
                            El detalle completo de fechas vive en el panel
                            expandible — el age es solo at-a-glance. */}
                        <span className="hidden sm:inline text-[11px] text-muted-foreground tabular-nums shrink-0">
                          {relativeAge(j.created_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        {(j.status === "failed" || j.status === "cancelled") && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={busy}
                            onClick={() => void retryJob(j)}
                            title={j.status === "cancelled" ? "Re-encolar" : "Reintentar"}
                          >
                            {isRetrying ? (
                              <Spinner size="sm" />
                            ) : (
                              <RefreshCw className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                        {j.status === "pending" && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={busy}
                            onClick={() => void processOne(j)}
                            title="Procesar este job ahora (bypass cron)"
                          >
                            {isProcessingNow ? (
                              <Spinner size="sm" />
                            ) : (
                              <Zap className="h-3.5 w-3.5" />
                            )}
                          </Button>
                        )}
                        {/* Rechazo con razón: SOLO Admin/SA y SOLO grading. */}
                        {isAdmin &&
                          j.source === "grading" &&
                          (j.status === "pending" || j.status === "failed") && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-orange-600 hover:text-orange-700 hover:bg-orange-500/10 dark:text-orange-400 dark:hover:text-orange-300"
                              disabled={busy}
                              onClick={() => openReject(j)}
                              title="Rechazar con razón (notifica al docente)"
                            >
                              <Ban className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        {(j.status === "pending" ||
                          j.status === "failed" ||
                          j.status === "processing") && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                            disabled={busy}
                            onClick={() => void cancelJob(j)}
                            title={
                              j.status === "processing"
                                ? "Cancelar (la llamada IA ya está en vuelo)"
                                : "Cancelar"
                            }
                          >
                            {isCancelling ? <Spinner size="sm" /> : <X className="h-3.5 w-3.5" />}
                          </Button>
                        )}
                        {j.status === "rejected" && !j.acknowledged_at && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400 dark:hover:text-emerald-300"
                            onClick={() => void acknowledgeReject(j)}
                            title="Cerrar conversación (acusar recibo del rechazo)"
                          >
                            <CheckCheck className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {/* Panel de detalle expandible — body del request (gen),
                        target/attempts/created (grading + gen), error
                        completo con botón Copiar. Restaurado del refactor
                        UnifiedAiQueuePanel que lo perdió silenciosamente. */}
                    {expanded && (
                      <div className="px-10 pr-3 pb-3 -mt-1 space-y-2">
                        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs space-y-1.5">
                          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                            <div>
                              <span className="text-muted-foreground">ID:</span>{" "}
                              <code className="font-mono text-[10px]">{j.id.slice(0, 8)}…</code>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Intentos:</span>{" "}
                              <span className="tabular-nums">{j.attempts}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Creado:</span>{" "}
                              <span className="tabular-nums">{formatDateTime(j.created_at)}</span>
                            </div>
                            {j.completed_at && (
                              <div>
                                <span className="text-muted-foreground">Terminado:</span>{" "}
                                <span className="tabular-nums">
                                  {formatDateTime(j.completed_at)}
                                </span>
                              </div>
                            )}
                            {j.source === "grading" && j.target_table && (
                              <div className="col-span-2">
                                <span className="text-muted-foreground">Target:</span>{" "}
                                <code className="font-mono text-[10px]">
                                  {j.target_table}/{j.target_row_id?.slice(0, 8)}…
                                </code>
                              </div>
                            )}
                          </div>
                          {j.source === "generation" && j.body && (
                            <div>
                              <div className="text-muted-foreground mb-0.5">Body del request:</div>
                              <pre className="font-mono text-[10px] whitespace-pre-wrap break-words max-h-40 overflow-y-auto rounded bg-background/60 p-2 border">
                                {JSON.stringify(j.body, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                        {j.last_error && (
                          <div className="rounded border border-destructive/30 bg-destructive/5 p-2 flex items-start gap-1.5">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-destructive" />
                            <div className="flex-1 min-w-0">
                              <div className="text-[11px] font-medium text-destructive mb-0.5">
                                Último error
                              </div>
                              <div className="text-[11px] text-destructive whitespace-pre-wrap break-words">
                                {j.last_error}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void navigator.clipboard
                                  .writeText(j.last_error ?? "")
                                  .then(() => toast.success("Error copiado"))
                                  .catch(() => toast.error("No se pudo copiar"));
                              }}
                              className="shrink-0 text-[10px] text-destructive/80 hover:text-destructive flex items-center gap-0.5"
                              title="Copiar error completo"
                            >
                              <Copy className="h-3 w-3" /> Copiar
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                    {/* Preview del error colapsado: cuando NO está expandido
                        pero el job tiene error, mostramos una línea recortada
                        para que se vea de un vistazo sin tener que abrir cada
                        fila. Click invita a expandir para ver el detalle. */}
                    {!expanded && j.last_error && (
                      <div className="px-10 pr-3 pb-2 -mt-1">
                        <button
                          type="button"
                          onClick={() => setExpandedId(j.id)}
                          className="text-left w-full text-[11px] text-destructive/90 hover:text-destructive truncate flex items-center gap-1"
                          title="Click para ver el error completo"
                        >
                          <AlertTriangle className="h-3 w-3 shrink-0" />
                          <span className="truncate">{j.last_error}</span>
                        </button>
                      </div>
                    )}
                    {isMyRejection && (
                      <div className="px-10 pr-3 pb-3 -mt-1">
                        <div className="rounded-md border border-orange-500/40 bg-orange-500/5 px-3 py-2 flex flex-col sm:flex-row sm:items-start gap-2">
                          <div className="flex items-start gap-2 flex-1 min-w-0">
                            <MessageSquareWarning className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0 space-y-1">
                              <p className="text-xs font-medium text-orange-700 dark:text-orange-400">
                                El administrador rechazó este trabajo de IA
                              </p>
                              <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                                {j.rejection_reason ?? "Sin razón especificada."}
                              </p>
                              {j.rejected_at && (
                                <p className="text-[10px] text-muted-foreground">
                                  Rechazado el {formatDateTime(j.rejected_at)}
                                </p>
                              )}
                            </div>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs shrink-0 border-orange-500/40 hover:bg-orange-500/10 w-full sm:w-auto"
                            onClick={() => void acknowledgeReject(j)}
                          >
                            <CheckCheck className="h-3.5 w-3.5 mr-1" />
                            Cerrar conversación
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <BulkDeleteDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        items={selectedItems}
        entityNameSingular="job"
        entityNamePlural="jobs"
        actionLabel="Cancelar"
        actionIcon={X}
        dismissLabel="Volver"
        extraWarning="Los jobs seleccionados se marcarán como cancelados. Si están en proceso, la llamada IA ya está en vuelo (no se recupera el costo) pero el resultado no se persistirá."
        onConfirm={bulkCancel}
      />

      {/* Override IA — docente. */}
      <AiOverrideDialog open={overrideOpen} onOpenChange={setOverrideOpen} />

      {/* Reject con razón — Admin/SA + grading. */}
      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Rechazar job de IA</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              El docente recibirá una notificación con tu razón. El job quedará visible en su cola
              hasta que cierre la conversación.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="reject-reason" required>
                Razón
              </Label>
              <Textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={4}
                placeholder="Ej: la rúbrica del taller está incompleta — completala antes de re-encolar."
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectTarget(null)}>
              Cancelar
            </Button>
            <Button onClick={() => void confirmReject()} disabled={rejecting}>
              {rejecting && <Spinner size="sm" className="mr-2" />}
              Rechazar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
