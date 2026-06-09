/**
 * AiGenerationQueuePanel — cola de generaciones de IA pendientes.
 *
 * Distinto de `AiQueuePanel` (que es para CALIFICACIÓN). Esta cola
 * acumula jobs cuando el docente intenta generar (preguntas, archivos,
 * contenido) en modo async sin código de IA inmediata. El job queda
 * pending hasta que:
 *   - El docente activa su código de IA inmediata y clickea "Procesar".
 *   - Un Admin lo procesa manualmente.
 *   - El docente lo cancela.
 *
 * RLS (mig 20260603070000): el docente ve solo sus propios jobs;
 * Admin/SA ven todos los del tenant.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { RowAction } from "@/components/ui/row-action";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { readOverrideExpiry, getProcessingMode } from "@/modules/ai/ai-grading";
import { AiOverrideDialog } from "@/modules/ai/AiOverrideDialog";
import { formatDateTime } from "@/shared/lib/format";
import { toast } from "sonner";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { Sparkles, Zap, X, RefreshCw, AlertTriangle, Wand2, Clock } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Status = "pending" | "processing" | "done" | "failed" | "cancelled";

interface Job {
  id: string;
  kind: string;
  invoke_target: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>;
  source_table: string;
  source_id: string;
  course_id: string | null;
  created_by: string;
  status: Status;
  attempts: number;
  last_error: string | null;
  inserted_count: number | null;
  created_at: string;
  completed_at: string | null;
  // Enriquecidos
  course_name?: string;
  source_title?: string;
}

interface Props {
  isAdmin?: boolean;
}

function getKindLabel(kind: string): string {
  const map: Record<string, string> = {
    workshop_questions: i18n.t("aiQueue.kindWorkshopQuestions"),
    exam_questions: i18n.t("aiQueue.kindExamQuestions"),
    project_files: i18n.t("aiQueue.kindProjectFiles"),
    content_generation: i18n.t("aiQueue.kindContentGeneration"),
  };
  return map[kind] ?? kind;
}

function getStatusLabel(status: Status): string {
  const map: Record<Status, string> = {
    pending: i18n.t("aiQueue.statusPending"),
    processing: i18n.t("aiQueue.statusProcessing"),
    done: i18n.t("aiQueue.statusDone"),
    failed: i18n.t("aiQueue.statusFailed"),
    cancelled: i18n.t("aiQueue.statusCancelled"),
  };
  return map[status];
}

export function AiGenerationQueuePanel({ isAdmin = false }: Props) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [processing, setProcessing] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState<Set<string>>(new Set());
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [draining, setDraining] = useState(false);
  // Filtro de estado. Default "active" para mostrar pending+processing+failed
  // (lo que el docente puede accionar). "all" trae historial completo.
  const [statusFilter, setStatusFilter] = useState<"active" | "all">("active");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await db
        .from("ai_generation_queue")
        .select(
          "id, kind, invoke_target, body, source_table, source_id, course_id, created_by, status, attempts, last_error, inserted_count, created_at, completed_at",
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) {
        setLoadError(friendlyError(error, "No pudimos cargar la cola de generación."));
        return;
      }
      const baseJobs = ((data ?? []) as Job[]).map((r) => ({ ...r }));

      // Enriquecimiento: nombre de curso + título del source (taller/examen/proyecto).
      const courseIds = Array.from(
        new Set(baseJobs.map((j) => j.course_id).filter((c): c is string => !!c)),
      );
      const wIds = baseJobs.filter((j) => j.source_table === "workshops").map((j) => j.source_id);
      const eIds = baseJobs.filter((j) => j.source_table === "exams").map((j) => j.source_id);
      const pIds = baseJobs.filter((j) => j.source_table === "projects").map((j) => j.source_id);

      const [coursesLookup, wLookup, eLookup, pLookup] = await Promise.all([
        courseIds.length > 0
          ? db.from("courses").select("id, name").in("id", courseIds)
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
      ]);
      const courseNameById = new Map(
        ((coursesLookup.data ?? []) as Array<{ id: string; name: string }>).map(
          (c) => [c.id, c.name] as const,
        ),
      );
      const titleById = new Map<string, string>();
      for (const r of (wLookup.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);
      for (const r of (eLookup.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);
      for (const r of (pLookup.data ?? []) as Array<{ id: string; title: string }>)
        titleById.set(r.id, r.title);

      const enriched = baseJobs.map((j) => ({
        ...j,
        course_name: j.course_id ? courseNameById.get(j.course_id) : undefined,
        source_title: titleById.get(j.source_id),
      }));
      setJobs(enriched);
    } catch (e) {
      // El Promise.all de los lookups (cursos/workshops/exams/projects)
      // puede rechazar si una de las 4 queries falla con throw (network,
      // auth expirado). Sin catch, `void load()` desde el useEffect
      // inicial Y desde el debounce realtime quedaban como rejection
      // huérfana → audit log "Promesa rechazada sin manejar".
      setLoadError(friendlyError(e, "No pudimos cargar la cola de generación."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  // Realtime — escucha cambios en `ai_generation_queue` para que la
  // lista se refresque sola cuando el worker drena jobs. Mismo patrón
  // que `AiQueuePanel` (debounce 800ms para evitar refresh storm
  // cuando el worker drena varios jobs seguidos).
  useEffect(() => {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const triggerReload = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        void load();
      }, 800);
    };
    const channel = supabase
      .channel("ai_generation_queue_panel")
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "ai_generation_queue" },
        triggerReload,
      )
      .subscribe();
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      // `removeChannel` retorna Promise<status>; en navegación con red
      // caída puede rechazar. Sin .catch, el rechazo se bubble como
      // unhandled. Swallow silencioso porque ya nos vamos del componente
      // y el cleanup de red no tiene UX que mostrar.
      void supabase.removeChannel(channel).catch(() => {});
    };
  }, [load]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return jobs;
    return jobs.filter(
      (j) => j.status === "pending" || j.status === "processing" || j.status === "failed",
    );
  }, [jobs, statusFilter]);

  /**
   * Procesa UN job: marca processing → invoca el edge con body original
   * → al éxito marca done con inserted_count → al fallo marca failed.
   * No usa una RPC server-side porque la edge `ai-generate-questions`
   * ya hace todo el trabajo; el cliente coordina el state-machine.
   */
  const processJob = async (job: Job) => {
    if (processing.has(job.id)) return;
    // Requisito de IA inmediata: si el docente no tiene código activo
    // y no es Admin, no puede dispatchear (el edge `ai-generate-questions`
    // valida el modo y un INSERT-now sin código fallaría con el mensaje
    // de "activá código"). Abrimos el dialog de override.
    if (!isAdmin) {
      const mode = await getProcessingMode();
      if (mode === "async" && !readOverrideExpiry()) {
        toast.info(i18n.t("aiQueue.toastActivateFirst"));
        setOverrideOpen(true);
        return;
      }
    }
    setProcessing((prev) => new Set(prev).add(job.id));
    try {
      // content_generation requiere CREAR la fila de generated_contents
      // antes de invocar `generate-contents`. Eso lo hace el worker
      // server-side (ai-generation-worker) en una transacción. Para
      // los demás kinds, el edge target ya espera solo el body sin
      // efectos secundarios DB-wise, así que lo invocamos directo y
      // marcamos status acá en el cliente — más rápido y nos da el
      // conteo de items.
      if (job.kind === "content_generation") {
        const { data, error } = await supabase.functions.invoke("ai-generation-worker", {
          body: { jobId: job.id },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = data as any;
        if (error || d?.failed > 0) {
          const detail =
            (await extractEdgeError(error, data)) ||
            (d?.failed > 0 ? "El worker reportó falla en el job" : "Error desconocido");
          toast.error(i18n.t("aiQueue.toastCouldNotProcess") + ": " + detail);
        } else if (d?.succeeded === 0 && d?.processed === 0) {
          toast.info(i18n.t("aiQueue.toastJobNoLongerPending"));
        } else {
          toast.success(i18n.t("aiQueue.toastJobQueued"));
        }
        await load();
        return;
      }

      // Marca processing.
      const startMs = new Date().toISOString();
      await db
        .from("ai_generation_queue")
        .update({ status: "processing", started_at: startMs, attempts: job.attempts + 1 })
        .eq("id", job.id);
      // Invoca el edge. body se guardó exactamente como se hubiera pasado
      // en el flujo sync, así que pasamos verbatim.
      const { data, error } = await supabase.functions.invoke(job.invoke_target, {
        body: job.body,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      if (error || d?.error) {
        const detail = (await extractEdgeError(error, data)) || "Error desconocido";
        await db
          .from("ai_generation_queue")
          .update({ status: "failed", last_error: detail, completed_at: new Date().toISOString() })
          .eq("id", job.id);
        toast.error(
          i18n.t("toast.modules_ai_AiGenerationQueuePanel.couldNotProcess", {
            defaultValue: "No se pudo procesar: {{detail}}",
            detail,
          }),
        );
      } else {
        const inserted = d?.inserted?.length ?? 0;
        await db
          .from("ai_generation_queue")
          .update({
            status: "done",
            inserted_count: inserted,
            completed_at: new Date().toISOString(),
            last_error: null,
          })
          .eq("id", job.id);
        toast.success(inserted > 0 ? `+${inserted} items` : i18n.t("aiQueue.toastJobProcessed"));
      }
      await load();
    } catch (e) {
      // Caller usa `() => void processJob(j)` — sin catch, una rejection
      // del invoke/update/load se vuelve unhandled. Cubrimos con toast
      // amigable que respeta `friendlyError` para mensajes en español.
      toast.error(friendlyError(e, "No se pudo procesar el job"));
    } finally {
      setProcessing((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
    }
  };

  /**
   * Drain mode (solo Admin/SA): invoca al worker sin jobId. El worker
   * procesa hasta 10 pending de la FIFO. Útil cuando el admin acaba
   * de cambiar el modo IA a sync y quiere vaciar la cola que se
   * acumuló en async. El worker respeta el modo: si sigue async,
   * retorna skipped sin tocar nada.
   */
  const drainAll = async () => {
    if (draining) return;
    setDraining(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-generation-worker", {
        body: {},
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      if (error) {
        const detail = (await extractEdgeError(error, data)) || "Error desconocido";
        toast.error(i18n.t("aiQueue.toastCouldNotDrain") + ": " + detail);
        return;
      }
      if (d?.skipped === "async_mode_no_jobid") {
        toast.info(i18n.t("aiQueue.toastAsyncMode"));
      } else {
        const proc = d?.processed ?? 0;
        const ok = d?.succeeded ?? 0;
        const fail = d?.failed ?? 0;
        toast.success(`${i18n.t("aiQueue.toastDrained")}: ${proc} — ${ok} ok, ${fail} ✗`);
      }
      await load();
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo drenar la cola"));
    } finally {
      setDraining(false);
    }
  };

  const cancelJob = async (job: Job) => {
    if (cancelling.has(job.id)) return;
    const ok = await confirm({
      title: i18n.t("aiQueue.cancelJobTitle"),
      description: i18n.t("aiQueue.cancelJobDescription", { kind: getKindLabel(job.kind) }),
      tone: "destructive",
      confirmLabel: i18n.t("aiQueue.cancelJobConfirm"),
    });
    if (!ok) return;
    setCancelling((prev) => new Set(prev).add(job.id));
    try {
      const { error } = await db
        .from("ai_generation_queue")
        .update({ status: "cancelled", completed_at: new Date().toISOString() })
        .eq("id", job.id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo cancelar"));
        return;
      }
      toast.success(i18n.t("aiQueue.toastJobCancelled"));
      await load();
    } catch (e) {
      // Caller: `() => void cancelJob(j)` desde RowAction. Sin catch
      // una rejection del update/load deja unhandled rejection.
      toast.error(friendlyError(e, "No se pudo cancelar"));
    } finally {
      setCancelling((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
    }
  };

  return (
    <div className="space-y-4">
      {draining && (
        <LoadingOverlay
          title={t("aiQueue.drainingTitle")}
          subtitle={t("aiQueue.drainingSubtitle")}
        />
      )}
      {/* Banner explicativo */}
      <div className="flex flex-wrap items-center gap-3 rounded-md border bg-amber-50/40 dark:bg-amber-500/5 border-amber-300/40 dark:border-amber-500/20 px-3 py-2">
        <Wand2 className="h-4 w-4 text-amber-500 shrink-0" />
        <p className="text-xs text-muted-foreground flex-1 min-w-[200px]">
          {t("aiQueue.infoBannerTitle")}{" "}
          {isAdmin ? t("aiQueue.infoBannerAdmin") : t("aiQueue.infoBannerTeacher")}
        </p>
        {!isAdmin && (
          <Button size="sm" variant="outline" className="h-8" onClick={() => setOverrideOpen(true)}>
            <Sparkles className="h-3.5 w-3.5 mr-1" />
            {t("aiQueue.actionActivateImmediate")}
          </Button>
        )}
        {isAdmin && (
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => void drainAll()}
            disabled={draining}
            title={t("aiQueue.actionProcessAllTitle")}
          >
            {draining ? (
              <Spinner size="xs" className="mr-1" />
            ) : (
              <Zap className="h-3.5 w-3.5 mr-1" />
            )}
            {t("aiQueue.actionProcessAll")}
          </Button>
        )}
      </div>

      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between gap-3 space-y-0 flex-wrap">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{t("aiQueue.title")}</CardTitle>
            <Badge variant="secondary" className="text-[10px]">
              {filtered.length}
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant={statusFilter === "active" ? "outline" : "ghost"}
              className="h-7 text-xs"
              onClick={() => setStatusFilter((s) => (s === "active" ? "all" : "active"))}
            >
              {statusFilter === "active" ? t("aiQueue.filterAll") : t("aiQueue.filterActive")}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setRetryNonce((n) => n + 1)}
              title={t("aiQueue.refresh")}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
              <Spinner size="sm" /> {t("aiQueue.loadingQueue")}
            </div>
          ) : loadError ? (
            <ErrorState
              message={t("aiQueue.loadError")}
              hint={loadError}
              onRetry={() => setRetryNonce((n) => n + 1)}
            />
          ) : filtered.length === 0 ? (
            <TableEmpty
              icon={Wand2}
              title={t("aiQueue.title")}
              description={statusFilter === "active" ? t("aiQueue.empty_active") : t("aiQueue.empty_all")}
            />
          ) : (
            <div className="divide-y">
              {filtered.map((j) => {
                const kindLabel = getKindLabel(j.kind);
                const isProc = processing.has(j.id);
                const isCanc = cancelling.has(j.id);
                const busy = isProc || isCanc;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const b = j.body as Record<string, any>;
                const summary = [
                  b.type && `${b.count ?? "?"} × ${b.type}`,
                  b.language && b.type === "codigo" ? b.language : null,
                  b.topics &&
                    `"${String(b.topics).slice(0, 50)}${String(b.topics).length > 50 ? "…" : ""}"`,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div key={j.id} className="px-3 py-2 text-sm flex items-center gap-2">
                    <StatusDot status={j.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{j.source_title ?? kindLabel}</span>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {kindLabel}
                        </Badge>
                        <Badge
                          variant={
                            j.status === "failed"
                              ? "destructive"
                              : j.status === "done"
                                ? "default"
                                : j.status === "cancelled"
                                  ? "secondary"
                                  : "secondary"
                          }
                          className={`text-[10px] shrink-0 ${
                            j.status === "done"
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                              : ""
                          }`}
                        >
                          {getStatusLabel(j.status)}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground truncate">
                        {[summary, j.course_name].filter(Boolean).join(" · ")}
                        {j.status === "done" && j.inserted_count != null && (
                          <span className="ml-1 text-emerald-600 dark:text-emerald-400">
                            · +{j.inserted_count} item{j.inserted_count === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                      {j.last_error && (
                        // Antes era `truncate` 1-línea con title hover —
                        // mensajes largos quedaban tapados ("silent fail"
                        // reportado por usuario). Ahora wrap + max 4
                        // líneas con `line-clamp-4` + botón "Copiar"
                        // para llevar el texto completo al portapapeles.
                        <div className="text-[10px] text-destructive mt-1 flex items-start gap-1.5 rounded border border-destructive/30 bg-destructive/5 p-1.5">
                          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0 whitespace-pre-wrap break-words line-clamp-4">
                            {j.last_error}
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void navigator.clipboard
                                .writeText(j.last_error ?? "")
                                .then(() =>
                                  toast.success(i18n.t("aiQueue.toastErrorCopied")),
                                )
                                .catch(() =>
                                  toast.error(i18n.t("aiQueue.toastCouldNotCopy")),
                                );
                            }}
                            className="shrink-0 text-[10px] text-destructive/80 hover:text-destructive underline"
                            title={t("aiQueue.copyErrorTitle")}
                          >
                            {t("aiQueue.copyError")}
                          </button>
                        </div>
                      )}
                    </div>
                    <span className="text-[11px] text-muted-foreground tabular-nums shrink-0 hidden sm:inline">
                      <Clock className="inline h-3 w-3 mr-0.5" />
                      {formatDateTime(j.created_at)}
                    </span>
                    <div className="flex items-center gap-0.5 shrink-0">
                      {(j.status === "pending" || j.status === "failed") && (
                        <RowAction
                          label={j.status === "failed" ? t("aiQueue.actionRetry") : t("aiQueue.actionProcessNow")}
                          icon={j.status === "failed" ? RefreshCw : Zap}
                          loading={isProc}
                          disabled={busy}
                          onClick={() => void processJob(j)}
                        />
                      )}
                      {(j.status === "pending" || j.status === "failed") && (
                        <RowAction
                          label={t("aiQueue.actionCancel")}
                          icon={X}
                          tone="destructive"
                          loading={isCanc}
                          disabled={busy}
                          onClick={() => void cancelJob(j)}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <AiOverrideDialog open={overrideOpen} onOpenChange={setOverrideOpen} />
    </div>
  );
}

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
