/**
 * Papelera — `/app/trash`
 *
 * Lista unificada de items borrados (soft-delete) de las 8 entidades
 * principales: cursos, exámenes, talleres, proyectos, sesiones,
 * pizarras, contenidos y encuestas.
 *
 * Visibilidad (por RLS de cada tabla):
 *   - Docente: ve TODO lo que esté borrado de SUS cursos (no solo lo
 *     borrado por él). Útil para que un docente del curso restaure lo
 *     que otro docente del mismo curso borró por error.
 *   - Admin / SuperAdmin: ve todo lo del tenant.
 *   - Estudiante: las queries no le aplican (no tiene rol de borrado).
 *
 * Acciones por fila:
 *   - **Restaurar** (RPC `trash_restore_item`): pone deleted_at=NULL.
 *     La fila reaparece en las listas normales.
 *   - **Eliminar definitivo** (RPC `trash_hard_delete_item`): borra
 *     físicamente con CASCADE. Irreversible.
 *
 * Retención: cualquier item con deleted_at > 30 días se purga
 * automáticamente cada noche (cron job `purge-deleted-items-daily`).
 * La UI muestra los días restantes en cada fila para que el usuario
 * sepa cuándo va a perderse.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { DateCell } from "@/components/ui/date-cell";
import { RowAction } from "@/components/ui/row-action";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, RotateCcw, X, Clock, Search, AlertTriangle, Archive } from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import {
  TRASH_TABLE_LABEL,
  TRASH_NAME_COL,
  restoreItem,
  hardDeleteItem,
  type TrashTable,
} from "@/modules/trash/soft-delete";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
} from "@/components/ui/multi-select";

export const Route = createFileRoute("/app/trash")({ component: TrashPage });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/** Item normalizado para el render. La fila original de cada tabla
 *  tiene shape distinto; acá la aplanamos a un solo shape común. */
interface TrashItem {
  id: string;
  table: TrashTable;
  name: string;
  deleted_at: string;
  deleted_by: string | null;
  deleted_by_name: string | null;
}

/** Días que un item permanece en papelera antes de que el cron lo purge.
 *  Debe coincidir con el TTL default de `purge_deleted_items` en la
 *  migración 20260816000000. */
const RETENTION_DAYS = 30;

/** Tablas en orden de aparición en el filtro. `tenants` solo es
 *  relevante para SuperAdmin — Docente/Admin no tienen SELECT sobre
 *  filas borradas de tenants por RLS, así que verán empty state si
 *  filtran por esa categoría. No lo gateamos en el Select para no
 *  acoplar el componente al rol; la RLS lo enforza naturalmente. */
const TABLES: TrashTable[] = [
  "courses",
  "exams",
  "workshops",
  "projects",
  "attendance_sessions",
  "whiteboards",
  "generated_contents",
  "polls",
  "tenants",
];

function TrashPage() {
  const confirm = useConfirm();
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filterTable, setFilterTable] = useState<TrashTable | "all">("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  // Bulk operation state — al hacer "Restaurar seleccionados" o
  // "Eliminar definitivo en bulk", deshabilitamos toda la tabla mientras
  // las N llamadas paralelas terminan.
  const [bulkBusy, setBulkBusy] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      // 8 queries en paralelo, una por tabla. Cada una trae solo lo
      // borrado y solo las columnas mínimas necesarias para el render.
      // RLS aplica: docente ve lo de sus cursos, admin lo de su tenant.
      const results = await Promise.all(
        TABLES.map(async (table) => {
          const nameCol = TRASH_NAME_COL[table];
          const { data, error } = await db
            .from(table)
            .select(`id, ${nameCol}, deleted_at, deleted_by`)
            .not("deleted_at", "is", null)
            .order("deleted_at", { ascending: false });
          if (error) {
            // No abortamos el load entero por un error en una tabla
            // — algunas pueden no existir en entornos viejos.
            console.warn(`[trash] no se pudo cargar ${table}`, error);
            return [];
          }
          return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
            id: String(row.id),
            table,
            name: row[nameCol] ? String(row[nameCol]) : "(sin nombre)",
            deleted_at: String(row.deleted_at),
            deleted_by: row.deleted_by ? String(row.deleted_by) : null,
            deleted_by_name: null as string | null,
          }));
        }),
      );
      const flat = results.flat();

      // Resolver nombres de deleted_by → 1 query a profiles con todos
      // los user_ids únicos. Si la tabla profiles falla, no rompe el
      // render — solo se muestra el UUID raw.
      const userIds = Array.from(
        new Set(flat.map((i) => i.deleted_by).filter(Boolean) as string[]),
      );
      const nameMap = new Map<string, string>();
      if (userIds.length > 0) {
        const { data: profs } = await db.from("profiles").select("id, full_name").in("id", userIds);
        for (const p of (profs ?? []) as Array<{ id: string; full_name: string | null }>) {
          if (p.full_name) nameMap.set(p.id, p.full_name);
        }
      }
      flat.forEach((i) => {
        if (i.deleted_by) i.deleted_by_name = nameMap.get(i.deleted_by) ?? null;
      });

      // Sort por deleted_at desc (más recientes arriba).
      flat.sort((a, b) => (a.deleted_at < b.deleted_at ? 1 : -1));
      setItems(flat);
      setLoading(false);
    } catch (e) {
      setLoadError(friendlyError(e, "No pudimos cargar la papelera."));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (filterTable !== "all" && i.table !== filterTable) return false;
      if (q) {
        const hay =
          i.name.toLowerCase().includes(q) ||
          (i.deleted_by_name ?? "").toLowerCase().includes(q) ||
          TRASH_TABLE_LABEL[i.table].toLowerCase().includes(q);
        if (!hay) return false;
      }
      return true;
    });
  }, [items, filterTable, search]);

  // Conteo por tipo — se muestra en el select de filtro. Sobre `items`
  // (no `filtered`) para que el dropdown muestre conteos absolutos
  // independientes del search activo.
  const countByTable = useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    TABLES.forEach((t) => {
      counts[t] = items.filter((i) => i.table === t).length;
    });
    return counts;
  }, [items]);

  // Multi-select sobre `filtered` (NO `paginated`) — CLAUDE.md regla:
  // "Seleccionar todos" debe abarcar todas las páginas del filtro activo,
  // no solo la página visible. La fila se identifica por `table:id`
  // (compuesto) porque dos tablas pueden tener UUIDs colisionando en
  // teoría — más defensivo que solo `id`.
  const filteredAsSelectable = useMemo(
    () => filtered.map((i) => ({ id: `${i.table}:${i.id}` })),
    [filtered],
  );
  const sel = useMultiSelect(filteredAsSelectable);

  // Paginación client-side. Reset a página 1 cuando cambia el filtro
  // por tipo o el search — sin esto el usuario filtra y queda en una
  // página vacía. Page size más alto que el default 25 porque la
  // papelera tiende a tener muchos items pequeños.
  const pagination = usePagination(filtered, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:trash",
    resetKey: `${filterTable}|${search}`,
  });

  /** Días restantes hasta la purga. Si negativo, el cron del próximo
   *  tick lo borrará. */
  const daysUntilPurge = (deletedAt: string): number => {
    const deleted = new Date(deletedAt).getTime();
    const purgeAt = deleted + RETENTION_DAYS * 86_400_000;
    const days = Math.ceil((purgeAt - Date.now()) / 86_400_000);
    return days;
  };

  const handleRestore = async (item: TrashItem) => {
    setBusy(item.id);
    try {
      const { error } = await restoreItem(item.table, item.id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo restaurar"));
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      toast.success(`${TRASH_TABLE_LABEL[item.table]}: ${item.name} restaurado`);
    } finally {
      setBusy(null);
    }
  };

  const handleHardDelete = async (item: TrashItem) => {
    const ok = await confirm({
      title: "¿Eliminar definitivamente?",
      description: `Vas a borrar "${item.name}" (${TRASH_TABLE_LABEL[item.table]}) y todos sus hijos asociados (preguntas, entregas, archivos, etc.). Esta acción NO se puede deshacer.`,
      confirmLabel: "Eliminar definitivo",
      tone: "destructive",
    });
    if (!ok) return;
    setBusy(item.id);
    try {
      const { error } = await hardDeleteItem(item.table, item.id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo eliminar"));
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      toast.success("Eliminado definitivamente");
    } finally {
      setBusy(null);
    }
  };

  /** Items seleccionados resueltos a objetos TrashItem para los handlers
   *  bulk. La selección es por `table:id` compuesto. */
  const selectedItems = useMemo(
    () => filtered.filter((i) => sel.isSelected(`${i.table}:${i.id}`)),
    [filtered, sel],
  );

  const handleBulkRestore = async () => {
    if (selectedItems.length === 0) return;
    const ok = await confirm({
      title: `¿Restaurar ${selectedItems.length} item(s)?`,
      description:
        "Las filas seleccionadas volverán a aparecer en sus listas normales. Sus hijos (preguntas, entregas, etc.) ya están intactos y seguirán visibles.",
      confirmLabel: "Restaurar",
      tone: "default",
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      // N llamadas paralelas. Si UNA falla, mostramos cuántas tuvieron
      // éxito en lugar de abortar todo. Cada restore es una RPC
      // independiente — no hay transacción multi-tabla.
      const results = await Promise.all(
        selectedItems.map(async (item) => ({
          item,
          error: (await restoreItem(item.table, item.id)).error,
        })),
      );
      const failed = results.filter((r) => r.error);
      const successIds = new Set(
        results.filter((r) => !r.error).map((r) => `${r.item.table}:${r.item.id}`),
      );
      setItems((prev) => prev.filter((i) => !successIds.has(`${i.table}:${i.id}`)));
      sel.clear();
      if (failed.length === 0) {
        toast.success(`${selectedItems.length} item(s) restaurado(s)`);
      } else {
        const first = failed[0];
        const detail = friendlyError(first.error ?? undefined, "Error desconocido");
        toast.error(
          `${selectedItems.length - failed.length} restaurado(s), ${failed.length} con error. ` +
            `Primero: "${first.item.name}" — ${detail}`,
          { duration: 12000 },
        );
      }
    } finally {
      setBulkBusy(false);
    }
  };

  const handleBulkHardDelete = async () => {
    if (selectedItems.length === 0) return;
    const ok = await confirm({
      title: `¿Eliminar definitivamente ${selectedItems.length} item(s)?`,
      description: `Vas a borrar las filas seleccionadas y TODOS sus hijos asociados (preguntas, entregas, archivos, etc.) con CASCADE. Esta acción NO se puede deshacer.`,
      confirmLabel: "Eliminar definitivo",
      tone: "destructive",
    });
    if (!ok) return;
    setBulkBusy(true);
    try {
      const results = await Promise.all(
        selectedItems.map(async (item) => ({
          item,
          error: (await hardDeleteItem(item.table, item.id)).error,
        })),
      );
      const failed = results.filter((r) => r.error);
      const successIds = new Set(
        results.filter((r) => !r.error).map((r) => `${r.item.table}:${r.item.id}`),
      );
      setItems((prev) => prev.filter((i) => !successIds.has(`${i.table}:${i.id}`)));
      sel.clear();
      if (failed.length === 0) {
        toast.success(`${selectedItems.length} item(s) eliminado(s) definitivamente`);
      } else {
        // Incluimos el detalle del PRIMER error y el nombre del item que
        // falló — antes era "N con error" a secas y el usuario no podía
        // diagnosticar qué tabla/FK lo bloqueaba (caso reportado al
        // hard-delete tenants con dependencias RESTRICT).
        const first = failed[0];
        const detail = friendlyError(first.error ?? undefined, "Error desconocido");
        toast.error(
          `${selectedItems.length - failed.length} eliminado(s), ${failed.length} con error. ` +
            `Primero: "${first.item.name}" — ${detail}`,
          { duration: 12000 },
        );
      }
    } finally {
      setBulkBusy(false);
    }
  };

  // Stats arriba — patrón 4-card compartido con los otros módulos.
  // Por urgencia de purga: ≤3d en rojo (urgente), ≤7d en ámbar (próxima
  // semana). Total = items totales. Recuperables = aproximación útil:
  // cuántos pueden restaurarse con calma (>7d).
  //
  // IMPORTANTE: este useMemo va ANTES de cualquier return condicional
  // (loading/error) para respetar las rules of hooks de React. Antes
  // estaba después y rompía con #310 (Rendered fewer hooks…) cuando
  // un tenant tenía error de carga en una de las 8 tablas y el primer
  // render iba directo al `if (loadError) return`.
  const trashStats = useMemo(() => {
    let urgent = 0;
    let soon = 0;
    let safe = 0;
    for (const i of items) {
      const days = daysUntilPurge(i.deleted_at);
      if (days <= 3) urgent += 1;
      else if (days <= 7) soon += 1;
      else safe += 1;
    }
    return { total: items.length, urgent, soon, safe };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-8">
        <Spinner size="sm" /> Cargando papelera…
      </div>
    );
  }

  if (loadError) {
    return (
      <ErrorState
        message="No pudimos cargar la papelera"
        hint={loadError}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Trash2 className="h-6 w-6 text-primary" />}
        title="Papelera"
        subtitle={
          items.length === 0
            ? "Sin items en papelera. Lo que elimines aparecerá acá."
            : `${items.length} item(s) recuperables · purga automática a los ${RETENTION_DAYS} días`
        }
      />

      {/* Stats 4-card — mismo patrón visual que el resto de los módulos.
          Conteos absolutos sobre `items` (sin aplicar search/filter) —
          dan contexto general; el detalle filtrado vive en la tabla. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Trash2} label="Total en papelera" value={trashStats.total} />
        <StatCard
          icon={AlertTriangle}
          label="Próximos a purgar (≤3d)"
          value={trashStats.urgent}
          tone={trashStats.urgent > 0 ? "destructive" : "default"}
        />
        <StatCard
          icon={Clock}
          label="Esta semana (≤7d)"
          value={trashStats.soon}
          tone={trashStats.soon > 0 ? "warning" : "default"}
        />
        <StatCard icon={Archive} label="Recuperables (>7d)" value={trashStats.safe} />
      </div>

      {/* Toolbar de filtros: search libre + selector de tipo. Stack en
          mobile (full-width), fila en sm+. Espejea el patrón de
          ListFilters de los otros grids pero sin curso (la papelera
          es cross-curso por diseño — el filtro principal es por entidad). */}
      {items.length > 0 && (
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o autor del borrado…"
              className="pl-8 h-9"
            />
          </div>
          <Select
            value={filterTable}
            onValueChange={(v) => setFilterTable(v as TrashTable | "all")}
          >
            <SelectTrigger className="w-full sm:w-[220px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos ({countByTable.all})</SelectItem>
              {TABLES.map((t) => (
                <SelectItem key={t} value={t} disabled={countByTable[t] === 0}>
                  {TRASH_TABLE_LABEL[t]} ({countByTable[t] ?? 0})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(search || filterTable !== "all") && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("");
                setFilterTable("all");
              }}
              className="h-9"
            >
              <X className="h-4 w-4 mr-1" /> Limpiar
            </Button>
          )}
        </div>
      )}

      {/* Toolbar de selección bulk — aparece arriba cuando hay items
          marcados. Espejea el patrón estándar de los otros grids
          (MultiSelectToolbar) pero con dos acciones en lugar de una
          (papelera necesita restaurar + hard-delete). */}
      {sel.count > 0 && (
        <Card className="bg-primary/5 border-primary/30">
          <CardContent className="p-2 px-3 flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">
              {sel.count} item{sel.count === 1 ? "" : "s"} seleccionado{sel.count === 1 ? "" : "s"}
            </span>
            <div className="ml-auto flex items-center gap-1.5 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleBulkRestore()}
                disabled={bulkBusy}
              >
                {bulkBusy ? (
                  <Spinner size="xs" className="mr-1" />
                ) : (
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                )}
                Restaurar
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleBulkHardDelete()}
                disabled={bulkBusy}
                className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="h-3.5 w-3.5 mr-1" />
                Eliminar definitivo
              </Button>
              <Button size="sm" variant="ghost" onClick={() => sel.clear()} disabled={bulkBusy}>
                Cancelar
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <MultiSelectHeaderCheckbox state={sel} />
                </TableHead>
                <TableHead>Nombre</TableHead>
                <TableHead className="hidden sm:table-cell">Tipo</TableHead>
                <TableHead className="hidden md:table-cell">Borrado por</TableHead>
                <TableHead className="hidden sm:table-cell">Borrado</TableHead>
                <TableHead className="hidden sm:table-cell">Purga en</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagination.paginatedItems.length === 0 ? (
                <TableEmpty
                  colSpan={7}
                  text={
                    search || filterTable !== "all"
                      ? "Sin resultados para los filtros activos."
                      : "Sin items en papelera."
                  }
                />
              ) : (
                pagination.paginatedItems.map((item) => {
                  const days = daysUntilPurge(item.deleted_at);
                  const isBusyItem = busy === item.id;
                  const selectId = `${item.table}:${item.id}`;
                  return (
                    <TableRow
                      key={selectId}
                      data-state={sel.isSelected(selectId) ? "selected" : undefined}
                    >
                      <TableCell>
                        <MultiSelectCheckbox id={selectId} state={sel} />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="truncate max-w-[260px]" title={item.name}>
                          {item.name}
                        </div>
                        {/* Repetir tipo en mobile (la columna está hidden). */}
                        <div className="sm:hidden">
                          <Badge variant="secondary" className="text-[10px]">
                            {TRASH_TABLE_LABEL[item.table]}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant="secondary" className="text-[10px]">
                          {TRASH_TABLE_LABEL[item.table]}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {item.deleted_by_name ?? "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <DateCell value={item.deleted_at} variant="datetime" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <span
                          className={`inline-flex items-center gap-1 text-xs tabular-nums ${
                            days <= 3
                              ? "text-destructive font-medium"
                              : days <= 7
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground"
                          }`}
                          title={`Se purgará automáticamente cuando pasen ${RETENTION_DAYS} días desde la eliminación.`}
                        >
                          <Clock className="h-3 w-3" />
                          {days <= 0 ? "Hoy" : `${days} día${days === 1 ? "" : "s"}`}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <RowAction
                            label="Restaurar"
                            icon={RotateCcw}
                            onClick={() => void handleRestore(item)}
                            disabled={isBusyItem || bulkBusy}
                            loading={isBusyItem}
                          />
                          <RowAction
                            label="Eliminar definitivo"
                            icon={X}
                            onClick={() => void handleHardDelete(item)}
                            disabled={isBusyItem || bulkBusy}
                            tone="destructive"
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
        {/* Paginación dentro de la Card, debajo de la tabla. Mismo
            patrón que los otros grids del repo. */}
        <DataPagination state={pagination} entityNamePlural="items" />
      </Card>
    </div>
  );
}
