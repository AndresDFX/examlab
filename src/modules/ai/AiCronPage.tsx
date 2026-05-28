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
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
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
import { AdminAiGradingPanel } from "@/modules/admin/AdminAiGradingPanel";
import { logEvent } from "@/shared/lib/audit";
import { AiOverrideDialog } from "@/modules/ai/AiOverrideDialog";
import { readOverrideExpiry, getProcessingMode } from "@/modules/ai/ai-grading";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Clock,
  Cpu,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  X,
  Zap,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  CalendarClock,
  Sliders,
  Sparkles,
  ListOrdered,
  Ban,
  MessageSquareWarning,
  CheckCheck,
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
  /** SuperAdmin muestra la tab "Tareas programadas" (pg_cron). Es
   *  gestión de infraestructura — el Admin de un tenant no tiene
   *  business viéndola. */
  showInfraTab?: boolean;
}

type Status = "pending" | "processing" | "failed" | "done" | "cancelled" | "rejected";

interface Counts {
  pending: number;
  processing: number;
  /** TODOS los jobs en estado `failed` (sin ventana de tiempo). Un job
   *  fallado sigue en la cola hasta que se reintenta o cancela, así que
   *  el contador debe reflejar exactamente lo que muestra la lista —
   *  antes una ventana de 24h dejaba fallos viejos "invisibles" en los
   *  contadores aunque seguían listados. */
  failed: number;
  lastDoneAt: string | null;
}

interface QueueJob {
  id: string;
  kind: string;
  status: Status;
  target_table: string;
  target_row_id: string;
  course_id: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
  attempts: number | null;
  last_error: string | null;
  // Rechazo con razón (Admin/SuperAdmin) — mig 20260705000000.
  rejection_reason: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  /** Set cuando el docente (created_by) acusa recibo del rechazo. Hasta
   *  que esté seteado, el job aparece pendiente para el docente. */
  acknowledged_at: string | null;
  // Resolución best-effort
  examTitle?: string;
  projectTitle?: string;
  workshopTitle?: string;
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
  rejected: "Rechazados",
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
 * Wrapper exportado. PageHeader + Tabs (IA / Tareas programadas). Solo
 * Admin ve la tab "Tareas programadas" — Docente solo gestiona la cola
 * IA y no debería ver jobs de infraestructura. Para Docente renderizamos
 * sin Tabs para no mostrar un control de un único tab (mala UX).
 *
 * NOTA: el módulo se llama "Cola" en UI; el `module_key` interno sigue
 * siendo `ai_cron` por compat (bookmarks, module_visibility, RBAC). No
 * "limpiar" la key sin migración.
 */
export function AiCronPage({ isAdmin = false, showInfraTab = false }: Props) {
  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ListOrdered className="h-6 w-6 text-primary" />}
        title="Cola"
        subtitle={
          showInfraTab
            ? "Cola de calificación con IA y tareas programadas de infraestructura. Gestiona, pausa o reagenda lo que corre en segundo plano."
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
            {/* Configuración: sync/async + códigos override. Antes vivía
                en Admin → Configuración → 'Cola IA'. Centralizada acá
                porque toda la operativa de cola (procesamiento +
                configuración) queda en un solo módulo. */}
            <TabsTrigger value="config" className="gap-1.5">
              <Sliders className="h-3.5 w-3.5" />
              Configuración
            </TabsTrigger>
            {/* pg_cron solo SuperAdmin (infra cross-tenant). */}
            {showInfraTab && (
              <TabsTrigger value="supabase" className="gap-1.5">
                <CalendarClock className="h-3.5 w-3.5" />
                Tareas programadas
              </TabsTrigger>
            )}
          </TabsList>
          <TabsContent value="ia" className="space-y-4 mt-4">
            <AiQueuePanel isAdmin={isAdmin} />
          </TabsContent>
          <TabsContent value="config" className="space-y-4 mt-4">
            <AdminAiGradingPanel />
          </TabsContent>
          {showInfraTab && (
            <TabsContent value="supabase" className="space-y-4 mt-4">
              <SupabaseCronPanel />
            </TabsContent>
          )}
        </Tabs>
      ) : (
        <AiQueuePanel isAdmin={isAdmin} />
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [counts, setCounts] = useState<Counts>({
    pending: 0,
    processing: 0,
    failed: 0,
    lastDoneAt: null,
  });
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Filtro por estado. "active" = pending + processing + failed +
  // rechazos no acusados (default, útil para "qué hay corriendo / qué me
  // toca cerrar"). "history" = done + cancelled + rechazos acusados —
  // los jobs ya cerrados. "all" trae todo sin discriminar. Y cada
  // estado individual queda como filtro fino.
  const [statusFilter, setStatusFilter] = useState<"active" | "history" | Status | "all">("active");
  // Usuario actual — necesario para detectar "este rechazo es para mí"
  // y mostrar el banner inline al docente que originó el job. Admin
  // que rechazó NO necesita banner; ya sabe que rechazó.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  // SuperAdmin: filtro por institución. ai_grading_queue NO tiene
  // tenant_id propio (vive en course_id → courses.tenant_id). Lo
  // resolvemos en 2 pasos dentro de `load`: primero los course_ids del
  // tenant elegido, luego `.in('course_id', ids)` en cada count + en
  // la lista. Para Admin normal RLS acota; el Select no se renderiza.
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  // Solo true cuando actúa como SuperAdmin (no por solo tener el rol).
  // Ver comentario en app.admin.users.
  const isSuperAdminCaller = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);
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
  // Detalle expandido inline — necesario para Admin (sin acceso a
  // /app/teacher/monitor) y útil para Docente para no perder contexto.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [processingOne, setProcessingOne] = useState<Set<string>>(new Set());
  // Dialog para activar el código override de IA inmediata (pegar
  // código → ventana sincrónica corta). Se movió desde el dashboard
  // del docente para tenerlo junto al resto del flujo de IA.
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // Filtro tenant (SuperAdmin): resolvemos los course_ids del tenant
      // elegido UNA VEZ y los inyectamos en todos los count + list query.
      // Si el tenant no tiene cursos, devolvemos counts en cero sin
      // pegarle a ai_grading_queue (evita el comportamiento de PostgREST
      // donde `.in('col', [])` devuelve TODO).
      let courseIdsFilter: string[] | null = null;
      if (isSuperAdminCaller && tenantFilter !== "all") {
        const { data: courseRows } = await db
          .from("courses")
          .select("id")
          .eq("tenant_id", tenantFilter);
        courseIdsFilter = ((courseRows ?? []) as Array<{ id: string }>).map((r) => r.id);
        if (courseIdsFilter.length === 0) {
          setCounts({ pending: 0, processing: 0, failed: 0, lastDoneAt: null });
          setJobs([]);
          setLoading(false);
          return;
        }
      }
      // Helper: aplica `.in('course_id', ids)` cuando hay filter activo.
      // Centralizado para no repetir la condición en cada query.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const applyTenant = (q: any) => (courseIdsFilter ? q.in("course_id", courseIdsFilter) : q);

      // Counts agregados — corren en paralelo y siempre se refrescan.
      // `failed` cuenta TODOS los jobs en estado failed (sin ventana de
      // tiempo) para que el contador coincida con la lista — la lista
      // del filtro "active" muestra todos los failed sin importar la
      // antigüedad. Antes un `.gte(completed_at, -24h)` dejaba fallos
      // viejos fuera del contador pero visibles en la lista.
      const [{ count: pending }, { count: processing }, { count: failed }, { data: lastDone }] =
        await Promise.all([
          applyTenant(
            db
              .from("ai_grading_queue")
              .select("id", { count: "exact", head: true })
              .eq("status", "pending"),
          ),
          applyTenant(
            db
              .from("ai_grading_queue")
              .select("id", { count: "exact", head: true })
              .eq("status", "processing"),
          ),
          applyTenant(
            db
              .from("ai_grading_queue")
              .select("id", { count: "exact", head: true })
              .eq("status", "failed"),
          ),
          applyTenant(
            db
              .from("ai_grading_queue")
              .select("completed_at")
              .eq("status", "done")
              .order("completed_at", { ascending: false })
              .limit(1),
          ).maybeSingle(),
        ]);
      setCounts({
        pending: pending ?? 0,
        processing: processing ?? 0,
        failed: failed ?? 0,
        lastDoneAt: lastDone?.completed_at ?? null,
      });

      // Lista de jobs según filtro.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query: any = db
        .from("ai_grading_queue")
        .select(
          "id, kind, status, target_table, target_row_id, course_id, created_by, created_at, completed_at, attempts, last_error, rejection_reason, rejected_by, rejected_at, acknowledged_at",
        )
        .order("created_at", { ascending: false })
        .limit(PAGE_LIMIT);
      query = applyTenant(query);
      if (statusFilter === "active") {
        // Activo = pending/processing/failed + rechazos sin acusar. El
        // rechazo no acusado sigue "pendiente" desde la óptica del
        // docente — es una conversación abierta hasta que él cierre.
        query = query.or(
          "status.in.(pending,processing,failed),and(status.eq.rejected,acknowledged_at.is.null)",
        );
      } else if (statusFilter === "history") {
        // Historial = done/cancelled + rechazos ya acusados. El job
        // rejected acked es equivalente a "cerrado" — pertenece al
        // archivo, no a la cola activa.
        query = query.or(
          "status.in.(done,cancelled),and(status.eq.rejected,acknowledged_at.not.is.null)",
        );
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
      // Jobs de taller: "Pregunta de taller" apunta a
      // workshop_submission_answers (→ submission_id), "Taller" completo
      // apunta directo a workshop_submissions. Resolvemos ambos a
      // workshop + estudiante para que el Admin vea el origen del evento.
      const wsAnswerIds = baseJobs
        .filter((j) => j.target_table === "workshop_submission_answers")
        .map((j) => j.target_row_id);
      const directWsSubIds = baseJobs
        .filter((j) => j.target_table === "workshop_submissions")
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

      // answer.id → workshop_submission.id
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

      const projectSubmissionIds = Array.from(new Set(projectFileRows.map((r) => r.submission_id)));
      const allUserIds = new Set<string>();
      for (const s of submissionsRows) allUserIds.add(s.user_id);
      const examIdsForLookup = Array.from(new Set(submissionsRows.map((s) => s.exam_id)));

      // IDs de workshop_submissions a resolver: los directos + los
      // derivados de answers. Dedup.
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
        } else if (
          j.target_table === "workshop_submission_answers" ||
          j.target_table === "workshop_submissions"
        ) {
          // Pregunta de taller → answer → submission; Taller completo →
          // submission directo. Resolvemos workshop + estudiante.
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
      setLoadError(friendlyError(e, "No pudimos cargar la cola de IA."));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, isSuperAdminCaller, tenantFilter]);

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

  const cancelJob = async (jobId: string, label: string) => {
    if (cancelling.has(jobId)) return;
    // Si el job ya está siendo procesado, advertir que la llamada IA
    // ya está en vuelo: el costo de Gemini no se recupera, pero sí se
    // evita persistir el resultado al target_table. Para
    // pending/failed la cancelación es limpia (sin costo asociado).
    const isProcessingNow = jobs.find((j) => j.id === jobId)?.status === "processing";
    const ok = await confirm({
      title: `¿Cancelar este job de IA?`,
      description: isProcessingNow
        ? `"${label}" — el job ya está siendo procesado. La llamada IA está en vuelo (el costo ` +
          `no se recupera), pero el resultado NO se persistirá. Esta acción no se puede deshacer.`
        : `"${label}" — el job no se procesará. Si la entrega del estudiante necesita ` +
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
      void logEvent({
        action: "ai_grading.job_cancelled",
        category: "grading",
        severity: "warning",
        entityType: "ai_grading_queue",
        entityId: jobId,
        entityName: label,
        metadata: { source: "cron_module", was_processing: isProcessingNow },
      });
      await load();
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  /**
   * Rechazar job con razón (Admin/SuperAdmin). Distinto a Cancelar:
   * deja registro de la decisión + notifica al docente + el job queda
   * VISIBLE para el docente hasta que el docente acuse recibo.
   */
  const [rejectJobTarget, setRejectJobTarget] = useState<{ id: string; label: string } | null>(
    null,
  );
  const [rejectReason, setRejectReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const openReject = (jobId: string, label: string) => {
    setRejectReason("");
    setRejectJobTarget({ id: jobId, label });
  };
  const confirmReject = async () => {
    if (!rejectJobTarget) return;
    if (rejectReason.trim().length < 5) {
      toast.error("La razón es obligatoria (mínimo 5 caracteres).");
      return;
    }
    setRejecting(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("reject_ai_grading_job", {
        _job_id: rejectJobTarget.id,
        _reason: rejectReason.trim(),
      });
      if (error) {
        toast.error(friendlyError(error, "No se pudo rechazar el job"));
        return;
      }
      toast.success("Job rechazado. El docente recibió la notificación.");
      setRejectJobTarget(null);
      await load();
    } finally {
      setRejecting(false);
    }
  };

  /**
   * Acusar recibo de un rechazo (docente). Mueve el job al historial.
   */
  const acknowledgeReject = async (jobId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("acknowledge_rejected_ai_grading_job", {
      _job_id: jobId,
    });
    if (error) {
      toast.error(friendlyError(error, "No se pudo cerrar el rechazo"));
      return;
    }
    toast.success("Rechazo cerrado. El job se movió al historial.");
    await load();
  };

  const processOne = async (jobId: string) => {
    if (processingOne.has(jobId)) return;
    // Autorización: con la cola en modo async, procesar un job a mano
    // (bypass del cron) es justamente lo que el modo async busca evitar.
    // El docente necesita una ventana de "IA inmediata" activa — el
    // mismo código override que habilita la calificación sync. El admin
    // gestiona la cola y queda exento.
    if (!isAdmin) {
      const mode = await getProcessingMode();
      if (mode === "async" && !readOverrideExpiry()) {
        toast.info(
          "La cola está en modo async. Activa un código de IA inmediata para procesar jobs al instante.",
        );
        setOverrideDialogOpen(true);
        return;
      }
    }
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
      void logEvent({
        action: "ai_grading.job_processed_manual",
        category: "grading",
        severity: d?.failed > 0 ? "error" : "info",
        entityType: "ai_grading_queue",
        entityId: jobId,
        metadata: {
          source: "cron_module",
          succeeded: d?.succeeded ?? 0,
          failed: d?.failed ?? 0,
          processed: d?.processed ?? 0,
        },
      });
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
      void logEvent({
        action: "ai_grading.job_requeued",
        category: "grading",
        severity: "info",
        entityType: "ai_grading_queue",
        entityId: jobId,
        metadata: { source: "cron_module" },
      });
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
  // tiene sentido para jobs en estados `pending`, `failed` o
  // `processing` (done/cancelled no se cancelan). Para processing, la
  // llamada IA ya está en vuelo — cancelar evita persistir el resultado
  // al target_table pero el costo de Gemini ya está consumido. El hook
  // deduplica automáticamente — si filtramos solo IDs cancelables al
  // confirmar, el resto se ignora.
  const selectableJobs = useMemo(
    () =>
      jobs.filter(
        (j) => j.status === "pending" || j.status === "failed" || j.status === "processing",
      ),
    [jobs],
  );
  const multi = useMultiSelect(selectableJobs);
  const [bulkOpen, setBulkOpen] = useState(false);
  const selectedItems = useMemo(
    () =>
      selectableJobs
        .filter((j) => multi.isSelected(j.id))
        .map((j) => {
          const kindLabel = KIND_LABELS[j.kind] ?? j.kind;
          const label = j.examTitle ?? j.projectTitle ?? j.workshopTitle ?? kindLabel;
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
    void logEvent({
      action: "ai_grading.jobs_cancelled_bulk",
      category: "grading",
      severity: "warning",
      entityType: "ai_grading_queue",
      metadata: { count: ids.length, source: "cron_module" },
    });
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
            {/* Pendientes = pending + failed: un job fallado sigue SIN
                calificar, así que desde la óptica del alumno la nota
                sigue pendiente. Los failed se desglosan aparte en su
                propio contador. El botón "Procesar ahora" usa solo el
                pending real (no este total). */}
            <div className="text-2xl font-semibold tabular-nums mt-1">
              {counts.pending + counts.failed}
            </div>
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
              <AlertTriangle className="h-3 w-3" /> Fallados
            </div>
            <div
              className={`text-2xl font-semibold tabular-nums mt-1 ${
                counts.failed > 0 ? "text-destructive" : ""
              }`}
            >
              {counts.failed}
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
          en lugar de Card propio para no inflar el alto del panel.
          Solo se muestra al Docente: el Admin GENERA los códigos
          (panel Configuración) y maneja el modo global, así que
          "pídele al administrador un código" no aplica para su rol. */}
      {!isAdmin && (
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
      )}

      {/* Toolbar de bulk actions — solo aparece con count>0. Reusa el
          design system (MultiSelectToolbar): texto "N seleccionado(s)"
          + botones "Limpiar selección" + "Cancelar". El handler abre
          el dialog de confirmación que detalla qué jobs caen.
          Importante: el actionLabel acá es "Cancelar" porque el bulk
          NO borra las filas — las pasa a status='cancelled'
          (preservadas para auditoría). El icono X refuerza la
          semántica vs el Trash2 default. */}
      <MultiSelectToolbar
        count={multi.count}
        onClear={multi.clear}
        onDelete={() => setBulkOpen(true)}
        entityNameSingular="job"
        entityNamePlural="jobs"
        actionLabel="Cancelar"
        actionIcon={X}
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
            {/* Filtro institución — siempre visible para SuperAdmin si hay
                al menos un tenant (consistente con Usuarios/Cursos/Errores/
                Estadísticas; antes estaba gateado a `> 1` y desaparecía en
                deploys de un solo tenant). Resuelve los course_ids del
                tenant y los aplica como `.in('course_id', ids)` a TODAS
                las queries del panel (counts + lista). Para Admin RLS ya
                acota — el Select no se renderiza. */}
            {isSuperAdminCaller && tenants.length > 0 && (
              <Select value={tenantFilter} onValueChange={setTenantFilter}>
                <SelectTrigger className="h-8 w-48 text-xs">
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
            )}
            <Select
              value={statusFilter}
              onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Activos + rechazos abiertos</SelectItem>
                <SelectItem value="history">Historial (cerrados)</SelectItem>
                <SelectItem value="pending">Solo pendientes</SelectItem>
                <SelectItem value="processing">Solo en proceso</SelectItem>
                <SelectItem value="failed">Solo fallados</SelectItem>
                <SelectItem value="rejected">Solo rechazados</SelectItem>
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
              icon={ListOrdered}
              title="No hay jobs"
              description={
                statusFilter === "active"
                  ? "No hay jobs activos en la cola. Cuando se encole una calificación con IA aparecerá aquí."
                  : statusFilter === "history"
                    ? "Aún no hay jobs cerrados (completados, cancelados o rechazos acusados)."
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
                const isRejected = j.status === "rejected";
                const isMyRejection =
                  isRejected && !j.acknowledged_at && j.created_by === currentUserId;
                const route = targetRouteForJob(j, isAdmin);
                const isRetrying = retrying.has(j.id);
                const isCancelling = cancelling.has(j.id);
                const isProcessingNow = processingOne.has(j.id);
                const expanded = expandedId === j.id;
                const label = j.examTitle ?? j.projectTitle ?? j.workshopTitle ?? kindLabel;
                const subtitleParts = [j.studentName, j.courseName].filter(Boolean) as string[];
                const busy = isRetrying || isCancelling || isProcessingNow;

                const isSelectable = isPending || isFailed || isProcessing;
                return (
                  <div key={j.id} className="text-sm">
                    <div
                      className={`px-3 py-2 flex items-center gap-2 ${
                        isFailed ? "bg-destructive/5" : isMyRejection ? "bg-orange-500/5" : ""
                      } hover:bg-muted/40 transition-colors`}
                    >
                      {/* Checkbox por fila — visible para jobs cancelables
                          (pending/failed/processing). Para los demás
                          (done/cancelled) un placeholder de mismo ancho
                          mantiene la alineación de columnas. */}
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
                            {(isProcessing || isFailed || isPending || isRejected) && (
                              <Badge
                                variant={
                                  isFailed
                                    ? "destructive"
                                    : isRejected
                                      ? "destructive"
                                      : isProcessing
                                        ? "secondary"
                                        : "outline"
                                }
                                className={`text-[10px] shrink-0 ${
                                  isRejected
                                    ? "bg-orange-500/15 text-orange-700 dark:text-orange-400 border-orange-500/30 hover:bg-orange-500/20"
                                    : ""
                                }`}
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
                        {/* External link oculto en mobile (`hidden sm:flex`):
                            la fila entera ya es clickeable para expandir
                            el panel de detalle inline. En mobile hasta 4
                            botones más este chocaban contra el espacio
                            del título; quitarlo deja respiro sin perder
                            funcionalidad (el detalle inline tiene el
                            mismo info que el monitor). */}
                        {route && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 hidden sm:flex"
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
                        {(isFailed || isCancelled) && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={busy}
                            onClick={() => void retryJob(j.id)}
                            title={isCancelled ? "Re-encolar" : "Reintentar"}
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
                        {/* Rechazar con razón — solo Admin/SuperAdmin, y solo
                            sobre jobs pending/failed. Distinto a Cancelar:
                            queda registrado con razón + notifica al docente
                            + el job sigue visible hasta que el docente lo
                            cierre. Para "matar" un job sin conversación, sigue
                            disponible el botón Cancelar al lado. */}
                        {isAdmin && (isPending || isFailed) && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-orange-600 hover:text-orange-700 hover:bg-orange-500/10 dark:text-orange-400 dark:hover:text-orange-300"
                            disabled={busy}
                            onClick={() => openReject(j.id, label)}
                            title="Rechazar con razón (notifica al docente)"
                          >
                            <Ban className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {(isPending || isFailed || isProcessing) && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                            disabled={busy}
                            onClick={() => void cancelJob(j.id, label)}
                            title={
                              isProcessing
                                ? "Cancelar (la llamada IA ya está en vuelo; el resultado no se persistirá)"
                                : "Cancelar"
                            }
                          >
                            {isCancelling ? <Spinner size="sm" /> : <X className="h-3.5 w-3.5" />}
                          </Button>
                        )}
                        {/* Acusar recibo del rechazo. Aparece para el docente
                            cuyo job fue rechazado (banner naranja arriba) o
                            para Admin que quiere cerrar como soporte. La
                            misma RPC `acknowledge_rejected_ai_grading_job`
                            valida el caller en el server (created_by o
                            Admin/SuperAdmin). */}
                        {isRejected && !j.acknowledged_at && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-400 dark:hover:text-emerald-300"
                            onClick={() => void acknowledgeReject(j.id)}
                            title="Cerrar conversación (acusar recibo del rechazo y mover al historial)"
                          >
                            <CheckCheck className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    {isMyRejection && (
                      <div className="px-10 pr-3 pb-3 -mt-1">
                        {/* En mobile: stack vertical (icon+texto arriba,
                            botón "Cerrar conversación" full-width abajo).
                            En sm+: layout horizontal con el botón a la
                            derecha. Antes era flex-row siempre y a 375px
                            el botón se comía ~160px dejando ~130px para
                            la razón del rechazo. */}
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
                            onClick={() => void acknowledgeReject(j.id)}
                          >
                            <CheckCheck className="h-3.5 w-3.5 mr-1" />
                            Cerrar conversación
                          </Button>
                        </div>
                      </div>
                    )}
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
                        {isRejected && (
                          <>
                            {j.rejection_reason && (
                              <div className="pt-1">
                                <div className="text-muted-foreground mb-0.5">
                                  Razón del rechazo
                                </div>
                                <pre className="text-[11px] bg-orange-500/10 text-orange-700 dark:text-orange-400 border border-orange-500/30 rounded p-2 whitespace-pre-wrap break-words">
                                  {j.rejection_reason}
                                </pre>
                              </div>
                            )}
                            {j.rejected_at && (
                              <DetailRow k="Rechazado" v={formatDateTime(j.rejected_at)} />
                            )}
                            {j.acknowledged_at ? (
                              <p className="pt-1 text-muted-foreground">
                                Rechazo cerrado por el docente el{" "}
                                {formatDateTime(j.acknowledged_at)}.
                              </p>
                            ) : (
                              <p className="pt-1 text-orange-600 dark:text-orange-400">
                                Esperando que el docente cierre la conversación.
                              </p>
                            )}
                          </>
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
        el botón "Procesar ahora" arriba a la derecha.
        {!isAdmin &&
          " Si necesitas IA sincrónica en un flujo del docente, pídele al administrador un código override."}
      </p>

      {/* Dialog de confirmación para bulk cancel. Reusa BulkDeleteDialog
          del design system con override de texto/icono — el verbo es
          "Cancelar" (no "Eliminar") porque los jobs NO se borran de la
          DB: pasan a status='cancelled' y se preservan para auditoría.
          `dismissLabel="Cerrar"` evita confusión con dos botones
          "Cancelar" en el footer (uno descarta el dialog, otro cancela
          los jobs). */}
      <BulkDeleteDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        items={selectedItems}
        entityNameSingular="job"
        entityNamePlural="jobs"
        actionLabel="Cancelar"
        actionIcon={X}
        dismissLabel="Cerrar"
        extraWarning="Se cancelarán los jobs seleccionados. Si alguno está en estado `procesando`, la llamada IA ya está en vuelo (su costo no se recupera) pero el resultado no se persistirá. Para los demás, la cancelación es limpia. Si una entrega necesita nota IA después, deberás encolarla manualmente."
        onConfirm={bulkCancel}
      />

      {/* Dialog para activar/gestionar el código override de IA inmediata.
          Antes vivía en el dashboard del docente; lo movimos junto a la
          cola para que el flujo entero (ver cola → decidir → activar
          sync) viva en el mismo módulo. */}
      <AiOverrideDialog open={overrideDialogOpen} onOpenChange={setOverrideDialogOpen} />

      {/* Dialog de rechazo con razón — Admin/SuperAdmin. La razón se
          envía al docente como notificación, queda en el audit log, y
          aparece como banner en la fila del docente hasta que éste
          cierre la conversación. Mínimo 5 chars para forzar contexto
          útil (no aceptamos rechazos vacíos). */}
      <Dialog
        open={rejectJobTarget !== null}
        onOpenChange={(o) => {
          if (!o && !rejecting) setRejectJobTarget(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Ban className="h-4 w-4 text-orange-500" />
              Rechazar job con razón
            </DialogTitle>
            <DialogDescription>
              {rejectJobTarget?.label && (
                <span className="block mb-2 font-medium text-foreground">
                  {rejectJobTarget.label}
                </span>
              )}
              El docente que encoló el job recibirá una notificación con la razón. El job no se
              eliminará hasta que el docente cierre la conversación desde su panel Cola. Esto sí
              queda en el audit log.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject-reason" required>
              Razón del rechazo
            </Label>
            <Textarea
              id="reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Ej. La entrega quedó fuera del scope del curso, no procede gastar cuota IA."
              rows={4}
              disabled={rejecting}
              maxLength={500}
            />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>Mínimo 5 caracteres. El docente verá este texto.</span>
              <span className="tabular-nums">{rejectReason.length}/500</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectJobTarget(null)} disabled={rejecting}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirmReject()}
              disabled={rejecting || rejectReason.trim().length < 5}
            >
              {rejecting ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Ban className="h-4 w-4 mr-1" />
              )}
              Rechazar y notificar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
            : status === "rejected"
              ? "bg-orange-500"
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
