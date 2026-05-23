/**
 * SupabaseCronPanel — gestión de pg_cron desde el módulo "Cola" (tab
 * "Tareas programadas").
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
import { Textarea } from "@/components/ui/textarea";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
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
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";

interface CronJob {
  jobid: number;
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_message: string | null;
  /** Descripción humana del propósito del job. La RPC la trae vía
   *  LEFT JOIN con `cron_job_descriptions` — `null` si el admin no la
   *  configuró todavía. */
  description: string | null;
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
  // Dialog separado para editar la descripción humana del job. Es una
  // edición distinta a la del schedule porque (a) el schedule es
  // técnico/funcional y (b) la descripción es texto libre — un solo
  // dialog combinado las mezclaba conceptualmente.
  const [editingDesc, setEditingDesc] = useState<CronJob | null>(null);
  const [editDescText, setEditDescText] = useState("");
  const [savingDesc, setSavingDesc] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("admin_list_cron_jobs");
      if (error) {
        toast.error(friendlyError(error, "Error cargando cron jobs"));
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
        toast.error(friendlyError(error, "No se pudo cambiar el estado"));
        return;
      }
      toast.success(
        !previous
          ? `"${job.jobname}" activado — aplica al próximo tick del scheduler (~1 min)`
          : `"${job.jobname}" pausado — no se disparará en el próximo tick`,
      );
      // Re-fetch para confirmar contra DB que el cambio realmente se
      // aplicó (cron.alter_job actualiza la fila inmediatamente — pero
      // si por alguna razón el alter_job no encontró el job, queremos
      // que la UI lo refleje en vez de mostrar el optimistic estado).
      await load();
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

  const openEditDesc = (job: CronJob) => {
    setEditingDesc(job);
    setEditDescText(job.description ?? "");
  };

  const saveDesc = async () => {
    if (!editingDesc) return;
    const trimmed = editDescText.trim();
    if (trimmed === (editingDesc.description ?? "").trim()) {
      setEditingDesc(null);
      return;
    }
    setSavingDesc(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("admin_set_cron_job_description", {
        _jobname: editingDesc.jobname,
        _description: trimmed,
      });
      if (error) {
        toast.error(friendlyError(error, "No se pudo actualizar la descripción"));
        return;
      }
      toast.success(`Descripción de "${editingDesc.jobname}" actualizada`);
      setEditingDesc(null);
      await load();
    } finally {
      setSavingDesc(false);
    }
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
        toast.error(friendlyError(error, "No se pudo actualizar la frecuencia"));
        return;
      }
      toast.success(
        `Frecuencia de "${editingJob.jobname}" actualizada — aplica al próximo tick (~1 min)`,
      );
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
              Tareas programadas
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              Pausa, reanuda o cambia la frecuencia de los jobs programados. El SQL que ejecuta
              cada job es de solo lectura — para modificarlo, usa una migración. Las horas están
              en UTC. <strong>Los cambios se aplican inmediatamente</strong> a la tabla{" "}
              <code>cron.job</code>; el scheduler de pg_cron los respeta en su próximo tick (hasta
              ~1 minuto).
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
            <ErrorState
              message="No se pudo acceder a pg_cron"
              hint="Revisa que la migración 20260603104000 esté aplicada y que tengas rol Admin."
              onRetry={() => void load()}
            />
          ) : jobs.length === 0 ? (
            <TableEmpty
              icon={CalendarClock}
              title="No hay tareas programadas todavía"
              description="La extensión pg_cron no está habilitada en este proyecto Supabase, o las migraciones que registran los jobs (ej. db-backup-weekly, ai-grading-worker-hourly) no se han publicado. Las tareas se programan vía migraciones SQL; no se crean desde esta UI."
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
                          {/* Preview de la descripción en la fila. Si no
                              hay descripción configurada, mostramos el
                              hint en cursiva para invitar a llenarla. */}
                          {job.description ? (
                            <div className="text-xs text-foreground/70 truncate mt-0.5">
                              {job.description}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground/70 italic mt-0.5">
                              Sin descripción — pulsa el ícono de texto para agregar una.
                            </div>
                          )}
                        </div>
                      </button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0"
                        onClick={() => openEditDesc(job)}
                        title="Editar descripción"
                      >
                        <FileText className="h-3.5 w-3.5" />
                      </Button>
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
                        {/* Descripción ARRIBA del bloque técnico — es lo
                            más importante para entender qué hace el job.
                            Renderizamos como párrafo (no DetailRow) para
                            soportar textos largos sin overflow lateral. */}
                        {job.description ? (
                          <div className="pt-2">
                            <div className="text-muted-foreground mb-0.5">Descripción</div>
                            <p className="text-foreground/90 leading-relaxed whitespace-pre-wrap">
                              {job.description}
                            </p>
                          </div>
                        ) : (
                          <div className="pt-2 text-muted-foreground italic">
                            Sin descripción configurada — pulsa el ícono{" "}
                            <FileText className="inline h-3 w-3 align-text-bottom" /> en la fila
                            para agregar una.
                          </div>
                        )}
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

      {/* Dialog separado para editar la descripción humana. Decisión:
          dialogs separados (no uno combinado con tabs) porque la
          edición de schedule es operación riesgosa (afecta cuándo se
          dispara el job) mientras que editar texto descriptivo es
          benigno — mezclarlos invita a errores. */}
      <Dialog
        open={!!editingDesc}
        onOpenChange={(open) => {
          if (!open) setEditingDesc(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Editar descripción</DialogTitle>
            <DialogDescription>
              Job <strong>{editingDesc?.jobname}</strong>. La descripción ayuda a futuros admins
              (o a ti mismo en seis meses) a saber QUÉ hace el job y qué impacto tiene pausarlo,
              sin tener que leer el SQL.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="cron-desc">Descripción</Label>
            <Textarea
              id="cron-desc"
              value={editDescText}
              onChange={(e) => setEditDescText(e.target.value)}
              placeholder="Ej. Cada hora drena la cola ai_grading_queue y aplica las calificaciones IA."
              rows={6}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Idealmente: qué hace, con qué frecuencia, y qué pasa si se pausa.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditingDesc(null)} disabled={savingDesc}>
              Cancelar
            </Button>
            <Button onClick={() => void saveDesc()} disabled={savingDesc}>
              {savingDesc && <Spinner size="sm" className="mr-1" />}
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
