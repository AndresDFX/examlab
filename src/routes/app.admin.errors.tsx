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
 */
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { DateCell } from "@/components/ui/date-cell";
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
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { errorMessage, ERROR_STATUSES, type ErrStatus } from "@/modules/errors/error-event";

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
  { label: string; badge: "destructive" | "secondary" | "outline" | "default"; color: string }
> = {
  nuevo: { label: "Nuevo", badge: "destructive", color: "text-rose-500 dark:text-rose-400" },
  revisando: { label: "Revisando", badge: "default", color: "text-amber-500 dark:text-amber-400" },
  resuelto: {
    label: "Resuelto",
    badge: "secondary",
    color: "text-emerald-500 dark:text-emerald-400",
  },
  ignorado: { label: "Ignorado", badge: "outline", color: "text-muted-foreground" },
};

function ErrorsModule() {
  const { roles } = useAuth();
  const isSuperAdmin = roles.includes("SuperAdmin");
  const isAdmin = roles.includes("Admin");

  const [events, setEvents] = useState<ErrorEvent[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const [statusFilter, setStatusFilter] = useState<"all" | ErrStatus>("all");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }>>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<ErrStatus>("revisando");
  const [applying, setApplying] = useState(false);

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
      `${ids.length} error${ids.length === 1 ? "" : "es"} → ${STATUS_CFG[bulkStatus].label}`,
    );
    setRetryNonce((n) => n + 1);
  };

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!isAdmin && !isSuperAdmin) {
    return <p className="text-muted-foreground p-6">Necesitas rol Admin o SuperAdmin.</p>;
  }

  const colSpan = isSuperAdmin ? 7 : 6;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Errores"
        subtitle={
          isSuperAdmin
            ? "Errores de toda la plataforma. Filtra por institución y gestiona su estado."
            : "Errores registrados en tu institución."
        }
        icon={<AlertTriangle className="h-6 w-6 text-rose-500" />}
        actions={
          <Button variant="outline" size="sm" onClick={() => setRetryNonce((n) => n + 1)}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Actualizar
          </Button>
        }
      />

      {/* Tiles de conteo por estado — "cantidad de eventos". */}
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

      {/* Toolbar de acción masiva. */}
      {sel.count > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-2">
          <span className="text-sm text-muted-foreground">
            {sel.count} seleccionado{sel.count === 1 ? "" : "s"}
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
                  <TableHead className="w-32">Fecha</TableHead>
                  <TableHead className="min-w-48">Acción</TableHead>
                  <TableHead className="hidden md:table-cell w-28">Categoría</TableHead>
                  {isSuperAdmin && (
                    <TableHead className="hidden lg:table-cell w-40">Institución</TableHead>
                  )}
                  <TableHead className="w-28">Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {events.length === 0 ? (
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
                  events.map((ev) => {
                    const cfg = STATUS_CFG[ev.status];
                    const msg = errorMessage(ev.metadata);
                    const isOpen = expanded.has(ev.id);
                    return (
                      <Fragment key={ev.id}>
                        <TableRow data-state={sel.isSelected(ev.id) ? "selected" : undefined}>
                          <TableCell className="w-10">
                            <MultiSelectCheckbox id={ev.id} state={sel} />
                          </TableCell>
                          <TableCell className="w-8">
                            <button
                              type="button"
                              onClick={() => toggleExpand(ev.id)}
                              className="text-muted-foreground hover:text-foreground"
                              aria-label={isOpen ? "Colapsar" : "Expandir"}
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </button>
                          </TableCell>
                          <TableCell>
                            <DateCell value={ev.created_at} variant="datetime" />
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className="truncate" title={ev.action}>
                              {ev.action}
                            </div>
                            {msg && (
                              <div className="text-[11px] text-destructive truncate" title={msg}>
                                {msg}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                            {ev.category}
                          </TableCell>
                          {isSuperAdmin && (
                            <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                              {ev.tenant_name ?? "— sistema —"}
                            </TableCell>
                          )}
                          <TableCell>
                            <Badge variant={cfg.badge} className="text-[10px]">
                              {cfg.label}
                            </Badge>
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow>
                            <TableCell colSpan={colSpan} className="bg-muted/30">
                              <div className="text-xs space-y-1 py-1">
                                <DetailRow k="ID" v={ev.id} mono />
                                <DetailRow k="Acción" v={ev.action} mono />
                                <DetailRow k="Categoría" v={ev.category} />
                                {ev.actor_email && (
                                  <DetailRow
                                    k="Actor"
                                    v={`${ev.actor_email}${ev.actor_role ? ` (${ev.actor_role})` : ""}`}
                                  />
                                )}
                                {ev.entity_name && (
                                  <DetailRow
                                    k="Entidad"
                                    v={`${ev.entity_type ?? ""} ${ev.entity_name}`.trim()}
                                  />
                                )}
                                {ev.course_name && <DetailRow k="Curso" v={ev.course_name} />}
                                {ev.reviewed_at && <DetailRow k="Revisado" v={ev.reviewed_at} />}
                                <div className="pt-1">
                                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
                                    Metadata
                                  </div>
                                  <pre className="text-[11px] whitespace-pre-wrap break-all bg-background rounded p-2 border max-h-48 overflow-y-auto">
                                    {JSON.stringify(ev.metadata, null, 2)}
                                  </pre>
                                </div>
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
