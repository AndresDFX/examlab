/**
 * AiGradingQueueWidget — card resumen de la cola IA.
 *
 * Embebible en cualquier dashboard (admin, docente). Muestra:
 *   - Pendientes
 *   - En proceso
 *   - Fallados (últimas 24h)
 *   - Última corrida exitosa
 *
 * Admin ve todas las filas (RLS lo permite). Docente ve los suyos
 * (created_by = uid) + los del curso que enseña (vía RLS extendida).
 *
 * Click en "Procesar ahora" (solo admin) invoca el edge function
 * `ai-grading-worker` manualmente sin esperar al cron horario.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Clock,
  Cpu,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Play,
  X,
  Zap,
  ArrowUpRight,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/shared/lib/format";
import { useConfirm } from "@/shared/components/ConfirmDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  /** Solo Admin ve el botón "Procesar ahora". */
  isAdmin?: boolean;
}

interface Counts {
  pending: number;
  processing: number;
  failed24h: number;
  lastDoneAt: string | null;
}

interface QueueJob {
  id: string;
  kind: string;
  status: "pending" | "processing" | "failed";
  target_table: string;
  target_row_id: string;
  course_id: string | null;
  created_at: string;
  last_error: string | null;
  // Resolución best-effort (se llena tras queries secundarias)
  examTitle?: string;
  workshopTitle?: string;
  projectTitle?: string;
  studentName?: string;
  courseName?: string;
  // IDs resueltos para navegación al detalle (link en la fila).
  examId?: string;
  projectId?: string;
}

/** Etiqueta humana para el tipo de job. */
const KIND_LABELS: Record<string, string> = {
  exam_submission: "Examen",
  exam_question: "Pregunta de examen",
  workshop_submission: "Taller",
  workshop_question: "Pregunta de taller",
  project_submission: "Proyecto",
  project_file: "Archivo de proyecto",
  project_codigo_zip: "Código ZIP de proyecto",
};

/** Tope de jobs visibles en la lista. Mantenemos compacto para no inflar
 *  el dashboard — si hay más, se muestra "+N más" al final. */
const MAX_VISIBLE_JOBS = 8;

/** Formato relativo simple ("hace 5m", "hace 2h"). Evita import de
 *  date-fns por ese solo uso. */
function relativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "ahora";
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

export function AiGradingQueueWidget({ isAdmin = false }: Props) {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [counts, setCounts] = useState<Counts>({
    pending: 0,
    processing: 0,
    failed24h: 0,
    lastDoneAt: null,
  });
  // Lista visible de jobs activos (pending + processing). Mostramos hasta
  // MAX_VISIBLE_JOBS para que el docente identifique cuál entrega está
  // bloqueada. Resolución best-effort: si la query secundaria falla
  // (RLS de submission o exam no permite ver, etc.), mostramos al menos
  // el tipo y la fecha.
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  // IDs en flight por acción — Set para soportar clicks paralelos.
  // Antes solo había retry; ahora tenemos 3 acciones por job (retry,
  // cancel, process-now) y necesitamos rastrear cada una por separado
  // para deshabilitar SU botón sin bloquear los demás.
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [processingOne, setProcessingOne] = useState<Set<string>>(new Set());

  /** Resuelve la ruta destino al hacer click en una fila del job. Si el
   *  tipo no tiene destino conocido (target_row no resuelto, kind raro),
   *  retorna null y la fila queda no-clickable. */
  const targetRouteForJob = (j: QueueJob): string | null => {
    if (j.target_table === "submissions" && j.examId) {
      // Monitor en vivo del examen — el docente ve todas las entregas
      // del exam y puede recalificar, revisar, etc.
      return `/app/teacher/monitor/${j.examId}`;
    }
    if (j.target_table === "project_submission_files" && j.projectId) {
      // No hay ruta `monitor` para proyectos; los abrimos en la lista
      // de proyectos del docente. Mejor que nada — el docente puede
      // luego elegir el proyecto y ver sus entregas.
      return "/app/teacher/projects";
    }
    return null;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      // Tres counts + 1 lookup + lista de jobs activos; corren en paralelo.
      const [
        { count: pending },
        { count: processing },
        { count: failed24h },
        { data: lastDone },
        { data: activeJobs },
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
        // Trae pending + processing + failed-reciente. Los failed se
        // muestran junto a los activos con un botón "Reintentar" — el
        // docente puede re-encolar sin esperar al admin. Limitamos a
        // failed del último día para no inundar la lista con jobs
        // viejos abandonados.
        db
          .from("ai_grading_queue")
          .select(
            "id, kind, status, target_table, target_row_id, course_id, created_at, last_error",
          )
          .or(
            `status.eq.pending,status.eq.processing,and(status.eq.failed,completed_at.gte.${since24})`,
          )
          .order("created_at", { ascending: false })
          .limit(MAX_VISIBLE_JOBS),
      ]);
      setCounts({
        pending: pending ?? 0,
        processing: processing ?? 0,
        failed24h: failed24h ?? 0,
        lastDoneAt: lastDone?.completed_at ?? null,
      });

      const baseJobs = (activeJobs ?? []) as QueueJob[];
      // Resolver títulos + nombres de estudiante. Hacemos lookups en
      // batch para no caer en N+1: agrupamos los row IDs por
      // target_table y disparamos UNA query por tabla, después
      // mergeamos. Si el docente no tiene RLS para ver una submission
      // (raro — el RLS de queue ya filtra por curso enseñado),
      // simplemente queda sin título resuelto y se muestra el kind.
      //
      // Tipos de jobs que resolvemos:
      //   - target_table = 'submissions'              → examen
      //   - target_table = 'project_submission_files' → archivo de proyecto
      // Workshops por ahora no encola (usa batch sync) — si en el futuro
      // se migra, agregar el caso `workshop_submissions` aquí.
      const examIds = baseJobs
        .filter((j) => j.target_table === "submissions")
        .map((j) => j.target_row_id);
      const projectFileIds = baseJobs
        .filter((j) => j.target_table === "project_submission_files")
        .map((j) => j.target_row_id);
      const courseIds = Array.from(
        new Set(baseJobs.map((j) => j.course_id).filter((c): c is string => !!c)),
      );

      // Paso 1: queries primarias para descubrir IDs intermedios.
      // - submissions: tenemos los IDs directos, pedimos user_id + exam_id
      //   sin embed (las FKs de submissions.user_id apuntan a auth.users
      //   NO a profiles, así que el embed PostgREST `profile:profiles!...`
      //   fallaba silenciosamente y nos quedábamos sin nombre).
      // - project_submission_files: pedimos submission_id sin embed; en
      //   el paso 2 lookup-eamos las project_submissions por separado.
      const [submissionsLookup, projectFilesLookup, courseLookup] = await Promise.all([
        examIds.length > 0
          ? db.from("submissions").select("id, user_id, exam_id").in("id", examIds)
          : Promise.resolve({ data: [] as unknown[] }),
        projectFileIds.length > 0
          ? db.from("project_submission_files").select("id, submission_id").in("id", projectFileIds)
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

      // Paso 2: lookups secundarios con los IDs descubiertos arriba.
      // Esto cuesta 2-3 round-trips extra pero es robusto a cualquier
      // configuración de FK (auth.users vs profiles, naming custom, etc.).
      const projectSubmissionIds = Array.from(new Set(projectFileRows.map((r) => r.submission_id)));
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

      // Paso 3: profiles + projects (necesitamos all_user_ids ya completo).
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
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime — escucha cambios en `ai_grading_queue` para refrescar el
  // widget sin que el usuario tenga que pulsar "refrescar". Cubre tres
  // casos críticos:
  //   - INSERT: nuevo estudiante entrega → aparece job pending.
  //   - UPDATE: worker reclama un job (pending → processing) o lo
  //     completa (→ done/failed).
  //   - DELETE: poco común pero por completitud.
  //
  // Debounce de 800ms — si llegan N eventos seguidos (ej. el worker
  // drena 25 jobs de golpe), evitamos disparar 25 queries de refresh.
  // Reagrupamos en una sola.
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const triggerReload = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void load();
      }, 800);
    };
    const channel = supabase
      .channel("ai_grading_queue_widget")
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
      if (error) {
        toast.error(error.message);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      if (d?.ok === false) {
        toast.error(d?.error ?? "Error en el worker");
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

  /** Cancela un job (status='cancelled'). Solo aplica a pending/failed —
   *  processing y done no se cancelan. Pide confirmación destructiva. */
  const cancelJob = async (jobId: string, label: string) => {
    if (cancelling.has(jobId)) return;
    const ok = await confirm({
      title: `¿Cancelar este job de IA?`,
      description:
        `"${label}" — el job no se procesará. Si la entrega del estudiante necesita ` +
        `nota IA después, deberás encolarla manualmente (ej. desde el monitor del examen). ` +
        `Esta acción no se puede deshacer.`,
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
        toast.error(error.message ?? "No se pudo cancelar el job");
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

  /** Procesa UN job específico ahora — bypassea la espera al cron
   *  hourly. Invoca al worker con `{ jobId }` para que reclame y procese
   *  solo ese job. Útil cuando el docente entregó nota IA urgente y no
   *  quiere esperar la próxima ventana. */
  const processOne = async (jobId: string) => {
    if (processingOne.has(jobId)) return;
    setProcessingOne((prev) => new Set(prev).add(jobId));
    try {
      const { data, error } = await supabase.functions.invoke("ai-grading-worker", {
        body: { jobId },
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      if (d?.ok === false) {
        toast.error(d?.error ?? "Error procesando el job");
        return;
      }
      if (d?.processed === 0) {
        toast.info(
          "El job ya no estaba en estado pending — quizás el worker hourly lo levantó primero.",
        );
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

  /** Re-encola un job `failed` para que el worker lo retome. La RPC
   *  `requeue_ai_grading_job` valida permisos server-side (admin O owner
   *  del job O docente del curso). Optimistic UI: removemos el job de
   *  la lista al instante y refrescamos al toast.success. */
  const retryJob = async (jobId: string) => {
    if (retrying.has(jobId)) return;
    setRetrying((prev) => new Set(prev).add(jobId));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("requeue_ai_grading_job", {
        _job_id: jobId,
      });
      if (error) {
        toast.error(error.message ?? "No se pudo re-encolar el job");
        return;
      }
      toast.success("Job re-encolado — el worker lo retomará en su próxima corrida");
      await load();
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary" />
          Cola IA
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 ml-auto"
            onClick={() => void load()}
            title="Refrescar"
          >
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size="sm" /> Cargando…
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border p-2 text-center">
                <div className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                  <Clock className="h-2.5 w-2.5" /> Pendientes
                </div>
                <div className="text-xl font-bold tabular-nums">{counts.pending}</div>
              </div>
              <div className="rounded-md border p-2 text-center">
                <div className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                  <Cpu className="h-2.5 w-2.5" /> En proceso
                </div>
                <div className="text-xl font-bold tabular-nums">{counts.processing}</div>
              </div>
              <div className="rounded-md border p-2 text-center">
                <div className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
                  <AlertTriangle className="h-2.5 w-2.5" /> Fallados 24h
                </div>
                <div className="text-xl font-bold tabular-nums">{counts.failed24h}</div>
              </div>
            </div>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              Último éxito: {counts.lastDoneAt ? formatDateTime(counts.lastDoneAt) : "—"}
            </div>

            {/* Lista de jobs activos. RLS filtra: Admin ve todos, Docente
                ve los suyos + los del curso que enseña, Estudiante no
                aplica acá (no monta este widget). Para exam_submission
                resolvemos el título del examen + estudiante mediante un
                join secundario. Otros kinds (workshop_*, project_*) por
                ahora muestran solo el tipo + curso — son más raros y
                requieren joins distintos por tabla destino. */}
            {jobs.length > 0 && (
              <div className="space-y-1 pt-1 border-t">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                  En cola
                </div>
                {jobs.slice(0, MAX_VISIBLE_JOBS).map((j) => {
                  const kindLabel = KIND_LABELS[j.kind] ?? j.kind;
                  const isProcessing = j.status === "processing";
                  const isFailed = j.status === "failed";
                  const isPending = j.status === "pending";
                  const route = targetRouteForJob(j);
                  const isRetrying = retrying.has(j.id);
                  const isCancelling = cancelling.has(j.id);
                  const isProcessingNow = processingOne.has(j.id);
                  const label = j.examTitle ?? j.workshopTitle ?? j.projectTitle ?? kindLabel;
                  const subtitle =
                    [j.studentName, j.courseName].filter(Boolean).join(" · ") || kindLabel;

                  // Header de la fila — todo en UNA línea para máxima
                  // densidad. Antes era 2 líneas (title arriba, subtítulo
                  // pequeño abajo) y consumía mucho alto vertical. Ahora
                  // title + subtítulo van inline separados por " — " con
                  // colores distintos para mantener jerarquía visual.
                  const header = (
                    <>
                      {isProcessing ? (
                        <Cpu className="h-3 w-3 text-amber-500 shrink-0 animate-pulse" />
                      ) : isFailed ? (
                        <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />
                      ) : (
                        <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                      )}
                      <div className="min-w-0 flex-1 text-left truncate">
                        <span className="font-medium">{label}</span>
                        {subtitle && subtitle !== label && (
                          <span className="text-muted-foreground"> · {subtitle}</span>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                        {relativeAge(j.created_at)}
                      </span>
                    </>
                  );

                  // Acciones disponibles por estado:
                  //   - pending  → "Procesar ahora" (bypass cron) + "Cancelar".
                  //   - failed   → "Reintentar" + "Cancelar" + (preserva el
                  //                last_error truncado).
                  //   - processing → sin acciones (ya está en flight; cancelar
                  //                a mitad de fetch a Gemini deja la edge en
                  //                estado inconsistente).
                  // Botones INLINE a la derecha del header (no en línea
                  // separada). Reduce altura de fila a 1 sola línea para
                  // pending y 2 para failed (header + error). last_error
                  // solo se renderiza en failed.
                  if (isFailed || isPending) {
                    const busy = isRetrying || isCancelling || isProcessingNow;
                    return (
                      <div
                        key={j.id}
                        className={
                          isFailed
                            ? "px-2 py-0.5 rounded text-[11px] bg-destructive/5 border border-destructive/20"
                            : "px-2 py-0.5 rounded text-[11px] hover:bg-muted/40"
                        }
                      >
                        <div className="flex items-center gap-2">
                          {header}
                          <div className="flex items-center gap-0.5 shrink-0">
                            {route && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-5 w-5"
                                onClick={() =>
                                  navigate({
                                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                    to: route as any,
                                  })
                                }
                                title="Abrir detalle"
                              >
                                <ArrowUpRight className="h-3 w-3" />
                              </Button>
                            )}
                            {isFailed && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-5 w-5"
                                disabled={busy}
                                onClick={() => void retryJob(j.id)}
                                title="Reintentar"
                              >
                                {isRetrying ? (
                                  <Spinner size="sm" />
                                ) : (
                                  <RefreshCw className="h-3 w-3" />
                                )}
                              </Button>
                            )}
                            {isPending && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-5 w-5"
                                disabled={busy}
                                onClick={() => void processOne(j.id)}
                                title="Procesa este job ahora (bypass cron)"
                              >
                                {isProcessingNow ? (
                                  <Spinner size="sm" />
                                ) : (
                                  <Zap className="h-3 w-3" />
                                )}
                              </Button>
                            )}
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-5 w-5 text-destructive hover:text-destructive hover:bg-destructive/10"
                              disabled={busy}
                              onClick={() => void cancelJob(j.id, label)}
                              title="Cancelar"
                            >
                              {isCancelling ? <Spinner size="sm" /> : <X className="h-3 w-3" />}
                            </Button>
                          </div>
                        </div>
                        {isFailed && j.last_error && (
                          <div
                            className="text-[10px] text-destructive/80 mt-0.5 truncate"
                            title={j.last_error}
                          >
                            {j.last_error}
                          </div>
                        )}
                      </div>
                    );
                  }

                  // Processing: sin acciones. Si tenemos route, la fila
                  // entera es clickable para abrir el detalle.
                  if (route) {
                    return (
                      <button
                        key={j.id}
                        type="button"
                        onClick={() =>
                          navigate({
                            // eslint-disable-next-line @typescript-eslint/no-explicit-any
                            to: route as any,
                          })
                        }
                        title={`Abrir detalle: ${label}`}
                        className="w-full flex items-center gap-2 px-2 py-1 rounded text-[11px] hover:bg-muted/60 cursor-pointer transition-colors"
                      >
                        {header}
                      </button>
                    );
                  }
                  return (
                    <div
                      key={j.id}
                      className="flex items-center gap-2 px-2 py-1 rounded text-[11px] hover:bg-muted/40"
                    >
                      {header}
                    </div>
                  );
                })}
                {counts.pending + counts.processing > jobs.length && (
                  <div className="text-[10px] text-muted-foreground text-center pt-1">
                    +{counts.pending + counts.processing - jobs.length} más en cola…
                  </div>
                )}
              </div>
            )}

            <div className="text-[10px] text-muted-foreground">
              El worker corre automáticamente cada hora. Si necesitas IA inmediata, pide un código
              override al administrador.
            </div>
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runNow()}
                disabled={running || counts.pending === 0}
                className="w-full"
              >
                {running ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <Play className="h-3.5 w-3.5 mr-1" />
                )}
                Procesar ahora ({counts.pending})
              </Button>
            )}
            {!isAdmin && counts.pending > 0 && (
              <Badge variant="outline" className="text-[10px] w-full justify-center py-1">
                {counts.pending} job(s) en cola — se procesan en el próximo turno
              </Badge>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
