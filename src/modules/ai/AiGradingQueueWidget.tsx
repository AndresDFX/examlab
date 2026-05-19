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
import { Clock, Cpu, AlertTriangle, CheckCircle2, RefreshCw, Play } from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/shared/lib/format";

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
  status: "pending" | "processing";
  target_table: string;
  target_row_id: string;
  course_id: string | null;
  created_at: string;
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
        db
          .from("ai_grading_queue")
          .select("id, kind, status, target_table, target_row_id, course_id, created_at")
          .in("status", ["pending", "processing"])
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

      const [examLookup, projectLookup, courseLookup] = await Promise.all([
        examIds.length > 0
          ? db
              .from("submissions")
              .select(
                "id, user_id, exam_id, exam:exams(title), profile:profiles!submissions_user_id_fkey(full_name)",
              )
              .in("id", examIds)
          : Promise.resolve({ data: [] as unknown[] }),
        projectFileIds.length > 0
          ? db
              .from("project_submission_files")
              .select(
                "id, submission:project_submissions(user_id, project_id, project:projects(title), profile:profiles!project_submissions_user_id_fkey(full_name))",
              )
              .in("id", projectFileIds)
          : Promise.resolve({ data: [] as unknown[] }),
        courseIds.length > 0
          ? db.from("courses").select("id, name").in("id", courseIds)
          : Promise.resolve({ data: [] as unknown[] }),
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const examMap = new Map<string, any>();
      for (const row of (examLookup.data ?? []) as Array<{ id: string }>) {
        examMap.set(row.id, row);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const projectFileMap = new Map<string, any>();
      for (const row of (projectLookup.data ?? []) as Array<{ id: string }>) {
        projectFileMap.set(row.id, row);
      }
      const courseMap = new Map<string, string>();
      for (const c of (courseLookup.data ?? []) as Array<{ id: string; name: string }>) {
        courseMap.set(c.id, c.name);
      }

      const enriched = baseJobs.map((j) => {
        const out: QueueJob = { ...j };
        if (j.course_id) out.courseName = courseMap.get(j.course_id);
        if (j.target_table === "submissions") {
          const sub = examMap.get(j.target_row_id);
          if (sub) {
            out.examTitle = sub.exam?.title ?? undefined;
            out.studentName = sub.profile?.full_name ?? undefined;
            out.examId = sub.exam_id ?? undefined;
          }
        } else if (j.target_table === "project_submission_files") {
          const pf = projectFileMap.get(j.target_row_id);
          if (pf?.submission) {
            out.projectTitle = pf.submission.project?.title ?? undefined;
            out.studentName = pf.submission.profile?.full_name ?? undefined;
            out.projectId = pf.submission.project_id ?? undefined;
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
                  const route = targetRouteForJob(j);
                  const rowContent = (
                    <>
                      {isProcessing ? (
                        <Cpu className="h-3 w-3 text-amber-500 shrink-0 animate-pulse" />
                      ) : (
                        <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                      )}
                      <div className="min-w-0 flex-1 text-left">
                        <div className="truncate font-medium">
                          {j.examTitle ?? j.workshopTitle ?? j.projectTitle ?? kindLabel}
                        </div>
                        <div className="truncate text-[10px] text-muted-foreground">
                          {[j.studentName, j.courseName].filter(Boolean).join(" · ") || kindLabel}
                        </div>
                      </div>
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                        {relativeAge(j.created_at)}
                      </span>
                    </>
                  );
                  // Si tenemos ruta destino conocida (exam → monitor,
                  // project → lista de proyectos), la fila es un botón
                  // clickable. Si no, es un div estático — para no dar
                  // afordance falsa de "click me" sobre algo que no
                  // navega a ningún lado.
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
                        title={`Abrir detalle: ${j.examTitle ?? j.projectTitle ?? kindLabel}`}
                        className="w-full flex items-center gap-2 px-2 py-1 rounded text-[11px] hover:bg-muted/60 cursor-pointer transition-colors"
                      >
                        {rowContent}
                      </button>
                    );
                  }
                  return (
                    <div
                      key={j.id}
                      className="flex items-center gap-2 px-2 py-1 rounded text-[11px] hover:bg-muted/40"
                    >
                      {rowContent}
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
