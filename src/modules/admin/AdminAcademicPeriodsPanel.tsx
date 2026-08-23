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
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { useTableSort } from "@/hooks/use-table-sort";
import { usePagination } from "@/hooks/use-pagination";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ErrorState, TableEmpty } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { SearchInput } from "@/components/ui/search-input";
import { DataPagination } from "@/components/ui/data-pagination";
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
  SortableHead,
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
import { CalendarRange, Plus, Pencil, Trash2, Lock, Unlock, Copy } from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { isValidDateRange } from "@/shared/lib/date-range";
import { logEvent } from "@/shared/lib/audit";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";

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

const STATUS_BADGE_CLS: Record<Status, string> = {
  planificado: "border-slate-300 text-slate-700 dark:border-slate-500/40 dark:text-slate-300",
  activo: "border-emerald-400 text-emerald-700 dark:border-emerald-500/50 dark:text-emerald-300",
  cerrado: "border-amber-400 text-amber-700 dark:border-amber-500/50 dark:text-amber-300",
};

/** Orden del estado al ordenar por esa columna: por vigencia (lo que está
 *  en curso primero), NO alfabético — alfabético daría
 *  activo/cerrado/planificado, que mezcla lo vigente con lo archivado. */
const STATUS_RANK: Record<Status, number> = {
  activo: 0,
  planificado: 1,
  cerrado: 2,
};

export function AdminAcademicPeriodsPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [rows, setRows] = useState<AcademicPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  // Fila con una acción en vuelo (cerrar/reabrir o eliminar). Deshabilita el
  // ítem del menú → anti doble-submit + feedback de "esto está corriendo".
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Guard "cambios sin guardar" para el dialog crear/editar periodo. El form
  // ya es UN objeto (`draft`), así que se pasa directo al hook.
  const dirty = useDirtyDialog(open, draft);
  // `load()` corre desde el effect y desde cada handler; sin este guard un
  // setState podía caer sobre el componente ya desmontado.
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await db
        .from("academic_periods")
        .select("id, code, name, start_date, end_date, status, closed_at")
        .order("code", { ascending: false });
      if (!mountedRef.current) return;
      if (error) {
        setLoadError(
          friendlyError(error, t("hc_modulesAdminAdminAcademicPeriodsPanel.loadFallback")),
        );
        return;
      }
      setRows((data ?? []) as AcademicPeriod[]);
    } catch (e) {
      // Un throw (red/sesión) también debe terminar en ErrorState + Reintentar.
      if (!mountedRef.current) return;
      setLoadError(friendlyError(e, t("hc_modulesAdminAdminAcademicPeriodsPanel.loadFallback")));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Flujo obligatorio del design system: filtrar → ORDENAR → paginar.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.code.toLowerCase().includes(q) ||
        (r.name?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, search]);

  const sort = useTableSort(filtered, {
    columns: {
      code: (r) => r.code,
      name: (r) => r.name,
      // Las fechas llegan como 'YYYY-MM-DD' (columna DATE) → el orden
      // lexicográfico coincide con el cronológico; no hace falta parsear.
      start_date: (r) => r.start_date,
      end_date: (r) => r.end_date,
      status: (r) => STATUS_RANK[r.status],
    },
    // Preserva el orden que traía la query (`.order("code", desc)`): el
    // periodo más reciente arriba.
    defaultSort: { key: "code", dir: "desc" },
    storageKey: "examlab_sort:admin_academic_periods",
  });

  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:admin_academic_periods",
    resetKey: `${search}|${sort.resetKey}`,
  });

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

  /** Duplicar: pre-llena el form de creación con el periodo origen. Útil para
   *  armar el siguiente periodo a partir del actual (mismas fechas relativas /
   *  estructura) y ajustar antes de guardar. El `code` (único) se sufija con
   *  " (copia)" para no chocar; el estado vuelve a "planificado" (un periodo
   *  nuevo no nace activo ni cerrado). */
  const duplicate = (r: AcademicPeriod) => {
    setDraft({
      id: null,
      code: `${r.code} (copia)`,
      name: r.name ?? "",
      start_date: r.start_date ?? "",
      end_date: r.end_date ?? "",
      status: "planificado",
    });
    setOpen(true);
  };

  const save = async () => {
    if (!user) return;
    if (saving) return; // anti doble-submit
    const code = draft.code.trim();
    if (!code) {
      toast.error(i18n.t("academic.periods.toastCodeRequired"));
      return;
    }
    // Regla cross-form (goal #10): la fecha de fin no puede ser anterior a la
    // de inicio (iguales OK). Ambos son YYYY-MM-DD del DatePicker → mismo
    // espacio; el helper compara por epoch.
    if (!isValidDateRange(draft.start_date, draft.end_date)) {
      toast.error(i18n.t("academic.periods.toastStartBeforeEnd"));
      return;
    }
    setSaving(true);
    try {
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
      if (error) {
        toast.error(
          friendlyError(error, t("hc_modulesAdminAdminAcademicPeriodsPanel.saveFallback")),
        );
        return;
      }
      void logEvent({
        action: draft.id ? "period.updated" : "period.created",
        category: "academic",
        severity: "info",
        entityType: "academic_period",
        entityId: draft.id ?? undefined,
        entityName: code,
        metadata: {
          name: draft.name,
          start_date: draft.start_date,
          end_date: draft.end_date,
          status: draft.status,
        },
      });
      toast.success(
        draft.id
          ? i18n.t("academic.periods.toastUpdated")
          : i18n.t("academic.periods.toastCreated"),
      );
      setOpen(false);
      void load();
    } catch (e) {
      toast.error(friendlyError(e, t("hc_modulesAdminAdminAcademicPeriodsPanel.saveFallback")));
    } finally {
      // Sin finally, un throw dejaba el botón "Guardando…" trabado.
      if (mountedRef.current) setSaving(false);
    }
  };

  const toggleClose = async (r: AcademicPeriod) => {
    if (!user) return;
    if (togglingId) return;
    const newStatus: Status = r.status === "cerrado" ? "activo" : "cerrado";
    const ok = await confirm({
      title: newStatus === "cerrado"
        ? i18n.t("academic.periods.confirmCloseTitle", { code: r.code })
        : i18n.t("academic.periods.confirmReopenTitle", { code: r.code }),
      description: newStatus === "cerrado"
        ? i18n.t("academic.periods.confirmCloseDesc")
        : i18n.t("academic.periods.confirmReopenDesc"),
      confirmLabel: newStatus === "cerrado"
        ? i18n.t("academic.periods.confirmCloseLabel")
        : i18n.t("academic.periods.confirmReopenLabel"),
      tone: "warning",
    });
    if (!ok) return;
    setTogglingId(r.id);
    try {
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
      void logEvent({
        action: newStatus === "cerrado" ? "period.closed" : "period.reopened",
        category: "academic",
        // 'warning' porque cerrar/reabrir un periodo es una acción
        // institucionalmente significativa (futuro: bloquea calificaciones).
        severity: "warning",
        entityType: "academic_period",
        entityId: r.id,
        entityName: r.code,
      });
      // Cerrar/reabrir no tosteaba nada: el admin solo veía cambiar el badge
      // (y nada si el load tardaba). Confirmación explícita del resultado.
      toast.success(
        newStatus === "cerrado"
          ? t("academic.periods.toastClosed", {
              code: r.code,
              defaultValue: "Periodo {{code}} cerrado",
            })
          : t("academic.periods.toastReopened", {
              code: r.code,
              defaultValue: "Periodo {{code}} reabierto",
            }),
      );
      void load();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      if (mountedRef.current) setTogglingId(null);
    }
  };

  const remove = async (r: AcademicPeriod) => {
    if (deletingId) return;
    const ok = await confirm({
      title: i18n.t("academic.periods.confirmDeleteTitle", { code: r.code }),
      description: i18n.t("academic.periods.confirmDeleteDesc"),
      confirmLabel: i18n.t("academic.periods.confirmDeleteLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    setDeletingId(r.id);
    try {
      const { error } = await db.from("academic_periods").delete().eq("id", r.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      void logEvent({
        action: "period.deleted",
        category: "academic",
        severity: "warning",
        entityType: "academic_period",
        entityId: r.id,
        entityName: r.code,
      });
      toast.success(i18n.t("academic.periods.toastDeleted"));
      void load();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      if (mountedRef.current) setDeletingId(null);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarRange className="h-4 w-4 text-emerald-500" />
          {t("academic.periods.title")}
        </CardTitle>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t("academic.periods.new")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {t("academic.periods.description")}
        </p>

        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t("academic.periods.searchPlaceholder", {
            defaultValue: "Buscar por código o nombre…",
          })}
          maxWidthClass="sm:max-w-sm"
        />

        {loadError ? (
          <ErrorState
            message={t("academic.periods.loadError")}
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <Table fixed resizable>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="code" sort={sort} className="w-28">{t("academic.periods.colCode")}</SortableHead>
                  <SortableHead sortKey="name" sort={sort} className="hidden md:table-cell">{t("academic.periods.colName")}</SortableHead>
                  <SortableHead sortKey="start_date" sort={sort} className="hidden sm:table-cell w-28">{t("academic.periods.colStart")}</SortableHead>
                  <SortableHead sortKey="end_date" sort={sort} className="hidden sm:table-cell w-28">{t("academic.periods.colEnd")}</SortableHead>
                  <SortableHead sortKey="status" sort={sort} className="w-28">{t("academic.periods.colStatus")}</SortableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* Carga inicial / reintento: skeleton con el shape de la tabla. */}
                {loading ? (
                  <TableSkeleton rows={5} cols={6} />
                ) : sort.sorted.length === 0 ? (
                  (() => {
                    // Distinguir "no hay periodos" de "el buscador no matchea":
                    // sin esto el admin cree que se le borraron los datos.
                    const noMatch = rows.length > 0 && !!search.trim();
                    return (
                      <TableEmpty
                        colSpan={6}
                        text={noMatch ? t("common.noResults") : t("academic.periods.empty")}
                        hint={
                          noMatch
                            ? t("common.tryClearFilter")
                            : t("academic.periods.emptyHint")
                        }
                      />
                    );
                  })()
                ) : (
                  pagination.paginatedItems.map((r) => {
                    const statusLabel = t(`academic.periods.status${r.status.charAt(0).toUpperCase()}${r.status.slice(1)}`);
                    return (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium tabular-nums">{r.code}</TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground" truncate title={r.name ?? undefined}>
                          {r.name ?? "—"}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <DateCell value={r.start_date} />
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <DateCell value={r.end_date} />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className={`text-xs ${STATUS_BADGE_CLS[r.status]}`}>
                              {statusLabel}
                            </Badge>
                            {/* Cerrar/reabrir corre desde el menú de acciones:
                                sin este spinner la fila no daba señal alguna. */}
                            {togglingId === r.id && <Spinner size="xs" />}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            actions={[
                              { label: t("academic.periods.actionEdit"), icon: Pencil, onClick: () => openEdit(r) },
                              { label: t("common.duplicate"), icon: Copy, onClick: () => duplicate(r) },
                              {
                                label: r.status === "cerrado" ? t("academic.periods.actionReopen") : t("academic.periods.actionClose"),
                                icon: r.status === "cerrado" ? Unlock : Lock,
                                onClick: () => void toggleClose(r),
                                separatorBefore: true,
                                disabled: togglingId !== null,
                                hint:
                                  togglingId !== null
                                    ? t("common.processing", { defaultValue: "Procesando…" })
                                    : undefined,
                              },
                              {
                                label: t("academic.periods.actionDelete"),
                                icon: Trash2,
                                tone: "destructive",
                                separatorBefore: true,
                                disabled: deletingId !== null,
                                hint:
                                  deletingId !== null
                                    ? t("common.processing", { defaultValue: "Procesando…" })
                                    : undefined,
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

        {!loading && !loadError && sort.sorted.length > 0 && (
          <DataPagination
            state={pagination}
            entityNamePlural={t("academic.periods.entityPlural", {
              defaultValue: "periodos",
            })}
          />
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={dirty.guardOpenChange(setOpen)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{draft.id ? t("academic.periods.editTitle") : t("academic.periods.createTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label required>{t("academic.periods.labelCode")}</Label>
              <Input
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                placeholder={t("hc_modulesAdminAdminAcademicPeriodsPanel.codePlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("academic.periods.labelName")}</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t("hc_modulesAdminAdminAcademicPeriodsPanel.namePlaceholder")}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t("academic.periods.labelStart")}</Label>
                <DatePicker
                  value={draft.start_date}
                  onChange={(v) => setDraft({ ...draft, start_date: v || "" })}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("academic.periods.labelEnd")}</Label>
                <DatePicker
                  value={draft.end_date}
                  onChange={(v) => setDraft({ ...draft, end_date: v || "" })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t("academic.periods.labelStatus")}</Label>
              <Select
                value={draft.status}
                onValueChange={(v) => setDraft({ ...draft, status: v as Status })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="planificado">{t("academic.periods.statusPlanificado")}</SelectItem>
                  <SelectItem value="activo">{t("academic.periods.statusActivo")}</SelectItem>
                  <SelectItem value="cerrado">{t("academic.periods.statusCerrado")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              {t("academic.periods.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Spinner size="sm" className="mr-2" />}
              {saving ? t("academic.periods.saving") : draft.id ? t("academic.periods.saveChanges") : t("academic.periods.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
