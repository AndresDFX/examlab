/**
 * /app/superadmin/support — bandeja del SuperAdmin.
 *
 * Lista TODOS los tickets de TODOS los tenants (RLS lo permite por
 * `is_super_admin()`). Filtros: estado + tenant + asignación. Detalle
 * con chat + cambio de status + asignar.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { DateCell } from "@/components/ui/date-cell";
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
import { LifeBuoy, MessageSquare, Clock, CheckCircle2, AlertCircle, Search, X, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import {
  SupportTicketDetailDialog,
  STATUS_LABEL,
  STATUS_TONE,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  CATEGORY_LABEL,
  type SupportTicket,
  type TicketStatus,
} from "@/modules/support/SupportTicketDetailDialog";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/app/superadmin/support")({
  component: SuperAdminSupportPage,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

function SuperAdminSupportPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [statusFilter, setStatusFilter] = useState<TicketStatus | "active" | "all">("active");
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [tenants, setTenants] = useState<Array<{ id: string; name: string }>>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeTicket, setActiveTicket] = useState<SupportTicket | null>(null);

  // `silent` evita togglear `loading` durante refrescos por realtime —
  // sin esto el SA veía "Cargando…" en cada update remoto sobre su lista.
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await db
        .from("support_tickets")
        .select(
          "id, tenant_id, created_by, category, priority, subject, body, status, assigned_to, resolution_notes, created_at, updated_at, resolved_at",
        )
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (error) {
        setLoadError(friendlyError(error, i18n.t("superadminSupport.loadError")));
        return;
      }
      const baseTickets = (data ?? []) as SupportTicket[];
      // Enriquecimiento: nombre del creator, tenant, assignee.
      const userIds = Array.from(
        new Set([
          ...baseTickets.map((t) => t.created_by),
          ...(baseTickets.map((t) => t.assigned_to).filter(Boolean) as string[]),
        ]),
      );
      const tenantIds = Array.from(new Set(baseTickets.map((t) => t.tenant_id)));
      const [profsRes, tensRes] = await Promise.all([
        userIds.length > 0
          ? db.from("profiles").select("id, full_name").in("id", userIds)
          : Promise.resolve({ data: [] }),
        tenantIds.length > 0
          ? db.from("tenants").select("id, name").in("id", tenantIds)
          : Promise.resolve({ data: [] }),
      ]);
      const userMap = new Map<string, string>();
      for (const p of (profsRes.data ?? []) as Array<{ id: string; full_name: string | null }>) {
        if (p.full_name) userMap.set(p.id, p.full_name);
      }
      const tenantMap = new Map<string, string>();
      for (const t of (tensRes.data ?? []) as Array<{ id: string; name: string }>) {
        tenantMap.set(t.id, t.name);
      }
      const enriched = baseTickets.map((t) => ({
        ...t,
        creator_name: userMap.get(t.created_by) ?? null,
        tenant_name: tenantMap.get(t.tenant_id) ?? null,
        assignee_name: t.assigned_to ? (userMap.get(t.assigned_to) ?? null) : null,
      }));
      setTickets(enriched);
    } catch (e) {
      setLoadError(friendlyError(e, i18n.t("superadminSupport.loadError")));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await db.from("tenants").select("id, name").is("deleted_at", null).order("name");
      if (cancelled) return;
      setTenants((data ?? []) as Array<{ id: string; name: string }>);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Realtime: cualquier insert/update sobre tickets refresca la lista.
  useEffect(() => {
    const ch = supabase
      .channel("support_superadmin")
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        { event: "*", schema: "public", table: "support_tickets" },
        () => void load(true), // silent — sin loader flicker
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch).catch(() => {});
    };
  }, [load]);

  const filtered = useMemo(() => {
    let out = tickets;
    if (statusFilter === "active") {
      out = out.filter(
        (t) => t.status === "open" || t.status === "in_progress" || t.status === "waiting_admin",
      );
    } else if (statusFilter !== "all") {
      out = out.filter((t) => t.status === statusFilter);
    }
    if (tenantFilter !== "all") {
      out = out.filter((t) => t.tenant_id === tenantFilter);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      out = out.filter((t) => {
        return (
          t.subject.toLowerCase().includes(q) ||
          (t.creator_name ?? "").toLowerCase().includes(q) ||
          (t.tenant_name ?? "").toLowerCase().includes(q)
        );
      });
    }
    return out;
  }, [tickets, statusFilter, tenantFilter, search]);

  const stats = useMemo(() => {
    let openSet = 0;
    let inProgress = 0;
    let resolved = 0;
    for (const t of tickets) {
      if (t.status === "open" || t.status === "waiting_admin") openSet += 1;
      else if (t.status === "in_progress") inProgress += 1;
      else if (t.status === "resolved" || t.status === "closed") resolved += 1;
    }
    return { total: tickets.length, open: openSet, inProgress, resolved };
  }, [tickets]);

  const openDetail = (t: SupportTicket) => {
    setActiveTicket(t);
    setDetailOpen(true);
  };

  // Eliminar (soft-delete) cualquier ticket. RPC autoriza SuperAdmin
  // (mig 20260913000000). Las listas filtran `deleted_at IS NULL`.
  const deleteTicket = async (t: SupportTicket) => {
    const ok = await confirm({
      title: i18n.t("superadminSupport.deleteConfirmTitle", {
        defaultValue: "¿Eliminar este ticket?",
      }),
      description: i18n.t("superadminSupport.deleteConfirmDesc", {
        defaultValue:
          "El ticket y su conversación se eliminarán de la bandeja. Esta acción no se puede deshacer.",
      }),
      tone: "destructive",
      confirmLabel: i18n.t("superadminSupport.deleteConfirmLabel", {
        defaultValue: "Eliminar",
      }),
    });
    if (!ok) return;
    const { error } = await db.rpc("soft_delete_support_ticket", { _ticket_id: t.id });
    if (error) {
      toast.error(friendlyError(error, "No se pudo eliminar el ticket"));
      return;
    }
    toast.success(
      i18n.t("superadminSupport.ticketDeleted", {
        defaultValue: "Ticket eliminado",
      }),
    );
    await load();
  };

  if (loadError) {
    return (
      <ErrorState
        message={t("superadminSupport.loadError")}
        hint={loadError}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<LifeBuoy className="h-6 w-6 text-primary" />}
        title={t("superadminSupport.title")}
        subtitle={t("superadminSupport.subtitle")}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={MessageSquare} label={t("superadminSupport.statTotal")} value={stats.total} />
        <StatCard
          icon={AlertCircle}
          label={t("superadminSupport.statOpen")}
          value={stats.open}
          tone={stats.open > 0 ? "warning" : "default"}
        />
        <StatCard icon={Clock} label={t("superadminSupport.statInProgress")} value={stats.inProgress} />
        <StatCard
          icon={CheckCircle2}
          label={t("superadminSupport.statResolved")}
          value={stats.resolved}
          tone="success"
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-2 flex-wrap">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("superadminSupport.searchPlaceholder")}
            className="pl-8 h-9"
          />
        </div>
        <Select value={tenantFilter} onValueChange={setTenantFilter}>
          <SelectTrigger className="h-9 sm:w-56 text-xs">
            <SelectValue placeholder={t("superadminSupport.colAdminInstitution")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("superadminSupport.filterAllInstitutions")}</SelectItem>
            {tenants.map((tn) => (
              <SelectItem key={tn.id} value={tn.id}>
                {tn.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="h-9 sm:w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">{t("superadminSupport.filterActive")}</SelectItem>
            <SelectItem value="all">{t("superadminSupport.filterAll")}</SelectItem>
            {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {(search || tenantFilter !== "all" || statusFilter !== "active") && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setTenantFilter("all");
              setStatusFilter("active");
            }}
            className="h-9"
          >
            <X className="h-4 w-4 mr-1" /> {t("superadminSupport.clearFiltersBtn")}
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
              <Spinner size="sm" /> {t("superadminSupport.loading")}
            </div>
          ) : filtered.length === 0 ? (
            <TableEmpty
              icon={LifeBuoy}
              title={t("superadminSupport.emptyTitle")}
              description={t("superadminSupport.emptyDesc")}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("superadminSupport.colSubject")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("superadminSupport.colAdminInstitution")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("superadminSupport.colCategory")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("superadminSupport.colPriority")}</TableHead>
                  <TableHead>{t("superadminSupport.colStatus")}</TableHead>
                  <TableHead className="hidden lg:table-cell">{t("superadminSupport.colAssigned")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("superadminSupport.colCreated")}</TableHead>
                  <TableHead className="w-12 text-right">{t("superadminSupport.colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((t) => (
                  <TableRow
                    key={t.id}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => openDetail(t)}
                  >
                    <TableCell className="font-medium">
                      <div className="truncate max-w-[260px]" title={t.subject}>
                        {t.subject}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-xs">
                      <div className="truncate max-w-[200px]">
                        <span className="text-foreground">{t.creator_name ?? "—"}</span>
                        <span className="text-muted-foreground"> · {t.tenant_name ?? "—"}</span>
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="secondary" className="text-[10px]">
                        {CATEGORY_LABEL[t.category]}
                      </Badge>
                    </TableCell>
                    <TableCell className={`hidden md:table-cell text-xs ${PRIORITY_TONE[t.priority]}`}>
                      {PRIORITY_LABEL[t.priority]}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${STATUS_TONE[t.status]}`}>
                        {STATUS_LABEL[t.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                      {t.assignee_name ?? "—"}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <DateCell value={t.created_at} variant="datetime" />
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <RowActionsMenu
                        actions={[
                          {
                            label: i18n.t("superadminSupport.deleteAction", {
                              defaultValue: "Eliminar",
                            }),
                            icon: Trash2,
                            tone: "destructive",
                            onClick: () => void deleteTicket(t),
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <SupportTicketDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        ticket={activeTicket}
        mode="superadmin"
        currentUserId={user?.id ?? null}
        onMutate={() => void load()}
      />
    </div>
  );
}
