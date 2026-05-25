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
import { Spinner } from "@/components/ui/spinner";
import {
  Clock,
  Cpu,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ArrowRight,
  ListOrdered,
} from "lucide-react";
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
  /** TODOS los jobs en estado `failed` (sin ventana de tiempo) — debe
   *  coincidir con la lista "En cola", que muestra todos los failed. */
  failed: number;
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
    failed: 0,
    lastDoneAt: null,
  });
  // Lista compacta de jobs activos para llenar el alto del card cuando
  // el dashboard lo estira a viewport-fill. Sin acciones por fila (esas
  // viven en el módulo Cron); solo un glance de "qué hay pendiente".
  const [jobs, setJobs] = useState<RecentJob[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Cuatro head-counts + lista compacta de jobs activos. La lista
      // se muestra en un overflow-y-auto dentro del card; trae hasta 20
      // para que el alumno típico vea todo lo que está en cola.
      // `failed` cuenta TODOS los failed (sin ventana 24h) para que el
      // contador coincida con la lista "En cola" — antes un fallo de
      // hace >24h aparecía en la lista pero no sumaba en el contador.
      const [
        { count: pending },
        { count: processing },
        { count: failed },
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
          .eq("status", "failed"),
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
        failed: failed ?? 0,
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

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ListOrdered className="h-4 w-4 text-primary" />
          Cola (IA)
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
            {/* Stats — mismo estilo visual que el widget "Correos
                (últimas 24h)" del dashboard admin (ver app.index.tsx
                `EmailStatTile`): bloque con bg tintado, número grande
                arriba, label abajo. Unifica la apariencia de los dos
                widgets de salud del dashboard. */}
            <div className="grid grid-cols-3 gap-2">
              {/* Pendientes = pending + failed: un job fallado sigue sin
                  calificar. Los failed se desglosan en su propio tile. */}
              <Stat
                label="Pendientes"
                value={counts.pending + counts.failed}
                color="text-sky-600 dark:text-sky-400"
                bg="bg-sky-500/10"
              />
              <Stat
                label="En proceso"
                value={counts.processing}
                color="text-amber-600 dark:text-amber-400"
                bg="bg-amber-500/10"
              />
              <Stat
                label="Fallados"
                value={counts.failed}
                color="text-destructive"
                bg="bg-destructive/10"
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

            {/* Eliminamos el badge "X en cola": duplicaba la stat tile
                superior "Pendientes" y el conteo de items renderizados
                bajo "EN COLA". Tres copias del mismo número en el mismo
                card era ruido visual. */}
            {activeRole && (
              <Link to={cronModulePath} className="block">
                <Button variant="ghost" size="sm" className="w-full text-xs h-7">
                  Ver Cola <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Tile con fondo tintado, número grande arriba y label abajo.
 *  Idéntico en estilo al `EmailStatTile` del dashboard admin
 *  (app.index.tsx) para que los dos widgets de salud usen el mismo
 *  vocabulario visual. */
function Stat({
  label,
  value,
  color,
  bg,
}: {
  label: string;
  value: number;
  color: string;
  bg: string;
}) {
  return (
    <div className={`rounded-md p-2.5 ${bg}`}>
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
