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
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
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
  SortableHead,
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
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import {
  TRASH_TABLE_LABEL,
  TRASH_NAME_COL,
  restoreItem,
  hardDeleteItem,
  type TrashTable,
} from "@/modules/trash/soft-delete";
import { usePagination } from "@/hooks/use-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
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
  const { t } = useTranslation();
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
            name: row[nameCol]
              ? String(row[nameCol])
              : t("trash.unnamed", { defaultValue: "(sin nombre)" }),
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
      setLoadError(
        friendlyError(e, t("trash.loadErrorFallback", { defaultValue: "No pudimos cargar la papelera." })),
      );
      setLoading(false);
    }
  }, [t]);

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

  /** Días restantes hasta la purga. Si negativo, el cron del próximo
   *  tick lo borrará. */
  const daysUntilPurge = (deletedAt: string): number => {
    const deleted = new Date(deletedAt).getTime();
    const purgeAt = deleted + RETENTION_DAYS * 86_400_000;
    const days = Math.ceil((purgeAt - Date.now()) / 86_400_000);
    return days;
  };

  // Orden por columna — flujo filtrar → ORDENAR → paginar. El "tipo" y
  // "purga en" ordenan por valores derivados (label de la entidad y días
  // restantes); el resto son campos directos.
  const sort = useTableSort(filtered, {
    columns: {
      name: (i) => i.name,
      type: (i) => TRASH_TABLE_LABEL[i.table],
      deleted_by: (i) => i.deleted_by_name,
      deleted_at: (i) => i.deleted_at,
      purges_in: (i) => daysUntilPurge(i.deleted_at),
    },
    defaultSort: { key: "deleted_at", dir: "desc" },
    storageKey: "examlab_sort:trash",
  });

  // Multi-select sobre `sort.sorted` (NO `paginated`) — CLAUDE.md regla:
  // "Seleccionar todos" debe abarcar todas las páginas del filtro activo,
  // no solo la página visible. La fila se identifica por `table:id`
  // (compuesto) porque dos tablas pueden tener UUIDs colisionando en
  // teoría — más defensivo que solo `id`.
  const filteredAsSelectable = useMemo(
    () => sort.sorted.map((i) => ({ id: `${i.table}:${i.id}` })),
    [sort.sorted],
  );
  const sel = useMultiSelect(filteredAsSelectable);

  // Paginación client-side. Reset a página 1 cuando cambia el filtro
  // por tipo, el search o el orden — sin esto el usuario filtra y queda
  // en una página vacía. Page size más alto que el default 25 porque la
  // papelera tiende a tener muchos items pequeños.
  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:trash",
    resetKey: `${filterTable}|${search}|${sort.resetKey}`,
  });

  const handleRestore = async (item: TrashItem) => {
    setBusy(item.id);
    try {
      const { error } = await restoreItem(item.table, item.id);
      if (error) {
        toast.error(friendlyError(error, t("trash.restoreError", { defaultValue: "No se pudo restaurar" })));
        return;
      }
      // Restaurar un curso/tenant cascadea a sus hijos (exámenes/talleres/
      // sesiones/etc. borrados con el mismo timestamp) vía restore_*_cascade →
      // esos hijos ya NO están en papelera pero seguirían visibles como filas
      // separadas si solo filtráramos el id clicado. Recargamos para reflejar
      // el estado real y evitar hard-deletes sobre filas fantasma.
      if (item.table === "courses" || item.table === "tenants") {
        void load();
      } else {
        setItems((prev) => prev.filter((i) => i.id !== item.id));
      }
      toast.success(
        i18n.t("toast.routes_app_trash.itemRestored", {
          defaultValue: "{{type}}: {{name}} restaurado",
          type: TRASH_TABLE_LABEL[item.table],
          name: item.name,
        }),
      );
    } finally {
      setBusy(null);
    }
  };

  const handleHardDelete = async (item: TrashItem) => {
    const ok = await confirm({
      title: t("trash.confirmHardDeleteTitle"),
      description: t("trash.confirmHardDeleteDesc", {
        name: item.name,
        type: TRASH_TABLE_LABEL[item.table],
      }),
      confirmLabel: t("trash.confirmHardDeleteLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    setBusy(item.id);
    try {
      const { error } = await hardDeleteItem(item.table, item.id);
      if (error) {
        toast.error(friendlyError(error, t("trash.hardDeleteError", { defaultValue: "No se pudo eliminar" })));
        return;
      }
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      toast.success(
        i18n.t("toast.routes_app_trash.itemHardDeleted", {
          defaultValue: "Eliminado definitivamente",
        }),
      );
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
      title: t("trash.confirmBulkRestoreTitle", { count: selectedItems.length }),
      description: t("trash.confirmBulkRestoreDesc"),
      confirmLabel: t("trash.confirmBulkRestoreLabel"),
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
      // Si alguna restauración exitosa fue de curso/tenant, cascadeó a hijos que
      // seguirían apareciendo como filas fantasma → recargar en vez de filtrar ids.
      const cascaded = results.some(
        (r) => !r.error && (r.item.table === "courses" || r.item.table === "tenants"),
      );
      sel.clear();
      if (cascaded) {
        void load();
      } else {
        setItems((prev) => prev.filter((i) => !successIds.has(`${i.table}:${i.id}`)));
      }
      if (failed.length === 0) {
        toast.success(
          i18n.t("toast.routes_app_trash.bulkRestoreSuccess", {
            defaultValue: "{{count}} item(s) restaurado(s)",
            count: selectedItems.length,
          }),
        );
      } else {
        const first = failed[0];
        const detail = friendlyError(
        first.error ?? undefined,
        t("trash.unknownError", { defaultValue: "Error desconocido" }),
      );
        toast.error(
          i18n.t("toast.routes_app_trash.bulkRestorePartialError", {
            defaultValue:
              '{{ok}} restaurado(s), {{failed}} con error. Primero: "{{name}}" — {{detail}}',
            ok: selectedItems.length - failed.length,
            failed: failed.length,
            name: first.item.name,
            detail,
          }),
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
      title: t("trash.confirmBulkHardDeleteTitle", { count: selectedItems.length }),
      description: t("trash.confirmBulkHardDeleteDesc"),
      confirmLabel: t("trash.confirmBulkHardDeleteLabel"),
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
        toast.success(
          i18n.t("toast.routes_app_trash.bulkHardDeleteSuccess", {
            defaultValue: "{{count}} item(s) eliminado(s) definitivamente",
            count: selectedItems.length,
          }),
        );
      } else {
        // Incluimos el detalle del PRIMER error y el nombre del item que
        // falló — antes era "N con error" a secas y el usuario no podía
        // diagnosticar qué tabla/FK lo bloqueaba (caso reportado al
        // hard-delete tenants con dependencias RESTRICT).
        const first = failed[0];
        const detail = friendlyError(
        first.error ?? undefined,
        t("trash.unknownError", { defaultValue: "Error desconocido" }),
      );
        toast.error(
          i18n.t("toast.routes_app_trash.bulkHardDeletePartialError", {
            defaultValue:
              '{{ok}} eliminado(s), {{failed}} con error. Primero: "{{name}}" — {{detail}}',
            ok: selectedItems.length - failed.length,
            failed: failed.length,
            name: first.item.name,
            detail,
          }),
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
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4 sm:p-8">
        <Spinner size="sm" /> {t("trash.loading")}
      </div>
    );
  }

  if (loadError) {
    return (
      <ErrorState
        message={t("trash.loadError")}
        hint={loadError}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {bulkBusy && (
        <LoadingOverlay
          title={t("trash.processingOverlay")}
          subtitle={t("trash.processingSubtitle", { count: selectedItems.length })}
        />
      )}
      <PageHeader
        icon={<Trash2 className="h-6 w-6 text-primary" />}
        title={t("trash.title")}
        subtitle={
          items.length === 0
            ? t("trash.subtitleEmpty")
            : t("trash.subtitleWithItems", { count: items.length, days: RETENTION_DAYS })
        }
      />

      {/* Stats 4-card — mismo patrón visual que el resto de los módulos.
          Conteos absolutos sobre `items` (sin aplicar search/filter) —
          dan contexto general; el detalle filtrado vive en la tabla. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={Trash2} label={t("trash.statTotal")} value={trashStats.total} />
        <StatCard
          icon={AlertTriangle}
          label={t("trash.statUrgent")}
          value={trashStats.urgent}
          tone={trashStats.urgent > 0 ? "destructive" : "default"}
        />
        <StatCard
          icon={Clock}
          label={t("trash.statSoon")}
          value={trashStats.soon}
          tone={trashStats.soon > 0 ? "warning" : "default"}
        />
        <StatCard icon={Archive} label={t("trash.statSafe")} value={trashStats.safe} />
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
              placeholder={t("trash.searchPlaceholder")}
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
              <SelectItem value="all">
                {t("trash.filterAll", { count: countByTable.all })}
              </SelectItem>
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
              <X className="h-4 w-4 mr-1" /> {t("trash.clearFilters")}
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
              {t("trash.bulkSelected", { count: sel.count })}
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
                {t("trash.bulkRestore")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleBulkHardDelete()}
                disabled={bulkBusy}
                className="text-destructive border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="h-3.5 w-3.5 mr-1" />
                {t("trash.bulkHardDelete")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => sel.clear()} disabled={bulkBusy}>
                {t("trash.bulkCancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table fixed resizable>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <MultiSelectHeaderCheckbox state={sel} />
                </TableHead>
                <SortableHead sortKey="name" sort={sort} className="min-w-40">
                  {t("trash.colName")}
                </SortableHead>
                <SortableHead sortKey="type" sort={sort} className="hidden sm:table-cell w-32">
                  {t("trash.colType")}
                </SortableHead>
                <SortableHead
                  sortKey="deleted_by"
                  sort={sort}
                  className="hidden md:table-cell w-40"
                >
                  {t("trash.colDeletedBy")}
                </SortableHead>
                <SortableHead
                  sortKey="deleted_at"
                  sort={sort}
                  className="hidden sm:table-cell w-44"
                >
                  {t("trash.colDeletedAt")}
                </SortableHead>
                <SortableHead sortKey="purges_in" sort={sort} className="hidden sm:table-cell w-32">
                  {t("trash.colPurgesIn")}
                </SortableHead>
                <TableHead className="text-right w-20">{t("trash.colActions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagination.paginatedItems.length === 0 ? (
                <TableEmpty
                  colSpan={7}
                  text={
                    search || filterTable !== "all" ? t("trash.emptyFiltered") : t("trash.emptyAll")
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
                        <div className="truncate" title={item.name}>
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
                        <div className="truncate" title={item.deleted_by_name ?? "—"}>
                          {item.deleted_by_name ?? "—"}
                        </div>
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
                          title={t("trash.purgeAutoTitle", {
                            days: RETENTION_DAYS,
                            defaultValue:
                              "Se purgará automáticamente cuando pasen {{days}} días desde la eliminación.",
                          })}
                        >
                          <Clock className="h-3 w-3" />
                          {days <= 0
                            ? t("trash.purgeToday")
                            : t("trash.purgeDays", { count: days })}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="inline-flex items-center gap-1">
                          <RowAction
                            label={t("trash.actionRestore")}
                            icon={RotateCcw}
                            onClick={() => void handleRestore(item)}
                            disabled={isBusyItem || bulkBusy}
                            loading={isBusyItem}
                          />
                          <RowAction
                            label={t("trash.actionHardDelete")}
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
