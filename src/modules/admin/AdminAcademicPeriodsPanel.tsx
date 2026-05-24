/**
 * Panel CRUD de Periodos Académicos (Admin).
 *
 * Modela el ciclo institucional (semestre/trimestre/etc). Cada
 * `course.period_id` apunta acá. Estados:
 *   - planificado → futuro o sin fecha. Editable.
 *   - activo      → en curso. Editable.
 *   - cerrado     → finalizado, no se modifican calificaciones.
 *                   Marca `closed_at` + `closed_by` para trazabilidad.
 *
 * La duda principal sobre eliminar: si se borra un periodo, los
 * cursos asociados quedan con period_id NULL (ON DELETE SET NULL).
 * Se conserva `courses.period` (text) como respaldo de display.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ErrorState, TableEmpty } from "@/components/ui/empty-state";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { DateCell } from "@/components/ui/date-cell";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { CalendarRange, Plus, Pencil, Trash2, Lock, Unlock } from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Status = "planificado" | "activo" | "cerrado";

interface AcademicPeriod {
  id: string;
  code: string;
  name: string | null;
  start_date: string | null;
  end_date: string | null;
  status: Status;
  closed_at: string | null;
}

interface Draft {
  id: string | null;
  code: string;
  name: string;
  start_date: string;
  end_date: string;
  status: Status;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  code: "",
  name: "",
  start_date: "",
  end_date: "",
  status: "planificado",
};

const STATUS_BADGE: Record<Status, { label: string; cls: string }> = {
  planificado: {
    label: "Planificado",
    cls: "border-slate-300 text-slate-700 dark:border-slate-500/40 dark:text-slate-300",
  },
  activo: {
    label: "Activo",
    cls: "border-emerald-400 text-emerald-700 dark:border-emerald-500/50 dark:text-emerald-300",
  },
  cerrado: {
    label: "Cerrado",
    cls: "border-amber-400 text-amber-700 dark:border-amber-500/50 dark:text-amber-300",
  },
};

export function AdminAcademicPeriodsPanel() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState<AcademicPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("academic_periods")
      .select("id, code, name, start_date, end_date, status, closed_at")
      .order("code", { ascending: false });
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar los periodos."));
      setLoading(false);
      return;
    }
    setRows((data ?? []) as AcademicPeriod[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  const openNew = () => {
    setDraft(EMPTY_DRAFT);
    setOpen(true);
  };

  const openEdit = (r: AcademicPeriod) => {
    setDraft({
      id: r.id,
      code: r.code,
      name: r.name ?? "",
      start_date: r.start_date ?? "",
      end_date: r.end_date ?? "",
      status: r.status,
    });
    setOpen(true);
  };

  const save = async () => {
    if (!user) return;
    const code = draft.code.trim();
    if (!code) {
      toast.error("El código es obligatorio");
      return;
    }
    if (draft.start_date && draft.end_date && draft.start_date > draft.end_date) {
      toast.error("La fecha de inicio debe ser anterior a la de fin");
      return;
    }
    setSaving(true);
    const payload: Record<string, unknown> = {
      code,
      name: draft.name.trim() || null,
      start_date: draft.start_date || null,
      end_date: draft.end_date || null,
      status: draft.status,
      updated_by: user.id,
    };
    // closed_at/closed_by se setean automáticamente al pasar a 'cerrado'.
    // Si el draft cambió de cerrado→otro estado, los limpiamos.
    if (draft.status === "cerrado") {
      // Solo marcar si todavía no estaba cerrado (no pisar timestamp original)
      const existing = rows.find((r) => r.id === draft.id);
      if (!existing || existing.status !== "cerrado") {
        payload.closed_at = new Date().toISOString();
        payload.closed_by = user.id;
      }
    } else {
      payload.closed_at = null;
      payload.closed_by = null;
    }
    const { error } = draft.id
      ? await db.from("academic_periods").update(payload).eq("id", draft.id)
      : await db.from("academic_periods").insert(payload);
    setSaving(false);
    if (error) {
      toast.error(friendlyError(error, "No se pudo guardar el periodo"));
      return;
    }
    toast.success(draft.id ? "Periodo actualizado" : "Periodo creado");
    setOpen(false);
    void load();
  };

  const toggleClose = async (r: AcademicPeriod) => {
    if (!user) return;
    const newStatus: Status = r.status === "cerrado" ? "activo" : "cerrado";
    const ok = await confirm({
      title: newStatus === "cerrado" ? `¿Cerrar el periodo "${r.code}"?` : `¿Reabrir el periodo "${r.code}"?`,
      description:
        newStatus === "cerrado"
          ? "Quedará marcado como cerrado. Próximamente esto bloqueará modificaciones a calificaciones."
          : "Vuelve a estado 'activo' y se limpia la marca de cierre.",
      confirmLabel: newStatus === "cerrado" ? "Cerrar periodo" : "Reabrir",
      tone: "warning",
    });
    if (!ok) return;
    const payload: Record<string, unknown> = { status: newStatus };
    if (newStatus === "cerrado") {
      payload.closed_at = new Date().toISOString();
      payload.closed_by = user.id;
    } else {
      payload.closed_at = null;
      payload.closed_by = null;
    }
    const { error } = await db.from("academic_periods").update(payload).eq("id", r.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    void load();
  };

  const remove = async (r: AcademicPeriod) => {
    const ok = await confirm({
      title: `¿Eliminar el periodo "${r.code}"?`,
      description:
        "Los cursos asociados quedarán con period_id NULL pero conservarán el texto del periodo. " +
        "Si solo quieres dejar de ofrecer este periodo, considera marcarlo como cerrado. " +
        "Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("academic_periods").delete().eq("id", r.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Periodo eliminado");
    void load();
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-emerald-500" />
          Periodos académicos
        </CardTitle>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Nuevo periodo
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Define los periodos institucionales (semestres, trimestres) con sus fechas. Los cursos se
          asocian a un periodo desde su formulario. Cerrar un periodo lo deja marcado para
          referencia histórica.
        </p>

        {loading ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> Cargando…
          </div>
        ) : loadError ? (
          <ErrorState
            message="No pudimos cargar"
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-28">Código</TableHead>
                  <TableHead className="hidden md:table-cell">Nombre</TableHead>
                  <TableHead className="hidden sm:table-cell w-28">Inicio</TableHead>
                  <TableHead className="hidden sm:table-cell w-28">Fin</TableHead>
                  <TableHead className="w-28">Estado</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableEmpty
                    colSpan={6}
                    text="Sin periodos registrados"
                    hint="Crea el primer periodo con el botón de arriba."
                  />
                ) : (
                  rows.map((r) => {
                    const b = STATUS_BADGE[r.status];
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium tabular-nums">{r.code}</TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                          {r.name ?? "—"}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <DateCell value={r.start_date} variant="date" />
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <DateCell value={r.end_date} variant="date" />
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs ${b.cls}`}>
                            {b.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            actions={[
                              { label: "Editar", icon: Pencil, onClick: () => openEdit(r) },
                              {
                                label: r.status === "cerrado" ? "Reabrir" : "Cerrar periodo",
                                icon: r.status === "cerrado" ? Unlock : Lock,
                                onClick: () => void toggleClose(r),
                                separatorBefore: true,
                              },
                              {
                                label: "Eliminar",
                                icon: Trash2,
                                tone: "destructive",
                                separatorBefore: true,
                                onClick: () => void remove(r),
                              },
                            ]}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft.id ? "Editar periodo" : "Nuevo periodo"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label required>Código</Label>
              <Input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                placeholder="Ej: 2026-1"
              />
            </div>
            <div className="space-y-1">
              <Label>Nombre</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Ej: Primer semestre 2026"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Inicio</Label>
                <DatePicker
                  value={draft.start_date}
                  onChange={(v) => setDraft({ ...draft, start_date: v || "" })}
                />
              </div>
              <div className="space-y-1">
                <Label>Fin</Label>
                <DatePicker
                  value={draft.end_date}
                  onChange={(v) => setDraft({ ...draft, end_date: v || "" })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Estado</Label>
              <Select
                value={draft.status}
                onValueChange={(v) => setDraft({ ...draft, status: v as Status })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="planificado">Planificado</SelectItem>
                  <SelectItem value="activo">Activo</SelectItem>
                  <SelectItem value="cerrado">Cerrado</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "Guardando…" : draft.id ? "Guardar cambios" : "Crear"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
