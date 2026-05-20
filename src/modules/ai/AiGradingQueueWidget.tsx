/**
 * AiGradingQueueWidget — card resumen MUY compacto de la cola IA.
 *
 * Embebible en cualquier dashboard (admin, docente). Muestra:
 *   - Pendientes / En proceso / Fallados 24h (3 contadores grandes)
 *   - Última corrida exitosa
 *   - Botón "Procesar ahora" (admin)
 *   - Link al módulo "Cron" para gestión completa (filtros, cancelar,
 *     reintentar, procesar uno a uno, etc.)
 *
 * Diseño: alto FIJO para que el dashboard no haga scroll vertical aunque
 * la cola tenga decenas de jobs. La lista detallada por job NO se
 * renderiza aquí — vive en `/app/(role)/ai-cron` (AiCronPage).
 *
 * Versiones previas tenían la lista expandida con acciones por fila
 * inline; consumían >400px de alto y empujaban el resto de cards del
 * dashboard fuera del viewport. Ese código se trasladó íntegro al
 * módulo Cron (AiQueuePanel en AiCronPage.tsx) — acá solo dejamos
 * el counter glance + el link.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useActiveRole } from "@/hooks/use-active-role";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Clock, Cpu, AlertTriangle, CheckCircle2, RefreshCw, Play, ArrowRight } from "lucide-react";
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

interface RecentJob {
  id: string;
  kind: string;
  status: "pending" | "processing" | "failed";
  created_at: string;
}

/** Etiqueta humana corta para `kind`. Se mantiene corta a propósito —
 *  cabe en una sola línea junto al ícono de estado y la antigüedad. */
const KIND_SHORT: Record<string, string> = {
  exam_submission: "Examen",
  exam_question: "Pregunta examen",
  workshop_submission: "Taller",
  workshop_question: "Pregunta taller",
  project_submission: "Proyecto",
  project_file: "Archivo proyecto",
  project_codigo_zip: "ZIP código",
};

/** Formato relativo simple ("ahora", "5m", "2h", "1d"). */
function relativeAge(iso: string): string {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return "ahora";
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

export function AiGradingQueueWidget({ isAdmin = false }: Props) {
  // Rol activo determina a qué ruta del módulo "Cron" enlaza el link
  // del pie del card.
  const activeRole = useActiveRole();
  const cronModulePath = activeRole === "Admin" ? "/app/admin/ai-cron" : "/app/teacher/ai-cron";

  const [counts, setCounts] = useState<Counts>({
    pending: 0,
    processing: 0,
    failed24h: 0,
    lastDoneAt: null,
  });
  // Lista compacta de jobs activos para llenar el alto del card cuando
  // el dashboard lo estira a viewport-fill. Sin acciones por fila (esas
  // viven en el módulo Cron); solo un glance de "qué hay pendiente".
  const [jobs, setJobs] = useState<RecentJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      // Cuatro head-counts + lista compacta de jobs activos. La lista
      // se muestra en un overflow-y-auto dentro del card; trae hasta 20
      // para que el alumno típico vea todo lo que está en cola.
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
          .select("id, kind, status, created_at")
          .in("status", ["pending", "processing", "failed"])
          .order("created_at", { ascending: false })
          .limit(20),
      ]);
      setCounts({
        pending: pending ?? 0,
        processing: processing ?? 0,
        failed24h: failed24h ?? 0,
        lastDoneAt: lastDone?.completed_at ?? null,
      });
      setJobs((activeJobs ?? []) as RecentJob[]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime — escucha cambios en `ai_grading_queue` para refrescar
  // los contadores sin que el usuario tenga que pulsar refresh. Debounce
  // 800ms para evitar avalanchas cuando el worker drena varios jobs.
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
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary" />
          Cron (IA)
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
      <CardContent className="space-y-2.5 flex-1 flex flex-col min-h-0">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Spinner size="sm" /> Cargando…
          </div>
        ) : (
          <>
            {/* Stats compactas — 3 contadores en una fila. Los íconos van
                INLINE con el número para reducir altura (antes había
                label + número en 2 líneas por tile). */}
            <div className="grid grid-cols-3 gap-2">
              <Stat
                icon={Clock}
                label="Pendientes"
                value={counts.pending}
                color="text-foreground"
              />
              <Stat
                icon={Cpu}
                label="En proceso"
                value={counts.processing}
                color="text-amber-600 dark:text-amber-400"
              />
              <Stat
                icon={AlertTriangle}
                label="Fallados 24h"
                value={counts.failed24h}
                color={counts.failed24h > 0 ? "text-destructive" : "text-foreground"}
              />
            </div>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />
              Último éxito: {counts.lastDoneAt ? formatDateTime(counts.lastDoneAt) : "—"}
            </div>

            {/* Lista compacta de jobs activos — UNA línea por job para
                máxima densidad. Llena el alto disponible del card
                (flex-1 + overflow-y-auto). Sin acciones por fila — esas
                viven en el módulo Cron, accesible vía el link de abajo.
                Si no hay jobs activos, mostramos un mensaje sutil para
                que el card no se vea vacío. */}
            <div className="flex-1 min-h-0 flex flex-col gap-1 border-t pt-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium shrink-0">
                En cola
              </div>
              <div className="flex-1 overflow-y-auto pr-1 space-y-0.5 min-h-0">
                {jobs.length === 0 ? (
                  <div className="text-xs text-muted-foreground italic py-2 text-center">
                    Sin jobs activos.
                  </div>
                ) : (
                  jobs.map((j) => {
                    const kindLabel = KIND_SHORT[j.kind] ?? j.kind;
                    const isProcessing = j.status === "processing";
                    const isFailed = j.status === "failed";
                    return (
                      <div
                        key={j.id}
                        className={`flex items-center gap-2 px-1.5 py-0.5 rounded text-[11px] ${
                          isFailed ? "bg-destructive/5" : ""
                        }`}
                      >
                        {isProcessing ? (
                          <Cpu className="h-3 w-3 text-amber-500 shrink-0 animate-pulse" />
                        ) : isFailed ? (
                          <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />
                        ) : (
                          <Clock className="h-3 w-3 text-muted-foreground shrink-0" />
                        )}
                        <span className="flex-1 truncate">{kindLabel}</span>
                        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                          {relativeAge(j.created_at)}
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Admin: botón directo para drenar la cola sin esperar al
                cron horario. Para Docente solo un badge informativo si
                hay pendientes. */}
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void runNow()}
                disabled={running || counts.pending === 0}
                className="w-full h-8"
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
                {counts.pending} en cola
              </Badge>
            )}
            {activeRole && (
              <Link to={cronModulePath} className="block">
                <Button variant="ghost" size="sm" className="w-full text-xs h-7">
                  Ver módulo Cron <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Tile compacto: ícono + número grande + label chico. Más compacto
 *  que la versión previa con bordes individuales — un solo bloque
 *  con padding mínimo. */
function Stat({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="rounded-md border px-2 py-1.5 text-center">
      <div className="text-[10px] text-muted-foreground flex items-center justify-center gap-1">
        <Icon className="h-2.5 w-2.5" /> {label}
      </div>
      <div className={`text-lg font-bold tabular-nums leading-tight ${color}`}>{value}</div>
    </div>
  );
}
