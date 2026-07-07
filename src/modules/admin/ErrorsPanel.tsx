/**
 * ErrorsPanel — vista de errores agrupados por fingerprint.
 *
 * Extraído de `app.admin.errors.tsx` para que pueda renderizarse como
 * tab dentro del módulo de Auditoría (la ruta `/app/admin/errors` se
 * mantiene como redirect a `/app/admin/audit-logs`, pero el item del
 * sidebar se eliminó: ahora todo lo de errores vive bajo Auditoría
 * para unificar la gestión de eventos del sistema).
 *
 * Admin: ve los errores de SU institución. SuperAdmin: ve los de TODA
 * la plataforma y puede filtrar por institución (incluye errores de
 * sistema sin tenant — cron/edges).
 *
 * Datos: `audit_logs` con severity='error', vía los RPCs SECURITY
 * DEFINER `list_error_events` / `error_event_counts` /
 * `set_error_events_status` (migración 20260713000000) que encapsulan
 * el scoping por rol + tenant. El estado (nuevo/revisando/resuelto/
 * ignorado) vive en `error_event_status` y se aplica en bulk.
 *
 * Vista por GRUPO (no por evento): los eventos se agrupan por
 * fingerprint (action + categoría + mensaje normalizado — UUIDs/ids/
 * números colapsados) en el cliente. Una fila por grupo muestra el
 * conteo de ocurrencias, el último visto, y el estado agregado.
 * Expandir el grupo muestra cada evento individual con sus propios
 * datos + checkbox para marcar individualmente. Cada grupo tiene su
 * propio menú "Marcar todos como…" que aplica el estado a TODOS sus
 * eventos de una.
 */
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
  SortableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
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
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  CheckCircle2,
  Eye,
  Circle,
  XCircle,
  Sparkles,
  Copy,
} from "lucide-react";
import {
  errorMessage,
  normalizeErrorMessage,
  ERROR_STATUSES,
  groupEvents,
  aggregateGroupStatus,
  type ErrStatus,
  type ErrorEventGroup,
} from "@/modules/errors/error-event";
import { MarkdownViewer } from "@/shared/components/MarkdownViewer";
import { extractEdgeError } from "@/shared/lib/edge-error";

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
  entity_id: string | null;
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
    label: i18n.t("hc_modulesAdminErrorsPanel.statusNuevo"),
    badge: "destructive",
    color: "text-rose-500 dark:text-rose-400",
    icon: Circle,
  },
  revisando: {
    label: i18n.t("hc_modulesAdminErrorsPanel.statusRevisando"),
    badge: "default",
    color: "text-amber-500 dark:text-amber-400",
    icon: Eye,
  },
  resuelto: {
    label: i18n.t("hc_modulesAdminErrorsPanel.statusResuelto"),
    badge: "secondary",
    color: "text-emerald-500 dark:text-emerald-400",
    icon: CheckCircle2,
  },
  ignorado: {
    label: i18n.t("hc_modulesAdminErrorsPanel.statusIgnorado"),
    badge: "outline",
    color: "text-muted-foreground",
    icon: XCircle,
  },
};

interface Props {
  /** Cuando true, omitimos el PageHeader interno. Lo usa el wrapper que
   *  monta este panel como tab dentro de Auditoría — el PageHeader ya
   *  está arriba de las tabs y otro duplica el título. */
  embedded?: boolean;
}

export function ErrorsPanel({ embedded = false }: Props) {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const isSuperAdmin = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");
  const isAdmin = roles.includes("Admin");

  const [events, setEvents] = useState<ErrorEvent[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // Default = "nuevo" (errores sin atender = lo accionable/vigente para el
  // triage). El admin puede ver el resto clicando el tile "Total" (= "all")
  // o cualquier otro estado. Constante determinista → sin riesgo de
  // hydration mismatch (no leemos storage/URL en el initializer).
  const [statusFilter, setStatusFilter] = useState<"all" | ErrStatus>("nuevo");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }>>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<ErrStatus>("revisando");
  const [applying, setApplying] = useState(false);
  const [applyingGroup, setApplyingGroup] = useState<string | null>(null);

  // Análisis con IA por grupo (fingerprint → estado). Advisory-only: el
  // edge `support-ai-suggest` SOLO devuelve texto; ninguna acción se
  // ejecuta desde acá.
  const [aiAnalysis, setAiAnalysis] = useState<
    Record<string, { loading: boolean; text: string | null; error: string | null }>
  >({});

  const sel = useMultiSelect(events);

  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    void (async () => {
      const { data } = await db
        .from("tenants")
        .select("id, name")
        .is("deleted_at", null)
        .order("name");
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
        setLoadError(friendlyError(listRes.error, t("hc_modulesAdminErrorsPanel.loadErrorFallback")));
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

  const groups = useMemo<ErrorEventGroup<ErrorEvent>[]>(() => groupEvents(events), [events]);

  // Orden por columna entre el agrupamiento y la paginación. Cada fila del
  // grid es un GRUPO (no un evento), así que los accessors leen del grupo.
  const sort = useTableSort(groups, {
    columns: {
      action: (g) => g.action,
      category: (g) => g.category,
      // Institución: mismo valor derivado que pinta la celda (nombre único,
      // "N instituciones" o "— sistema —") para que el orden coincida con
      // lo que el SuperAdmin ve en la columna.
      institution: (g) => {
        const names = Array.from(
          new Set(g.events.map((e) => e.tenant_name).filter((n): n is string => Boolean(n))),
        );
        if (names.length === 0) return t("hc_modulesAdminErrorsPanel.systemTenant");
        if (names.length === 1) return names[0];
        return t("hc_modulesAdminErrorsPanel.nInstitutions", { count: names.length });
      },
      count: (g) => g.count,
      status: (g) => aggregateGroupStatus(g.statusCounts),
    },
    defaultSort: { key: "count", dir: "desc" },
    storageKey: "examlab_sort:admin_errors",
  });

  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:admin_errors",
    resetKey: `${statusFilter}|${tenantFilter}|${sort.resetKey}`,
  });

  const total = useMemo(
    () => ERROR_STATUSES.reduce((acc, s) => acc + (counts[s] ?? 0), 0),
    [counts],
  );

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
      i18n.t("toast.modules_admin_ErrorsPanel.bulkStatusApplied", {
        defaultValue: "{{count}} evento{{plural}} → {{status}}",
        count: ids.length,
        plural: ids.length === 1 ? "" : "s",
        status: STATUS_CFG[bulkStatus].label,
      }),
    );
    setRetryNonce((n) => n + 1);
  };

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
      i18n.t("toast.modules_admin_ErrorsPanel.groupStatusApplied", {
        defaultValue: "{{count}} evento{{plural}} del grupo → {{status}}",
        count: ids.length,
        plural: ids.length === 1 ? "" : "s",
        status: STATUS_CFG[next].label,
      }),
    );
    setRetryNonce((n) => n + 1);
  };

  // "Analizar con IA": pide al edge un diagnóstico + pasos de remediación
  // para el grupo de errores. El mensaje se envía YA NORMALIZADO por
  // error-event.ts (el edge NO re-normaliza). El resultado se muestra en
  // el panel expandible del grupo.
  const analyzeGroup = async (group: ErrorEventGroup<ErrorEvent>) => {
    const fp = group.fingerprint;
    if (aiAnalysis[fp]?.loading) return;
    // Asegurar que el grupo quede expandido para que se vea el resultado.
    setExpandedGroups((prev) => new Set(prev).add(fp));
    setAiAnalysis((prev) => ({ ...prev, [fp]: { loading: true, text: null, error: null } }));
    try {
      const raw = group.sampleMessage ?? "";
      const normalized = raw ? normalizeErrorMessage(raw) : group.action;
      const { data, error } = await supabase.functions.invoke("support-ai-suggest", {
        body: {
          mode: "error",
          auditLogId: group.events[0]?.id ?? null,
          errorMessage: normalized,
          errorAction: group.action,
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (error || (data as any)?.error) {
        const real = await extractEdgeError(error, data);
        throw new Error(real || t("hc_modulesAdminErrorsPanel.aiAnalyzeError"));
      }
      const suggestion = (data as { suggestion?: string } | null)?.suggestion?.trim();
      if (!suggestion) throw new Error(t("hc_modulesAdminErrorsPanel.aiAnalyzeError"));
      setAiAnalysis((prev) => ({
        ...prev,
        [fp]: { loading: false, text: suggestion, error: null },
      }));
    } catch (e) {
      setAiAnalysis((prev) => ({
        ...prev,
        [fp]: {
          loading: false,
          text: null,
          error: friendlyError(e, t("hc_modulesAdminErrorsPanel.aiAnalyzeError")),
        },
      }));
    }
  };

  const toggleExpand = (fingerprint: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(fingerprint)) next.delete(fingerprint);
      else next.add(fingerprint);
      return next;
    });

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
    return <p className="text-muted-foreground p-6">{t("hc_modulesAdminErrorsPanel.needAdminRole")}</p>;
  }

  const colSpan = isSuperAdmin ? 8 : 7;

  return (
    <div className="space-y-5">
      {!embedded && (
        <PageHeader
          title={t("hc_modulesAdminErrorsPanel.pageTitle")}
          subtitle={
            isSuperAdmin
              ? t("hc_modulesAdminErrorsPanel.subtitleSuperAdmin")
              : t("hc_modulesAdminErrorsPanel.subtitleAdmin")
          }
          icon={<AlertTriangle className="h-6 w-6 text-rose-500" />}
          actions={
            <Button variant="outline" size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
              <RefreshCw className="h-4 w-4 mr-1" />
              {t("hc_modulesAdminErrorsPanel.refresh")}
            </Button>
          }
        />
      )}

      {/* Tiles de conteo por estado — son conteos de EVENTOS, no de
          grupos, para mantener consistencia con los RPCs de count que
          también cuentan eventos (un grupo puede tener N eventos). */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <CountTile
          label={t("hc_modulesAdminErrorsPanel.total")}
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

      {/* Filtro de institución (solo SuperAdmin) + acción de refresh
          cuando el panel va embebido (no tiene PageHeader donde colocar
          el botón "Actualizar"). */}
      <div className="flex flex-wrap items-center gap-2">
        {isSuperAdmin && tenants.length > 0 && (
          <Select value={tenantFilter} onValueChange={setTenantFilter}>
            <SelectTrigger className="w-full sm:w-64 h-9 text-xs">
              <SelectValue placeholder={t("hc_modulesAdminErrorsPanel.institution")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("hc_modulesAdminErrorsPanel.allInstitutions")}</SelectItem>
              {tenants.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {embedded && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetryNonce((n) => n + 1)}
            className="ml-auto"
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            {t("hc_modulesAdminErrorsPanel.refresh")}
          </Button>
        )}
      </div>

      {sel.count > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
          <span className="text-sm text-muted-foreground">
            {t("hc_modulesAdminErrorsPanel.eventsSelected", { count: sel.count })}
          </span>
          <span className="text-sm text-muted-foreground">
            {t("hc_modulesAdminErrorsPanel.markAsLabel")}
          </span>
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
            {t("hc_modulesAdminErrorsPanel.apply")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => sel.clear()}>
            {t("hc_modulesAdminErrorsPanel.clear")}
          </Button>
        </div>
      )}

      {loading ? (
        <div className="p-4 sm:p-8 flex items-center justify-center text-sm text-muted-foreground">
          <Spinner size="sm" className="mr-2" /> {t("hc_modulesAdminErrorsPanel.loading")}
        </div>
      ) : loadError ? (
        <ErrorState
          message={t("hc_modulesAdminErrorsPanel.loadErrorTitle")}
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
                  <SortableHead sortKey="action" sort={sort} className="min-w-36 sm:min-w-48">
                    {t("hc_modulesAdminErrorsPanel.colError")}
                  </SortableHead>
                  <SortableHead sortKey="category" sort={sort} className="hidden md:table-cell w-28">
                    {t("hc_modulesAdminErrorsPanel.colCategory")}
                  </SortableHead>
                  {isSuperAdmin && (
                    <SortableHead
                      sortKey="institution"
                      sort={sort}
                      className="hidden lg:table-cell w-40"
                    >
                      {t("hc_modulesAdminErrorsPanel.colInstitution")}
                    </SortableHead>
                  )}
                  <SortableHead sortKey="count" sort={sort} className="w-24">
                    {t("hc_modulesAdminErrorsPanel.colEvents")}
                  </SortableHead>
                  <SortableHead sortKey="status" sort={sort} className="w-28">
                    {t("hc_modulesAdminErrorsPanel.colStatus")}
                  </SortableHead>
                  <TableHead className="w-12 text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.length === 0 ? (
                  <TableEmpty
                    colSpan={colSpan}
                    icon={AlertTriangle}
                    title={t("hc_modulesAdminErrorsPanel.emptyTitle")}
                    description={
                      statusFilter !== "all"
                        ? t("hc_modulesAdminErrorsPanel.emptyFiltered")
                        : t("hc_modulesAdminErrorsPanel.emptyAll")
                    }
                  />
                ) : (
                  pagination.paginatedItems.map((g) => {
                    const aggStatus = aggregateGroupStatus(g.statusCounts);
                    const aggCfg = STATUS_CFG[aggStatus];
                    const isOpen = expandedGroups.has(g.fingerprint);
                    const allSelected = g.events.every((e) => sel.isSelected(e.id));
                    const someSelected = !allSelected && g.events.some((e) => sel.isSelected(e.id));
                    const tenantNames = Array.from(
                      new Set(
                        g.events.map((e) => e.tenant_name).filter((n): n is string => Boolean(n)),
                      ),
                    );
                    const tenantLabel =
                      tenantNames.length === 0
                        ? t("hc_modulesAdminErrorsPanel.systemTenant")
                        : tenantNames.length === 1
                          ? tenantNames[0]
                          : t("hc_modulesAdminErrorsPanel.nInstitutions", {
                              count: tenantNames.length,
                            });
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
                              aria-label={t("hc_modulesAdminErrorsPanel.selectGroupAria")}
                            />
                          </TableCell>
                          <TableCell className="w-8">
                            <button
                              type="button"
                              onClick={() => toggleExpand(g.fingerprint)}
                              className="text-muted-foreground hover:text-foreground"
                              aria-label={
                                isOpen
                                  ? t("hc_modulesAdminErrorsPanel.collapseGroupAria")
                                  : t("hc_modulesAdminErrorsPanel.expandGroupAria")
                              }
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
                              {t("hc_modulesAdminErrorsPanel.lastSeenLabel")}{" "}
                              <DateCell value={g.lastSeen} variant="datetime" />
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
                              {t("hc_modulesAdminErrorsPanel.eventCount", { count: g.count })}
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
                                actions={[
                                  {
                                    label: t("hc_modulesAdminErrorsPanel.aiAnalyze"),
                                    icon: Sparkles,
                                    onClick: () => void analyzeGroup(g),
                                    disabled: aiAnalysis[g.fingerprint]?.loading,
                                  },
                                  ...ERROR_STATUSES.map((s, i) => ({
                                    label: t("hc_modulesAdminErrorsPanel.markAllAs", {
                                      status: STATUS_CFG[s].label,
                                    }),
                                    icon: STATUS_CFG[s].icon,
                                    onClick: () => void applyGroupStatus(g, s),
                                    disabled: s === aggStatus && g.count === g.statusCounts[s],
                                    separatorBefore: i === 0 ? true : undefined,
                                  })),
                                ]}
                              />
                            )}
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow>
                            <TableCell colSpan={colSpan} className="bg-muted/30 py-2">
                              <div className="space-y-2">
                                <AiAnalysisPanel
                                  state={aiAnalysis[g.fingerprint]}
                                  onAnalyze={() => void analyzeGroup(g)}
                                />
                                {g.events.map((ev) => (
                                  <EventDetailBlock
                                    key={ev.id}
                                    ev={ev}
                                    sel={sel}
                                    onRetried={() => setRetryNonce((n) => n + 1)}
                                  />
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

function AiAnalysisPanel({
  state,
  onAnalyze,
}: {
  state?: { loading: boolean; text: string | null; error: string | null };
  onAnalyze: () => void;
}) {
  const { t } = useTranslation();
  const copySuggestion = () => {
    if (!state?.text) return;
    void navigator.clipboard
      .writeText(state.text)
      .then(() => toast.success(t("hc_modulesAdminErrorsPanel.aiCopied")))
      .catch(() => toast.error(t("hc_modulesAdminErrorsPanel.aiCopyError")));
  };
  return (
    <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-xs space-y-2">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium">{t("hc_modulesAdminErrorsPanel.aiPanelTitle")}</span>
        <div className="ml-auto flex items-center gap-1">
          {state?.text && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={copySuggestion}>
              <Copy className="h-3 w-3 mr-1" />
              {t("hc_modulesAdminErrorsPanel.aiCopy")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={onAnalyze}
            disabled={state?.loading}
          >
            {state?.loading ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <Sparkles className="h-3 w-3 mr-1" />
            )}
            {state?.text || state?.error
              ? t("hc_modulesAdminErrorsPanel.aiReanalyze")
              : t("hc_modulesAdminErrorsPanel.aiAnalyze")}
          </Button>
        </div>
      </div>
      {state?.loading && (
        <p className="text-muted-foreground">{t("hc_modulesAdminErrorsPanel.aiAnalyzing")}</p>
      )}
      {state?.error && !state.loading && (
        <p className="text-destructive break-words">{state.error}</p>
      )}
      {state?.text && !state.loading && (
        <div className="rounded bg-background border p-2 max-h-80 overflow-y-auto">
          <MarkdownViewer>{state.text}</MarkdownViewer>
        </div>
      )}
      {!state && (
        <p className="text-muted-foreground">{t("hc_modulesAdminErrorsPanel.aiPanelHint")}</p>
      )}
    </div>
  );
}

function EventDetailBlock({
  ev,
  sel,
  onRetried,
}: {
  ev: ErrorEvent;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sel: any;
  onRetried?: () => void;
}) {
  const { t } = useTranslation();
  const cfg = STATUS_CFG[ev.status];
  const msg = errorMessage(ev.metadata);
  const [retrying, setRetrying] = useState(false);
  // Safe-action: reintentar calificación. Solo aplica a jobs de la cola de
  // IA (`ai_grading.job_failed`, entity_type='ai_grading_queue'), cuyo
  // entity_id ES el id del job. Reusa la RPC existente
  // `requeue_ai_grading_job(_job_id)` (que revalida permisos server-side).
  const isGradingJob = ev.entity_type === "ai_grading_queue" && !!ev.entity_id;
  const retryGrading = async () => {
    if (!ev.entity_id || retrying) return;
    setRetrying(true);
    const { error } = await db.rpc("requeue_ai_grading_job", { _job_id: ev.entity_id });
    setRetrying(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(t("hc_modulesAdminErrorsPanel.retryGradingDone"));
    onRetried?.();
  };
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
              <DetailRow
                k={t("hc_modulesAdminErrorsPanel.detailEntity")}
                v={`${ev.entity_type ?? ""} ${ev.entity_name}`.trim()}
              />
            )}
            {ev.course_name && (
              <DetailRow k={t("hc_modulesAdminErrorsPanel.detailCourse")} v={ev.course_name} />
            )}
            {ev.reviewed_at && (
              <DetailRow k={t("hc_modulesAdminErrorsPanel.detailReviewed")} v={ev.reviewed_at} />
            )}
            <DetailRow k={t("hc_modulesAdminErrorsPanel.detailId")} v={ev.id} mono />
          </div>
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground">
              {t("hc_modulesAdminErrorsPanel.metadata")}
            </summary>
            <pre className="text-[11px] whitespace-pre-wrap break-all bg-muted rounded p-2 mt-1 max-h-40 overflow-y-auto">
              {JSON.stringify(ev.metadata, null, 2)}
            </pre>
          </details>
          {isGradingJob && (
            <div className="pt-1">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={() => void retryGrading()}
                disabled={retrying}
              >
                {retrying ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <RefreshCw className="h-3 w-3 mr-1" />
                )}
                {t("hc_modulesAdminErrorsPanel.retryGrading")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
