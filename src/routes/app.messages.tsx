/**
 * Módulo de mensajería interna 1-a-1 — V2.
 *
 * Features:
 *   - Conversaciones 1-a-1 con borrado asimétrico (V1).
 *   - Leído/no-leído por usuario: badge en la lista con conteo de
 *     mensajes ajenos posteriores a mi `last_read_at`. Se marca como
 *     leído al abrir la conversación y al recibir un mensaje estando en
 *     la conversación activa.
 *   - Notificación automática al destinatario: trigger SQL inserta una
 *     fila en `notifications`. El sistema existente del bell la pinta.
 *     Adicionalmente, el hook `useMessagingToasts` (montado en
 *     AppLayout) dispara un toast en tiempo real si NO estoy en /app/messages.
 *   - Editar/Borrar mensajes individuales — solo los míos. Se muestra
 *     "(editado)" cuando `edited_at` no es null.
 *   - Adjuntos por mensaje (texto puro + 0..N archivos). Layout en
 *     bucket `message-attachments`: <user_id>/<message_id>/<filename>.
 *   - Búsqueda local en la conversación activa (resalta los matches).
 *
 * RLS resume:
 *   - `conversations.SELECT`: soy miembro.
 *   - `messages.SELECT`: soy miembro AND created_at > mi cleared_at.
 *   - `messages.INSERT`: sender = yo AND `can_message(user_a, user_b)`.
 *   - `messages.UPDATE`: sender = yo. `DELETE`: sender = yo.
 *   - `message_attachments.*`: el uploader es yo + el mensaje es mío.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import {
  MessageSquare,
  Send,
  Trash2,
  Search,
  Plus,
  Shield,
  GraduationCap,
  UserCog,
  User as UserIcon,
  Pencil,
  X,
  Check,
  CheckCheck,
  CheckSquare,
  Square,
  Paperclip,
  Megaphone,
  MailOpen,
  Mail,
  MoreVertical,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { extractEdgeError } from "@/shared/lib/edge-error";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  groupMessagesByDay,
  formatMessageTime,
  previewBody,
  shouldStackWithPrevious,
  unreadCount,
  searchMessages,
  splitByMatch,
  isMessageReadByOther,
  canEditOrDeleteMessage,
  type MessageLite,
} from "@/modules/messaging/messaging";
import {
  buildMessageAttachmentPath,
  MESSAGE_ATTACHMENT_MAX_COUNT,
  formatAttachmentSize,
  safeAttachmentName,
  validateAttachmentFile,
  type MessageAttachmentRow,
} from "@/modules/messaging/message-attachments";
import { MessageAttachments } from "@/modules/messaging/MessageAttachments";
import { formatDateTime } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";
import { friendlyError } from "@/shared/lib/db-errors";

export const Route = createFileRoute("/app/messages")({ component: MessagesPage });

// `conversations`, `messages`, `message_attachments` y las RPC son
// nuevos — todavía no están en los types generados. Usamos `any` puntual.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface ConversationRow {
  id: string;
  user_a: string;
  user_b: string;
  user_a_cleared_at: string | null;
  user_b_cleared_at: string | null;
  user_a_last_read_at: string | null;
  user_b_last_read_at: string | null;
  created_at: string;
}

interface MessageableUser {
  user_id: string;
  full_name: string | null;
  email: string | null;
  role_label: "Admin" | "Docente" | "Estudiante" | "Usuario";
}

interface ConversationEnriched {
  conv: ConversationRow;
  other: MessageableUser;
  lastMessage: MessageLite | null;
  /** Cuántos mensajes ajenos posteriores a mi last_read_at. Calculado
   *  via una query agregada — ver `loadAll`. */
  unread: number;
}

const ROLE_ICON: Record<MessageableUser["role_label"], typeof Shield> = {
  Admin: Shield,
  Docente: UserCog,
  Estudiante: GraduationCap,
  Usuario: UserIcon,
};

const ROLE_BADGE_CLASS: Record<MessageableUser["role_label"], string> = {
  Admin: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/25",
  Docente: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/25",
  Estudiante: "bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/25",
  Usuario: "bg-muted text-muted-foreground",
};

function MessagesPage() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const myUserId = user?.id ?? null;

  const [contacts, setContacts] = useState<MessageableUser[]>([]);
  /** Mensaje a mostrar cuando la lista de contactos viene vacía. Difere
   *  entre "no tienes contactos disponibles" (lista honesta) y "la RPC
   *  falló" (migración faltante u otro error de DB). */
  const [contactsLoadError, setContactsLoadError] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationEnriched[]>([]);
  const [conversationsLoadError, setConversationsLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  /** IDs de conversaciones seleccionadas para acciones bulk. Cuando hay
   *  >0, los clicks en items togglean selección en lugar de abrir el chat. */
  const [selectedConvIds, setSelectedConvIds] = useState<Set<string>>(() => new Set());
  const [messages, setMessages] = useState<MessageLite[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState("");

  // ── Broadcast a curso (Docente/Admin) ──
  // Solo carga cuando se detecta rol Docente o Admin en mount; el botón
  // y diálogo se ocultan para Estudiantes (no son destinatarios válidos
  // ni autorizados a enviar masivos).
  const [isStaff, setIsStaff] = useState(false);
  const [broadcastDialogOpen, setBroadcastDialogOpen] = useState(false);
  const [broadcastCourses, setBroadcastCourses] = useState<
    Array<{ id: string; name: string; student_count?: number }>
  >([]);
  const [broadcastCourseId, setBroadcastCourseId] = useState<string>("");
  const [broadcastSubject, setBroadcastSubject] = useState("");
  const [broadcastBody, setBroadcastBody] = useState("");
  const [broadcastSending, setBroadcastSending] = useState(false);

  // V2: búsqueda dentro de la conversación activa.
  const [searchQuery, setSearchQuery] = useState("");
  // V2: edición de mensaje. `editingId === m.id` reemplaza el render del
  // bubble por un textarea.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [savingEditId, setSavingEditId] = useState<string | null>(null);
  // V2: adjuntos pendientes (aún no subidos al bucket).
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // V2: adjuntos cargados por message_id (para el render bajo cada bubble).
  const [attachmentsByMessageId, setAttachmentsByMessageId] = useState<
    Map<string, MessageAttachmentRow[]>
  >(new Map());

  // V3: modo selección múltiple para borrado masivo. Cuando está activo:
  //  - Las acciones inline (editar/borrar por bubble) se ocultan.
  //  - Cada mensaje propio borrable muestra checkbox.
  //  - Aparece un toolbar superior con "X seleccionados" + Eliminar.
  // RLS y la lógica de `canEditOrDeleteMessage` siguen siendo la fuente
  // de verdad — sólo se pueden seleccionar mensajes propios dentro de
  // la ventana de edición (no leídos por el otro).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const toggleSelectMessage = (id: string) => {
    setSelectedMessageIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  // Salir del modo selección automáticamente cuando se cambia de
  // conversación — los IDs seleccionados eran de la conv anterior.
  useEffect(() => {
    setSelectMode(false);
    setSelectedMessageIds(new Set());
  }, [activeConvId]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Scroll al fondo en cada cambio de mensajes o de conversación.
    // Antes hacíamos solo `el.scrollTop = el.scrollHeight` una vez, pero:
    //   1) En el primer render de una conversación, el browser todavía no
    //      había calculado el layout final (imágenes/adjuntos cargando
    //      asincrónicamente desplazaban scrollHeight). Resultado: el
    //      usuario abría una conv y veía el mensaje 1 arriba, no el
    //      ultimo abajo.
    //   2) requestAnimationFrame + setTimeout reaseguran el snap al
    //      fondo después del primer paint y de cargas tardías de imgs.
    const snap = () => {
      el.scrollTop = el.scrollHeight;
    };
    snap();
    const rafId = requestAnimationFrame(snap);
    const timeoutId = window.setTimeout(snap, 150);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timeoutId);
    };
  }, [messages, activeConvId, loadingMessages]);

  /** Carga contactos + conversaciones + previews + conteo "no leídos". */
  const loadAll = async () => {
    if (!myUserId) return;
    setLoading(true);
    try {
      const [contactsRes, convsRes] = await Promise.all([
        db.rpc("list_messageable_users"),
        db.from("conversations").select("*").order("created_at", { ascending: false }),
      ]);
      // Si la query de conversations falla, marcamos error en vez de
      // renderizar "Sin conversaciones" (falso negativo). El render del
      // sidebar lo muestra como ErrorState con botón Reintentar.
      if (convsRes.error) {
        setConversationsLoadError(
          friendlyError(convsRes.error, "No pudimos cargar tus conversaciones."),
        );
      } else {
        setConversationsLoadError(null);
      }
      // Si la RPC falla — típicamente porque la migración del módulo
      // aún no está aplicada en este entorno (Lovable aún no publicó) —
      // antes caíamos a `[]` silencioso y mostrábamos "sin contactos".
      // Ahora preservamos el error para mostrarlo en el dialog.
      if (contactsRes.error) {
        const msg = String(contactsRes.error.message ?? contactsRes.error);
        console.warn("[messages] list_messageable_users", contactsRes.error);
        // Mensaje legible al usuario según el código de PostgREST.
        const code = (contactsRes.error as { code?: string }).code;
        if (code === "PGRST202" || code === "42883" || /function .* does not exist/i.test(msg)) {
          setContactsLoadError(
            "El módulo de mensajería aún no está publicado en este entorno. Pide al administrador que publique los cambios pendientes.",
          );
        } else {
          setContactsLoadError(`No pudimos cargar los contactos: ${msg}`);
        }
        setContacts([]);
      } else {
        setContactsLoadError(null);
      }
      const contactsList = (contactsRes.data ?? []) as MessageableUser[];
      const convList = (convsRes.data ?? []) as ConversationRow[];
      setContacts(contactsList);

      const contactsById = new Map(contactsList.map((c) => [c.user_id, c]));
      const enriched: ConversationEnriched[] = [];
      for (const c of convList) {
        const otherId = c.user_a === myUserId ? c.user_b : c.user_a;
        const other = contactsById.get(otherId) ?? {
          user_id: otherId,
          full_name: null,
          email: null,
          role_label: "Usuario" as const,
        };
        // Último mensaje + lista corta para contar no-leídos del otro
        // posteriores a MI last_read_at. RLS recorta lo "borrado para
        // mí" automáticamente.
        const lastReadAt =
          c.user_a === myUserId ? c.user_a_last_read_at : c.user_b_last_read_at;
        const { data: recent } = await db
          .from("messages")
          .select("id, sender_id, created_at")
          .eq("conversation_id", c.id)
          .order("created_at", { ascending: false })
          .limit(50);
        const recentList = (recent ?? []) as MessageLite[];
        const { data: lastMsgRow } = await db
          .from("messages")
          .select("*")
          .eq("conversation_id", c.id)
          .order("created_at", { ascending: false })
          .limit(1);
        enriched.push({
          conv: c,
          other,
          lastMessage: (lastMsgRow?.[0] as MessageLite | undefined) ?? null,
          unread: unreadCount(recentList, lastReadAt, myUserId),
        });
      }
      enriched.sort((a, b) => {
        const aT = a.lastMessage?.created_at ?? a.conv.created_at;
        const bT = b.lastMessage?.created_at ?? b.conv.created_at;
        return bT.localeCompare(aT);
      });
      setConversations(enriched);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!myUserId) return;
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myUserId]);

  // ── Detección de rol: el botón de broadcast solo aparece para
  // Docente o Admin. Lo cargamos una sola vez en mount (no cambia
  // durante la sesión a no ser que el admin re-promote roles —
  // raro, una recarga lo refresca).
  useEffect(() => {
    if (!myUserId) return;
    void (async () => {
      const { data } = await db
        .from("user_roles")
        .select("role")
        .eq("user_id", myUserId);
      const roles = (data ?? []) as Array<{ role: string }>;
      setIsStaff(roles.some((r) => r.role === "Docente" || r.role === "Admin"));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myUserId]);

  // Carga la lista de cursos cuando se abre el diálogo de broadcast.
  // Admin → todos los cursos. Docente → solo los que dicta (course_teachers).
  // Solo se ejecuta al abrir el diálogo para no consumir queries en cada
  // entrada al módulo de mensajes — el 95% de las veces el usuario
  // entra a leer su inbox, no a enviar masivos.
  useEffect(() => {
    if (!broadcastDialogOpen || !myUserId) return;
    void (async () => {
      // 1) Cursos según rol.
      const { data: roleRows } = await db
        .from("user_roles")
        .select("role")
        .eq("user_id", myUserId);
      const roles = ((roleRows ?? []) as Array<{ role: string }>).map((r) => r.role);
      const isAdminLocal = roles.includes("Admin");

      let coursesQuery = db.from("courses").select("id, name").order("name");
      if (!isAdminLocal) {
        // Filtra por cursos donde es teacher.
        const { data: ctRows } = await db
          .from("course_teachers")
          .select("course_id")
          .eq("user_id", myUserId);
        const courseIds = ((ctRows ?? []) as Array<{ course_id: string }>).map(
          (r) => r.course_id,
        );
        if (courseIds.length === 0) {
          setBroadcastCourses([]);
          return;
        }
        coursesQuery = db.from("courses").select("id, name").in("id", courseIds).order("name");
      }
      const { data: coursesData } = await coursesQuery;
      const courses = (coursesData ?? []) as Array<{ id: string; name: string }>;

      // 2) Conteo de estudiantes por curso (1 query agregada usando count).
      // Hacemos N queries individuales — N suele ser <20 cursos, vale la
      // pena por simplicidad vs. una RPC dedicada.
      const enriched = await Promise.all(
        courses.map(async (c) => {
          const { count } = await db
            .from("course_enrollments")
            .select("user_id", { count: "exact", head: true })
            .eq("course_id", c.id);
          return { ...c, student_count: count ?? 0 };
        }),
      );
      setBroadcastCourses(enriched);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcastDialogOpen, myUserId]);

  const sendBroadcast = async () => {
    if (!broadcastCourseId) {
      toast.error("Selecciona un curso.");
      return;
    }
    if (!broadcastSubject.trim() || !broadcastBody.trim()) {
      toast.error("Asunto y mensaje son obligatorios.");
      return;
    }
    setBroadcastSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("broadcast-course-message", {
        body: {
          courseId: broadcastCourseId,
          subject: broadcastSubject.trim(),
          body: broadcastBody.trim(),
        },
      });
      if (error || data?.error) {
        const detail = await extractEdgeError(error, data);
        toast.error(detail || "Error al enviar el mensaje.");
        return;
      }
      const notified = typeof data?.notified === "number" ? data.notified : 0;
      const bcc = typeof data?.bcc_count === "number" ? data.bcc_count : 0;
      const emailSent = data?.email_sent === true;
      if (emailSent) {
        toast.success(
          `Mensaje enviado a ${notified} estudiante(s). Correo con ${bcc} BCC despachado.`,
        );
      } else {
        toast.warning(
          data?.warning ?? `Notificaciones a ${notified} estudiante(s) creadas, pero el correo no salió.`,
        );
      }
      setBroadcastDialogOpen(false);
      setBroadcastCourseId("");
      setBroadcastSubject("");
      setBroadcastBody("");
    } finally {
      setBroadcastSending(false);
    }
  };

  // Deep-link desde notificaciones/correo: si la URL trae ?conv=<id>,
  // auto-selecciona esa conversación cuando esté en la lista cargada.
  // Patrón mirror del check-in de asistencia: leer searchParams, limpiar
  // la URL para no re-disparar, fijar el activeConvId. Solo dispara
  // cuando `conversations` está pobladita — si la conv no está en la
  // lista (RLS, borrada, etc.) el activeConvId queda null y el render
  // muestra el estado "selecciona una conversación".
  useEffect(() => {
    if (!myUserId || conversations.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const convFromUrl = params.get("conv");
    if (!convFromUrl) return;
    const exists = conversations.some((c) => c.conv.id === convFromUrl);
    // Limpiamos la URL antes incluso de verificar exists — así si la
    // conv ya no es accesible no quedamos con un querystring rancio
    // que vuelva a disparar este effect si el user recarga.
    const url = new URL(window.location.href);
    url.searchParams.delete("conv");
    window.history.replaceState({}, "", url.toString());
    if (exists) setActiveConvId(convFromUrl);
  }, [myUserId, conversations]);

  // Realtime: INSERTs en messages/conversations/message_attachments.
  useEffect(() => {
    if (!myUserId) return;
    const channel = supabase
      .channel(`messaging-${myUserId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload: { new: MessageLite }) => {
          const m = payload.new;
          if (activeConvId && m.conversation_id === activeConvId) {
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
            // Si estoy en la conv activa y llega un mensaje ajeno, marco
            // como leído automáticamente — es coherente con que estoy
            // VIENDO la conversación.
            if (m.sender_id !== myUserId) {
              void db.rpc("mark_conversation_read", { _conv_id: activeConvId });
            }
          }
          void loadAll();
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "messages" },
        (payload: { new: MessageLite }) => {
          const m = payload.new;
          if (activeConvId && m.conversation_id === activeConvId) {
            setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, ...m } : x)));
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "messages" },
        (rawPayload: { old: Record<string, unknown> }) => {
          const m = rawPayload.old as { id: string; conversation_id?: string };
          setMessages((prev) => prev.filter((x) => x.id !== m.id));
          void loadAll();
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        () => void loadAll(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "message_attachments" },
        () => {
          if (activeConvId) void reloadAttachments(activeConvId);
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myUserId, activeConvId]);

  /** Recarga la map de adjuntos para los mensajes de UNA conv. */
  const reloadAttachments = async (convId: string) => {
    const { data: msgs } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", convId);
    const ids = ((msgs ?? []) as Array<{ id: string }>).map((m) => m.id);
    if (ids.length === 0) {
      setAttachmentsByMessageId(new Map());
      return;
    }
    const { data: atts } = await db
      .from("message_attachments")
      .select("*")
      .in("message_id", ids)
      .order("created_at", { ascending: true });
    const m = new Map<string, MessageAttachmentRow[]>();
    for (const row of (atts ?? []) as MessageAttachmentRow[]) {
      const arr = m.get(row.message_id) ?? [];
      arr.push(row);
      m.set(row.message_id, arr);
    }
    setAttachmentsByMessageId(m);
  };

  // Al cambiar la conv activa: carga mensajes + adjuntos + marca como leída.
  useEffect(() => {
    if (!activeConvId) {
      setMessages([]);
      setAttachmentsByMessageId(new Map());
      setSearchQuery("");
      setEditingId(null);
      setPendingFiles([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingMessages(true);
      try {
        const { data, error } = await db
          .from("messages")
          .select("*")
          .eq("conversation_id", activeConvId)
          .order("created_at", { ascending: true });
        if (cancelled) return;
        if (error) {
          toast.error(friendlyError(error));
          setMessages([]);
          return;
        }
        setMessages((data ?? []) as MessageLite[]);
        await reloadAttachments(activeConvId);
        // Marca leída — silencioso. El loadAll que dispara realtime
        // refresca el badge de la lista de convs.
        void db.rpc("mark_conversation_read", { _conv_id: activeConvId }).then(() => loadAll());
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConvId]);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    const next: File[] = [];
    for (const f of Array.from(incoming)) {
      const err = validateAttachmentFile(f);
      if (err) {
        toast.error(`${f.name}: ${err}`);
        continue;
      }
      next.push(f);
    }
    setPendingFiles((prev) => {
      const merged = [...prev, ...next];
      if (merged.length > MESSAGE_ATTACHMENT_MAX_COUNT) {
        toast.error(`Máximo ${MESSAGE_ATTACHMENT_MAX_COUNT} archivos por mensaje.`);
        return merged.slice(0, MESSAGE_ATTACHMENT_MAX_COUNT);
      }
      return merged;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePendingFile = (idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  const uploadPendingFiles = async (messageId: string): Promise<MessageAttachmentRow[]> => {
    if (pendingFiles.length === 0 || !myUserId) return [];
    const created: MessageAttachmentRow[] = [];
    for (const file of pendingFiles) {
      const safe = safeAttachmentName(file.name);
      const path = buildMessageAttachmentPath(myUserId, messageId, file.name);
      const up = await supabase.storage.from("message-attachments").upload(path, file, {
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });
      if (up.error) {
        toast.error(`No se pudo subir ${safe}: ${friendlyError(up.error)}`);
        continue;
      }
      const { data, error } = await db
        .from("message_attachments")
        .insert({
          message_id: messageId,
          path,
          name: safe,
          mime_type: file.type || null,
          size_bytes: file.size,
          uploaded_by: myUserId,
        })
        .select("*")
        .single();
      if (error || !data) {
        await supabase.storage.from("message-attachments").remove([path]);
        toast.error(`No se pudo registrar ${safe}: ${friendlyError(error, "desconocido")}`);
        continue;
      }
      created.push(data as MessageAttachmentRow);
    }
    return created;
  };

  const send = async () => {
    if (!activeConvId || !myUserId) return;
    const hasBody = body.trim().length > 0;
    const hasFiles = pendingFiles.length > 0;
    if (!hasBody && !hasFiles) return;
    const text = hasBody ? body.trim() : "(adjuntos)";
    setSending(true);
    try {
      const { data, error } = await db
        .from("messages")
        .insert({ conversation_id: activeConvId, sender_id: myUserId, body: text })
        .select("*")
        .single();
      if (error || !data) {
        toast.error(friendlyError(error, "No se pudo enviar el mensaje"));
        return;
      }
      const inserted = data as MessageLite;
      // Subir adjuntos antes del append para que el bubble pinte ya con
      // los archivos en su lugar.
      const newAtts = await uploadPendingFiles(inserted.id);
      setMessages((prev) =>
        prev.some((m) => m.id === inserted.id) ? prev : [...prev, inserted],
      );
      if (newAtts.length > 0) {
        setAttachmentsByMessageId((prev) => {
          const next = new Map(prev);
          next.set(inserted.id, newAtts);
          return next;
        });
      }
      setBody("");
      setPendingFiles([]);
      void loadAll();
    } finally {
      setSending(false);
    }
  };

  const startEdit = (m: MessageLite) => {
    // Defensa cliente: la UI ya oculta el botón cuando el otro leyó el
    // mensaje, pero si por algún edge case (race con realtime) llegan a
    // disparar el handler, abortamos con toast amigable. La RLS en DB
    // tiene la última palabra de todos modos.
    if (isMessageReadByOther(m.created_at, otherLastReadAt)) {
      toast.error("Ya no puedes editar este mensaje: el otro usuario lo leyó.");
      return;
    }
    setEditingId(m.id);
    setEditingText(m.body);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditingText("");
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const trimmed = editingText.trim();
    if (!trimmed) {
      toast.error("El mensaje no puede estar vacío");
      return;
    }
    setSavingEditId(editingId);
    try {
      const { data, error } = await db
        .from("messages")
        .update({ body: trimmed, edited_at: new Date().toISOString() })
        .eq("id", editingId)
        .select("*")
        .single();
      if (error || !data) {
        toast.error(friendlyError(error, "No se pudo editar el mensaje"));
        return;
      }
      setMessages((prev) =>
        prev.map((m) => (m.id === editingId ? { ...m, ...(data as MessageLite) } : m)),
      );
      cancelEdit();
    } finally {
      setSavingEditId(null);
    }
  };

  const deleteMessage = async (m: MessageLite) => {
    // Defensa cliente (espejo de la RLS): si el otro ya leyó el mensaje,
    // queda congelado. Abortamos con toast en vez de mostrar el error
    // crudo de Postgres ("policy violation").
    if (isMessageReadByOther(m.created_at, otherLastReadAt)) {
      toast.error("Ya no puedes eliminar este mensaje: el otro usuario lo leyó.");
      return;
    }
    const ok = await confirm({
      title: "Eliminar mensaje",
      description:
        "Se eliminará el mensaje para ambas partes. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    // También borramos los adjuntos del bucket (la fila se borra por
    // CASCADE cuando el message se borra; el archivo en storage NO).
    const atts = attachmentsByMessageId.get(m.id) ?? [];
    if (atts.length > 0) {
      await supabase.storage.from("message-attachments").remove(atts.map((a) => a.path));
    }
    const { error } = await db.from("messages").delete().eq("id", m.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setMessages((prev) => prev.filter((x) => x.id !== m.id));
    setAttachmentsByMessageId((prev) => {
      const next = new Map(prev);
      next.delete(m.id);
      return next;
    });
  };

  /** Borra todos los mensajes seleccionados a la vez. Filtra defensivo
   *  por elegibilidad (mismo predicado que el bubble individual), aunque
   *  el checkbox ya se renderiza solo cuando es elegible. Limpia
   *  adjuntos de Storage en batch. Si el batch del DB falla parcialmente,
   *  Postgres lo deshace entero (transacción implícita por `.delete().in()`). */
  const bulkDeleteMessages = async () => {
    const idArr = Array.from(selectedMessageIds);
    if (idArr.length === 0) return;
    // Construir lista de mensajes elegibles según los IDs seleccionados.
    const eligible = messages.filter(
      (m) =>
        idArr.includes(m.id) &&
        canEditOrDeleteMessage({
          senderId: m.sender_id,
          myUserId,
          messageCreatedAt: m.created_at,
          otherSideLastReadAt: otherLastReadAt,
        }),
    );
    if (eligible.length === 0) {
      toast.error("Ninguno de los mensajes seleccionados es elegible para eliminar.");
      return;
    }
    const ok = await confirm({
      title: `Eliminar ${eligible.length} mensaje(s)`,
      description: `Se eliminarán ${eligible.length} mensaje(s) para ambas partes. Esta acción no se puede deshacer.`,
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    setBulkDeleting(true);
    try {
      // 1) Borrar adjuntos de Storage. El bucket también recibe CASCADE
      //    a nivel de filas message_attachments cuando borramos mensajes,
      //    pero los objetos físicos quedan huérfanos — limpiamos aquí.
      const pathsToRemove: string[] = [];
      for (const m of eligible) {
        const atts = attachmentsByMessageId.get(m.id) ?? [];
        for (const a of atts) if (a.path) pathsToRemove.push(a.path);
      }
      if (pathsToRemove.length > 0) {
        await supabase.storage.from("message-attachments").remove(pathsToRemove);
      }
      // 2) Borrado batch via `.in()` — Postgres lo ejecuta como una
      //    sola statement con rollback si algo falla.
      const eligibleIds = eligible.map((m) => m.id);
      const { error } = await db.from("messages").delete().in("id", eligibleIds);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      setMessages((prev) => prev.filter((x) => !eligibleIds.includes(x.id)));
      setAttachmentsByMessageId((prev) => {
        const next = new Map(prev);
        for (const id of eligibleIds) next.delete(id);
        return next;
      });
      const skipped = idArr.length - eligible.length;
      toast.success(
        skipped > 0
          ? `${eligible.length} eliminado(s) · ${skipped} omitido(s) (ya leídos por el otro)`
          : `${eligible.length} mensaje(s) eliminado(s)`,
      );
      setSelectMode(false);
      setSelectedMessageIds(new Set());
    } finally {
      setBulkDeleting(false);
    }
  };

  const openConversationWith = async (otherUserId: string) => {
    if (!myUserId) return;
    const { data, error } = await db.rpc("open_conversation", { _other: otherUserId });
    if (error || !data) {
      toast.error(friendlyError(error, "No se pudo abrir la conversación"));
      return;
    }
    const convId = data as string;
    setNewDialogOpen(false);
    setContactSearch("");
    await loadAll();
    setActiveConvId(convId);
  };

  const toggleConvSelected = (id: string) => {
    setSelectedConvIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearConvSelection = () => setSelectedConvIds(new Set());

  const markConvRead = async (convId: string) => {
    const { error } = await db.rpc("mark_conversation_read", { _conv_id: convId });
    if (error) {
      toast.error(friendlyError(error, "No se pudo marcar como leída"));
      return false;
    }
    return true;
  };

  const markConvUnread = async (convId: string) => {
    const { error } = await db.rpc("mark_conversation_unread", { _conv_id: convId });
    if (error) {
      toast.error(friendlyError(error, "No se pudo marcar como no leída"));
      return false;
    }
    return true;
  };

  const markSelectedRead = async () => {
    const ids = Array.from(selectedConvIds);
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => markConvRead(id)));
    clearConvSelection();
    await loadAll();
    toast.success(`${ids.length} conversación${ids.length === 1 ? "" : "es"} marcada${ids.length === 1 ? "" : "s"} como leída${ids.length === 1 ? "" : "s"}`);
  };

  const markSelectedUnread = async () => {
    const ids = Array.from(selectedConvIds);
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => markConvUnread(id)));
    clearConvSelection();
    await loadAll();
    toast.success(`${ids.length} conversación${ids.length === 1 ? "" : "es"} marcada${ids.length === 1 ? "" : "s"} como no leída${ids.length === 1 ? "" : "s"}`);
  };

  const clearSelectedConversations = async () => {
    const ids = Array.from(selectedConvIds);
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Eliminar ${ids.length} conversación${ids.length === 1 ? "" : "es"}`,
      description:
        "Desaparecerán SOLO para ti. La otra persona las sigue viendo. Si te escriben de nuevo, las volverás a ver con los mensajes nuevos.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    await Promise.all(ids.map((id) => db.rpc("clear_conversation", { _conv_id: id })));
    if (activeConvId && ids.includes(activeConvId)) setActiveConvId(null);
    clearConvSelection();
    await loadAll();
    toast.success(`${ids.length} conversación${ids.length === 1 ? "" : "es"} eliminada${ids.length === 1 ? "" : "s"} para ti`);
  };

  const clearConversation = async (convId: string) => {
    const ok = await confirm({
      title: "Eliminar conversación",
      description:
        "La conversación desaparecerá SOLO para ti. La otra persona la sigue viendo. Si te escribe de nuevo, volverás a verla con los mensajes nuevos.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.rpc("clear_conversation", { _conv_id: convId });
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    if (activeConvId === convId) setActiveConvId(null);
    await loadAll();
    toast.success("Conversación eliminada para ti");
  };

  const filteredContacts = useMemo(() => {
    const q = contactSearch.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const haystack = `${c.full_name ?? ""} ${c.email ?? ""} ${c.role_label}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [contacts, contactSearch]);

  const activeConv = conversations.find((c) => c.conv.id === activeConvId) ?? null;
  // Mensajes filtrados por búsqueda local.
  const visibleMessages = useMemo(
    () => searchMessages(messages, searchQuery),
    [messages, searchQuery],
  );
  const dayGroups = useMemo(() => groupMessagesByDay(visibleMessages), [visibleMessages]);

  // last_read_at del OTRO usuario en la conv activa. Lo usamos para
  // (a) decidir si los mensajes propios están "leídos" (doble check)
  // y (b) bloquear edit/delete cuando el otro ya los vio. La RLS en DB
  // ya impone la regla; esto es coherencia visual + UX preventiva.
  const otherLastReadAt = useMemo(() => {
    if (!activeConv || !myUserId) return null;
    const c = activeConv.conv;
    // El "otro" es el que NO soy yo: si yo soy user_a, el otro es user_b.
    return c.user_a === myUserId ? c.user_b_last_read_at : c.user_a_last_read_at;
  }, [activeConv, myUserId]);

  return (
    <div className="space-y-3">
      <PageHeader
        icon={<MessageSquare className="h-6 w-6 text-cyan-400 dark:text-cyan-300" />}
        title="Mensajes"
        actions={
          <>
            {isStaff && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setBroadcastDialogOpen(true)}
                title="Enviar un mensaje a todos los estudiantes de un curso. Genera notificación in-app y correo (con todos los alumnos en BCC)."
              >
                <Megaphone className="h-4 w-4 mr-1" />
                <span className="hidden sm:inline">Enviar a todos los estudiantes</span>
                <span className="sm:hidden">Broadcast</span>
              </Button>
            )}
            <Button size="sm" onClick={() => setNewDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">Nueva conversación</span>
              <span className="sm:hidden">Nueva</span>
            </Button>
          </>
        }
      />

      <Card>
        <CardContent className="p-0 grid md:grid-cols-[280px_1fr] min-h-[60vh]">
          {/* Lista de conversaciones */}
          <div className="border-r min-h-[60vh] max-h-[75vh] overflow-y-auto">
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
                <Spinner size="sm" /> Cargando…
              </div>
            ) : conversationsLoadError ? (
              <ErrorState
                message="No pudimos cargar tus conversaciones"
                hint={conversationsLoadError}
                onRetry={() => void loadAll()}
              />
            ) : conversations.length === 0 ? (
              <EmptyState
                title="Sin conversaciones"
                description="Inicia una conversación con alguien de tus cursos o con un Admin."
              />
            ) : (
              <>
                {/* Toolbar bulk: visible cuando hay selección */}
                {selectedConvIds.size > 0 && (
                  <div className="sticky top-0 z-10 flex items-center gap-1 border-b bg-background/95 px-2 py-1.5 backdrop-blur">
                    <span className="text-xs font-medium mr-1">
                      {selectedConvIds.size} seleccionada{selectedConvIds.size === 1 ? "" : "s"}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => void markSelectedRead()}
                      title="Marcar como leídas"
                    >
                      <MailOpen className="h-3.5 w-3.5 mr-1" />
                      <span className="text-xs">Leídas</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => void markSelectedUnread()}
                      title="Marcar como no leídas"
                    >
                      <Mail className="h-3.5 w-3.5 mr-1" />
                      <span className="text-xs">No leídas</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-destructive hover:text-destructive"
                      onClick={() => void clearSelectedConversations()}
                      title="Eliminar conversaciones (solo para mí)"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 ml-auto"
                      onClick={clearConvSelection}
                      title="Cancelar selección"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
                <ul className="divide-y">
                  {conversations.map((c) => {
                    const RoleIcon = ROLE_ICON[c.other.role_label];
                    const isActive = c.conv.id === activeConvId;
                    const isSelected = selectedConvIds.has(c.conv.id);
                    const inSelectionMode = selectedConvIds.size > 0;
                    return (
                      <li key={c.conv.id} className="relative group">
                        <button
                          type="button"
                          onClick={() => {
                            // En modo selección, click togglea selección
                            // en vez de abrir el chat (patrón estándar tipo
                            // app de correo / iMessage).
                            if (inSelectionMode) {
                              toggleConvSelected(c.conv.id);
                            } else {
                              setActiveConvId(c.conv.id);
                            }
                          }}
                          className={cn(
                            "w-full text-left px-3 py-2.5 hover:bg-muted/40 transition-colors",
                            isActive && !inSelectionMode && "bg-primary/5 border-l-2 border-primary",
                            isSelected && "bg-primary/10",
                          )}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            {/* Checkbox: en modo selección reemplaza el ícono
                                de rol; sino aparece en hover para iniciar
                                selección. */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleConvSelected(c.conv.id);
                              }}
                              className={cn(
                                "shrink-0 flex items-center justify-center w-4 h-4 rounded transition-opacity",
                                inSelectionMode ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
                              )}
                              aria-label={isSelected ? "Quitar selección" : "Seleccionar"}
                            >
                              {isSelected ? (
                                <CheckSquare className="h-4 w-4 text-primary" />
                              ) : (
                                <Square className="h-4 w-4 text-muted-foreground" />
                              )}
                            </button>
                            {!inSelectionMode && (
                              <RoleIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0 group-hover:hidden" />
                            )}
                            <span className="font-medium text-sm truncate flex-1">
                              {c.other.full_name ?? c.other.email ?? "Usuario"}
                            </span>
                            {c.unread > 0 && (
                              <Badge
                                className="text-[10px] h-4 min-w-4 px-1 bg-primary text-primary-foreground"
                                data-testid={`unread-badge-${c.conv.id}`}
                              >
                                {c.unread}
                              </Badge>
                            )}
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[9px] px-1 py-0 h-auto",
                                ROLE_BADGE_CLASS[c.other.role_label],
                              )}
                            >
                              {c.other.role_label}
                            </Badge>
                          </div>
                          <p
                            className={cn(
                              "text-[11px] truncate pl-6",
                              c.unread > 0
                                ? "text-foreground font-medium"
                                : "text-muted-foreground",
                            )}
                          >
                            {previewBody(c.lastMessage?.body, 50) || (
                              <span className="italic">Sin mensajes visibles</span>
                            )}
                          </p>
                          {c.lastMessage && (
                            <p className="text-[10px] text-muted-foreground/70 mt-0.5 pl-6 tabular-nums">
                              {formatDateTime(c.lastMessage.created_at)}
                            </p>
                          )}
                        </button>
                        {/* Kebab por conv: solo visible si no hay selección
                            activa (cuando hay, la toolbar arriba toma el
                            control y el kebab confunde). */}
                        {!inSelectionMode && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="absolute right-1 top-2 h-7 w-7 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                                onClick={(e) => e.stopPropagation()}
                                aria-label="Acciones de la conversación"
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              {c.unread > 0 ? (
                                <DropdownMenuItem
                                  onClick={async () => {
                                    if (await markConvRead(c.conv.id)) await loadAll();
                                  }}
                                >
                                  <MailOpen className="h-4 w-4 mr-2" />
                                  Marcar como leída
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onClick={async () => {
                                    if (await markConvUnread(c.conv.id)) await loadAll();
                                  }}
                                >
                                  <Mail className="h-4 w-4 mr-2" />
                                  Marcar como no leída
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => void clearConversation(c.conv.id)}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Eliminar
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>

          {/* Panel de chat */}
          <div className="flex flex-col min-h-[60vh] max-h-[75vh]">
            {!activeConv ? (
              <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
                Selecciona una conversación o inicia una nueva.
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b">
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate flex items-center gap-1.5">
                      {(() => {
                        const RI = ROLE_ICON[activeConv.other.role_label];
                        return <RI className="h-3.5 w-3.5 text-muted-foreground" />;
                      })()}
                      {activeConv.other.full_name ?? activeConv.other.email ?? "Usuario"}
                      <Badge
                        variant="outline"
                        className={cn("text-[9px] px-1 py-0 h-auto", ROLE_BADGE_CLASS[activeConv.other.role_label])}
                      >
                        {activeConv.other.role_label}
                      </Badge>
                    </p>
                    {activeConv.other.email && (
                      <p className="text-[10px] text-muted-foreground truncate">
                        {activeConv.other.email}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Toggle del modo selección. Cuando hay 0
                        seleccionados y selectMode=false, muestra solo
                        el ícono. Cuando se entra al modo, el ícono
                        cambia y al hacer click sale. */}
                    <Button
                      variant={selectMode ? "secondary" : "ghost"}
                      size="sm"
                      className="shrink-0"
                      onClick={() => {
                        if (selectMode) {
                          setSelectMode(false);
                          setSelectedMessageIds(new Set());
                        } else {
                          setSelectMode(true);
                        }
                      }}
                      title={selectMode ? "Salir de selección" : "Seleccionar mensajes"}
                      aria-pressed={selectMode}
                    >
                      <CheckSquare className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive shrink-0"
                      onClick={() => void clearConversation(activeConv.conv.id)}
                      title="Eliminar conversación (solo para mí)"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Toolbar de selección — solo visible cuando hay items
                    seleccionados. Diseño consistente con MultiSelectToolbar
                    de los grids, pero inline aquí porque la UX de mensajes
                    es vertical y necesita estar pegada arriba del scroll. */}
                {selectMode && selectedMessageIds.size > 0 && (
                  <div className="flex items-center justify-between gap-2 px-4 py-2 bg-muted/40 border-b">
                    <span className="text-xs font-medium">
                      {selectedMessageIds.size} mensaje
                      {selectedMessageIds.size === 1 ? "" : "s"} seleccionado
                      {selectedMessageIds.size === 1 ? "" : "s"}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setSelectMode(false);
                          setSelectedMessageIds(new Set());
                        }}
                        disabled={bulkDeleting}
                      >
                        Cancelar
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => void bulkDeleteMessages()}
                        disabled={bulkDeleting}
                      >
                        {bulkDeleting ? (
                          <Spinner size="xs" className="mr-1" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5 mr-1" />
                        )}
                        Eliminar
                      </Button>
                    </div>
                  </div>
                )}

                {/* Búsqueda local */}
                <div className="px-3 py-2 border-b">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder="Buscar en la conversación…"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-7 h-8 text-xs"
                      aria-label="Buscar en la conversación"
                    />
                  </div>
                </div>

                {/* Mensajes */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
                  {loadingMessages ? (
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <Spinner size="sm" /> Cargando mensajes…
                    </div>
                  ) : visibleMessages.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic text-center py-8">
                      {searchQuery.trim()
                        ? "Sin coincidencias para la búsqueda."
                        : "Aún no hay mensajes. Escribe el primero ↓"}
                    </p>
                  ) : (
                    dayGroups.map((group) => (
                      <div key={group.dayKey} className="space-y-1">
                        <div className="flex justify-center">
                          <Badge variant="secondary" className="text-[10px]">
                            {group.label}
                          </Badge>
                        </div>
                        {group.items.map((m, idx) => {
                          const mine = m.sender_id === myUserId;
                          const stack = shouldStackWithPrevious(m, group.items[idx - 1]);
                          const isEditing = editingId === m.id;
                          const isSaving = savingEditId === m.id;
                          const atts = attachmentsByMessageId.get(m.id) ?? [];
                          // Solo se pueden seleccionar mensajes propios
                          // dentro de la ventana de edición. Otros mensajes
                          // muestran el bubble sin checkbox.
                          const eligibleForBulk =
                            mine &&
                            canEditOrDeleteMessage({
                              senderId: m.sender_id,
                              myUserId,
                              messageCreatedAt: m.created_at,
                              otherSideLastReadAt: otherLastReadAt,
                            });
                          const isSelected = selectedMessageIds.has(m.id);
                          const bubbleClickable = selectMode && eligibleForBulk && !isEditing;
                          const onBubbleClick = bubbleClickable
                            ? () => toggleSelectMessage(m.id)
                            : undefined;
                          // Pre-computamos isRead aquí para no usar una
                          // IIFE dentro del JSX (prettier se confunde
                          // con la indentación). Solo aplica a mensajes
                          // propios — del lado del otro no mostramos el
                          // doble check.
                          const isReadByOther = mine
                            ? isMessageReadByOther(m.created_at, otherLastReadAt)
                            : false;
                          return (
                            <div
                              key={m.id}
                              className={cn(
                                "flex group items-start gap-2",
                                mine ? "justify-end" : "justify-start",
                                stack ? "mt-0.5" : "mt-1.5",
                              )}
                            >
                              {/* Checkbox de selección — solo en modo
                                  selección y solo si el mensaje es
                                  elegible para borrado masivo. */}
                              {selectMode && eligibleForBulk && (
                                <button
                                  type="button"
                                  onClick={() => toggleSelectMessage(m.id)}
                                  className="shrink-0 mt-1 text-muted-foreground hover:text-foreground transition-colors"
                                  aria-label={
                                    isSelected ? "Deseleccionar mensaje" : "Seleccionar mensaje"
                                  }
                                  aria-pressed={isSelected}
                                >
                                  {isSelected ? (
                                    <CheckSquare className="h-4 w-4 text-primary" />
                                  ) : (
                                    <Square className="h-4 w-4" />
                                  )}
                                </button>
                              )}
                              <div
                                className={cn(
                                  "max-w-[75%] rounded-lg px-3 py-1.5 text-sm shadow-sm relative",
                                  mine
                                    ? "bg-primary text-primary-foreground rounded-br-sm"
                                    : "bg-muted text-foreground rounded-bl-sm",
                                  isSelected && "ring-2 ring-primary ring-offset-1",
                                  selectMode && eligibleForBulk && "cursor-pointer",
                                )}
                                onClick={onBubbleClick}
                              >
                                {isEditing ? (
                                  <div className="space-y-1 min-w-[200px]">
                                    <Textarea
                                      value={editingText}
                                      onChange={(e) => setEditingText(e.target.value)}
                                      rows={2}
                                      className="text-xs min-h-[2.5rem] bg-background text-foreground"
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                                          e.preventDefault();
                                          void saveEdit();
                                        }
                                        if (e.key === "Escape") {
                                          e.preventDefault();
                                          cancelEdit();
                                        }
                                      }}
                                    />
                                    <div className="flex justify-end gap-1">
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="h-6 text-[10px] text-primary-foreground hover:text-primary-foreground"
                                        onClick={cancelEdit}
                                        disabled={isSaving}
                                      >
                                        <X className="h-3 w-3 mr-1" /> Cancelar
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="secondary"
                                        className="h-6 text-[10px]"
                                        onClick={() => void saveEdit()}
                                        disabled={isSaving || !editingText.trim()}
                                      >
                                        {isSaving ? (
                                          <Spinner size="xs" className="mr-1" />
                                        ) : (
                                          <Check className="h-3 w-3 mr-1" />
                                        )}
                                        Guardar
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <p className="whitespace-pre-wrap break-words">
                                      {searchQuery.trim()
                                        ? splitByMatch(m.body, searchQuery).map((seg, i) =>
                                            seg.isMatch ? (
                                              <mark
                                                key={i}
                                                className={cn(
                                                  "rounded px-0.5",
                                                  mine
                                                    ? "bg-primary-foreground text-primary"
                                                    : "bg-yellow-200 text-foreground dark:bg-yellow-500/40",
                                                )}
                                              >
                                                {seg.text}
                                              </mark>
                                            ) : (
                                              <span key={i}>{seg.text}</span>
                                            ),
                                          )
                                        : m.body}
                                    </p>
                                    {atts.length > 0 && (
                                      <MessageAttachments attachments={atts} inverted={mine} />
                                    )}
                                    <div className="flex items-center justify-between gap-2 mt-0.5">
                                      <p
                                        className={cn(
                                          "text-[9px] tabular-nums flex items-center gap-1",
                                          mine ? "text-primary-foreground/70" : "text-muted-foreground",
                                        )}
                                      >
                                        <span>
                                          {formatMessageTime(m.created_at)}
                                          {m.edited_at ? " · editado" : ""}
                                        </span>
                                        {/* Doble check de "leído" — solo en
                                            mensajes propios. ✓✓ azul (heredado
                                            del foreground) cuando el otro lo
                                            leyó; ✓ gris para "enviado pero no
                                            leído todavía". Patrón WhatsApp. */}
                                        {mine && (
                                          <span
                                            className={cn(
                                              "inline-flex",
                                              isReadByOther
                                                ? "text-primary-foreground"
                                                : "text-primary-foreground/50",
                                            )}
                                            title={isReadByOther ? "Leído" : "Enviado"}
                                            aria-label={isReadByOther ? "Leído" : "Enviado"}
                                          >
                                            {isReadByOther ? (
                                              <CheckCheck className="h-3 w-3" />
                                            ) : (
                                              <Check className="h-3 w-3" />
                                            )}
                                          </span>
                                        )}
                                      </p>
                                      {!selectMode && eligibleForBulk && (
                                        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-5 w-5 text-primary-foreground hover:text-primary-foreground"
                                            onClick={() => startEdit(m)}
                                            title="Editar mensaje"
                                            aria-label={`Editar mensaje ${m.id}`}
                                          >
                                            <Pencil className="h-3 w-3" />
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-5 w-5 text-primary-foreground hover:text-primary-foreground"
                                            onClick={() => void deleteMessage(m)}
                                            title="Eliminar mensaje"
                                            aria-label={`Eliminar mensaje ${m.id}`}
                                          >
                                            <Trash2 className="h-3 w-3" />
                                          </Button>
                                        </div>
                                      )}
                                    </div>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>

                {/* Composer + adjuntos */}
                <div className="border-t p-2 space-y-1.5">
                  <div className="flex gap-2">
                    <Textarea
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      placeholder="Escribe un mensaje…"
                      rows={2}
                      className="text-sm min-h-[2.5rem] resize-none"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                          e.preventDefault();
                          void send();
                        }
                      }}
                    />
                    <div className="flex flex-col gap-1 self-end">
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => addFiles(e.target.files)}
                        aria-label="Adjuntar archivos"
                        data-testid="message-file-input"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-9 px-2"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={
                          sending || pendingFiles.length >= MESSAGE_ATTACHMENT_MAX_COUNT
                        }
                        title="Adjuntar archivos"
                        aria-label="Adjuntar archivos"
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        onClick={() => void send()}
                        disabled={(!body.trim() && pendingFiles.length === 0) || sending}
                        className="h-9"
                      >
                        {sending ? <Spinner size="xs" /> : <Send className="h-4 w-4" />}
                      </Button>
                    </div>
                  </div>
                  {pendingFiles.length > 0 && (
                    <ul className="space-y-1" data-testid="message-pending-files">
                      {pendingFiles.map((f, idx) => (
                        <li
                          key={`${f.name}-${idx}`}
                          className="flex items-center gap-2 rounded border bg-muted/30 px-2 py-1 text-[11px]"
                        >
                          <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
                          <span className="truncate flex-1" title={f.name}>
                            {f.name}
                          </span>
                          <span className="text-muted-foreground tabular-nums shrink-0">
                            {formatAttachmentSize(f.size)}
                          </span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 shrink-0 text-destructive hover:text-destructive"
                            onClick={() => removePendingFile(idx)}
                            disabled={sending}
                            title="Quitar"
                            aria-label={`Quitar ${f.name}`}
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Dialog: nueva conversación */}
      <Dialog open={newDialogOpen} onOpenChange={setNewDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nueva conversación</DialogTitle>
            <DialogDescription>
              Solo puedes mensajear a personas de tus cursos y a los Admin.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nombre, correo o rol…"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <div className="max-h-[50vh] overflow-y-auto -mx-3">
              {contactsLoadError ? (
                <p className="text-sm text-destructive px-3 py-4 text-center">
                  {contactsLoadError}
                </p>
              ) : filteredContacts.length === 0 ? (
                <p className="text-sm text-muted-foreground italic px-3 py-4 text-center">
                  {contactSearch.trim()
                    ? "No hay contactos que coincidan con la búsqueda."
                    : contacts.length === 0
                      ? "No hay contactos disponibles todavía. Si esperas mensajear a alguien de un curso, asegúrate de estar matriculado en al menos un curso compartido. También puedes escribirle a un administrador."
                      : "No hay contactos disponibles."}
                </p>
              ) : (
                <ul className="divide-y">
                  {filteredContacts.map((c) => {
                    const RoleIcon = ROLE_ICON[c.role_label];
                    return (
                      <li key={c.user_id}>
                        <button
                          type="button"
                          onClick={() => void openConversationWith(c.user_id)}
                          className="w-full text-left px-3 py-2 hover:bg-muted/40 transition-colors flex items-center gap-2"
                        >
                          <RoleIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium truncate">
                              {c.full_name ?? c.email ?? "Usuario"}
                            </p>
                            {c.email && (
                              <p className="text-[11px] text-muted-foreground truncate">
                                {c.email}
                              </p>
                            )}
                          </div>
                          <Badge
                            variant="outline"
                            className={cn("text-[9px] px-1 py-0 h-auto", ROLE_BADGE_CLASS[c.role_label])}
                          >
                            {c.role_label}
                          </Badge>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Broadcast a curso (Docente/Admin) ──
          Envía un mensaje a TODOS los estudiantes de un curso. Edge
          function: broadcast-course-message. Crea notificación in-app
          por cada alumno (kind='broadcast', no dispara correo
          automático) y manda UN solo correo con todos en BCC para
          que ninguno vea la lista del resto. */}
      <Dialog
        open={broadcastDialogOpen}
        onOpenChange={(open) => {
          if (!broadcastSending) setBroadcastDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-cyan-500" />
              Enviar a todos los estudiantes
            </DialogTitle>
            <DialogDescription>
              Crea una notificación in-app para cada estudiante del curso y envía un correo con
              todos los alumnos en copia oculta (BCC). Ningún estudiante verá la lista del resto.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <Label className="text-xs">Curso</Label>
              <Select
                value={broadcastCourseId}
                onValueChange={setBroadcastCourseId}
                disabled={broadcastSending || broadcastCourses.length === 0}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      broadcastCourses.length === 0 ? "Cargando cursos…" : "Selecciona un curso"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {broadcastCourses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {typeof c.student_count === "number" && (
                        <span className="ml-2 text-[11px] text-muted-foreground">
                          · {c.student_count} estudiante{c.student_count === 1 ? "" : "s"}
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {broadcastCourses.length === 0 && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  No tienes cursos donde enviar mensajes masivos.
                </p>
              )}
            </div>

            <div>
              <Label className="text-xs">Asunto</Label>
              <Input
                value={broadcastSubject}
                onChange={(e) => setBroadcastSubject(e.target.value)}
                placeholder="Ej. Recordatorio: entrega del taller 2 mañana"
                maxLength={200}
                disabled={broadcastSending}
              />
              <p className="text-[10px] text-muted-foreground text-right mt-0.5">
                {broadcastSubject.length} / 200
              </p>
            </div>

            <div>
              <Label className="text-xs">Mensaje</Label>
              <Textarea
                value={broadcastBody}
                onChange={(e) => setBroadcastBody(e.target.value)}
                placeholder="Escribe el mensaje que recibirán todos los estudiantes del curso…"
                rows={5}
                maxLength={10000}
                disabled={broadcastSending}
              />
              <p className="text-[10px] text-muted-foreground text-right mt-0.5">
                {broadcastBody.length} / 10000
              </p>
            </div>

            <div className="rounded-md border bg-amber-50/40 dark:bg-amber-500/5 border-amber-300/50 p-2 text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-2">
              <Megaphone className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                Los estudiantes <strong>no podrán responder este correo</strong> — es solo un
                anuncio. Si necesitan contactarte, deben usar "Mensajes" → "Nueva conversación".
              </span>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              onClick={() => setBroadcastDialogOpen(false)}
              disabled={broadcastSending}
            >
              Cancelar
            </Button>
            <Button
              onClick={() => void sendBroadcast()}
              disabled={
                broadcastSending ||
                !broadcastCourseId ||
                !broadcastSubject.trim() ||
                !broadcastBody.trim()
              }
            >
              {broadcastSending ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              Enviar a todos
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
