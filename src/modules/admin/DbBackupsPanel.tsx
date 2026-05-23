/**
 * Panel de Backups de la BD (Admin).
 *
 * Vista principal del módulo. Permite al Admin:
 *   1. Listar todos los snapshots con estado, tamaño y cantidad de
 *      tablas exportadas.
 *   2. Crear un backup nuevo eligiendo las tablas a respaldar (manual).
 *   3. Descargar un backup vía signed URL (válido 5 min).
 *   4. Borrar un backup (fila + archivo en Storage).
 *
 * NO incluye restauración desde UI — los snapshots son JSON inspecciona-
 * bles que el admin aplica manualmente vía SQL si hace falta. Es la
 * decisión consciente: cero riesgo de que un click destruya datos en
 * producción.
 *
 * Cron semanal vive en pg_cron como `db-backup-weekly` (domingos 03:05
 * UTC) — visible y pausable desde el módulo Cola → tab Tareas programadas.
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import { ErrorState, TableEmpty } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { RowAction } from "@/components/ui/row-action";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import {
  Database,
  Download,
  Trash2,
  RefreshCw,
  Plus,
  HardDrive,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Cpu,
  Info,
} from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface BackupRow {
  id: string;
  created_at: string;
  created_by: string | null;
  label: string | null;
  tables: string[];
  source: "manual" | "cron";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  started_at: string | null;
  completed_at: string | null;
  file_path: string | null;
  size_bytes: number | null;
  row_count: number | null;
  error: string | null;
}

interface TableInfo {
  table_name: string;
  est_rows: number;
}

/** Formatea bytes a "1.2 MB" / "456 KB" / "789 B". */
function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function DbBackupsPanel() {
  const confirm = useConfirm();

  const [backups, setBackups] = useState<BackupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // Dialog de creación
  const [createOpen, setCreateOpen] = useState(false);
  const [tableInfos, setTableInfos] = useState<TableInfo[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("db_backups")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar los backups."));
      setLoading(false);
      return;
    }
    setBackups((data ?? []) as BackupRow[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Polling cada 5s mientras hay un backup queued/running — así la UI
  // refleja el progreso sin que el admin tenga que recargar. Realtime
  // sobre db_backups sería más limpio pero el polling es más simple y
  // suficiente para una operación que tarda < 1min en la mayoría de
  // casos. Para detenerlo apenas no hay activos.
  const hasActive = useMemo(
    () => backups.some((b) => b.status === "queued" || b.status === "running"),
    [backups],
  );
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive]);

  // ─── Stats ──────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const lastDone = backups.find((b) => b.status === "done");
    const totalBytes = backups
      .filter((b) => b.status === "done")
      .reduce((sum, b) => sum + (b.size_bytes ?? 0), 0);
    return {
      total: backups.length,
      successful: backups.filter((b) => b.status === "done").length,
      lastDoneAt: lastDone?.completed_at ?? null,
      lastDoneSize: lastDone?.size_bytes ?? null,
      totalBytes,
    };
  }, [backups]);

  // ─── Crear backup ───────────────────────────────────────────────────
  const openCreateDialog = async () => {
    setCreateOpen(true);
    setLoadingTables(true);
    setSelectedTables(new Set());
    setNewLabel("");
    const { data, error } = await db.rpc("admin_list_backupable_tables");
    setLoadingTables(false);
    if (error) {
      toast.error(friendlyError(error, "No pudimos cargar las tablas disponibles."));
      return;
    }
    const infos = (data ?? []) as TableInfo[];
    setTableInfos(infos);
    // Pre-selecciona todas — el caso común es backup completo y el
    // admin desmarca lo que no quiere (más rápido que marcarlas todas
    // una por una cuando hay ~40 tablas).
    setSelectedTables(new Set(infos.map((t) => t.table_name)));
  };

  const toggleTable = (name: string) => {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAllTables = () => {
    setSelectedTables(new Set(tableInfos.map((t) => t.table_name)));
  };

  const selectNoneTables = () => {
    setSelectedTables(new Set());
  };

  const createBackup = async () => {
    if (selectedTables.size === 0) {
      toast.error("Elige al menos una tabla.");
      return;
    }
    setCreating(true);
    try {
      // 1) Encolar (RPC crea fila status='queued' y devuelve id).
      const { data: backupId, error: rpcErr } = await db.rpc("admin_enqueue_db_backup", {
        _tables: Array.from(selectedTables),
        _label: newLabel.trim() || null,
        _source: "manual",
      });
      if (rpcErr) throw rpcErr;

      // 2) Disparar la edge function. No await porque el backup puede
      //    tardar minutos para tablas grandes — el polling de status
      //    refresca la UI. Capturamos fallas inmediatas (red caída,
      //    edge no desplegada) en .then para que el row no quede en
      //    queued para siempre.
      void supabase.functions
        .invoke("db-backup-runner", { body: { backupId } })
        .then(async ({ data: invData, error: invErr }) => {
          if (invErr || (invData as { error?: string })?.error) {
            const detail = await extractEdgeError(invErr, invData);
            toast.error(
              friendlyError(invErr ?? new Error(detail || "No se pudo iniciar el backup")),
            );
          }
        });

      toast.success("Backup iniciado — refrescará automáticamente cuando termine.");
      setCreateOpen(false);
      await load();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setCreating(false);
    }
  };

  // ─── Descargar backup (signed URL) ──────────────────────────────────
  const downloadBackup = async (row: BackupRow) => {
    if (!row.file_path) {
      toast.error("Este backup no tiene archivo disponible.");
      return;
    }
    // 5 min de validez — suficiente para que el navegador inicie la
    // descarga. No regalamos URLs eternas: si el admin quiere bajarlo
    // otra vez clickea otra vez (genera URL nueva).
    const { data, error } = await db.storage
      .from("db-backups")
      .createSignedUrl(row.file_path, 300);
    if (error || !data?.signedUrl) {
      toast.error(friendlyError(error, "No se pudo generar la URL de descarga."));
      return;
    }
    // Forzamos la descarga con `download` attr — sin esto el browser
    // intenta abrir el ZIP inline en algunos casos.
    const a = document.createElement("a");
    a.href = data.signedUrl;
    a.download = `examlab-backup-${row.id}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  // ─── Borrar backup ──────────────────────────────────────────────────
  const deleteBackup = async (row: BackupRow) => {
    const ok = await confirm({
      title: `¿Borrar este backup?`,
      description: row.file_path
        ? `Se eliminará el archivo del bucket y la fila de control. Esta acción no se puede deshacer.`
        : `Se eliminará la fila de control. Esta acción no se puede deshacer.`,
      tone: "destructive",
      confirmLabel: "Borrar",
    });
    if (!ok) return;
    const { error } = await db.rpc("admin_delete_db_backup", { _id: row.id });
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Backup eliminado.");
    void load();
  };

  // ─── Procesar ahora (drenar queued) ─────────────────────────────────
  // Cuando el cron no está habilitado en el proyecto o cuando un backup
  // se quedó queued por una falla, el admin puede dispararlo a mano.
  const processQueued = async (backupId: string) => {
    const { data, error } = await supabase.functions.invoke("db-backup-runner", {
      body: { backupId },
    });
    if (error || (data as { error?: string })?.error) {
      const detail = await extractEdgeError(error, data);
      toast.error(friendlyError(error ?? new Error(detail || "Falló el backup")));
      return;
    }
    toast.success("Backup procesado.");
    void load();
  };

  // ─── Render ─────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <ErrorState
        message="No pudimos cargar los backups"
        hint={loadError}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Database className="h-4 w-4 text-indigo-500" />
            Backups de la base de datos
            <HelpHint>
              Snapshots lógicos de las tablas a un ZIP en Storage. El cron `db-backup-weekly`
              corre los domingos 03:05 UTC y crea uno con todas las tablas; el botón "Crear
              backup" deja generar uno manual eligiendo qué tablas incluir. NO hay restore
              desde la UI por seguridad — descargá el ZIP y aplicá vía SQL si hace falta.
            </HelpHint>
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
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat
              label="Total backups"
              value={String(stats.total)}
              color="text-foreground"
              bg="bg-muted/30"
            />
            <Stat
              label="Exitosos"
              value={String(stats.successful)}
              color="text-emerald-600 dark:text-emerald-400"
              bg="bg-emerald-500/10"
            />
            <Stat
              label="Espacio usado"
              value={formatBytes(stats.totalBytes)}
              color="text-sky-600 dark:text-sky-400"
              bg="bg-sky-500/10"
            />
            <Stat
              label="Último exitoso"
              value={stats.lastDoneAt ? formatDateTime(stats.lastDoneAt) : "—"}
              color="text-foreground"
              bg="bg-muted/30"
              size="sm"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => void openCreateDialog()}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Crear backup
            </Button>
            <span className="text-[11px] text-muted-foreground">
              El cron semanal corre cada domingo 03:05 UTC.
            </span>
          </div>

          <Alert className="bg-amber-500/5 border-amber-500/30">
            <Info className="h-4 w-4 text-amber-500" />
            <AlertDescription className="text-xs">
              Los snapshots viven en el mismo proyecto Supabase. Si lo que se rompe es el
              proyecto entero, descargá los ZIP críticos a tu máquina o cloud externo
              periódicamente.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <HardDrive className="h-4 w-4 text-muted-foreground" />
            Histórico
            <Badge variant="secondary" className="text-[10px]">
              {backups.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <TableSkeleton cols={6} rows={4} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Etiqueta</TableHead>
                  <TableHead className="hidden sm:table-cell">Origen</TableHead>
                  <TableHead className="hidden md:table-cell text-right">Tablas</TableHead>
                  <TableHead className="hidden md:table-cell text-right">Filas</TableHead>
                  <TableHead className="text-right">Tamaño</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="text-right w-32">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {backups.length === 0 ? (
                  <TableEmpty
                    colSpan={8}
                    icon={Database}
                    text="Sin backups todavía."
                    hint="Creá uno con el botón “Crear backup” o esperá al cron semanal."
                  />
                ) : (
                  backups.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell className="text-xs tabular-nums whitespace-nowrap">
                        {formatDateTime(b.created_at)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {b.label || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge
                          variant="outline"
                          className="text-[10px]"
                        >
                          {b.source === "cron" ? "Auto" : "Manual"}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className="hidden md:table-cell text-xs tabular-nums text-right"
                        title={b.tables.join(", ")}
                      >
                        {b.tables.length}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs tabular-nums text-right">
                        {b.row_count != null ? b.row_count.toLocaleString("es-CO") : "—"}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums text-right">
                        {formatBytes(b.size_bytes)}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={b.status} error={b.error} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-0.5">
                          {b.status === "queued" && (
                            <RowAction
                              label="Procesar ahora"
                              icon={Cpu}
                              onClick={() => void processQueued(b.id)}
                            />
                          )}
                          {b.status === "done" && b.file_path && (
                            <RowAction
                              label="Descargar"
                              icon={Download}
                              onClick={() => void downloadBackup(b)}
                            />
                          )}
                          <RowAction
                            label="Borrar"
                            icon={Trash2}
                            tone="destructive"
                            onClick={() => void deleteBackup(b)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ─── Dialog: crear backup ─────────────────────────────────── */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="h-4 w-4 text-indigo-500" />
              Crear backup manual
            </DialogTitle>
            <DialogDescription className="text-xs">
              Elegí las tablas a exportar. El edge function genera un ZIP con un{" "}
              <code className="text-[10px] bg-muted px-1 py-0.5 rounded">.json</code> por
              tabla más un <code className="text-[10px] bg-muted px-1 py-0.5 rounded">
                metadata.json
              </code>{" "}
              con el resumen.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label className="text-[11px]">Etiqueta (opcional)</Label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Ej. Pre-deploy migración cortes"
                maxLength={200}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[11px]">
                  Tablas a respaldar
                  <span className="text-muted-foreground ml-1">
                    ({selectedTables.size} de {tableInfos.length})
                  </span>
                </Label>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] px-2"
                    onClick={selectAllTables}
                    disabled={loadingTables}
                  >
                    Todas
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] px-2"
                    onClick={selectNoneTables}
                    disabled={loadingTables}
                  >
                    Ninguna
                  </Button>
                </div>
              </div>
              {loadingTables ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                  <Spinner size="sm" /> Cargando tablas…
                </div>
              ) : (
                <div className="border rounded-md max-h-64 overflow-y-auto">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-2">
                    {tableInfos.map((t) => (
                      <label
                        key={t.table_name}
                        className="flex items-center gap-2 px-2 py-1 hover:bg-muted/50 cursor-pointer text-xs"
                      >
                        <Checkbox
                          checked={selectedTables.has(t.table_name)}
                          onCheckedChange={() => toggleTable(t.table_name)}
                        />
                        <span className="font-mono truncate flex-1" title={t.table_name}>
                          {t.table_name}
                        </span>
                        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                          {/* `est_rows` es estimación de pg_class (puede
                              ser -1 si la tabla nunca tuvo ANALYZE). En
                              ese caso mostramos "—" en vez de "-1" para
                              no confundir. */}
                          {t.est_rows > 0 ? `~${t.est_rows.toLocaleString("es-CO")}` : "—"}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancelar
            </Button>
            <Button onClick={() => void createBackup()} disabled={creating || loadingTables}>
              {creating ? <Spinner size="sm" className="mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
              Crear backup
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Helpers de presentación ──────────────────────────────────────────

function Stat({
  label,
  value,
  color,
  bg,
  size = "lg",
}: {
  label: string;
  value: string;
  color: string;
  bg: string;
  size?: "sm" | "lg";
}) {
  return (
    <div className={`rounded-md p-2.5 ${bg}`}>
      <div
        className={`${size === "sm" ? "text-[11px]" : "text-2xl"} font-semibold tabular-nums ${color}`}
      >
        {value}
      </div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function StatusBadge({ status, error }: { status: BackupRow["status"]; error: string | null }) {
  const map: Record<BackupRow["status"], { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ComponentType<{ className?: string }> }> = {
    queued: { label: "En cola", variant: "outline", icon: Clock },
    running: { label: "Procesando", variant: "secondary", icon: Cpu },
    done: { label: "OK", variant: "default", icon: CheckCircle2 },
    failed: { label: "Falló", variant: "destructive", icon: AlertTriangle },
    cancelled: { label: "Cancelado", variant: "outline", icon: AlertTriangle },
  };
  const m = map[status];
  const Icon = m.icon;
  return (
    <Badge
      variant={m.variant}
      className="text-[10px] inline-flex items-center gap-1"
      title={error ?? undefined}
    >
      <Icon className={`h-2.5 w-2.5 ${status === "running" ? "animate-pulse" : ""}`} />
      {m.label}
    </Badge>
  );
}
