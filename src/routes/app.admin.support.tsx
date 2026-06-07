/**
 * /app/admin/support — vista del Admin de tenant.
 *
 * Lista los tickets de soporte que él abrió hacia el SuperAdmin + botón
 * "Nuevo ticket" + dialog detalle con chat. RLS recorta a created_by
 * = auth.uid().
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { StatCard } from "@/components/ui/stat-card";
import { DateCell } from "@/components/ui/date-cell";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { LifeBuoy, Plus, MessageSquare, Clock, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  SupportTicketDetailDialog,
  STATUS_LABEL,
  STATUS_TONE,
  PRIORITY_LABEL,
  PRIORITY_TONE,
  CATEGORY_LABEL,
  type SupportTicket,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from "@/modules/support/SupportTicketDetailDialog";

export const Route = createFileRoute("/app/admin/support")({
  component: AdminSupportPage,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

function AdminSupportPage() {
  const { user, profile } = useAuth();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [statusFilter, setStatusFilter] = useState<TicketStatus | "all">("all");
  const [detailOpen, setDetailOpen] = useState(false);
  const [activeTicket, setActiveTicket] = useState<SupportTicket | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Create-form state
  const [newCategory, setNewCategory] = useState<TicketCategory>("peticion");
  const [newPriority, setNewPriority] = useState<TicketPriority>("normal");
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
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
        setLoadError(friendlyError(error, "No pudimos cargar tus tickets"));
        return;
      }
      setTickets((data ?? []) as SupportTicket[]);
    } catch (e) {
      setLoadError(friendlyError(e, "No pudimos cargar tus tickets"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  // Realtime: nuevo ticket o cambio de estado → refresca lista.
  useEffect(() => {
    if (!user?.id) return;
    const ch = supabase
      .channel(`support_admin_${user.id}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table: "support_tickets",
          filter: `created_by=eq.${user.id}`,
        },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch).catch(() => {});
    };
  }, [user?.id, load]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return tickets;
    return tickets.filter((t) => t.status === statusFilter);
  }, [tickets, statusFilter]);

  const stats = useMemo(() => {
    let open = 0;
    let inProgress = 0;
    let resolved = 0;
    for (const t of tickets) {
      if (t.status === "open" || t.status === "waiting_admin") open += 1;
      else if (t.status === "in_progress") inProgress += 1;
      else if (t.status === "resolved" || t.status === "closed") resolved += 1;
    }
    return { total: tickets.length, open, inProgress, resolved };
  }, [tickets]);

  const openCreate = () => {
    setNewCategory("peticion");
    setNewPriority("normal");
    setNewSubject("");
    setNewBody("");
    setCreateOpen(true);
  };

  const createTicket = async () => {
    if (!user?.id || !profile?.tenant_id) {
      toast.error("Tu cuenta no tiene institución asignada. Contacta al SuperAdmin.");
      return;
    }
    if (newSubject.trim().length < 3) {
      toast.error("El asunto debe tener al menos 3 caracteres.");
      return;
    }
    if (newBody.trim().length < 10) {
      toast.error("La descripción debe tener al menos 10 caracteres.");
      return;
    }
    setCreating(true);
    try {
      const { data, error } = await db
        .from("support_tickets")
        .insert({
          tenant_id: profile.tenant_id,
          created_by: user.id,
          category: newCategory,
          priority: newPriority,
          subject: newSubject.trim(),
          body: newBody.trim(),
        })
        .select("*")
        .maybeSingle();
      if (error || !data) {
        toast.error(friendlyError(error, "No se pudo crear el ticket"));
        return;
      }
      toast.success("Ticket abierto. El SuperAdmin recibió la notificación.");
      setCreateOpen(false);
      await load();
      // Abrir el detalle del recién creado.
      setActiveTicket(data as SupportTicket);
      setDetailOpen(true);
    } catch (e) {
      toast.error(friendlyError(e, "Error creando el ticket"));
    } finally {
      setCreating(false);
    }
  };

  const openDetail = (t: SupportTicket) => {
    setActiveTicket(t);
    setDetailOpen(true);
  };

  if (loadError) {
    return (
      <ErrorState
        message="No pudimos cargar tus tickets"
        hint={loadError}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<LifeBuoy className="h-6 w-6 text-primary" />}
        title="Soporte"
        subtitle="Tus peticiones, quejas, reclamos y sugerencias al SuperAdmin de la plataforma."
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4 mr-1" />
            Nuevo ticket
          </Button>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard icon={MessageSquare} label="Total" value={stats.total} />
        <StatCard
          icon={AlertCircle}
          label="Abiertos / Esperando"
          value={stats.open}
          tone={stats.open > 0 ? "warning" : "default"}
        />
        <StatCard icon={Clock} label="En progreso" value={stats.inProgress} />
        <StatCard
          icon={CheckCircle2}
          label="Resueltos / Cerrados"
          value={stats.resolved}
          tone="success"
        />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Label className="text-xs text-muted-foreground">Estado:</Label>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABEL[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
              <Spinner size="sm" /> Cargando…
            </div>
          ) : filtered.length === 0 ? (
            <TableEmpty
              icon={LifeBuoy}
              title={statusFilter === "all" ? "Sin tickets" : "Sin tickets con ese estado"}
              description={
                statusFilter === "all"
                  ? "No has abierto tickets todavía. Usa 'Nuevo ticket' para enviar una petición al SuperAdmin."
                  : "Cambia el filtro de estado para ver otros tickets."
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Asunto</TableHead>
                  <TableHead className="hidden sm:table-cell">Categoría</TableHead>
                  <TableHead className="hidden sm:table-cell">Prioridad</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead className="hidden md:table-cell">Creado</TableHead>
                  <TableHead className="hidden lg:table-cell">Resuelto</TableHead>
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
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="secondary" className="text-[10px]">
                        {CATEGORY_LABEL[t.category]}
                      </Badge>
                    </TableCell>
                    <TableCell className={`hidden sm:table-cell text-xs ${PRIORITY_TONE[t.priority]}`}>
                      {PRIORITY_LABEL[t.priority]}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`text-[10px] ${STATUS_TONE[t.status]}`}>
                        {STATUS_LABEL[t.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <DateCell value={t.created_at} variant="datetime" />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {t.resolved_at ? <DateCell value={t.resolved_at} variant="datetime" /> : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Dialog detalle */}
      <SupportTicketDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        ticket={activeTicket}
        mode="admin"
        currentUserId={user?.id ?? null}
        onMutate={() => void load()}
      />

      {/* Dialog crear */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Nuevo ticket de soporte</DialogTitle>
            <DialogDescription>
              Describe tu petición, queja, reclamo o sugerencia. El SuperAdmin recibirá una
              notificación de inmediato.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs" required>
                  Categoría
                </Label>
                <Select value={newCategory} onValueChange={(v) => setNewCategory(v as TicketCategory)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CATEGORY_LABEL) as TicketCategory[]).map((c) => (
                      <SelectItem key={c} value={c}>
                        {CATEGORY_LABEL[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Prioridad</Label>
                <Select value={newPriority} onValueChange={(v) => setNewPriority(v as TicketPriority)}>
                  <SelectTrigger className="h-9 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PRIORITY_LABEL) as TicketPriority[]).map((p) => (
                      <SelectItem key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-xs" required>
                Asunto
              </Label>
              <Input
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                placeholder="Ej. No puedo invitar usuarios desde el panel"
                maxLength={200}
              />
            </div>
            <div>
              <Label className="text-xs" required>
                Descripción
              </Label>
              <Textarea
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                placeholder="Cuenta con detalle el problema, qué intentaste, mensajes de error, etc. Podrás adjuntar archivos después de crear el ticket."
                rows={6}
                maxLength={10000}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancelar
            </Button>
            <Button onClick={() => void createTicket()} disabled={creating}>
              {creating && <Spinner size="sm" className="mr-2" />}
              Crear ticket
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
