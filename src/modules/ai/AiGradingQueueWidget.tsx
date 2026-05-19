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

export function AiGradingQueueWidget({ isAdmin = false }: Props) {
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
      // Tres counts + 1 lookup; corren en paralelo.
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
