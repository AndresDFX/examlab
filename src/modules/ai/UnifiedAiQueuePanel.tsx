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
import { Input } from "@/components/ui/input";
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
  Search,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import i18n from "@/i18n";
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
  /** Cuándo el worker reclamó el job (status → processing). Para detectar
   *  atascos: un job lleva (now - started_at) en proceso. */
  started_at: string | null;
  completed_at: string | null;
  last_error: string | null;
  course_id: string | null;
  created_by: string | null;
  /** Mejor label que tengamos para mostrar como título de la fila. */
  label: string;
  /** Subtítulo opcional (curso, estudiante, etc.). */
  subtitle: string | null;
  /** Nombre del curso resuelto — fila explícita del detalle (el subtítulo
   *  del header lo trunca; acá se muestra completo). */
  courseLabel?: string | null;
  /** Solo grading: campos del workflow de rechazo. Para generation
   *  quedan en null/undefined porque no aplica. */
  rejection_reason?: string | null;
  rejected_by?: string | null;
  /** Nombre resuelto de quien rechazó (rejected_by → profiles). */
  rejectedByName?: string | null;
  rejected_at?: string | null;
  acknowledged_at?: string | null;
  /** Solo grading: para resolver detalles del target. */
  target_table?: string;
  target_row_id?: string;
  /** Body del request — solo `generation`. Para grading no se persiste
   *  body (el target_table + target_row_id ya describe la entrada). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body?: Record<string, any> | null;
  /** "Enviado por": dueño de la entrega para grading (el estudiante
   *  resuelto vía target_table → user_id → profiles). Para generación
   *  representa al solicitante (== quien encoló). Resuelto en load(). */
  submitterName?: string | null;
  submitterEmail?: string | null;
  /** "Encolado por": created_by resuelto a nombre + email. Quien disparó
   *  el job (docente, estudiante o sistema). Puede diferir del submitter
   *  en grading (ej. docente recalifica la entrega de un alumno). */
  enqueuedByName?: string | null;
  enqueuedByEmail?: string | null;
}

interface Props {
  /** Admin/SA: muestra "Procesar todos", filtro por tenant, rechazar con razón. */
  isAdmin?: boolean;
}

const GRADING_KIND_LABELS: Record<string, string> = {
  exam_submission: i18n.t("hc_modulesAiUnifiedAiQueuePanel.gradingKindExamSubmission"),
  exam_question: i18n.t("hc_modulesAiUnifiedAiQueuePanel.gradingKindExamQuestion"),
  workshop_submission: i18n.t("hc_modulesAiUnifiedAiQueuePanel.gradingKindWorkshopSubmission"),
  workshop_question: i18n.t("hc_modulesAiUnifiedAiQueuePanel.gradingKindWorkshopQuestion"),
  workshop_full: i18n.t("hc_modulesAiUnifiedAiQueuePanel.gradingKindWorkshopFull"),
  project_submission: i18n.t("hc_modulesAiUnifiedAiQueuePanel.gradingKindProjectSubmission"),
  project_file: i18n.t("hc_modulesAiUnifiedAiQueuePanel.gradingKindProjectFile"),
  project_full: i18n.t("hc_modulesAiUnifiedAiQueuePanel.gradingKindProjectFull"),
  project_codigo_zip: i18n.t("hc_modulesAiUnifiedAiQueuePanel.gradingKindProjectCodigoZip"),
};

const GENERATION_KIND_LABELS: Record<string, string> = {
  workshop_questions: i18n.t("hc_modulesAiUnifiedAiQueuePanel.generationKindWorkshopQuestions"),
  exam_questions: i18n.t("hc_modulesAiUnifiedAiQueuePanel.generationKindExamQuestions"),
  project_files: i18n.t("hc_modulesAiUnifiedAiQueuePanel.generationKindProjectFiles"),
  content_generation: i18n.t("hc_modulesAiUnifiedAiQueuePanel.generationKindContentGeneration"),
};

const STATUS_LABELS: Record<Status, string> = {
  pending: i18n.t("hc_modulesAiUnifiedAiQueuePanel.statusPending"),
  processing: i18n.t("hc_modulesAiUnifiedAiQueuePanel.statusProcessing"),
  failed: i18n.t("hc_modulesAiUnifiedAiQueuePanel.statusFailed"),
  done: i18n.t("hc_modulesAiUnifiedAiQueuePanel.statusDone"),
  cancelled: i18n.t("hc_modulesAiUnifiedAiQueuePanel.statusCancelled"),
  rejected: i18n.t("hc_modulesAiUnifiedAiQueuePanel.statusRejected"),
};

function kindLabelFor(j: UnifiedJob): string {
  const map = j.source === "grading" ? GRADING_KIND_LABELS : GENERATION_KIND_LABELS;
  return map[j.kind] ?? j.kind;
}

function relativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return i18n.t("hc_modulesAiUnifiedAiQueuePanel.ageNow");
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

// Un job sano se procesa en segundos; si lleva más de esto en 'processing'
// es muy probable que esté ATASCADO (el worker murió a mitad). Coincide con
// el umbral de release del worker (release_stuck_processing_jobs, 3 min).
const STUCK_PROCESSING_MIN = 3;

/** Minutos que un job lleva en 'processing'. null si no hay started_at o el
 *  reloj aún no inicializó (nowMs=0 antes del primer tick post-mount). */
function processingAgeMin(startedIso: string | null, nowMs: number): number | null {
  if (!startedIso || nowMs <= 0) return null;
  return Math.floor((nowMs - new Date(startedIso).getTime()) / 60_000);
}

export function UnifiedAiQueuePanel({ isAdmin = false }: Props) {
  const { t } = useTranslation();
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
  const [search, setSearch] = useState("");
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
              "id, kind, status, target_table, target_row_id, course_id, created_by, created_at, started_at, completed_at, attempts, last_error, rejection_reason, rejected_by, rejected_at, acknowledged_at",
            )
            .order("created_at", { ascending: false })
            .limit(100),
        ),
        applyTenant(
          db
            .from("ai_generation_queue")
            .select(
              "id, kind, status, source_table, source_id, course_id, created_by, created_at, started_at, completed_at, attempts, last_error, body",
            )
            .order("created_at", { ascending: false })
            .limit(100),
        ),
      ]);

      if (gradingRes.error || genRes.error) {
        const err = gradingRes.error ?? genRes.error;
        setLoadError(
          friendlyError(err, t("hc_modulesAiUnifiedAiQueuePanel.errLoadQueue")),
        );
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
      // Solo los workshops referenciados DIRECTO por generación
      // (source_id ES el workshop id). Para grading, target_row_id es el id
      // de la ENTREGA (workshop_submissions), NO del taller — su título se
      // resuelve en un 2º paso vía workshop_submissions.workshop_id (igual
      // que project_submissions → project_id).
      const wIds = genRaw
        .filter((j) => j.source_table === "workshops")
        .map((j) => j.source_id);
      const eIds = genRaw.filter((j) => j.source_table === "exams").map((j) => j.source_id);
      const pSubIds = gradingRaw
        .filter((j) => j.target_table === "project_submissions")
        .map((j) => j.target_row_id);
      const pIds = genRaw.filter((j) => j.source_table === "projects").map((j) => j.source_id);
      const submissionIds = gradingRaw
        .filter((j) => j.target_table === "submissions")
        .map((j) => j.target_row_id);
      const wSubIds = gradingRaw
        .filter((j) => j.target_table === "workshop_submissions")
        .map((j) => j.target_row_id);
      // project_submission_files: el owner es indirecto (file → submission
      // → user_id). Primero resolvemos el submission_id de cada file.
      const pFileIds = gradingRaw
        .filter((j) => j.target_table === "project_submission_files")
        .map((j) => j.target_row_id);

      const [coursesL, wL, eL, pL, pSubL, submissionsL, wSubL, pFileL] = await Promise.all([
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
        // pedimos user_id además del project_id → dueño de la entrega.
        pSubIds.length > 0
          ? db.from("project_submissions").select("id, project_id, user_id").in("id", pSubIds)
          : Promise.resolve({ data: [] }),
        // pedimos user_id además del exam_id → dueño de la entrega.
        submissionIds.length > 0
          ? db.from("submissions").select("id, exam_id, user_id").in("id", submissionIds)
          : Promise.resolve({ data: [] }),
        // workshop_submissions: pedimos workshop_id además de user_id → para
        // resolver el TÍTULO del taller (paridad con project_submissions).
        wSubIds.length > 0
          ? db.from("workshop_submissions").select("id, user_id, workshop_id").in("id", wSubIds)
          : Promise.resolve({ data: [] }),
        pFileIds.length > 0
          ? db.from("project_submission_files").select("id, submission_id").in("id", pFileIds)
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
      // Dueño de cada entrega — mapeamos target_row_id → user_id según la
      // tabla destino. Se usa para resolver "Enviado por" (el estudiante).
      const ownerByTargetRow = new Map<string, string>();
      for (const r of (pSubL.data ?? []) as Array<{
        id: string;
        project_id: string;
        user_id: string | null;
      }>) {
        pSubToProj.set(r.id, r.project_id);
        if (r.user_id) ownerByTargetRow.set(r.id, r.user_id);
      }
      // Resolver exams de submissions del grading.
      const subToExam = new Map<string, string>();
      for (const r of (submissionsL.data ?? []) as Array<{
        id: string;
        exam_id: string;
        user_id: string | null;
      }>) {
        subToExam.set(r.id, r.exam_id);
        if (r.user_id) ownerByTargetRow.set(r.id, r.user_id);
      }
      // workshop_submission_id → workshop_id (para resolver el título del
      // taller de los jobs workshop_full, igual que pSubToProj para proyectos).
      const wSubToWorkshop = new Map<string, string>();
      for (const r of (wSubL.data ?? []) as Array<{
        id: string;
        user_id: string | null;
        workshop_id: string | null;
      }>) {
        if (r.user_id) ownerByTargetRow.set(r.id, r.user_id);
        if (r.workshop_id) wSubToWorkshop.set(r.id, r.workshop_id);
      }
      // project_submission_files → submission_id; resolveremos el user_id
      // del owner en el segundo paso (junto a projects/exams).
      const pFileToSub = new Map<string, string>();
      for (const r of (pFileL.data ?? []) as Array<{ id: string; submission_id: string }>)
        pFileToSub.set(r.id, r.submission_id);

      // Fetch projects + exams referenciados por grading (segundo paso de lookup).
      const examIds = Array.from(new Set(subToExam.values()));
      // Las submissions de los project_submission_files que aún no
      // resolvimos su owner (no estaban en pSubIds).
      const pFileSubIds = Array.from(new Set(pFileToSub.values())).filter(
        (id) => !ownerByTargetRow.has(id),
      );
      const [examL, pFileSubL] = await Promise.all([
        examIds.length > 0
          ? db.from("exams").select("id, title").in("id", examIds)
          : Promise.resolve({ data: [] }),
        // pedimos project_id además de user_id → para resolver el TÍTULO del
        // proyecto de los jobs project_submission_files (paridad con
        // project_full, que sí muestra el título de la entrega).
        pFileSubIds.length > 0
          ? db.from("project_submissions").select("id, user_id, project_id").in("id", pFileSubIds)
          : Promise.resolve({ data: [] }),
      ]);
      for (const r of (examL.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);
      // owner + project del submission de cada project_submission_file.
      const ownerBySubId = new Map<string, string>();
      const fileSubToProj = new Map<string, string>();
      for (const r of (pFileSubL.data ?? []) as Array<{
        id: string;
        user_id: string | null;
        project_id: string | null;
      }>) {
        if (r.user_id) ownerBySubId.set(r.id, r.user_id);
        if (r.project_id) fileSubToProj.set(r.id, r.project_id);
      }
      // Títulos de TODOS los proyectos referenciados (project_full vía
      // pSubToProj + project_submission_files vía fileSubToProj). Se hace
      // acá —no en el Promise.all de arriba— porque fileSubToProj recién
      // se conoce tras resolver las submissions de los archivos.
      const allProjIds = Array.from(
        new Set<string>([...pSubToProj.values(), ...fileSubToProj.values()]),
      );
      const projL =
        allProjIds.length > 0
          ? await db.from("projects").select("id, title").in("id", allProjIds)
          : { data: [] };
      for (const r of (projL.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);

      // Títulos de los talleres referenciados por jobs workshop_full (grading):
      // target_row_id → workshop_submission → workshop_id (wSubToWorkshop) →
      // título. Se hace acá porque wSubToWorkshop recién se conoce tras el
      // primer Promise.all (idéntico al patrón de allProjIds para proyectos).
      const allWorkshopIds = Array.from(new Set<string>(wSubToWorkshop.values()));
      const wGradeL =
        allWorkshopIds.length > 0
          ? await db.from("workshops").select("id, title").in("id", allWorkshopIds)
          : { data: [] };
      for (const r of (wGradeL.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);

      // ─── Resolución de nombres (created_by + dueños de entregas) ──────
      // Juntamos TODOS los user_ids en un solo Set y hacemos UN lookup a
      // profiles. NO embebemos (*.user_id → auth.users no es embebible;
      // profiles.id == ese id, así que .in("id", ...) funciona).
      const ownerIds = new Set<string>();
      for (const uid of ownerByTargetRow.values()) ownerIds.add(uid);
      for (const uid of ownerBySubId.values()) ownerIds.add(uid);
      const allProfileIds = Array.from(
        new Set<string>([
          ...[...gradingRaw, ...genRaw]
            .map((r) => r.created_by)
            .filter((c): c is string => !!c),
          // rejected_by (solo grading) → para mostrar "Rechazado por" con nombre.
          ...gradingRaw
            .map((r) => r.rejected_by)
            .filter((c): c is string => !!c),
          ...ownerIds,
        ]),
      );
      const profilesL =
        allProfileIds.length > 0
          ? await db
              .from("profiles")
              .select("id, full_name, institutional_email")
              .in("id", allProfileIds)
          : { data: [] };
      const profileNameById = new Map<string, string>();
      const profileEmailById = new Map<string, string>();
      for (const p of (profilesL.data ?? []) as Array<{
        id: string;
        full_name: string | null;
        institutional_email: string | null;
      }>) {
        if (p.full_name) profileNameById.set(p.id, p.full_name);
        if (p.institutional_email) profileEmailById.set(p.id, p.institutional_email);
      }

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
            const wsId = wSubToWorkshop.get(r.target_row_id);
            const t = wsId ? titleById.get(wsId) : undefined;
            if (t) label = t;
          } else if (r.target_table === "project_submissions") {
            const projId = pSubToProj.get(r.target_row_id);
            const t = projId ? titleById.get(projId) : undefined;
            if (t) label = t;
          } else if (r.target_table === "project_submission_files") {
            // file → submission → project_id (la submission pudo resolverse
            // como project_full en pSubToProj, o como archivo en fileSubToProj).
            const subId = pFileToSub.get(r.target_row_id);
            const projId = subId ? (pSubToProj.get(subId) ?? fileSubToProj.get(subId)) : undefined;
            const t = projId ? titleById.get(projId) : undefined;
            if (t) label = t;
          }
          // Dueño de la entrega (estudiante) según la tabla destino.
          let ownerId = ownerByTargetRow.get(r.target_row_id);
          if (!ownerId && r.target_table === "project_submission_files") {
            const subId = pFileToSub.get(r.target_row_id);
            if (subId) ownerId = ownerBySubId.get(subId);
          }
          const submitterName = ownerId ? (profileNameById.get(ownerId) ?? null) : null;
          const submitterEmail = ownerId ? (profileEmailById.get(ownerId) ?? null) : null;
          const courseLabel = r.course_id ? (courseName.get(r.course_id) ?? null) : null;
          // Mostramos el estudiante junto al curso en el subtítulo (visible
          // sin expandir). Formato: "Curso · 👤 Estudiante".
          const subtitle = submitterName
            ? courseLabel
              ? `${courseLabel} · ${submitterName}`
              : submitterName
            : courseLabel;
          return {
            id: r.id,
            source: "grading" as const,
            kind: r.kind,
            status: r.status as Status,
            attempts: r.attempts ?? 0,
            created_at: r.created_at,
            started_at: r.started_at ?? null,
            completed_at: r.completed_at,
            last_error: r.last_error,
            course_id: r.course_id,
            created_by: r.created_by,
            label,
            subtitle,
            courseLabel,
            rejection_reason: r.rejection_reason,
            rejected_by: r.rejected_by,
            rejectedByName: r.rejected_by
              ? (profileNameById.get(r.rejected_by) ?? null)
              : null,
            rejected_at: r.rejected_at,
            acknowledged_at: r.acknowledged_at,
            target_table: r.target_table,
            target_row_id: r.target_row_id,
            submitterName,
            submitterEmail,
            enqueuedByName: r.created_by ? (profileNameById.get(r.created_by) ?? null) : null,
            enqueuedByEmail: r.created_by ? (profileEmailById.get(r.created_by) ?? null) : null,
          };
        }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...genRaw.map((r: any) => {
          let label = GENERATION_KIND_LABELS[r.kind] ?? r.kind;
          const sourceTitle = titleById.get(r.source_id);
          if (sourceTitle) label = sourceTitle;
          // En generación, "Enviado por" == el solicitante (created_by);
          // no hay "dueño de entrega" distinto.
          const requesterName = r.created_by ? (profileNameById.get(r.created_by) ?? null) : null;
          const requesterEmail = r.created_by
            ? (profileEmailById.get(r.created_by) ?? null)
            : null;
          const courseLabel = r.course_id ? (courseName.get(r.course_id) ?? null) : null;
          const subtitle = requesterName
            ? courseLabel
              ? `${courseLabel} · ${requesterName}`
              : requesterName
            : courseLabel;
          return {
            id: r.id,
            source: "generation" as const,
            kind: r.kind,
            status: r.status as Status,
            attempts: r.attempts ?? 0,
            created_at: r.created_at,
            started_at: r.started_at ?? null,
            completed_at: r.completed_at,
            last_error: r.last_error,
            course_id: r.course_id,
            created_by: r.created_by,
            label,
            subtitle,
            courseLabel,
            body: r.body ?? null,
            submitterName: requesterName,
            submitterEmail: requesterEmail,
            enqueuedByName: requesterName,
            enqueuedByEmail: requesterEmail,
          };
        }),
      ];

      // Sort por created_at desc (más recientes arriba — ambas fuentes
      // mezcladas).
      unified.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      setJobs(unified);
    } catch (e) {
      setLoadError(friendlyError(e, t("hc_modulesAiUnifiedAiQueuePanel.errLoadQueue")));
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

  // Reloj en vivo para la edad "en proceso". Solo tickea (cada 20s) cuando
  // hay jobs en proceso; si no, queda quieto para no re-renderizar.
  useEffect(() => {
    setNowMs(Date.now());
    const hasProcessing = jobs.some((j) => j.status === "processing");
    if (!hasProcessing) return;
    const id = setInterval(() => setNowMs(Date.now()), 20_000);
    return () => clearInterval(id);
  }, [jobs]);

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
    // Búsqueda libre: matchea contra título, curso, estudiante/solicitante,
    // tipo, estado e identificadores (id del job + target). Case-insensitive.
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((j) =>
        [
          j.label,
          j.subtitle,
          j.courseLabel,
          j.submitterName,
          j.submitterEmail,
          j.enqueuedByName,
          j.enqueuedByEmail,
          j.kind,
          j.status,
          j.source,
          j.id,
          j.target_table,
          j.target_row_id,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(q),
      );
    }
    return out;
  }, [jobs, sourceFilter, statusFilter, search]);

  // Multi-select: solo jobs cancelables (pending/processing/failed).
  const selectableJobs = useMemo(
    () =>
      filteredJobs.filter(
        (j) => j.status === "pending" || j.status === "processing" || j.status === "failed",
      ),
    [filteredJobs],
  );
  const multi = useMultiSelect(selectableJobs);
  // bulkOpen → dialog de ELIMINAR (borrado físico). El re-encolado ("Volver a
  // la cola") no abre dialog: usa un confirm liviano porque no es destructivo.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [requeuing, setRequeuing] = useState(false);
  const [releasing, setReleasing] = useState(false);
  // Reloj para la edad "en proceso" en vivo. Init determinístico a 0 (regla
  // de hidratación) → se setea post-mount y solo tickea si hay jobs en
  // proceso, para no re-renderizar el panel sin necesidad.
  const [nowMs, setNowMs] = useState(0);
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
      title: t("hc_modulesAiUnifiedAiQueuePanel.cancelConfirmTitle"),
      description: isProcessingNow
        ? t("hc_modulesAiUnifiedAiQueuePanel.cancelConfirmDescProcessing", { label: job.label })
        : t("hc_modulesAiUnifiedAiQueuePanel.cancelConfirmDescPending", { label: job.label }),
      tone: "destructive",
      confirmLabel: t("hc_modulesAiUnifiedAiQueuePanel.cancelConfirmLabel"),
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
      toast.success(
        i18n.t("toast.modules_ai_UnifiedAiQueuePanel.jobCancelled", {
          defaultValue: "Job cancelado",
        }),
      );
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
      toast.error(friendlyError(e, t("hc_modulesAiUnifiedAiQueuePanel.errCancelJob")));
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
      toast.success(
        i18n.t("toast.modules_ai_UnifiedAiQueuePanel.jobRequeued", {
          defaultValue: "Job re-encolado",
        }),
      );
      await load();
    } catch (e) {
      toast.error(friendlyError(e, t("hc_modulesAiUnifiedAiQueuePanel.errRequeue")));
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
          i18n.t("toast.modules_ai_UnifiedAiQueuePanel.asyncModeActivateCode", {
            defaultValue:
              "La cola está en modo async. Activá un código de IA inmediata para procesar jobs al instante.",
          }),
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
        toast.error(detail || t("hc_modulesAiUnifiedAiQueuePanel.errProcessJob"));
        return;
      }
      if (d?.processed === 0) {
        toast.info(
          i18n.t("toast.modules_ai_UnifiedAiQueuePanel.jobNoLongerPending", {
            defaultValue:
              "El job ya no estaba pending — quizás el worker lo levantó primero.",
          }),
        );
      } else if (d?.failed > 0) {
        toast.error(
          i18n.t("toast.modules_ai_UnifiedAiQueuePanel.jobProcessedButFailed", {
            defaultValue: "El job se procesó pero falló — revisá el error en la cola.",
          }),
        );
      } else {
        toast.success(
          i18n.t("toast.modules_ai_UnifiedAiQueuePanel.jobProcessed", {
            defaultValue: "Job procesado",
          }),
        );
      }
      await load();
    } catch (e) {
      toast.error(friendlyError(e, t("hc_modulesAiUnifiedAiQueuePanel.errProcessJob")));
    } finally {
      setProcessing((p) => {
        const n = new Set(p);
        n.delete(job.id);
        return n;
      });
    }
  };

  // Drain mode (Admin only) — invoca AMBOS workers sin jobId.
  //
  // Cada invocación del worker de calificación procesa UNO A UNO dentro de su
  // presupuesto de tiempo y para al primer fallo (los no procesados siguen
  // 'pending'). Si tras una pasada QUEDAN pendientes, re-invocamos el worker
  // automáticamente hasta DRAIN_MAX_RETRIES veces más: cada nueva pasada salta
  // el job que ya falló (ahora 'failed', fuera de 'pending') y sigue con el
  // resto, así que progresa. Solo si tras agotar los reintentos AÚN quedan
  // pendientes mostramos el mensaje de "vuelve a ejecutar manualmente".
  // Guard de no-progreso: si una pasada no reduce los pendientes (worker no
  // pudo reclamar nada), cortamos antes de gastar los reintentos restantes.
  const DRAIN_MAX_RETRIES = 3;
  const drainAll = async () => {
    if (draining) return;
    setDraining(true);
    try {
      let procTotal = 0;
      let failTotal = 0;
      let remaining = 0;
      let prevRemaining = Number.POSITIVE_INFINITY;
      let attempt = 0; // 0 = pasada inicial; 1..3 = reintentos automáticos
      let noProgress = false;
      // Bucle: pasada inicial + hasta DRAIN_MAX_RETRIES reintentos.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const [gradingRes, genRes] = await Promise.all([
          supabase.functions.invoke("ai-grading-worker", { body: {} }),
          supabase.functions.invoke("ai-generation-worker", { body: {} }),
        ]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = gradingRes.data as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const gn = genRes.data as any;
        procTotal += (g?.processed ?? 0) + (gn?.processed ?? 0);
        // Cada pasada reporta fallos DISTINTOS (un job 'failed' ya no se
        // re-reclama), así que acumular no doble-cuenta.
        failTotal += (g?.failed ?? 0) + (gn?.failed ?? 0);
        remaining = g?.remainingPending ?? 0;

        if (remaining === 0) break; // todo procesado
        if (attempt >= DRAIN_MAX_RETRIES) break; // agotó reintentos
        if (remaining >= prevRemaining) {
          // La pasada no redujo pendientes → reintentar no ayudará.
          noProgress = true;
          break;
        }
        prevRemaining = remaining;
        attempt++;
        // Pausa breve entre reintentos (no martillar el gateway).
        await new Promise((r) => setTimeout(r, 2000));
      }

      const failPart =
        failTotal > 0
          ? i18n.t("toast.modules_ai_UnifiedAiQueuePanel.drainFailPart", {
              defaultValue: " ({{failed}} con error, quedan listos para reintentar)",
              failed: failTotal,
            })
          : "";

      if (remaining > 0) {
        // Agotó los reintentos automáticos (o no hubo progreso) y aún quedan
        // pendientes → ahora SÍ pedir ejecución manual.
        toast.warning(
          i18n.t("toast.modules_ai_UnifiedAiQueuePanel.drainExhausted", {
            defaultValue:
              "Procesados {{n}}{{failPart}}. Tras {{retries}} reintentos aún quedan {{remaining}} pendientes. Espera unos minutos y vuelve a pulsar «Procesar todos» manualmente.",
            n: procTotal,
            remaining,
            retries: attempt,
            failPart,
            noProgress,
          }),
          { duration: 13000 },
        );
      } else {
        toast.success(
          i18n.t("toast.modules_ai_UnifiedAiQueuePanel.drainDone", {
            defaultValue: "Listo: procesados {{n}}{{failPart}}. No quedan jobs pendientes.",
            n: procTotal,
            failPart,
          }),
        );
      }
      await load();
    } catch (e) {
      toast.error(friendlyError(e, t("hc_modulesAiUnifiedAiQueuePanel.errDrainQueue")));
    } finally {
      setDraining(false);
    }
  };

  // "Liberar atascados": un clic global (Admin/SA) que devuelve a la cola los
  // jobs colgados en 'processing' por más del umbral. Atajo del "Volver a la
  // cola" cuando NO se quiere seleccionar uno a uno. La autorización vive en
  // el RPC admin_release_stuck_ai_jobs (es global/cross-tenant).
  const releaseStuck = async () => {
    if (releasing) return;
    setReleasing(true);
    try {
      const { data, error } = await db.rpc("admin_release_stuck_ai_jobs", {
        _threshold_minutes: STUCK_PROCESSING_MIN,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      const toPending = row?.released_to_pending ?? 0;
      const toFailed = row?.released_to_failed ?? 0;
      if (toPending === 0 && toFailed === 0) {
        toast.info(
          i18n.t("toast.modules_ai_UnifiedAiQueuePanel.releaseNone", {
            defaultValue: "No había jobs atascados para liberar.",
          }),
        );
      } else {
        toast.success(
          i18n.t("toast.modules_ai_UnifiedAiQueuePanel.released", {
            defaultValue:
              "{{pending}} job(s) devuelto(s) a la cola{{failedPart}}. Espera unos minutos o pulsa «Procesar todos».",
            pending: toPending,
            failedPart:
              toFailed > 0
                ? i18n.t("toast.modules_ai_UnifiedAiQueuePanel.releasedFailedPart", {
                    defaultValue: " · {{n}} marcados como fallidos (agotaron reintentos)",
                    n: toFailed,
                  })
                : "",
          }),
          { duration: 9000 },
        );
      }
      await load();
    } catch (e) {
      toast.error(friendlyError(e, t("unifiedAiQueue.releaseError", { defaultValue: "No se pudieron liberar los jobs atascados" })));
    } finally {
      setReleasing(false);
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
      toast.error(
        i18n.t("toast.modules_ai_UnifiedAiQueuePanel.reasonRequired", {
          defaultValue: "La razón es obligatoria (mínimo 5 caracteres).",
        }),
      );
      return;
    }
    setRejecting(true);
    try {
      const { error } = await db.rpc("reject_ai_grading_job", {
        _job_id: rejectTarget.id,
        _reason: rejectReason.trim(),
      });
      if (error) throw error;
      toast.success(
        i18n.t("toast.modules_ai_UnifiedAiQueuePanel.jobRejected", {
          defaultValue: "Job rechazado. El docente recibió la notificación.",
        }),
      );
      setRejectTarget(null);
      await load();
    } catch (e) {
      toast.error(friendlyError(e, t("hc_modulesAiUnifiedAiQueuePanel.errRejectJob")));
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
      toast.success(
        i18n.t("toast.modules_ai_UnifiedAiQueuePanel.rejectionClosed", {
          defaultValue: "Rechazo cerrado. El job se movió al historial.",
        }),
      );
      await load();
    } catch (e) {
      toast.error(friendlyError(e, t("hc_modulesAiUnifiedAiQueuePanel.errCloseRejection")));
    }
  };

  // Bulk cancel — usa el dispatch correcto por source.
  // "Volver a la cola": devuelve los jobs seleccionados a 'pending' para que el
  // worker los reintente. NO los borra. Los que ya están 'pending' se omiten
  // (ya están en cola). Usa un confirm liviano (no destructivo) en vez de
  // dialog con lista. Sirve sobre todo para rescatar jobs atascados en proceso.
  const bulkRequeue = async () => {
    if (requeuing) return;
    const targets = jobs.filter(
      (j) => multi.isSelected(j.id) && j.status !== "pending",
    );
    const alreadyQueued = multi.count - targets.length;
    if (targets.length === 0) {
      toast.info(
        i18n.t("toast.modules_ai_UnifiedAiQueuePanel.requeueNoneNeeded", {
          defaultValue: "Los jobs seleccionados ya están en la cola.",
        }),
      );
      return;
    }
    const ok = await confirm({
      title: t("unifiedAiQueue.bulkRequeueTitle", {
        defaultValue: "Volver a la cola",
      }),
      description: t("unifiedAiQueue.bulkRequeueDesc", {
        defaultValue:
          "Se devolverán {{count}} job(s) a la cola como pendientes para que la IA los reintente. No se borra nada.",
        count: targets.length,
      }),
      tone: "warning",
      confirmLabel: t("unifiedAiQueue.bulkRequeueConfirm", {
        defaultValue: "Volver a la cola",
      }),
    });
    if (!ok) return;
    setRequeuing(true);
    try {
      const results = await Promise.allSettled(
        targets.map((j) => {
          if (j.source === "grading") {
            return db.rpc("requeue_ai_grading_job", { _job_id: j.id });
          }
          return db
            .from("ai_generation_queue")
            .update({
              status: "pending",
              started_at: null,
              completed_at: null,
              last_error: null,
            })
            .eq("id", j.id);
        }),
      );
      const failures = results
        .map((r, i) => ({ r, j: targets[i] }))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter(({ r }) => r.status === "rejected" || (r.status === "fulfilled" && (r.value as any)?.error));
      const okCount = targets.length - failures.length;
      if (failures.length > 0) {
        const first = failures[0];
        const err =
          first.r.status === "rejected"
            ? first.r.reason
            : // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (first.r.value as any)?.error;
        toast.error(
          i18n.t("toast.modules_ai_UnifiedAiQueuePanel.bulkRequeuePartial", {
            defaultValue:
              "{{ok}} devuelto(s) a la cola, {{failed}} con error. Primero: «{{label}}» — {{reason}}",
            ok: okCount,
            failed: failures.length,
            label: first.j?.label ?? "",
            reason: friendlyError(err),
          }),
          { duration: 12000 },
        );
      } else {
        toast.success(
          i18n.t("toast.modules_ai_UnifiedAiQueuePanel.bulkRequeued", {
            defaultValue:
              "{{count}} job(s) devuelto(s) a la cola{{skipped}}. Espera unos minutos a que la IA los procese o pulsa «Procesar todos».",
            count: okCount,
            skipped:
              alreadyQueued > 0
                ? i18n.t("toast.modules_ai_UnifiedAiQueuePanel.requeueSkippedSuffix", {
                    defaultValue: " ({{n}} ya estaban en cola)",
                    n: alreadyQueued,
                  })
                : "",
          }),
          { duration: 9000 },
        );
      }
      multi.clear();
      await load();
    } finally {
      setRequeuing(false);
    }
  };

  // "Eliminar": borra FÍSICAMENTE las filas de la cola (acción destructiva).
  const bulkDelete = async (ids: string[]) => {
    const targets = jobs.filter((j) => ids.includes(j.id));
    const results = await Promise.allSettled(
      targets.map((j) => {
        if (j.source === "grading") {
          return db.rpc("delete_ai_grading_job", { _job_id: j.id });
        }
        return db.from("ai_generation_queue").delete().eq("id", j.id);
      }),
    );
    const failures = results
      .map((r, i) => ({ r, j: targets[i] }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter(({ r }) => r.status === "rejected" || (r.status === "fulfilled" && (r.value as any)?.error));
    if (failures.length > 0) {
      const first = failures[0];
      const err =
        first.r.status === "rejected"
          ? first.r.reason
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (first.r.value as any)?.error;
      throw new Error(
        i18n.t("toast.modules_ai_UnifiedAiQueuePanel.bulkDeletePartial", {
          defaultValue:
            "{{ok}} eliminado(s), {{failed}} con error. Primero: «{{label}}» — {{reason}}",
          ok: targets.length - failures.length,
          failed: failures.length,
          label: first.j?.label ?? "",
          reason: friendlyError(err),
        }),
      );
    }
    toast.success(
      i18n.t("toast.modules_ai_UnifiedAiQueuePanel.bulkDeleted", {
        defaultValue: "{{count}} job(s) eliminado(s)",
        count: ids.length,
      }),
    );
    multi.clear();
    await load();
  };

  return (
    <div className="space-y-4">
      {draining && (
        <LoadingOverlay
          title={t("unifiedAiQueue.drainingTitle")}
          subtitle={t("unifiedAiQueue.drainingSubtitle")}
        />
      )}
      {/* Stats 4-card — suman AMBAS colas. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Clock}
          label={t("unifiedAiQueue.statPending")}
          value={counts.pending + counts.failed}
          tone={counts.failed > 0 ? "warning" : "default"}
        />
        <StatCard icon={Cpu} label={t("unifiedAiQueue.statProcessing")} value={counts.processing} />
        <StatCard
          icon={AlertTriangle}
          label={t("unifiedAiQueue.statFailed")}
          value={counts.failed}
          tone={counts.failed > 0 ? "destructive" : "default"}
        />
        <StatCard
          icon={CheckCircle2}
          label={t("unifiedAiQueue.statDone")}
          value={counts.done}
          tone={counts.done > 0 ? "success" : "default"}
        />
      </div>

      {/* IA inmediata (override) — docente. */}
      {!isAdmin && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-amber-50/40 dark:bg-amber-500/5 border-amber-300/40 dark:border-amber-500/20 px-3 py-2">
          <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
          <p className="text-xs text-muted-foreground flex-1 min-w-[200px]">
            {t("unifiedAiQueue.overrideBannerText")}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-8 shrink-0"
            onClick={() => setOverrideOpen(true)}
          >
            <Sparkles className="h-3.5 w-3.5 mr-1" />
            {t("unifiedAiQueue.btnActivateAi")}
          </Button>
        </div>
      )}

      {/* Bulk toolbar: "Volver a la cola" (re-encolar, no destructivo) +
          "Eliminar" (borrado físico, destructivo). */}
      <MultiSelectToolbar
        count={multi.count}
        onClear={multi.clear}
        onDelete={() => setBulkOpen(true)}
        entityNameSingular="job"
        entityNamePlural="jobs"
        actionLabel={t("unifiedAiQueue.actionDelete", { defaultValue: "Eliminar" })}
        actionIcon={Trash2}
        extraActions={[
          {
            key: "requeue",
            label: t("unifiedAiQueue.actionRequeue", { defaultValue: "Volver a la cola" }),
            icon: RotateCcw,
            onClick: () => void bulkRequeue(),
          },
        ]}
      />

      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between gap-3 space-y-0 flex-wrap">
          <div className="flex items-center gap-2">
            {selectableJobs.length > 0 && <MultiSelectHeaderCheckbox state={multi} />}
            <CardTitle className="text-base">{t("unifiedAiQueue.cardTitle")}</CardTitle>
            <Badge variant="secondary" className="text-[10px]">
              {filteredJobs.length}
            </Badge>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Buscador de la cola: filtra por título, curso, estudiante,
                tipo, estado e id (job/target). Mismo patrón visual que
                ListFilters (ícono lupa + Input pl-8), tamaño compacto h-8
                para alinear con los Selects del toolbar. */}
            <div className="relative min-w-[180px] sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("unifiedAiQueue.searchPlaceholder")}
                className="h-8 pl-8 pr-8 text-xs"
                aria-label={t("unifiedAiQueue.searchPlaceholder")}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={t("unifiedAiQueue.clearSearch")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {isSuperAdminCaller && tenants.length > 0 && (
              <Select value={tenantFilter} onValueChange={setTenantFilter}>
                <SelectTrigger className="h-8 w-48 text-xs">
                  <SelectValue placeholder={t("unifiedAiQueue.tenantPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("unifiedAiQueue.allTenants")}</SelectItem>
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
                <SelectItem value="all">{t("unifiedAiQueue.filterAllTypes")}</SelectItem>
                <SelectItem value="grading">{t("unifiedAiQueue.filterGrading")}</SelectItem>
                <SelectItem value="generation">{t("unifiedAiQueue.filterGeneration")}</SelectItem>
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
                <SelectItem value="active">{t("unifiedAiQueue.filterActive")}</SelectItem>
                <SelectItem value="pending">{t("unifiedAiQueue.filterPending")}</SelectItem>
                <SelectItem value="processing">{t("unifiedAiQueue.filterProcessing")}</SelectItem>
                <SelectItem value="failed">{t("unifiedAiQueue.filterFailed")}</SelectItem>
                <SelectItem value="done">{t("unifiedAiQueue.filterDone")}</SelectItem>
                <SelectItem value="cancelled">{t("unifiedAiQueue.filterCancelled")}</SelectItem>
                <SelectItem value="all">{t("unifiedAiQueue.filterAll")}</SelectItem>
              </SelectContent>
            </Select>
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => void drainAll()}
                disabled={draining}
                title={t("hc_modulesAiUnifiedAiQueuePanel.drainAllTooltip")}
              >
                {draining ? (
                  <Spinner size="xs" className="mr-1" />
                ) : (
                  <Zap className="h-3.5 w-3.5 mr-1" />
                )}
                {t("unifiedAiQueue.btnProcessAll")}
              </Button>
            )}
            {isAdmin && counts.processing > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => void releaseStuck()}
                disabled={releasing}
                title={t("unifiedAiQueue.releaseStuckTooltip", {
                  defaultValue:
                    "Devuelve a la cola los jobs colgados en proceso por más de unos minutos.",
                })}
              >
                {releasing ? (
                  <Spinner size="xs" className="mr-1" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                )}
                {t("unifiedAiQueue.btnReleaseStuck", { defaultValue: "Liberar atascados" })}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setRetryNonce((n) => n + 1)}
              title={t("hc_modulesAiUnifiedAiQueuePanel.refreshTooltip")}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
              <Spinner size="sm" /> {t("unifiedAiQueue.loading")}
            </div>
          ) : loadError ? (
            <ErrorState
              message={t("unifiedAiQueue.loadError")}
              hint={loadError}
              onRetry={() => setRetryNonce((n) => n + 1)}
            />
          ) : filteredJobs.length === 0 ? (
            <TableEmpty
              icon={Wand2}
              title={t("unifiedAiQueue.emptyTitle")}
              description={
                statusFilter === "active"
                  ? t("unifiedAiQueue.emptyActiveDesc")
                  : t("unifiedAiQueue.emptyFilterDesc")
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
                const procMins =
                  j.status === "processing"
                    ? processingAgeMin(j.started_at, nowMs)
                    : null;
                const procStuck = procMins !== null && procMins >= STUCK_PROCESSING_MIN;
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
                        title={expanded ? t("unifiedAiQueue.hideDetail") : t("unifiedAiQueue.viewDetail")}
                        aria-expanded={expanded}
                        aria-label={expanded ? t("unifiedAiQueue.hideDetailAria") : t("unifiedAiQueue.viewDetailAria")}
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
                              {t("unifiedAiQueue.sourceGrading")}
                            </>
                          ) : (
                            <>
                              <Wand2 className="h-3 w-3 mr-0.5" />
                              {t("unifiedAiQueue.sourceGeneration")}
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
                            {/* Edad "en proceso" en vivo — herramienta de
                                seguimiento de atascos. Ámbar/destructive
                                cuando supera el umbral (probable atasco). */}
                            {procMins !== null && (
                              <Badge
                                variant={procStuck ? "destructive" : "secondary"}
                                className="text-[10px] shrink-0 gap-0.5"
                                title={
                                  procStuck
                                    ? t("unifiedAiQueue.processingStuckHint", {
                                        defaultValue:
                                          "Lleva mucho en proceso — probable atasco. Selecciónalo y usa «Volver a la cola».",
                                      })
                                    : undefined
                                }
                              >
                                <Clock className="h-3 w-3" />
                                {procStuck
                                  ? t("unifiedAiQueue.processingStuck", {
                                      defaultValue: "atascado {{mins}}m",
                                      mins: procMins,
                                    })
                                  : t("unifiedAiQueue.processingFor", {
                                      defaultValue: "en proceso {{mins}}m",
                                      mins: procMins,
                                    })}
                              </Badge>
                            )}
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
                            title={j.status === "cancelled" ? t("unifiedAiQueue.requeue") : t("unifiedAiQueue.retry")}
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
                            title={t("unifiedAiQueue.processNow")}
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
                              title={t("unifiedAiQueue.rejectWithReason")}
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
                                ? t("unifiedAiQueue.cancelInFlight")
                                : t("unifiedAiQueue.actionCancel")
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
                            title={t("unifiedAiQueue.closeConversation")}
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
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1">
                            <div>
                              <span className="text-muted-foreground">ID:</span>{" "}
                              <code className="font-mono text-[10px]">{j.id.slice(0, 8)}…</code>
                            </div>
                            <div>
                              <span className="text-muted-foreground">{t("unifiedAiQueue.detailType")}:</span>{" "}
                              <span>{kindLabelFor(j)}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">{t("unifiedAiQueue.detailStatus")}:</span>{" "}
                              <span>{STATUS_LABELS[j.status]}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">{t("unifiedAiQueue.detailAttempts")}:</span>{" "}
                              <span className="tabular-nums">{j.attempts}</span>
                            </div>
                            {j.courseLabel && (
                              <div className="col-span-2">
                                <span className="text-muted-foreground">{t("unifiedAiQueue.detailCourse")}:</span>{" "}
                                <span>{j.courseLabel}</span>
                              </div>
                            )}
                            <div>
                              <span className="text-muted-foreground">{t("unifiedAiQueue.detailCreated")}:</span>{" "}
                              <span className="tabular-nums">{formatDateTime(j.created_at)}</span>
                            </div>
                            {j.completed_at && (
                              <div>
                                <span className="text-muted-foreground">{t("unifiedAiQueue.detailFinished")}:</span>{" "}
                                <span className="tabular-nums">
                                  {formatDateTime(j.completed_at)}
                                </span>
                              </div>
                            )}
                            {/* "Enviado por": dueño de la entrega (grading) o
                                solicitante (generación) con nombre + email. */}
                            {j.submitterName && (
                              <div className="col-span-2">
                                <span className="text-muted-foreground">
                                  {t("unifiedAiQueue.detailSubmitter")}:
                                </span>{" "}
                                <span>
                                  {j.submitterName}
                                  {j.submitterEmail ? ` (${j.submitterEmail})` : ""}
                                </span>
                              </div>
                            )}
                            {/* "Encolado por": SOLO si difiere del submitter
                                (ej. docente recalifica la entrega de un
                                alumno). En generación coincide → no se muestra
                                redundante. */}
                            {j.enqueuedByName &&
                              j.enqueuedByName !== j.submitterName && (
                                <div className="col-span-2">
                                  <span className="text-muted-foreground">
                                    {t("unifiedAiQueue.detailEnqueuedBy")}:
                                  </span>{" "}
                                  <span>
                                    {j.enqueuedByName}
                                    {j.enqueuedByEmail ? ` (${j.enqueuedByEmail})` : ""}
                                  </span>
                                </div>
                              )}
                            {j.source === "grading" && j.target_table && (
                              <div className="col-span-2">
                                <span className="text-muted-foreground">{t("unifiedAiQueue.detailTarget")}:</span>{" "}
                                <code className="font-mono text-[10px]">
                                  {j.target_table}/{j.target_row_id?.slice(0, 8)}…
                                </code>
                              </div>
                            )}
                            {/* Datos de rechazo en el detalle — para quien
                                gestiona la cola (Admin/SA) que ve jobs ajenos.
                                El dueño del job ya tiene el bloque interactivo
                                naranja abajo (con "Cerrar conversación"). */}
                            {j.status === "rejected" && !isMyRejection && (
                              <>
                                <div className="col-span-2">
                                  <span className="text-muted-foreground">
                                    {t("unifiedAiQueue.detailRejectedBy")}:
                                  </span>{" "}
                                  <span>
                                    {j.rejectedByName ?? "—"}
                                    {j.rejected_at ? ` · ${formatDateTime(j.rejected_at)}` : ""}
                                  </span>
                                </div>
                                <div className="col-span-2">
                                  <span className="text-muted-foreground">
                                    {t("unifiedAiQueue.detailRejectionReason")}:
                                  </span>{" "}
                                  <span className="whitespace-pre-wrap break-words">
                                    {j.rejection_reason ?? t("unifiedAiQueue.noReason")}
                                  </span>
                                </div>
                              </>
                            )}
                          </div>
                          {j.source === "generation" && j.body && (
                            <div>
                              <div className="text-muted-foreground mb-0.5">{t("unifiedAiQueue.detailBody")}:</div>
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
                                {t("unifiedAiQueue.detailLastError")}
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
                                  .then(() =>
                                    toast.success(
                                      i18n.t(
                                        "toast.modules_ai_UnifiedAiQueuePanel.errorCopied",
                                        { defaultValue: "Error copiado" },
                                      ),
                                    ),
                                  )
                                  .catch(() =>
                                    toast.error(
                                      i18n.t(
                                        "toast.modules_ai_UnifiedAiQueuePanel.copyFailed",
                                        { defaultValue: "No se pudo copiar" },
                                      ),
                                    ),
                                  );
                              }}
                              className="shrink-0 text-[10px] text-destructive/80 hover:text-destructive flex items-center gap-0.5"
                              title={t("unifiedAiQueue.copyError")}
                            >
                              <Copy className="h-3 w-3" /> {t("unifiedAiQueue.btnCopy")}
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
                          title={t("unifiedAiQueue.clickToExpand")}
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
                                {t("unifiedAiQueue.rejectionTitle")}
                              </p>
                              <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
                                {j.rejection_reason ?? t("unifiedAiQueue.noReason")}
                              </p>
                              {j.rejected_at && (
                                <p className="text-[10px] text-muted-foreground">
                                  {t("unifiedAiQueue.rejectedAt", { datetime: formatDateTime(j.rejected_at) })}
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
                            {t("unifiedAiQueue.closeConversation")}
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
        actionLabel={t("unifiedAiQueue.actionDelete", { defaultValue: "Eliminar" })}
        actionIcon={Trash2}
        dismissLabel={t("unifiedAiQueue.btnBack")}
        extraWarning={t("unifiedAiQueue.bulkDeleteWarning", {
          defaultValue:
            "Se eliminarán permanentemente los jobs seleccionados de la cola. Si querías reintentarlos, usa «Volver a la cola» en su lugar.",
        })}
        onConfirm={bulkDelete}
      />

      {/* Override IA — docente. */}
      <AiOverrideDialog open={overrideOpen} onOpenChange={setOverrideOpen} />

      {/* Reject con razón — Admin/SA + grading. */}
      <Dialog open={!!rejectTarget} onOpenChange={(o) => !o && setRejectTarget(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{t("unifiedAiQueue.rejectDialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("unifiedAiQueue.rejectDialogDesc")}
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="reject-reason" required>
                {t("unifiedAiQueue.rejectReasonLabel")}
              </Label>
              <Textarea
                id="reject-reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={4}
                placeholder={t("unifiedAiQueue.rejectReasonPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectTarget(null)}>
              {t("unifiedAiQueue.actionCancel")}
            </Button>
            <Button onClick={() => void confirmReject()} disabled={rejecting}>
              {rejecting && <Spinner size="sm" className="mr-2" />}
              {t("unifiedAiQueue.btnReject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
