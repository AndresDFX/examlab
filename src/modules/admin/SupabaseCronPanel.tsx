/**
 * SupabaseCronPanel — gestión de pg_cron desde el módulo "Cron IA".
 *
 * Admin-only. Lista los jobs registrados vía `extensions.cron.schedule`,
 * permite encenderlos/apagarlos y editar su frecuencia (schedule). El
 * `command` (SQL que se ejecuta) se muestra como solo lectura — editarlo
 * desde UI es demasiado riesgoso para una manipulación rápida; eso queda
 * para migraciones versionadas.
 *
 * RPCs:
 *  - admin_list_cron_jobs()
 *  - admin_set_cron_job_active(jobid, active)
 *  - admin_update_cron_job_schedule(jobid, schedule)
 *
 * Si pg_cron no está disponible (entorno local sin la extensión), la
 * lista llega vacía y mostramos un estado explicativo.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableEmpty } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  CalendarClock,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Pencil,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/shared/lib/format";

interface CronJob {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_message: string | null;
}

/** Traduce expresiones cron comunes a lenguaje natural. No pretende ser
 *  cron-parser completo (eso es 5KB de regex); cubre los patrones
 *  típicos en el proyecto y deja el raw para los que no matchean. */
function describeSchedule(s: string): string {
  const t = s.trim();
  if (t.startsWith("@")) {
    const map: Record<string, string> = {
      "@hourly": "Cada hora",
      "@daily": "Cada día a medianoche",
      "@weekly": "Cada lunes a medianoche",
      "@monthly": "Día 1 de cada mes",
      "@yearly": "Cada 1 de enero",
      "@annually": "Cada 1 de enero",
      "@reboot": "Al iniciar el servidor",
    };
    return map[t] ?? t;
  }
  const parts = t.split(/\s+/);
  if (parts.length < 5) return t;
  const [m, h, dom, mon, dow] = parts;
  // Patrones comunes
  if (m === "*" && h === "*" && dom === "*" && mon === "*" && dow === "*") return "Cada minuto";
  if (/^\*\/\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Cada ${m.slice(2)} minutos`;
  }
  if (/^\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") {
    return `Cada hora en el minuto ${m}`;
  }
  if (h.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    return `Cada ${h.slice(2)} horas en el minuto ${m}`;
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === "*" && mon === "*" && dow === "*") {
    return `Diario a las ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`;
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(dom) && mon === "*" && dow === "*") {
    return `Día ${dom} de cada mes a las ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`;
  }
  return t;
}

export function SupabaseCronPanel() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // jobs en flight por acción (set para soportar clicks paralelos)
  const [toggling, setToggling] = useState<Set<number>>(new Set());
  // Dialog de edición de schedule. Lo abrimos con el job actual.
  const [editingJob, setEditingJob] = useState<CronJob | null>(null);
  const [editSchedule, setEditSchedule] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("admin_list_cron_jobs");
      if (error) {
        toast.error(error.message ?? "Error cargando cron jobs");
        setUnavailable(true);
        setJobs([]);
        return;
      }
      const list = (data ?? []) as CronJob[];
      setJobs(list);
      setUnavailable(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleActive = async (job: CronJob) => {
    if (toggling.has(job.jobid)) return;
    setToggling((prev) => new Set(prev).add(job.jobid));
    // Optimistic UI — flip al instante. Si el RPC falla, revertimos al
    // valor previo y mostramos error. Hace la interacción más natural,
    // pero importante limpiarla en el catch.
    const previous = job.active;
    setJobs((prev) =>
      prev.map((j) => (j.jobid === job.jobid ? { ...j, active: !previous } : j)),
    );
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("admin_set_cron_job_active", {
        _jobid: job.jobid,
        _active: !previous,
      });
      if (error) {
        // Revert
        setJobs((prev) =>
          prev.map((j) => (j.jobid === job.jobid ? { ...j, active: previous } : j)),
        );
        toast.error(error.message ?? "No se pudo cambiar el estado");
        return;
      }
      toast.success(!previous ? `"${job.jobname}" activado` : `"${job.jobname}" pausado`);
    } finally {
      setToggling((prev) => {
        const next = new Set(prev);
        next.delete(job.jobid);
        return next;
      });
    }
  };

  const openEdit = (job: CronJob) => {
    setEditingJob(job);
    setEditSchedule(job.schedule);
  };

  const saveSchedule = async () => {
    if (!editingJob) return;
    const trimmed = editSchedule.trim();
    if (trimmed === editingJob.schedule) {
      setEditingJob(null);
      return;
    }
    setSavingSchedule(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("admin_update_cron_job_schedule", {
        _jobid: editingJob.jobid,
        _schedule: trimmed,
      });
      if (error) {
        toast.error(error.message ?? "No se pudo actualizar la frecuencia");
        return;
      }
      toast.success(`Frecuencia de "${editingJob.jobname}" actualizada`);
      setEditingJob(null);
      await load();
    } finally {
      setSavingSchedule(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="pb-3 flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-indigo-500" />
              Jobs de Supabase (pg_cron)
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Pausa, reanuda o cambia la frecuencia de los jobs programados. El SQL que ejecuta
              cada job es de solo lectura — para modificarlo, usa una migración. Las horas están
              en UTC.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => void load()}
            title="Refrescar"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
              <Spinner size="sm" /> Cargando…
            </div>
          ) : unavailable ? (
            <TableEmpty
              icon={AlertTriangle}
              title="No se pudo acceder a pg_cron"
              description="Revisa que la migración 20260603104000 esté aplicada y que tengas rol Admin."
            />
          ) : jobs.length === 0 ? (
            <TableEmpty
              icon={CalendarClock}
              title="pg_cron no disponible o sin jobs"
              description="La extensión pg_cron no está habilitada en este proyecto, o no hay jobs registrados. Los jobs se programan vía migraciones SQL."
            />
          ) : (
            <div className="divide-y">
              {jobs.map((job) => {
                const expanded = expandedId === job.jobid;
                const isToggling = toggling.has(job.jobid);
                const human = describeSchedule(job.schedule);
                const showsHuman = human !== job.schedule;
                const lastFailed = job.last_status && job.last_status !== "succeeded";
                return (
                  <div key={job.jobid} className="text-sm">
                    <div className="px-3 py-2.5 flex items-center gap-3 hover:bg-muted/40 transition-colors">
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : job.jobid)}
                        className="flex items-center gap-2 flex-1 min-w-0 text-left"
                        title={expanded ? "Ocultar detalle" : "Ver detalle"}
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate">{job.jobname}</span>
                            {!job.active && (
                              <Badge variant="secondary" className="text-[10px] shrink-0">
                                Pausado
                              </Badge>
                            )}
                            {lastFailed && (
                              <Badge variant="destructive" className="text-[10px] shrink-0">
                                Último: {job.last_status}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground truncate">
                            <code className="font-mono">{job.schedule}</code>
                            {showsHuman && <span> · {human}</span>}
                          </div>
                        </div>
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0"
                        onClick={() => openEdit(job)}
                        title="Editar frecuencia"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <div className="flex items-center gap-2 shrink-0">
                        {isToggling ? (
                          <Spinner size="sm" />
                        ) : (
                          <Switch
                            checked={job.active}
                            onCheckedChange={() => void toggleActive(job)}
                            aria-label={job.active ? "Pausar" : "Activar"}
                          />
                        )}
                      </div>
                    </div>
                    {expanded && (
                      <div className="px-10 pr-3 pb-3 text-xs space-y-2 bg-muted/20 border-t">
                        <DetailRow k="Job ID" v={String(job.jobid)} mono />
                        <DetailRow k="Estado" v={job.active ? "Activo" : "Pausado"} />
                        <DetailRow k="Frecuencia" v={job.schedule} mono />
                        {showsHuman && <DetailRow k="Equivale a" v={human} />}
                        {job.last_run_at && (
                          <DetailRow k="Última ejecución" v={formatDateTime(job.last_run_at)} />
                        )}
                        {job.last_status && (
                          <DetailRow
                            k="Último estado"
                            v={job.last_status}
                            highlight={lastFailed ? "destructive" : "success"}
                          />
                        )}
                        {job.last_message && (
                          <div>
                            <div className="text-muted-foreground mb-0.5">Último mensaje</div>
                            <pre
                              className={`text-[11px] rounded p-2 whitespace-pre-wrap break-all border ${
                                lastFailed
                                  ? "bg-destructive/10 text-destructive border-destructive/30"
                                  : "bg-muted/40 border-muted-foreground/20"
                              }`}
                            >
                              {job.last_message}
                            </pre>
                          </div>
                        )}
                        <div>
                          <div className="text-muted-foreground mb-0.5">
                            Comando (solo lectura)
                          </div>
                          <pre className="text-[11px] bg-muted/40 border border-muted-foreground/20 rounded p-2 whitespace-pre-wrap break-all font-mono">
                            {job.command}
                          </pre>
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

      <Dialog
        open={!!editingJob}
        onOpenChange={(open) => {
          if (!open) setEditingJob(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Editar frecuencia</DialogTitle>
            <DialogDescription>
              Job <strong>{editingJob?.jobname}</strong>. Acepta el formato cron clásico de 5
              campos (<code>m h dom mon dow</code>) o un alias <code>@hourly</code>,{" "}
              <code>@daily</code>, etc.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="cron-schedule" required>
                Expresión cron
              </Label>
              <Input
                id="cron-schedule"
                value={editSchedule}
                onChange={(e) => setEditSchedule(e.target.value)}
                placeholder="*/15 * * * *"
                className="font-mono"
                autoFocus
              />
              {editSchedule.trim() && (
                <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <CheckCircle2 className="h-3 w-3 text-emerald-500 mt-0.5 shrink-0" />
                  <span>{describeSchedule(editSchedule)}</span>
                </p>
              )}
            </div>
            <div className="text-xs text-muted-foreground space-y-1">
              <p className="font-medium">Ejemplos:</p>
              <ul className="list-disc list-inside space-y-0.5 ml-1">
                <li>
                  <code>*/15 * * * *</code> — cada 15 minutos
                </li>
                <li>
                  <code>0 7 * * *</code> — todos los días a las 07:00 UTC
                </li>
                <li>
                  <code>5 * * * *</code> — cada hora en el minuto 5
                </li>
                <li>
                  <code>@hourly</code> — alias por hora exacta
                </li>
              </ul>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setEditingJob(null)}
              disabled={savingSchedule}
            >
              Cancelar
            </Button>
            <Button onClick={() => void saveSchedule()} disabled={savingSchedule}>
              {savingSchedule && <Spinner size="sm" className="mr-1" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DetailRow({
  k,
  v,
  mono = false,
  highlight,
}: {
  k: string;
  v: string;
  mono?: boolean;
  highlight?: "success" | "destructive";
}) {
  const color =
    highlight === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : highlight === "destructive"
        ? "text-destructive"
        : "";
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted-foreground w-32 shrink-0">{k}</span>
      <span className={`flex-1 break-all ${mono ? "font-mono text-[11px]" : ""} ${color}`}>
        {v}
      </span>
    </div>
  );
}
