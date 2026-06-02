/**
 * Módulo de gestión de errores de la plataforma.
 *
 * Admin: ve los errores de SU institución. SuperAdmin: ve los de TODA la
 * plataforma y puede filtrar por institución (incluye errores de sistema
 * sin tenant — cron/edges). Misma convención que otros módulos
 * compartidos (Usuarios/Cursos/Certificados): el SuperAdmin hereda la
 * ruta /app/admin/* y se le muestra el filtro de institución.
 *
 * Datos: `audit_logs` con severity='error', vía los RPCs SECURITY DEFINER
 * `list_error_events` / `error_event_counts` / `set_error_events_status`
 * (migración 20260713000000) que encapsulan el scoping por rol + tenant.
 * El estado (nuevo/revisando/resuelto/ignorado) vive en
 * `error_event_status` y se aplica en bulk.
 *
 * Vista por GRUPO (no por evento): los eventos se agrupan por
 * fingerprint (action + categoría + mensaje normalizado — UUIDs/ids/
 * números colapsados) en el cliente. Una fila por grupo muestra el conteo
 * de ocurrencias, el último visto, y el estado agregado. Expandir el
 * grupo muestra cada evento individual con sus propios datos + checkbox
 * para marcar individualmente. Cada grupo tiene su propio menú "Marcar
 * todos como…" que aplica el estado a TODOS sus eventos de una.
 */
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { DateCell } from "@/components/ui/date-cell";
import { Checkbox } from "@/components/ui/checkbox";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
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
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
} from "@/components/ui/multi-select";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  CheckCircle2,
  Eye,
  Circle,
  XCircle,
} from "lucide-react";
import {
  errorMessage,
  ERROR_STATUSES,
  groupEvents,
  aggregateGroupStatus,
  type ErrStatus,
  type ErrorEventGroup,
} from "@/modules/errors/error-event";

export const Route = createFileRoute("/app/admin/errors")({ component: ErrorsModule });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface ErrorEvent {
  id: string;
  created_at: string;
  action: string;
  category: string;
  actor_email: string | null;
  actor_role: string | null;
  entity_type: string | null;
  entity_name: string | null;
  course_name: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata: any;
  status: ErrStatus;
  reviewed_at: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
}

const STATUS_CFG: Record<
  ErrStatus,
  {
    label: string;
    badge: "destructive" | "secondary" | "outline" | "default";
    color: string;
    icon: typeof CheckCircle2;
  }
> = {
  nuevo: {
    label: "Nuevo",
    badge: "destructive",
    color: "text-rose-500 dark:text-rose-400",
    icon: Circle,
  },
  revisando: {
    label: "Revisando",
    badge: "default",
    color: "text-amber-500 dark:text-amber-400",
    icon: Eye,
  },
  resuelto: {
    label: "Resuelto",
    badge: "secondary",
    color: "text-emerald-500 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  ignorado: {
    label: "Ignorado",
    badge: "outline",
    color: "text-muted-foreground",
    icon: XCircle,
  },
};

function ErrorsModule() {
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  // Filtro cross-tenant solo cuando actúa como SuperAdmin (no por solo
  // tener el rol). Ver comentario en app.admin.users.
  const isSuperAdmin = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");
  const isAdmin = roles.includes("Admin");

  const [events, setEvents] = useState<ErrorEvent[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const [statusFilter, setStatusFilter] = useState<"all" | ErrStatus>("all");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }>>([]);
  // Set de fingerprints expandidos — un grupo expandido revela sus eventos.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<ErrStatus>("revisando");
  const [applying, setApplying] = useState(false);
  // Fingerprint del grupo cuyo "Marcar todos…" está corriendo (para
  // mostrar spinner inline y deshabilitar reentradas).
  const [applyingGroup, setApplyingGroup] = useState<string | null>(null);

  // Multi-select sobre eventos individuales. La selección "por grupo"
  // (checkbox en la fila del grupo) opera sobre los IDs de eventos de
  // ese grupo, por lo que la toolbar de acción masiva sigue funcionando
  // sin saber de grupos.
  const sel = useMultiSelect(events);

  // Tenants para el filtro (solo SuperAdmin).
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    void (async () => {
      const { data } = await db.from("tenants").select("id, name").order("name");
      if (cancelled) return;
      setTenants((data ?? []) as Array<{ id: string; name: string }>);
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdmin]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      const tenantArg = isSuperAdmin && tenantFilter !== "all" ? tenantFilter : null;
      const statusArg = statusFilter === "all" ? null : statusFilter;
      const [listRes, countRes] = await Promise.all([
        db.rpc("list_error_events", {
          _tenant_filter: tenantArg,
          _status_filter: statusArg,
          _limit: 300,
        }),
        db.rpc("error_event_counts", { _tenant_filter: tenantArg }),
      ]);
      if (cancelled) return;
      if (listRes.error) {
        setLoadError(friendlyError(listRes.error, "No pudimos cargar los errores."));
      } else {
        setEvents((listRes.data ?? []) as ErrorEvent[]);
      }
      const cmap: Record<string, number> = {};
      for (const r of (countRes.data ?? []) as Array<{ status: string; count: number }>) {
        cmap[r.status] = Number(r.count);
      }
      setCounts(cmap);
      sel.clear();
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuperAdmin, tenantFilter, statusFilter, retryNonce]);

  // Agrupado client-side por fingerprint (action+categoría+mensaje
  // normalizado). Si en el futuro la cantidad de eventos supera el
  // límite de 300 del RPC, hay que migrar a un RPC de agrupamiento en
  // SQL — por ahora, 300 cubre el caso típico.
  const groups = useMemo<ErrorEventGroup<ErrorEvent>[]>(() => groupEvents(events), [events]);

  // Paginación sobre la lista de GRUPOS (cada grupo es una fila del grid;
  // los eventos individuales viven dentro del grupo expandido). Reset
  // cuando cambia el scope del fetch (status + tenant).
  const pagination = usePagination(groups, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:admin_errors",
    resetKey: `${statusFilter}|${tenantFilter}`,
  });

  const total = useMemo(
    () => ERROR_STATUSES.reduce((acc, s) => acc + (counts[s] ?? 0), 0),
    [counts],
  );

  // Aplica un estado a TODOS los eventos seleccionados (toolbar masiva).
  const applyBulk = async () => {
    const ids = [...sel.selectedIds];
    if (ids.length === 0) return;
    setApplying(true);
    const { error } = await db.rpc("set_error_events_status", {
      _ids: ids,
      _status: bulkStatus,
    });
    setApplying(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      `${ids.length} evento${ids.length === 1 ? "" : "s"} → ${STATUS_CFG[bulkStatus].label}`,
    );
    setRetryNonce((n) => n + 1);
  };

  // Aplica un estado a TODOS los eventos de un grupo (acción "Marcar
  // todos como…" del menú por fila).
  const applyGroupStatus = async (group: ErrorEventGroup<ErrorEvent>, next: ErrStatus) => {
    if (applyingGroup) return;
    const ids = group.events.map((e) => e.id);
    if (ids.length === 0) return;
    setApplyingGroup(group.fingerprint);
    const { error } = await db.rpc("set_error_events_status", {
      _ids: ids,
      _status: next,
    });
    setApplyingGroup(null);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      `${ids.length} evento${ids.length === 1 ? "" : "s"} del grupo → ${STATUS_CFG[next].label}`,
    );
    setRetryNonce((n) => n + 1);
  };

  const toggleExpand = (fingerprint: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(fingerprint)) next.delete(fingerprint);
      else next.add(fingerprint);
      return next;
    });

  // Selecciona / deselecciona todos los eventos del grupo en bloque.
  // Si TODOS ya están seleccionados → los quita; si no → los suma.
  const toggleGroupSelection = (group: ErrorEventGroup<ErrorEvent>) => {
    const allSelected = group.events.every((e) => sel.isSelected(e.id));
    if (allSelected) {
      for (const e of group.events) {
        if (sel.isSelected(e.id)) sel.toggle(e.id);
      }
    } else {
      for (const e of group.events) {
        if (!sel.isSelected(e.id)) sel.toggle(e.id);
      }
    }
  };

  if (!isAdmin && !isSuperAdmin) {
    return <p className="text-muted-foreground p-6">Necesitas rol Admin o SuperAdmin.</p>;
  }

  // checkbox + expand + acción/mensaje + categoría + (institución) +
  // ocurrencias + estado + acciones. La columna "Institución" solo
  // existe para SuperAdmin.
  const colSpan = isSuperAdmin ? 8 : 7;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Errores"
        subtitle={
          isSuperAdmin
            ? "Errores de toda la plataforma. Agrupados por tipo; expandí un grupo para ver sus eventos."
            : "Errores de tu institución. Agrupados por tipo; expandí un grupo para ver sus eventos."
        }
        icon={<AlertTriangle className="h-6 w-6 text-rose-500" />}
        actions={
          <Button variant="outline" size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Actualizar
          </Button>
        }
      />

      {/* Tiles de conteo por estado — son conteos de EVENTOS, no de
          grupos, para mantener consistencia con los RPCs de count que
          también cuentan eventos (un grupo puede tener N eventos). */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <CountTile
          label="Total"
          value={total}
          active={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
        />
        {ERROR_STATUSES.map((s) => (
          <CountTile
            key={s}
            label={STATUS_CFG[s].label}
            value={counts[s] ?? 0}
            color={STATUS_CFG[s].color}
            active={statusFilter === s}
            onClick={() => setStatusFilter((prev) => (prev === s ? "all" : s))}
          />
        ))}
      </div>

      {/* Filtro de institución (solo SuperAdmin). */}
      {isSuperAdmin && tenants.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={tenantFilter} onValueChange={setTenantFilter}>
            <SelectTrigger className="w-full sm:w-64 h-9 text-xs">
              <SelectValue placeholder="Institución" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las instituciones</SelectItem>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Toolbar de acción masiva — opera sobre eventos seleccionados
          individualmente o vía "seleccionar grupo". */}
      {sel.count > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
          <span className="text-sm text-muted-foreground">
            {sel.count} evento{sel.count === 1 ? "" : "s"} seleccionado
            {sel.count === 1 ? "" : "s"}
          </span>
          <span className="text-sm text-muted-foreground">· marcar como</span>
          <Select value={bulkStatus} onValueChange={(v) => setBulkStatus(v as ErrStatus)}>
            <SelectTrigger className="w-40 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ERROR_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_CFG[s].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={() => void applyBulk()} disabled={applying}>
            {applying && <Spinner size="sm" className="mr-1" />}
            Aplicar
          </Button>
          <Button size="sm" variant="ghost" onClick={() => sel.clear()}>
            Limpiar
          </Button>
        </div>
      )}

      {loading ? (
        <div className="p-8 flex items-center justify-center text-sm text-muted-foreground">
          <Spinner size="sm" className="mr-2" /> Cargando…
        </div>
      ) : loadError ? (
        <ErrorState
          message="No pudimos cargar los errores"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table fixed resizable>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <MultiSelectHeaderCheckbox state={sel} />
                  </TableHead>
                  <TableHead className="w-8" />
                  <TableHead className="min-w-48">Error</TableHead>
                  <TableHead className="hidden md:table-cell w-28">Categoría</TableHead>
                  {isSuperAdmin && (
                    <TableHead className="hidden lg:table-cell w-40">Institución</TableHead>
                  )}
                  <TableHead className="w-24">Eventos</TableHead>
                  <TableHead className="w-28">Estado</TableHead>
                  <TableHead className="w-12 text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.length === 0 ? (
                  <TableEmpty
                    colSpan={colSpan}
                    icon={AlertTriangle}
                    title="Sin errores"
                    description={
                      statusFilter !== "all"
                        ? "No hay errores con ese estado/filtro."
                        : "No se han registrado errores. 🎉"
                    }
                  />
                ) : (
                  pagination.paginatedItems.map((g) => {
                    const aggStatus = aggregateGroupStatus(g.statusCounts);
                    const aggCfg = STATUS_CFG[aggStatus];
                    const isOpen = expandedGroups.has(g.fingerprint);
                    const allSelected = g.events.every((e) => sel.isSelected(e.id));
                    const someSelected = !allSelected && g.events.some((e) => sel.isSelected(e.id));
                    // Para SuperAdmin: agrupamos por fingerprint pero los
                    // eventos pueden venir de distintos tenants (un mismo
                    // bug afecta a varias instituciones). Mostramos el
                    // tenant si es único, o "N instituciones" si son varios.
                    const tenantNames = Array.from(
                      new Set(
                        g.events.map((e) => e.tenant_name).filter((n): n is string => Boolean(n)),
                      ),
                    );
                    const tenantLabel =
                      tenantNames.length === 0
                        ? "— sistema —"
                        : tenantNames.length === 1
                          ? tenantNames[0]
                          : `${tenantNames.length} instituciones`;
                    const isGroupBusy = applyingGroup === g.fingerprint;
                    return (
                      <Fragment key={g.fingerprint}>
                        <TableRow
                          data-state={
                            allSelected ? "selected" : someSelected ? "selected" : undefined
                          }
                        >
                          <TableCell className="w-10">
                            <Checkbox
                              checked={allSelected ? true : someSelected ? "indeterminate" : false}
                              onCheckedChange={() => toggleGroupSelection(g)}
                              aria-label="Seleccionar grupo"
                            />
                          </TableCell>
                          <TableCell className="w-8">
                            <button
                              type="button"
                              onClick={() => toggleExpand(g.fingerprint)}
                              className="text-muted-foreground hover:text-foreground"
                              aria-label={isOpen ? "Colapsar grupo" : "Expandir grupo"}
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </button>
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className="truncate" title={g.action}>
                              {g.action}
                            </div>
                            {g.sampleMessage && (
                              <div
                                className="text-[11px] text-destructive truncate"
                                title={g.sampleMessage}
                              >
                                {g.sampleMessage}
                              </div>
                            )}
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              Último: <DateCell value={g.lastSeen} variant="datetime" />
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                            {g.category}
                          </TableCell>
                          {isSuperAdmin && (
                            <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                              {tenantLabel}
                            </TableCell>
                          )}
                          <TableCell className="text-xs tabular-nums">
                            <Badge variant="outline" className="text-[10px]">
                              {g.count} {g.count === 1 ? "evento" : "eventos"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant={aggCfg.badge} className="text-[10px]">
                              {aggCfg.label}
                            </Badge>
                          </TableCell>
                          <TableCell className="w-12 text-right">
                            {isGroupBusy ? (
                              <Spinner size="sm" />
                            ) : (
                              <RowActionsMenu
                                actions={ERROR_STATUSES.map((s) => ({
                                  label: `Marcar todos como ${STATUS_CFG[s].label}`,
                                  icon: STATUS_CFG[s].icon,
                                  onClick: () => void applyGroupStatus(g, s),
                                  disabled: s === aggStatus && g.count === g.statusCounts[s],
                                }))}
                              />
                            )}
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow>
                            <TableCell colSpan={colSpan} className="bg-muted/30 py-2">
                              <div className="space-y-2">
                                {g.events.map((ev) => (
                                  <EventDetailBlock key={ev.id} ev={ev} sel={sel} />
                                ))}
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </TableBody>
            </Table>
            <DataPagination state={pagination} entityNamePlural="errores" />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CountTile({
  label,
  value,
  color = "text-foreground",
  active,
  onClick,
}: {
  label: string;
  value: number;
  color?: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition-colors ${
        active ? "border-primary/50 bg-primary/5" : "hover:border-primary/30"
      }`}
    >
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
    </button>
  );
}

function DetailRow({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground w-24 shrink-0">{k}</span>
      <span className={mono ? "font-mono break-all" : "break-words"}>{v}</span>
    </div>
  );
}

/**
 * Fila de evento dentro de un grupo expandido. Pintada como tarjeta
 * compacta (no como `<tr>` anidado — evita el caos visual de tablas
 * dentro de tablas). Cada evento tiene su propio checkbox para entrar
 * en la selección masiva + sus datos crudos + metadata colapsable.
 */
function EventDetailBlock({
  ev,
  sel,
}: {
  ev: ErrorEvent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sel: any;
}) {
  const cfg = STATUS_CFG[ev.status];
  const msg = errorMessage(ev.metadata);
  return (
    <div className="rounded-md border bg-background p-2 text-xs">
      <div className="flex items-start gap-2">
        <div className="pt-0.5">
          <MultiSelectCheckbox id={ev.id} state={sel} />
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <DateCell value={ev.created_at} variant="datetime" />
            <Badge variant={cfg.badge} className="text-[10px]">
              {cfg.label}
            </Badge>
            {ev.actor_email && (
              <span className="text-muted-foreground truncate max-w-[200px]" title={ev.actor_email}>
                {ev.actor_email}
              </span>
            )}
            {ev.tenant_name && <span className="text-muted-foreground">· {ev.tenant_name}</span>}
          </div>
          {msg && <div className="text-destructive break-words">{msg}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5 text-muted-foreground">
            {ev.entity_name && (
              <DetailRow k="Entidad" v={`${ev.entity_type ?? ""} ${ev.entity_name}`.trim()} />
            )}
            {ev.course_name && <DetailRow k="Curso" v={ev.course_name} />}
            {ev.reviewed_at && <DetailRow k="Revisado" v={ev.reviewed_at} />}
            <DetailRow k="ID" v={ev.id} mono />
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
              Metadata
            </summary>
            <pre className="text-[11px] whitespace-pre-wrap break-all bg-muted rounded p-2 mt-1 max-h-40 overflow-y-auto">
              {JSON.stringify(ev.metadata, null, 2)}
            </pre>
          </details>
        </div>
      </div>
    </div>
  );
}
