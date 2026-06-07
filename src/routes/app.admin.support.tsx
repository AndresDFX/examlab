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
import { LifeBuoy, Plus, MessageSquare, Clock, CheckCircle2, AlertCircle, Paperclip, X as XIcon } from "lucide-react";
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
  // Archivos a adjuntar EN la creación del ticket. Antes solo podían
  // subirse desde el dialog detalle (después de crear) — bug reportado:
  // el admin escribía el ticket con un screenshot listo y tenía que
  // crear primero, abrir el detalle, después adjuntar. Ahora se sube
  // antes y la edge/cliente sube los archivos al bucket apenas tenga
  // el ticket_id (post-insert), sin requerir un segundo viaje del usuario.
  const [newAttachments, setNewAttachments] = useState<File[]>([]);
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  // `silent` evita togglear `loading` durante refrescos por realtime —
  // sin esto, cada vez que llega un INSERT/UPDATE remoto, la tabla
  // flickeaba a "Cargando…" por unos cientos de ms. Reservamos el spinner
  // SOLO para el primer load y para el botón "Reintentar" del ErrorState.
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
        setLoadError(friendlyError(error, "No pudimos cargar tus tickets"));
        return;
      }
      setTickets((data ?? []) as SupportTicket[]);
    } catch (e) {
      setLoadError(friendlyError(e, "No pudimos cargar tus tickets"));
    } finally {
      if (!silent) setLoading(false);
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
        () => void load(true), // silent — sin loader flicker
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

  // Abre el dialog SIN resetear el draft del form. Si el admin cierra
  // accidentalmente y vuelve a abrir, conserva lo que estaba escribiendo
  // (categoría/prioridad/asunto/descripción). El reset solo pasa tras un
  // submit exitoso o cuando el admin clickea "Empezar de cero" abajo.
  const openCreate = () => {
    setCreateOpen(true);
  };

  const resetCreateForm = () => {
    setNewCategory("peticion");
    setNewPriority("normal");
    setNewSubject("");
    setNewBody("");
    setNewAttachments([]);
  };

  // Hay draft si cualquiera de los campos editables tiene contenido
  // distinto al default. Lo usamos para mostrar el botón "Empezar de
  // cero" solo cuando tiene sentido.
  const hasDraft =
    newSubject.trim().length > 0 ||
    newBody.trim().length > 0 ||
    newCategory !== "peticion" ||
    newPriority !== "normal" ||
    newAttachments.length > 0;

  const onPickFiles = (files: FileList | null) => {
    if (!files) return;
    const incoming = Array.from(files);
    const oversized = incoming.filter((f) => f.size > MAX_FILE_BYTES);
    if (oversized.length > 0) {
      toast.error(
        `${oversized.length} archivo(s) superan 25 MB y se descartaron: ${oversized.map((f) => f.name).join(", ")}`,
      );
    }
    const valid = incoming.filter((f) => f.size <= MAX_FILE_BYTES);
    setNewAttachments((prev) => [...prev, ...valid]);
  };

  const removeAttachment = (idx: number) => {
    setNewAttachments((prev) => prev.filter((_, i) => i !== idx));
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
      const createdTicket = data as SupportTicket;

      // Subir los adjuntos seleccionados ANTES de crear (si los hay) al
      // bucket. La RLS del bucket valida ticket_id = primer segmento del
      // path → necesitamos el ticket recién creado primero, después
      // subimos. Best-effort: si algún archivo falla, el ticket queda
      // creado igual y avisamos en el toast cuántos no subieron.
      let attachmentsUploaded = 0;
      const failedFiles: File[] = [];
      if (newAttachments.length > 0) {
        for (const file of newAttachments) {
          try {
            const ext = file.name.split(".").pop() ?? "bin";
            const randomId = crypto.randomUUID();
            const path = `${createdTicket.id}/${randomId}.${ext}`;
            const { error: upErr } = await supabase.storage
              .from("support-attachments")
              .upload(path, file, {
                contentType: file.type || "application/octet-stream",
              });
            if (upErr) throw upErr;
            const { error: insErr } = await db.from("support_ticket_attachments").insert({
              ticket_id: createdTicket.id,
              file_path: path,
              file_name: file.name,
              file_size: file.size,
              mime_type: file.type || null,
              uploaded_by: user.id,
            });
            if (insErr) throw insErr;
            attachmentsUploaded += 1;
          } catch (uploadErr) {
            failedFiles.push(file);
            console.warn(
              "[support] adjunto inicial falló",
              file.name,
              uploadErr,
            );
          }
        }
      }
      const attachmentsFailed = failedFiles.length;

      if (attachmentsFailed > 0) {
        toast.warning(
          `Ticket creado. ${attachmentsUploaded} adjunto(s) subido(s), ${attachmentsFailed} fallaron — podés volver a subirlos desde el detalle.`,
        );
      } else if (attachmentsUploaded > 0) {
        toast.success(
          `Ticket abierto con ${attachmentsUploaded} adjunto(s). El SuperAdmin recibió la notificación.`,
        );
      } else {
        toast.success("Ticket abierto. El SuperAdmin recibió la notificación.");
      }

      // Si hay adjuntos fallidos, NO cerramos el dialog ni reseteamos —
      // dejamos la lista de adjuntos solo con los que fallaron para que
      // el admin pueda reintentarlos sin re-seleccionar. El ticket ya
      // está creado, así que ocultamos los campos editables del header
      // visualmente... wait, simplificamos: dejamos los adjuntos fallidos
      // y cerramos el dialog. El admin verá el detalle del ticket y
      // puede re-subir los archivos desde ahí. La opción de reintentar
      // inline sería más fluida pero implica un modo "post-create" que
      // complica el dialog. Mantenemos los archivos fallidos en
      // `newAttachments` por si el admin reabre y quiere ver qué falló.
      if (attachmentsFailed > 0) {
        // Reset del FORM pero preservar los failedFiles en el state
        // para que cuando el admin reabra el dialog vea esos archivos
        // listos y sepa cuáles re-subir.
        setNewCategory("peticion");
        setNewPriority("normal");
        setNewSubject("");
        setNewBody("");
        setNewAttachments(failedFiles);
      } else {
        resetCreateForm();
      }
      setCreateOpen(false);
      await load();
      // Abrir el detalle del recién creado.
      setActiveTicket(createdTicket);
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
              action={
                statusFilter === "all" ? (
                  <Button onClick={openCreate}>
                    <Plus className="h-4 w-4 mr-1" />
                    Crear primer ticket
                  </Button>
                ) : undefined
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
            {/* grid-cols-1 sm:grid-cols-2: a 375px los 2 selects en una
                misma fila apretaban los labels haciendo wrap del valor.
                En sm+ vuelven a 2 columnas. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
                placeholder="Cuenta con detalle el problema, qué intentaste, mensajes de error, etc."
                rows={6}
                maxLength={10000}
              />
            </div>
            {/* Adjuntos pre-creación. El input es type=file multiple — el
                admin puede seleccionar varios archivos (screenshots, logs,
                CSV) y agregarlos a la lista local. Al crear el ticket,
                primero se inserta el ticket (necesitamos su id para el
                path del bucket) y después se sube cada archivo. Falla
                tolerante: si un archivo no sube, el ticket queda creado
                igual y el admin puede subirlo después desde el detalle. */}
            <div>
              <Label className="text-xs flex items-center gap-1.5">
                <Paperclip className="h-3.5 w-3.5" />
                Adjuntos (opcional)
              </Label>
              <Input
                type="file"
                multiple
                onChange={(e) => {
                  onPickFiles(e.target.files);
                  // Limpiar el input para permitir re-seleccionar el mismo
                  // archivo si el admin lo quitó por error.
                  e.target.value = "";
                }}
                className="text-xs file:mr-2 file:text-xs"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Hasta 25 MB por archivo. Screenshots, logs o cualquier evidencia que ayude.
              </p>
              {newAttachments.length > 0 && (
                <div className="mt-2 space-y-1 max-h-32 overflow-y-auto rounded border bg-muted/30 p-2">
                  {newAttachments.map((file, idx) => (
                    <div
                      key={`${file.name}-${idx}`}
                      className="flex items-center gap-2 text-xs"
                    >
                      <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1" title={file.name}>
                        {file.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                        {(file.size / 1024).toFixed(1)} KB
                      </span>
                      {/* Tap target ≥ 32x32px en mobile — el ícono X de
                          h-3 w-3 (12px) sin padding era casi imposible
                          de clickear con el dedo. h-7 w-7 = 28px botón
                          + ícono h-3.5 w-3.5 centrado da target táctil. */}
                      <button
                        type="button"
                        onClick={() => removeAttachment(idx)}
                        className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0 transition-colors"
                        title="Quitar"
                        aria-label={`Quitar adjunto ${file.name}`}
                        disabled={creating}
                      >
                        <XIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          {/* Banner sutil cuando hay draft: el dialog conserva lo escrito
              entre opens, asi que el admin sabe que su info esta a salvo. */}
          {hasDraft && (
            <p className="text-[11px] text-muted-foreground italic">
              El borrador se conserva si cerrás el diálogo.
            </p>
          )}
          <DialogFooter className="flex-col sm:flex-row gap-2">
            {hasDraft && (
              <Button
                type="button"
                variant="ghost"
                onClick={resetCreateForm}
                disabled={creating}
                className="text-muted-foreground hover:text-destructive sm:mr-auto"
              >
                Empezar de cero
              </Button>
            )}
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cerrar
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
