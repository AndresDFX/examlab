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
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const since24 = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      // Cuatro head-counts en paralelo. Sin lista de jobs porque el
      // widget es solo glance — los detalles viven en /app/(role)/ai-cron.
      const [{ count: pending }, { count: processing }, { count: failed24h }, { data: lastDone }] =
        await Promise.all([
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
      <CardContent className="space-y-2.5">
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
                {counts.pending} en cola — próximo turno
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
