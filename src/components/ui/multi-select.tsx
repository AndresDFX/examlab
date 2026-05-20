/**
 * Design system: multi-selección + bulk delete para grids/tablas.
 *
 * Componentes:
 *   - useMultiSelect(items)        — hook con state de selección (Set de ids)
 *   - <MultiSelectHeaderCheckbox/> — checkbox del <TableHead> (todos/ninguno/indeterminate)
 *   - <MultiSelectCheckbox/>       — checkbox por fila
 *   - <MultiSelectToolbar/>        — barra superior cuando hay selección, con
 *                                    botones "Limpiar selección" y "Eliminar"
 *   - <BulkDeleteDialog/>          — dialog confirm con lista expandible
 *                                    de los items a eliminar
 *
 * Uso típico en una tabla:
 *
 *   const sel = useMultiSelect(rows);
 *
 *   <MultiSelectToolbar
 *     count={sel.count}
 *     onClear={sel.clear}
 *     onDelete={() => setBulkOpen(true)}
 *   />
 *   <Table>
 *     <TableHeader>
 *       <TableRow>
 *         <TableHead className="w-10">
 *           <MultiSelectHeaderCheckbox state={sel} />
 *         </TableHead>
 *         ...
 *       </TableRow>
 *     </TableHeader>
 *     <TableBody>
 *       {rows.map((r) => (
 *         <TableRow key={r.id} data-state={sel.isSelected(r.id) ? "selected" : undefined}>
 *           <TableCell>
 *             <MultiSelectCheckbox id={r.id} state={sel} />
 *           </TableCell>
 *           ...
 *         </TableRow>
 *       ))}
 *     </TableBody>
 *   </Table>
 *   <BulkDeleteDialog
 *     open={bulkOpen}
 *     onOpenChange={setBulkOpen}
 *     entityName="examen"
 *     items={selectedRowsWithLabels}
 *     onConfirm={async () => {
 *       const { error } = await supabase.from("exams").delete().in("id", [...sel.selectedIds]);
 *       ...
 *     }}
 *   />
 */
import { useCallback, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Trash2, X, ChevronDown, ChevronRight } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";

// ───────────────────────── Hook ─────────────────────────

export interface MultiSelectState {
  selectedIds: Set<string>;
  count: number;
  allSelected: boolean;
  /** Hay selección parcial (al menos uno pero no todos). */
  indeterminate: boolean;
  isSelected: (id: string) => boolean;
  toggle: (id: string) => void;
  toggleAll: () => void;
  clear: () => void;
  setSelected: (ids: string[]) => void;
}

/**
 * Hook de multi-select.
 * Reaccionar a cambios en `items` para sincronizar la selección queda
 * fuera de scope: si una fila desaparece, simplemente queda "huérfana"
 * en el set y no afecta nada visualmente. El bulk delete deduplica con
 * los items que sí existen al momento de operar.
 */
export function useMultiSelect<T extends { id: string }>(items: readonly T[]): MultiSelectState {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const allIds = useMemo(() => items.map((i) => i.id), [items]);

  const isSelected = useCallback((id: string) => selectedIds.has(id), [selectedIds]);

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      // Si ya están todos, deselect all. Si hay menos (o ninguno), select all.
      const allInSet = allIds.length > 0 && allIds.every((id) => prev.has(id));
      return allInSet ? new Set() : new Set(allIds);
    });
  }, [allIds]);

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  const setSelected = useCallback((ids: string[]) => setSelectedIds(new Set(ids)), []);

  // Calculamos count y allSelected/indeterminate solo sobre items
  // visibles, para que la UI refleje exactamente lo que el usuario ve.
  const visibleSelected = useMemo(
    () => allIds.filter((id) => selectedIds.has(id)),
    [allIds, selectedIds],
  );
  const allSelected = allIds.length > 0 && visibleSelected.length === allIds.length;
  const indeterminate = visibleSelected.length > 0 && visibleSelected.length < allIds.length;

  return {
    selectedIds,
    count: visibleSelected.length,
    allSelected,
    indeterminate,
    isSelected,
    toggle,
    toggleAll,
    clear,
    setSelected,
  };
}

// ───────────────────────── Checkboxes ─────────────────────────

export function MultiSelectHeaderCheckbox({
  state,
  ariaLabel = "Seleccionar todos",
}: {
  state: MultiSelectState;
  ariaLabel?: string;
}) {
  return (
    <Checkbox
      checked={state.allSelected ? true : state.indeterminate ? "indeterminate" : false}
      onCheckedChange={() => state.toggleAll()}
      aria-label={ariaLabel}
    />
  );
}

export function MultiSelectCheckbox({
  id,
  state,
  ariaLabel = "Seleccionar fila",
}: {
  id: string;
  state: MultiSelectState;
  ariaLabel?: string;
}) {
  return (
    <Checkbox
      checked={state.isSelected(id)}
      onCheckedChange={() => state.toggle(id)}
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ───────────────────────── Toolbar ─────────────────────────

export function MultiSelectToolbar({
  count,
  onClear,
  onDelete,
  entityNameSingular,
  entityNamePlural,
}: {
  count: number;
  onClear: () => void;
  onDelete: () => void;
  entityNameSingular: string;
  entityNamePlural: string;
}) {
  if (count === 0) return null;
  const label = count === 1 ? `1 ${entityNameSingular}` : `${count} ${entityNamePlural}`;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">seleccionado{count === 1 ? "" : "s"}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X className="h-3.5 w-3.5 mr-1" />
          Limpiar selección
        </Button>
        <Button variant="destructive" size="sm" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          Eliminar
        </Button>
      </div>
    </div>
  );
}

// ───────────────────────── Bulk delete dialog ─────────────────────────

const PREVIEW_ROWS = 5;

export function BulkDeleteDialog({
  open,
  onOpenChange,
  items,
  entityNameSingular,
  entityNamePlural,
  extraWarning,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: { id: string; label: string }[];
  entityNameSingular: string;
  entityNamePlural: string;
  /** Texto extra de impacto, ej. "Se eliminarán también todas sus entregas y notas." */
  extraWarning?: string;
  /** Debe lanzar si falla; el dialog cierra solo si resuelve. */
  onConfirm: (ids: string[]) => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const count = items.length;
  const label = count === 1 ? entityNameSingular : entityNamePlural;
  const visibleItems = expanded ? items : items.slice(0, PREVIEW_ROWS);
  const hidden = items.length - visibleItems.length;

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm(items.map((i) => i.id));
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Error al eliminar";
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Eliminar {count} {label}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {extraWarning
              ? extraWarning
              : `Se eliminarán los registros seleccionados.`}{" "}
            Esta acción no se puede deshacer.
          </p>

          <div className="rounded-md border bg-muted/30">
            <ul className="divide-y text-sm">
              {visibleItems.map((it) => (
                <li key={it.id} className="px-3 py-1.5 truncate" title={it.label}>
                  {it.label}
                </li>
              ))}
            </ul>
            {items.length > PREVIEW_ROWS && (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="w-full px-3 py-1.5 text-xs text-muted-foreground border-t hover:bg-muted/50 flex items-center justify-center gap-1"
              >
                {expanded ? (
                  <>
                    <ChevronDown className="h-3 w-3" />
                    Mostrar menos
                  </>
                ) : (
                  <>
                    <ChevronRight className="h-3 w-3" />
                    Mostrar {hidden} más
                  </>
                )}
              </button>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={submitting}>
            {submitting ? (
              <Spinner size="md" className="mr-1" />
            ) : (
              <Trash2 className="h-4 w-4 mr-1" />
            )}
            Eliminar {count}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
