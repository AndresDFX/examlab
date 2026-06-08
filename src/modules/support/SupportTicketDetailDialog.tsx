/**
 * SupportTicketDetailDialog — vista detalle de un ticket de soporte.
 *
 * Compartido entre el Admin (creator) y el SuperAdmin (gestor). El UI
 * adapta sus controles según `mode`:
 *   - mode="admin": muestra el chat y permite responder + adjuntar.
 *     Botón "Cerrar ticket" para marcar el propio como `closed`.
 *   - mode="superadmin": además permite cambiar status, asignar el
 *     ticket a sí mismo, y escribir resolution_notes.
 *
 * Conversación realtime: se suscribe a INSERT en
 * `support_ticket_messages` filtrado por ticket_id para mostrar
 * mensajes nuevos sin polling.
 *
 * Adjuntos: subida directa al bucket `support-attachments`, path
 * `<ticket_id>/<random-uuid>.<ext>`. La RLS del bucket valida que el
 * caller sea creator o SuperAdmin (mig 20260904000000).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Send, Paperclip, Download, X, UserCheck, CheckCircle2 } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";
import { useConfirm } from "@/shared/components/ConfirmDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type TicketStatus = "open" | "in_progress" | "waiting_admin" | "resolved" | "closed";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketCategory = "peticion" | "queja" | "reclamo" | "sugerencia" | "otro";

export interface SupportTicket {
  id: string;
  tenant_id: string;
  created_by: string;
  category: TicketCategory;
  priority: TicketPriority;
  subject: string;
  body: string;
  status: TicketStatus;
  assigned_to: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  // Enriquecidos
  creator_name?: string | null;
  tenant_name?: string | null;
  assignee_name?: string | null;
}

export interface SupportMessage {
  id: string;
  ticket_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  sender_name?: string | null;
}

export interface SupportAttachment {
  id: string;
  ticket_id: string;
  message_id: string | null;
  file_path: string;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  uploaded_by: string;
  uploaded_at: string;
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Abierto",
  in_progress: "En progreso",
  waiting_admin: "Esperando tu respuesta",
  resolved: "Resuelto",
  closed: "Cerrado",
};

export const STATUS_TONE: Record<TicketStatus, string> = {
  open: "bg-sky-500/15 text-sky-700 dark:text-sky-400 border-sky-500/30",
  in_progress: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  waiting_admin: "bg-violet-500/15 text-violet-700 dark:text-violet-400 border-violet-500/30",
  resolved: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  closed: "bg-muted text-muted-foreground border-muted-foreground/30",
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: "Baja",
  normal: "Normal",
  high: "Alta",
  urgent: "Urgente",
};

export const PRIORITY_TONE: Record<TicketPriority, string> = {
  low: "text-muted-foreground",
  normal: "text-foreground",
  high: "text-amber-600 dark:text-amber-400",
  urgent: "text-destructive font-semibold",
};

export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  peticion: "Petición",
  queja: "Queja",
  reclamo: "Reclamo",
  sugerencia: "Sugerencia",
  otro: "Otro",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticket: SupportTicket | null;
  mode: "admin" | "superadmin";
  currentUserId: string | null;
  /** Se llama cuando el ticket muta (status change, mensaje nuevo) para
   *  que el padre refresque su lista. */
  onMutate?: () => void;
}

export function SupportTicketDetailDialog({
  open,
  onOpenChange,
  ticket,
  mode,
  currentUserId,
  onMutate,
}: Props) {
  const confirm = useConfirm();
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [attachments, setAttachments] = useState<SupportAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<TicketStatus>("open");
  const [resolutionNotes, setResolutionNotes] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Sync state inicial cuando se abre con un ticket nuevo.
  useEffect(() => {
    if (ticket) {
      setStatus(ticket.status);
      setResolutionNotes(ticket.resolution_notes ?? "");
    } else {
      setStatus("open");
      setResolutionNotes("");
    }
  }, [ticket?.id, ticket?.status, ticket?.resolution_notes]);

  const load = useCallback(async () => {
    if (!ticket) return;
    setLoading(true);
    try {
      const [msgsRes, attsRes] = await Promise.all([
        db
          .from("support_ticket_messages")
          .select("id, ticket_id, sender_id, body, created_at")
          .eq("ticket_id", ticket.id)
          .order("created_at", { ascending: true }),
        db
          .from("support_ticket_attachments")
          .select("id, ticket_id, message_id, file_path, file_name, file_size, mime_type, uploaded_by, uploaded_at")
          .eq("ticket_id", ticket.id)
          .order("uploaded_at", { ascending: true }),
      ]);
      const msgs = (msgsRes.data ?? []) as SupportMessage[];
      const senderIds = Array.from(new Set(msgs.map((m) => m.sender_id)));
      if (senderIds.length > 0) {
        const { data: profs } = await db
          .from("profiles")
          .select("id, full_name")
          .in("id", senderIds);
        const map = new Map<string, string>();
        for (const p of (profs ?? []) as Array<{ id: string; full_name: string | null }>) {
          if (p.full_name) map.set(p.id, p.full_name);
        }
        msgs.forEach((m) => {
          m.sender_name = map.get(m.sender_id) ?? null;
        });
      }
      setMessages(msgs);
      setAttachments((attsRes.data ?? []) as SupportAttachment[]);
    } catch (e) {
      toast.error(friendlyError(e, "No pudimos cargar el ticket"));
    } finally {
      setLoading(false);
    }
  }, [ticket]);

  useEffect(() => {
    if (open && ticket) void load();
  }, [open, ticket, load]);

  // Realtime: escucha INSERT en messages del ticket actual.
  useEffect(() => {
    if (!open || !ticket) return;
    const ch = supabase
      .channel(`support_ticket_${ticket.id}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event: "INSERT",
          schema: "public",
          table: "support_ticket_messages",
          filter: `ticket_id=eq.${ticket.id}`,
        },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch).catch(() => {});
    };
  }, [open, ticket, load]);

  // Autoscroll al final cuando llegan mensajes nuevos.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const sendReply = async () => {
    if (!ticket || !currentUserId || sending || reply.trim().length === 0) return;
    // Optimistic send: agregamos el mensaje a la lista local INMEDIATAMENTE
    // con un id temporal (`tmp-<random>`). El usuario ve su mensaje al
    // instante en vez de esperar 1-2s al ack del INSERT + realtime. Si
    // el INSERT falla, removemos el mensaje optimista. Si tiene éxito,
    // realtime trae la fila real (con id de la DB); el filter por id
    // temporal lo reemplaza implícitamente cuando `load()` lo trae con
    // su id real. Para evitar duplicado breve, removemos el temporal
    // al success y dejamos que realtime/load pinte el real.
    const tmpId = `tmp-${crypto.randomUUID()}`;
    const tmpMessage: SupportMessage = {
      id: tmpId,
      ticket_id: ticket.id,
      sender_id: currentUserId,
      body: reply.trim(),
      created_at: new Date().toISOString(),
      sender_name: null,
    };
    setMessages((prev) => [...prev, tmpMessage]);
    const draftBody = reply.trim();
    setReply("");
    setSending(true);
    try {
      const { error } = await db.from("support_ticket_messages").insert({
        ticket_id: ticket.id,
        sender_id: currentUserId,
        body: draftBody,
      });
      if (error) {
        // Rollback optimistic: removemos el temporal y restauramos el
        // textarea con el draft para que el usuario pueda reintentar.
        setMessages((prev) => prev.filter((m) => m.id !== tmpId));
        setReply(draftBody);
        toast.error(friendlyError(error, "No se pudo enviar"));
        return;
      }
      // Success: NO removemos el tmp acá — el realtime subscription
      // (postgres_changes ON INSERT) dispara load() que reemplaza
      // messages con la lista server-side (sin el tmp), eliminándolo
      // de forma natural. Removerlo explícitamente acá puede crear
      // un flicker si realtime tarda en llegar.
      // El SA que responde por primera vez puede auto-mover a in_progress
      // si todavía está "open" — opcional. Lo dejamos manual para no
      // confundir.
      if (mode === "superadmin" && ticket.status === "open") {
        await db
          .from("support_tickets")
          .update({ status: "in_progress", assigned_to: currentUserId })
          .eq("id", ticket.id);
        setStatus("in_progress");
      }
      onMutate?.();
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== tmpId));
      setReply(draftBody);
      toast.error(friendlyError(e, "No se pudo enviar"));
    } finally {
      setSending(false);
    }
  };

  const uploadFile = async (file: File) => {
    if (!ticket || !currentUserId || uploading) return;
    if (file.size > 25 * 1024 * 1024) {
      toast.error("El archivo supera 25 MB. Subí algo más pequeño.");
      return;
    }
    setUploading(true);
    try {
      const ext = file.name.split(".").pop() ?? "bin";
      const randomId = crypto.randomUUID();
      const path = `${ticket.id}/${randomId}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("support-attachments")
        .upload(path, file, { contentType: file.type || "application/octet-stream" });
      if (upErr) {
        toast.error(friendlyError(upErr, "No se pudo subir el archivo"));
        return;
      }
      const { error: insErr } = await db.from("support_ticket_attachments").insert({
        ticket_id: ticket.id,
        file_path: path,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type || null,
        uploaded_by: currentUserId,
      });
      if (insErr) {
        toast.error(friendlyError(insErr, "Adjunto cargado pero no se registró"));
        return;
      }
      toast.success("Adjunto cargado");
      await load();
    } catch (e) {
      toast.error(friendlyError(e, "Error subiendo"));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const downloadAttachment = async (att: SupportAttachment) => {
    try {
      const { data, error } = await supabase.storage
        .from("support-attachments")
        .createSignedUrl(att.file_path, 60);
      if (error || !data) {
        toast.error(friendlyError(error, "No se pudo generar el link de descarga"));
        return;
      }
      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    } catch (e) {
      toast.error(friendlyError(e, "Error descargando"));
    }
  };

  const saveMeta = async () => {
    if (!ticket || savingMeta) return;
    setSavingMeta(true);
    try {
      const update: Record<string, unknown> = { status };
      if (mode === "superadmin") {
        update.resolution_notes = resolutionNotes.trim() || null;
        // Si el SA mueve a resolved/closed sin assignment, auto-asignar.
        if ((status === "resolved" || status === "closed") && !ticket.assigned_to && currentUserId) {
          update.assigned_to = currentUserId;
        }
      }
      const { error } = await db.from("support_tickets").update(update).eq("id", ticket.id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo guardar"));
        return;
      }
      toast.success("Cambios guardados");
      onMutate?.();
    } catch (e) {
      toast.error(friendlyError(e, "Error guardando"));
    } finally {
      setSavingMeta(false);
    }
  };

  const assignToMe = async () => {
    if (!ticket || !currentUserId || mode !== "superadmin") return;
    try {
      const { error } = await db
        .from("support_tickets")
        .update({ assigned_to: currentUserId, status: "in_progress" })
        .eq("id", ticket.id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo asignar"));
        return;
      }
      setStatus("in_progress");
      toast.success("Asignado a vos");
      onMutate?.();
    } catch (e) {
      toast.error(friendlyError(e, "Error asignando"));
    }
  };

  const closeMyTicket = async () => {
    if (!ticket || mode !== "admin" || ticket.created_by !== currentUserId) return;
    // Cerrar el ticket es irreversible para el Admin (solo el SuperAdmin
    // puede reabrirlo). Pedimos confirmación con tono `warning` (no
    // destructive — los datos no se pierden, solo el estado cambia).
    const ok = await confirm({
      title: "¿Cerrar este ticket?",
      description:
        "Una vez cerrado, no podrás reabrirlo desde tu vista. Si lo necesitas reabierto, el SuperAdmin puede hacerlo. Esta acción no se puede deshacer desde tu rol.",
      tone: "warning",
      confirmLabel: "Cerrar ticket",
    });
    if (!ok) return;
    try {
      const { error } = await db
        .from("support_tickets")
        .update({ status: "closed" })
        .eq("id", ticket.id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo cerrar"));
        return;
      }
      toast.success("Ticket cerrado");
      setStatus("closed");
      onMutate?.();
    } catch (e) {
      toast.error(friendlyError(e, "Error cerrando"));
    }
  };

  const generalAttachments = useMemo(
    () => attachments.filter((a) => a.message_id === null),
    [attachments],
  );

  if (!ticket) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `DialogContent` ya tiene `max-h-[calc(100dvh-2rem)] overflow-y-auto`
          por default (ver dialog.tsx). Dejamos solo el max-w para mobile.
          Antes el override `max-h-[90dvh]` redundante daba problemas en
          dialogs muy altos donde el composer del chat se iba al fondo y
          requería scrollear todo el modal. Ahora el composer queda en
          flujo normal y el área de mensajes scrollea independientemente
          (su propio `max-h-72` interno). */}
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl">
        <DialogHeader>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base flex items-center gap-2 flex-wrap">
                <span className="truncate">{ticket.subject}</span>
                <Badge variant="outline" className={`text-[10px] ${STATUS_TONE[status]}`}>
                  {STATUS_LABEL[status]}
                </Badge>
                <Badge variant="outline" className={`text-[10px] ${PRIORITY_TONE[ticket.priority]}`}>
                  {PRIORITY_LABEL[ticket.priority]}
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {CATEGORY_LABEL[ticket.category]}
                </Badge>
              </DialogTitle>
              <DialogDescription className="text-xs mt-1">
                Abierto por <strong>{ticket.creator_name ?? "—"}</strong>
                {mode === "superadmin" && ticket.tenant_name && (
                  <>
                    {" "}
                    de <strong>{ticket.tenant_name}</strong>
                  </>
                )}
                {" · "}
                {formatDateTime(ticket.created_at)}
                {ticket.resolved_at && (
                  <>
                    {" · Resuelto "}
                    {formatDateTime(ticket.resolved_at)}
                  </>
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Body original del ticket */}
        <Card className="border-muted-foreground/20">
          <CardContent className="p-3 text-sm whitespace-pre-wrap break-words">
            {ticket.body}
          </CardContent>
        </Card>

        {/* Adjuntos del ticket inicial */}
        {generalAttachments.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs">Adjuntos del ticket</Label>
            <div className="flex flex-wrap gap-1">
              {generalAttachments.map((a) => (
                <Button
                  key={a.id}
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => void downloadAttachment(a)}
                >
                  <Download className="h-3.5 w-3.5 mr-1" />
                  {a.file_name}
                </Button>
              ))}
            </div>
          </div>
        )}

        {/* Controles SuperAdmin (status + asignar + notas) */}
        {mode === "superadmin" && (
          <Card className="border-violet-500/30 bg-violet-500/5">
            <CardContent className="p-3 space-y-2">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                Gestión (SuperAdmin)
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs">Estado</Label>
                  <Select value={status} onValueChange={(v) => setStatus(v as TicketStatus)}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(STATUS_LABEL) as TicketStatus[]).map((s) => (
                        <SelectItem key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-end gap-1">
                  {!ticket.assigned_to && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs flex-1"
                      onClick={() => void assignToMe()}
                    >
                      <UserCheck className="h-3.5 w-3.5 mr-1" />
                      Asignarme
                    </Button>
                  )}
                  {ticket.assigned_to && (
                    <div className="text-xs text-muted-foreground truncate flex-1">
                      Asignado: {ticket.assignee_name ?? ticket.assigned_to.slice(0, 8) + "…"}
                    </div>
                  )}
                </div>
              </div>
              <div>
                <Label className="text-xs">Notas de resolución (opcional)</Label>
                <Textarea
                  value={resolutionNotes}
                  onChange={(e) => setResolutionNotes(e.target.value)}
                  rows={2}
                  className="text-sm"
                  placeholder="Anota qué se hizo, decisiones tomadas, etc."
                />
              </div>
              <Button
                size="sm"
                onClick={() => void saveMeta()}
                disabled={savingMeta}
                className="w-full"
              >
                {savingMeta && <Spinner size="sm" className="mr-2" />}
                Guardar gestión
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Conversación */}
        <div className="space-y-2">
          <Label className="text-xs">Conversación</Label>
          <div
            ref={scrollRef}
            className="border rounded-md p-2 max-h-72 overflow-y-auto space-y-2 bg-muted/20"
          >
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground p-2">
                <Spinner size="sm" /> Cargando…
              </div>
            ) : messages.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-3">
                Sin respuestas todavía. {mode === "admin" ? "El SuperAdmin te responderá pronto." : "Sé el primero en responder."}
              </p>
            ) : (
              messages.map((m) => {
                const isMine = m.sender_id === currentUserId;
                return (
                  <div
                    key={m.id}
                    className={`flex flex-col gap-0.5 ${isMine ? "items-end" : "items-start"}`}
                  >
                    <div className="text-[10px] text-muted-foreground px-1">
                      <strong>{m.sender_name ?? (isMine ? "Vos" : "—")}</strong>
                      {" · "}
                      {formatDateTime(m.created_at)}
                    </div>
                    <div
                      className={`text-sm px-3 py-2 rounded-lg max-w-[90%] sm:max-w-[85%] whitespace-pre-wrap break-words ${
                        isMine ? "bg-primary text-primary-foreground" : "bg-background border"
                      }`}
                    >
                      {m.body}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Composer — disabled si ticket cerrado. Envuelto en <form>
              para que en mobile (donde Ctrl+Enter no es accesible con
              teclados táctiles) el submit del form mande el mensaje, y
              para asociar semánticamente Textarea + botón "Enviar" para
              lectores de pantalla. El submit del form llama sendReply. */}
          {status !== "closed" && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (sending || reply.trim().length === 0) return;
                void sendReply();
              }}
            >
              <Textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                rows={3}
                placeholder="Escribí tu respuesta…"
                className="text-sm"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void sendReply();
                  }
                }}
                aria-label="Mensaje de respuesta"
              />
              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadFile(f);
                  }}
                  aria-label="Adjuntar archivo al ticket"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  type="button"
                  aria-label="Adjuntar archivo"
                >
                  {uploading ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <Paperclip className="h-3.5 w-3.5 mr-1" />
                  )}
                  Adjuntar
                </Button>
                <Button
                  size="sm"
                  type="submit"
                  disabled={sending || reply.trim().length === 0}
                  className="ml-auto"
                >
                  {sending ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <Send className="h-3.5 w-3.5 mr-1" />
                  )}
                  Enviar (Ctrl+Enter)
                </Button>
              </div>
            </form>
          )}

          {/* Cerrar ticket — solo admin sobre su ticket si no está cerrado */}
          {mode === "admin" &&
            ticket.created_by === currentUserId &&
            status !== "closed" &&
            status !== "resolved" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void closeMyTicket()}
                className="w-full"
              >
                <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                Cerrar este ticket
              </Button>
            )}

          {status === "closed" && (
            <p className="text-xs text-muted-foreground text-center italic">
              Este ticket está cerrado. {mode === "superadmin" ? "Cambia el estado arriba para reabrirlo." : ""}
            </p>
          )}
        </div>

        {/* Adjuntos sueltos (subidos sin estar atados a un mensaje) */}
        {attachments.filter((a) => a.message_id !== null).length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs">Otros adjuntos</Label>
            <div className="flex flex-wrap gap-1">
              {attachments
                .filter((a) => a.message_id !== null)
                .map((a) => (
                  <Button
                    key={a.id}
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => void downloadAttachment(a)}
                  >
                    <Download className="h-3 w-3 mr-1" />
                    {a.file_name}
                  </Button>
                ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
