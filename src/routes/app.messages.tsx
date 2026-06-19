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
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { isStaffActive } from "@/shared/lib/roles";
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
  ArrowLeft,
  Hash,
  Hammer,
  FileText,
  FolderKanban,
  Clock,
  CalendarClock,
  AlertTriangle,
  Zap,
} from "lucide-react";
import {
  parseMessageBody,
  tagRoute,
  buildTagToken,
  type ContentTag,
} from "@/modules/messaging/message-tags";
import { MessageTagPicker } from "@/modules/messaging/MessageTagPicker";
import { TagTextarea } from "@/modules/messaging/TagTextarea";
import { DateTimePicker } from "@/components/ui/date-picker";
import {
  validateScheduledSend,
  localToIso,
  SCHEDULED_STATUS_LABEL,
  type ScheduledStatus,
} from "@/modules/messaging/scheduled";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import i18n from "@/i18n";

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
  const { t } = useTranslation();
  const { user } = useAuth();
  const activeRole = useActiveRole();
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
  // Picker para etiquetar contenido (taller/examen/proyecto) dentro del
  // mensaje. Se abre desde el botón # al lado del adjuntar (o escribiendo
  // `#` inline en el chat). El tag
  // queda embebido como token `[[T:type:id:label]]` en el body — el
  // renderer lo parsea y lo muestra como Link clickeable.
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  // Inserta un tag desde el picker (botón #). Lo anexa al final del body;
  // TagTextarea lo renderiza como preview + lo manda en el body. El
  // autocomplete inline `#` lo maneja TagTextarea internamente.
  const insertTag = (tag: ContentTag) => {
    const token = buildTagToken(tag);
    setBody((prev) => (prev.length === 0 ? token + " " : `${prev.trimEnd()} ${token} `));
  };

  const [contactSearch, setContactSearch] = useState("");

  // ── Broadcast a curso (Docente/Admin) ──
  // Solo carga cuando se detecta rol Docente o Admin en mount; el botón
  // y diálogo se ocultan para Estudiantes (no son destinatarios válidos
  // ni autorizados a enviar masivos).
  // Roles POSEÍDOS (query a user_roles). El gate efectivo `isStaff` combina
  // esto con el ROL ACTIVO abajo — un multi-rol actuando como Estudiante no
  // ve difusión/programados aunque posea el rol Docente.
  const [staffRoles, setStaffRoles] = useState<string[]>([]);
  const isStaff = isStaffActive(activeRole, staffRoles);
  const [broadcastDialogOpen, setBroadcastDialogOpen] = useState(false);
  const [broadcastCourses, setBroadcastCourses] = useState<
    // `recipient_count` excluye al creador (autor de la difusión) — la
    // dispatch hace lo mismo (`AND e.user_id <> r.creator_id`). Si el
    // único matriculado es el propio docente, este número es 0 y la
    // difusión no va a llegar a nadie aunque "Programar" digiera success.
    Array<{ id: string; name: string; recipient_count?: number }>
  >([]);
  // Multi-curso: el docente/admin puede difundir a varios cursos a la vez.
  // Los alumnos matriculados en >1 curso seleccionado reciben UNA sola
  // notificación/correo/mensaje (la edge dedup por user_id).
  const [broadcastCourseIds, setBroadcastCourseIds] = useState<string[]>([]);
  const [broadcastSubject, setBroadcastSubject] = useState("");
  const [broadcastBody, setBroadcastBody] = useState("");
  const [broadcastSending, setBroadcastSending] = useState(false);
  // Programación de la difusión: si `broadcastScheduleAt` tiene fecha, el
  // botón pasa a "Programar" (inserta en scheduled_messages) en vez de
  // "Enviar ahora". Formato local YYYY-MM-DDTHH:mm del DateTimePicker.
  const [broadcastScheduleAt, setBroadcastScheduleAt] = useState("");

  // ── Mensajes programados (lista + cancelar + editar) ──
  const [scheduledDialogOpen, setScheduledDialogOpen] = useState(false);
  const [scheduledItems, setScheduledItems] = useState<
    Array<{
      id: string;
      kind: "direct" | "broadcast" | "group";
      subject: string | null;
      body: string;
      send_at: string;
      status: ScheduledStatus;
      error: string | null;
    }>
  >([]);
  const [scheduledLoading, setScheduledLoading] = useState(false);
  // Toggle "Ver historial" — por default mostramos solo PENDING (los
  // únicos accionables). El usuario puede pedir ver enviados / cancelados
  // / fallidos para auditoría.
  const [showScheduledHistory, setShowScheduledHistory] = useState(false);
  // Edit inline: id de la fila en edición + drafts del body y send_at.
  // El send_at se edita con DateTimePicker (mismo formato YYYY-MM-DDTHH:mm).
  const [editingScheduledId, setEditingScheduledId] = useState<string | null>(null);
  const [editDraftBody, setEditDraftBody] = useState("");
  const [editDraftSendAt, setEditDraftSendAt] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  // Programación de un mensaje directo desde el composer del chat.
  const [directScheduleOpen, setDirectScheduleOpen] = useState(false);
  const [directScheduleAt, setDirectScheduleAt] = useState("");

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
          friendlyError(convsRes.error, t("hc_routesAppMessages.couldNotLoadConversations")),
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
          setContactsLoadError(t("hc_routesAppMessages.messagingModuleNotPublished"));
        } else {
          setContactsLoadError(t("hc_routesAppMessages.couldNotLoadContacts", { error: msg }));
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
        // mí" automáticamente — los mensajes con created_at <= mi
        // cleared_at no aparecen.
        const lastReadAt = c.user_a === myUserId ? c.user_a_last_read_at : c.user_b_last_read_at;
        const myClearedAt = c.user_a === myUserId ? c.user_a_cleared_at : c.user_b_cleared_at;
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
        const lastMessage = (lastMsgRow?.[0] as MessageLite | undefined) ?? null;
        // "Borrar para mí": una vez que el usuario clickea Eliminar, el
        // backend setea su `cleared_at`. La RLS de messages oculta los
        // mensajes anteriores, así que la conversación quedaba en la
        // lista con preview vacío — confuso. Filtramos acá: si tengo
        // cleared_at Y no hay mensajes visibles posteriores, oculto la
        // conversación de mi lista por completo. Si el otro usuario me
        // manda un mensaje nuevo, lastMessage tendrá created_at >
        // cleared_at → la conversación "resucita" automáticamente.
        if (myClearedAt && !lastMessage) continue;
        enriched.push({
          conv: c,
          other,
          lastMessage,
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
      const { data } = await db.from("user_roles").select("role").eq("user_id", myUserId);
      const roles = (data ?? []) as Array<{ role: string }>;
      // Guardamos los roles poseídos; `isStaff` se deriva combinándolos con
      // el rol activo (isStaffActive). SuperAdmin también es "staff" para
      // difundir/programar — paridad con la nav y RBAC del resto del producto.
      setStaffRoles(roles.map((r) => r.role));
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
      const { data: roleRows } = await db.from("user_roles").select("role").eq("user_id", myUserId);
      const roles = ((roleRows ?? []) as Array<{ role: string }>).map((r) => r.role);
      const isAdminLocal = roles.includes("Admin");

      // Excluir cursos en PAPELERA (deleted_at): no deben aparecer en el
      // selector de difusión (regla universal soft-delete — un curso en la
      // papelera deja de ser visualizable/usable en CUALQUIER flujo).
      let coursesQuery = db
        .from("courses")
        .select("id, name")
        .is("deleted_at", null)
        .order("name");
      if (!isAdminLocal) {
        // Filtra por cursos donde es teacher.
        const { data: ctRows } = await db
          .from("course_teachers")
          .select("course_id")
          .eq("user_id", myUserId);
        const courseIds = ((ctRows ?? []) as Array<{ course_id: string }>).map((r) => r.course_id);
        if (courseIds.length === 0) {
          setBroadcastCourses([]);
          return;
        }
        coursesQuery = db
          .from("courses")
          .select("id, name")
          .in("id", courseIds)
          .is("deleted_at", null)
          .order("name");
      }
      const { data: coursesData } = await coursesQuery;
      const courses = (coursesData ?? []) as Array<{ id: string; name: string }>;

      // 2) Conteo de DESTINATARIOS reales por curso = matriculados EXCEPTO
      // el creador. Sin el `.neq` el UI mostraba "1 est." en un curso donde
      // el único matriculado era el propio docente — la difusión se "enviaba"
      // pero a 0 destinatarios (la dispatch SQL excluye al creator).
      // Hacemos N queries individuales — N suele ser <20 cursos, vale la
      // pena por simplicidad vs. una RPC dedicada.
      const enriched = await Promise.all(
        courses.map(async (c) => {
          const { count } = await db
            .from("course_enrollments")
            .select("user_id", { count: "exact", head: true })
            .eq("course_id", c.id)
            .neq("user_id", myUserId);
          return { ...c, recipient_count: count ?? 0 };
        }),
      );
      setBroadcastCourses(enriched);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broadcastDialogOpen, myUserId]);

  const toggleBroadcastCourse = (courseId: string) => {
    setBroadcastCourseIds((prev) =>
      prev.includes(courseId) ? prev.filter((id) => id !== courseId) : [...prev, courseId],
    );
  };

  const sendBroadcast = async () => {
    if (broadcastCourseIds.length === 0) {
      toast.error(
        i18n.t("toast.routes_app_messages.selectAtLeastOneCourse", {
          defaultValue: "Selecciona al menos un curso.",
        }),
      );
      return;
    }
    if (!broadcastSubject.trim() || !broadcastBody.trim()) {
      toast.error(
        i18n.t("toast.routes_app_messages.subjectAndMessageRequired", {
          defaultValue: "Asunto y mensaje son obligatorios.",
        }),
      );
      return;
    }
    setBroadcastSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("broadcast-course-message", {
        body: {
          // `courseIds` es el shape nuevo (multi-curso). La edge sigue
          // aceptando `courseId` legacy via normalizeCourseIds.
          courseIds: broadcastCourseIds,
          subject: broadcastSubject.trim(),
          body: broadcastBody.trim(),
        },
      });
      if (error || data?.error) {
        const detail = await extractEdgeError(error, data);
        toast.error(detail || t("hc_routesAppMessages.errorSendingMessage"));
        return;
      }
      const notified = typeof data?.notified === "number" ? data.notified : 0;
      const withEmail =
        typeof data?.recipients_with_email === "number" ? data.recipients_with_email : 0;
      const courseWord = broadcastCourseIds.length === 1 ? "curso" : "cursos";
      if (withEmail > 0) {
        toast.success(
          i18n.t("toast.routes_app_messages.broadcastSentWithEmail", {
            defaultValue:
              "Mensaje enviado a {{notified}} estudiante(s) de {{courseCount}} {{courseWord}}. {{withEmail}} recibirá(n) correo.",
            notified,
            courseCount: broadcastCourseIds.length,
            courseWord,
            withEmail,
          }),
        );
      } else {
        toast.success(
          i18n.t("toast.routes_app_messages.broadcastSentNoEmail", {
            defaultValue:
              "Mensaje enviado a {{notified}} estudiante(s) de {{courseCount}} {{courseWord}}. Solo notificación in-app (sin correos configurados).",
            notified,
            courseCount: broadcastCourseIds.length,
            courseWord,
          }),
        );
      }
      setBroadcastDialogOpen(false);
      setBroadcastCourseIds([]);
      setBroadcastSubject("");
      setBroadcastBody("");
    } catch (e) {
      // El invoke puede rechazar (network, edge crash). Sin catch: rejection
      // huérfana → audit log app.unhandled_rejection.
      toast.error(friendlyError(e, t("hc_routesAppMessages.errorSendingMessage")));
    } finally {
      setBroadcastSending(false);
    }
  };

  // Programa la difusión para más tarde: inserta en scheduled_messages.
  // El cron `dispatch_scheduled_messages` la envía cuando vence.
  const scheduleBroadcast = async () => {
    if (broadcastCourseIds.length === 0) {
      toast.error(
        i18n.t("toast.routes_app_messages.selectAtLeastOneCourse", {
          defaultValue: "Selecciona al menos un curso.",
        }),
      );
      return;
    }
    if (!broadcastSubject.trim() || !broadcastBody.trim()) {
      toast.error(
        i18n.t("toast.routes_app_messages.subjectAndMessageRequired", {
          defaultValue: "Asunto y mensaje son obligatorios.",
        }),
      );
      return;
    }
    const v = validateScheduledSend(broadcastScheduleAt);
    if (!v.ok) {
      toast.error(v.error ?? t("hc_routesAppMessages.invalidDate"));
      return;
    }
    if (!myUserId) return;
    setBroadcastSending(true);
    try {
      const { error } = await db.from("scheduled_messages").insert({
        creator_id: myUserId,
        kind: "broadcast",
        course_ids: broadcastCourseIds,
        subject: broadcastSubject.trim(),
        body: broadcastBody.trim(),
        send_at: localToIso(broadcastScheduleAt),
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(
        i18n.t("toast.routes_app_messages.broadcastScheduled", {
          defaultValue: "Difusión programada para {{when}}.",
          when: formatDateTime(localToIso(broadcastScheduleAt)),
        }),
      );
      setBroadcastDialogOpen(false);
      setBroadcastCourseIds([]);
      setBroadcastSubject("");
      setBroadcastBody("");
      setBroadcastScheduleAt("");
    } catch (e) {
      toast.error(friendlyError(e, t("hc_routesAppMessages.couldNotScheduleBroadcast")));
    } finally {
      setBroadcastSending(false);
    }
  };

  // Programa un mensaje directo (1-a-1) al otro usuario de la conv activa.
  const scheduleDirect = async () => {
    if (!activeConv || !myUserId) return;
    if (!body.trim()) {
      toast.error(
        i18n.t("toast.routes_app_messages.writeAMessage", {
          defaultValue: "Escribe un mensaje.",
        }),
      );
      return;
    }
    const v = validateScheduledSend(directScheduleAt);
    if (!v.ok) {
      toast.error(v.error ?? t("hc_routesAppMessages.invalidDate"));
      return;
    }
    const otherId =
      activeConv.conv.user_a === myUserId ? activeConv.conv.user_b : activeConv.conv.user_a;
    try {
      const { error } = await db.from("scheduled_messages").insert({
        creator_id: myUserId,
        kind: "direct",
        recipient_id: otherId,
        body: body.trim(),
        send_at: localToIso(directScheduleAt),
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(
        i18n.t("toast.routes_app_messages.directScheduled", {
          defaultValue: "Mensaje programado para {{when}}.",
          when: formatDateTime(localToIso(directScheduleAt)),
        }),
      );
      setBody("");
      setDirectScheduleAt("");
      setDirectScheduleOpen(false);
    } catch (e) {
      // Caller `void scheduleDirect()` desde onClick. Cubrimos rejection
      // del insert para no contaminar audit log.
      toast.error(friendlyError(e, t("hc_routesAppMessages.couldNotScheduleMessage")));
    }
  };

  // Carga los mensajes programados del usuario (RLS: solo los suyos).
  // Por default trae SOLO pending (lo accionable). Con
  // `showScheduledHistory=true` también trae sent/cancelled/failed para
  // auditoría. Esto reemplaza el comportamiento anterior que listaba
  // TODO mezclado y dejaba al usuario navegando entre estados ya cerrados.
  const loadScheduled = async () => {
    setScheduledLoading(true);
    let q = db
      .from("scheduled_messages")
      .select("id, kind, subject, body, send_at, status, error")
      .order("send_at", { ascending: true });
    if (!showScheduledHistory) {
      q = q.eq("status", "pending");
    }
    const { data } = await q;
    setScheduledItems((data ?? []) as typeof scheduledItems);
    setScheduledLoading(false);
  };

  // Abre el editor inline para una fila pending. Carga drafts con valores
  // actuales convertidos al formato local YYYY-MM-DDTHH:mm que espera
  // DateTimePicker.
  const beginEditScheduled = (it: (typeof scheduledItems)[number]) => {
    if (it.status !== "pending") {
      toast.error(
        i18n.t("toast.routes_app_messages.onlyPendingEditable", {
          defaultValue: "Solo se pueden editar mensajes pendientes.",
        }),
      );
      return;
    }
    setEditingScheduledId(it.id);
    setEditDraftBody(it.body);
    // ISO → local YYYY-MM-DDTHH:mm. new Date(iso) interpreta UTC y
    // `getFullYear/getMonth/...` retornan local del navegador.
    const d = new Date(it.send_at);
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setEditDraftSendAt(local);
  };

  const cancelEditScheduled = () => {
    setEditingScheduledId(null);
    setEditDraftBody("");
    setEditDraftSendAt("");
  };

  // Guarda body + send_at. Re-valida la fecha (mínimo 1min en futuro).
  // El UPDATE incluye `eq("status", "pending")` como guard contra TOCTOU:
  // si el cron despachó la fila entre que el usuario abrió el editor y
  // guardó, evitamos modificar un mensaje ya enviado (RLS lo permite,
  // pero semánticamente no tiene sentido).
  const saveEditScheduled = async () => {
    if (!editingScheduledId) return;
    if (!editDraftBody.trim()) {
      toast.error(
        i18n.t("toast.routes_app_messages.messageCannotBeEmptyDot", {
          defaultValue: "El mensaje no puede quedar vacío.",
        }),
      );
      return;
    }
    const validation = validateScheduledSend(editDraftSendAt);
    if (!validation.ok) {
      toast.error(validation.error ?? t("hc_routesAppMessages.invalidDate"));
      return;
    }
    setSavingEdit(true);
    try {
      const { error, data } = await db
        .from("scheduled_messages")
        .update({
          body: editDraftBody.trim(),
          send_at: localToIso(editDraftSendAt),
          error: null,
        })
        .eq("id", editingScheduledId)
        .eq("status", "pending")
        .select("id")
        .maybeSingle();
      if (error) {
        toast.error(friendlyError(error, t("hc_routesAppMessages.couldNotSaveChange")));
        return;
      }
      if (!data) {
        // No row → status cambió mientras tanto (cron lo dispatchó o user
        // lo canceló desde otro tab). Informamos sin mostrar como error.
        toast.info(
          i18n.t("toast.routes_app_messages.messageNoLongerPending", {
            defaultValue: "El mensaje ya no está pendiente; refrescamos la lista.",
          }),
        );
      } else {
        toast.success(
          i18n.t("toast.routes_app_messages.changesSaved", {
            defaultValue: "Cambios guardados.",
          }),
        );
      }
      cancelEditScheduled();
      void loadScheduled();
    } catch (e) {
      // `await db.from().update()...` puede rechazar (network, sesión
      // expirada). Sin catch, el caller `() => void saveEditScheduled()`
      // produce unhandled rejection → audit log.
      toast.error(friendlyError(e, t("hc_routesAppMessages.couldNotSaveChange")));
    } finally {
      setSavingEdit(false);
    }
  };

  const cancelScheduled = async (id: string) => {
    // try/catch defensivo. Caller: `() => void cancelScheduled(it.id)`
    // desde onClick. Sin esto, una rejection del update (network,
    // sesión expirada) burbujea al handler global de unhandled rejection.
    try {
      const { error } = await db
        .from("scheduled_messages")
        .update({ status: "cancelled" })
        .eq("id", id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(
        i18n.t("toast.routes_app_messages.scheduleCancelled", {
          defaultValue: "Programación cancelada.",
        }),
      );
      void loadScheduled();
    } catch (e) {
      toast.error(friendlyError(e, t("hc_routesAppMessages.couldNotCancel")));
    }
  };

  // Fuerza dispatch inmediato. Útil cuando el cron está atrasado o
  // pausado y el usuario quiere despachar manualmente. El RPC
  // `request_dispatch_scheduled_messages` corre `dispatch_scheduled_messages()`
  // ya re-validando autorización por fila — el caller no puede enviar
  // mensajes que no le pertenecen.
  const [forcingDispatch, setForcingDispatch] = useState(false);
  const forceDispatchNow = async () => {
    if (forcingDispatch) return;
    setForcingDispatch(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("request_dispatch_scheduled_messages");
      if (error) {
        toast.error(friendlyError(error, t("hc_routesAppMessages.couldNotProcessQueue")));
        return;
      }
      const n = Number(data ?? 0);
      if (n === 0) {
        toast.info(
          i18n.t("toast.routes_app_messages.noDueMessages", {
            defaultValue: "No había mensajes vencidos para procesar.",
          }),
        );
      } else {
        toast.success(
          i18n.t("toast.routes_app_messages.messagesDispatched", {
            defaultValue: `${n} mensaje${n === 1 ? "" : "s"} despachado${n === 1 ? "" : "s"}.`,
            count: n,
          }),
        );
      }
      void loadScheduled();
    } catch (e) {
      // El RPC puede rechazar con throw (función removida, JWT expirado,
      // network). Sin catch: rejection huérfana → audit log.
      toast.error(friendlyError(e, t("hc_routesAppMessages.couldNotProcessQueue")));
    } finally {
      setForcingDispatch(false);
    }
  };

  useEffect(() => {
    if (scheduledDialogOpen) void loadScheduled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduledDialogOpen]);

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
              // `.then(noop, noop)` fuerza el builder lazy de supabase-js
              // (ver kahoot heartbeat). Fire-and-forget intencional.
              db.rpc("mark_conversation_read", { _conv_id: activeConvId }).then(
                () => {},
                () => {},
              );
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
    const { data: msgs } = await db.from("messages").select("id").eq("conversation_id", convId);
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
        toast.error(
          i18n.t("toast.routes_app_messages.fileValidationError", {
            defaultValue: "{{fileName}}: {{error}}",
            fileName: f.name,
            error: err,
          }),
        );
        continue;
      }
      next.push(f);
    }
    setPendingFiles((prev) => {
      const merged = [...prev, ...next];
      if (merged.length > MESSAGE_ATTACHMENT_MAX_COUNT) {
        toast.error(
          i18n.t("toast.routes_app_messages.maxAttachmentsPerMessage", {
            defaultValue: "Máximo {{max}} archivos por mensaje.",
            max: MESSAGE_ATTACHMENT_MAX_COUNT,
          }),
        );
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
        toast.error(
          i18n.t("toast.routes_app_messages.attachmentUploadFailed", {
            defaultValue: "No se pudo subir {{name}}: {{error}}",
            name: safe,
            error: friendlyError(up.error),
          }),
        );
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
        toast.error(
          i18n.t("toast.routes_app_messages.attachmentRegisterFailed", {
            defaultValue: "No se pudo registrar {{name}}: {{error}}",
            name: safe,
            error: friendlyError(error, "desconocido"),
          }),
        );
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
    const text = hasBody ? body.trim() : t("hc_routesAppMessages.attachmentsPlaceholder");
    setSending(true);
    try {
      const { data, error } = await db
        .from("messages")
        .insert({ conversation_id: activeConvId, sender_id: myUserId, body: text })
        .select("*")
        .single();
      if (error || !data) {
        toast.error(friendlyError(error, t("hc_routesAppMessages.couldNotSendMessage")));
        return;
      }
      const inserted = data as MessageLite;
      // Subir adjuntos antes del append para que el bubble pinte ya con
      // los archivos en su lugar.
      const newAtts = await uploadPendingFiles(inserted.id);
      setMessages((prev) => (prev.some((m) => m.id === inserted.id) ? prev : [...prev, inserted]));
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
      toast.error(
        i18n.t("toast.routes_app_messages.cannotEditAlreadyRead", {
          defaultValue: "Ya no puedes editar este mensaje: el otro usuario lo leyó.",
        }),
      );
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
      toast.error(
        i18n.t("toast.routes_app_messages.messageCannotBeEmpty", {
          defaultValue: "El mensaje no puede estar vacío",
        }),
      );
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
        toast.error(friendlyError(error, t("hc_routesAppMessages.couldNotEditMessage")));
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
      toast.error(
        i18n.t("toast.routes_app_messages.cannotDeleteAlreadyRead", {
          defaultValue: "Ya no puedes eliminar este mensaje: el otro usuario lo leyó.",
        }),
      );
      return;
    }
    const ok = await confirm({
      title: t("hc_routesAppMessages.deleteMessageTitle"),
      description: t("hc_routesAppMessages.deleteMessageDescription"),
      confirmLabel: t("hc_routesAppMessages.delete"),
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
      toast.error(
        i18n.t("toast.routes_app_messages.noneEligibleToDelete", {
          defaultValue: "Ninguno de los mensajes seleccionados es elegible para eliminar.",
        }),
      );
      return;
    }
    const ok = await confirm({
      title: t("hc_routesAppMessages.bulkDeleteMessagesTitle", { count: eligible.length }),
      description: t("hc_routesAppMessages.bulkDeleteMessagesDescription", {
        count: eligible.length,
      }),
      confirmLabel: t("hc_routesAppMessages.delete"),
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
          ? i18n.t("toast.routes_app_messages.bulkDeletedWithSkipped", {
              defaultValue: "{{deleted}} eliminado(s) · {{skipped}} omitido(s) (ya leídos por el otro)",
              deleted: eligible.length,
              skipped,
            })
          : i18n.t("toast.routes_app_messages.bulkDeleted", {
              defaultValue: "{{deleted}} mensaje(s) eliminado(s)",
              deleted: eligible.length,
            }),
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
      toast.error(friendlyError(error, t("hc_routesAppMessages.couldNotOpenConversation")));
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
      toast.error(friendlyError(error, t("hc_routesAppMessages.couldNotMarkRead")));
      return false;
    }
    return true;
  };

  const markConvUnread = async (convId: string) => {
    const { error } = await db.rpc("mark_conversation_unread", { _conv_id: convId });
    if (error) {
      toast.error(friendlyError(error, t("hc_routesAppMessages.couldNotMarkUnread")));
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
    toast.success(
      i18n.t("toast.routes_app_messages.markedSelectedRead", {
        defaultValue: `${ids.length} conversación${ids.length === 1 ? "" : "es"} marcada${ids.length === 1 ? "" : "s"} como leída${ids.length === 1 ? "" : "s"}`,
        count: ids.length,
      }),
    );
  };

  const markSelectedUnread = async () => {
    const ids = Array.from(selectedConvIds);
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => markConvUnread(id)));
    clearConvSelection();
    await loadAll();
    toast.success(
      i18n.t("toast.routes_app_messages.markedSelectedUnread", {
        defaultValue: `${ids.length} conversación${ids.length === 1 ? "" : "es"} marcada${ids.length === 1 ? "" : "s"} como no leída${ids.length === 1 ? "" : "s"}`,
        count: ids.length,
      }),
    );
  };

  const clearSelectedConversations = async () => {
    const ids = Array.from(selectedConvIds);
    if (ids.length === 0) return;
    const ok = await confirm({
      title: t("hc_routesAppMessages.deleteConversationsTitle", { count: ids.length }),
      description: t("hc_routesAppMessages.deleteConversationsDescription"),
      confirmLabel: t("hc_routesAppMessages.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    await Promise.all(ids.map((id) => db.rpc("clear_conversation", { _conv_id: id })));
    if (activeConvId && ids.includes(activeConvId)) setActiveConvId(null);
    clearConvSelection();
    await loadAll();
    toast.success(
      i18n.t("toast.routes_app_messages.clearedSelectedConversations", {
        defaultValue: `${ids.length} conversación${ids.length === 1 ? "" : "es"} eliminada${ids.length === 1 ? "" : "s"} para ti`,
        count: ids.length,
      }),
    );
  };

  const clearConversation = async (convId: string) => {
    const ok = await confirm({
      title: t("hc_routesAppMessages.deleteConversationTitle"),
      description: t("hc_routesAppMessages.deleteConversationDescription"),
      confirmLabel: t("hc_routesAppMessages.delete"),
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
    toast.success(
      i18n.t("toast.routes_app_messages.conversationCleared", {
        defaultValue: "Conversación eliminada para ti",
      }),
    );
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
        title={t("hc_routesAppMessages.pageTitle")}
        actions={
          <>
            {isStaff && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setScheduledDialogOpen(true)}
                  title={t("hc_routesAppMessages.scheduledButtonTooltip")}
                >
                  <CalendarClock className="h-4 w-4 mr-1" />
                  <span className="hidden sm:inline">{t("hc_routesAppMessages.scheduled")}</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBroadcastDialogOpen(true)}
                  title={t("hc_routesAppMessages.broadcastButtonTooltip")}
                  data-tour-id="broadcast-messages"
                >
                  <Megaphone className="h-4 w-4 mr-1" />
                  <span className="hidden sm:inline">
                    {t("hc_routesAppMessages.sendToAllStudents")}
                  </span>
                  <span className="sm:hidden">{t("hc_routesAppMessages.broadcast")}</span>
                </Button>
              </>
            )}
            <Button size="sm" onClick={() => setNewDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">{t("hc_routesAppMessages.newConversation")}</span>
              <span className="sm:hidden">{t("hc_routesAppMessages.newShort")}</span>
            </Button>
          </>
        }
      />

      <Card>
        <CardContent className="p-0 grid grid-cols-1 md:grid-cols-[280px_1fr] min-h-[60dvh]">
          {/* Lista de conversaciones — en mobile se oculta cuando hay
              conv activa (single-pane navigation tipo iMessage). En md+
              siempre visible. */}
          <div
            className={cn(
              "border-r min-h-[60dvh] max-h-[75dvh] overflow-y-auto md:block",
              activeConvId ? "hidden" : "block",
            )}
          >
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
                <Spinner size="sm" /> {t("hc_routesAppMessages.loading")}
              </div>
            ) : conversationsLoadError ? (
              <ErrorState
                message={t("hc_routesAppMessages.couldNotLoadConversationsTitle")}
                hint={conversationsLoadError}
                onRetry={() => void loadAll()}
              />
            ) : conversations.length === 0 ? (
              <EmptyState
                title={t("hc_routesAppMessages.noConversationsTitle")}
                description={t("hc_routesAppMessages.noConversationsDescription")}
              />
            ) : (
              <>
                {/* Toolbar bulk: visible cuando hay selección */}
                {selectedConvIds.size > 0 && (
                  <div className="sticky top-0 z-10 flex items-center gap-1 border-b bg-background/95 px-2 py-1.5 backdrop-blur">
                    <span className="text-xs font-medium mr-1">
                      {t("hc_routesAppMessages.conversationsSelected", {
                        count: selectedConvIds.size,
                      })}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => void markSelectedRead()}
                      title={t("hc_routesAppMessages.markAsRead")}
                    >
                      <MailOpen className="h-3.5 w-3.5 mr-1" />
                      <span className="text-xs">{t("hc_routesAppMessages.readPlural")}</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => void markSelectedUnread()}
                      title={t("hc_routesAppMessages.markAsUnread")}
                    >
                      <Mail className="h-3.5 w-3.5 mr-1" />
                      <span className="text-xs">{t("hc_routesAppMessages.unreadPlural")}</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                      onClick={() => void clearSelectedConversations()}
                      title={t("hc_routesAppMessages.deleteSelectedConversationsTooltip")}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      <span className="text-xs">{t("hc_routesAppMessages.delete")}</span>
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 ml-auto"
                      onClick={clearConvSelection}
                      title={t("hc_routesAppMessages.cancelSelection")}
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
                            // pr-10 reserva espacio para el kebab absoluto
                            // (right-1 + w-7 ~ 36px) y que la fila de badges
                            // no se solape con el botón.
                            "w-full text-left pl-3 pr-10 py-2.5 hover:bg-muted/40 transition-colors",
                            isActive &&
                              !inSelectionMode &&
                              "bg-primary/5 border-l-2 border-primary",
                            isSelected && "bg-primary/10",
                          )}
                        >
                          <div className="flex items-center gap-2 mb-1 min-w-0">
                            {/* Checkbox: en modo selección reemplaza el ícono
                                de rol; sino aparece en hover para iniciar
                                selección. */}
                            {/* Checkbox + ícono de rol: en mobile, NO hay
                                hover, así que NO ocultamos el ícono de rol
                                ni mostramos el checkbox por hover. En su lugar
                                damos un long-press / tap explícito desde el
                                kebab para entrar en modo selección.
                                En md+ usamos hover para no recargar la lista
                                con dos columnas visibles. */}
                            {inSelectionMode ? (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleConvSelected(c.conv.id);
                                }}
                                className="shrink-0 flex items-center justify-center w-4 h-4 rounded"
                                aria-label={
                                  isSelected
                                    ? t("hc_routesAppMessages.deselect")
                                    : t("hc_routesAppMessages.select")
                                }
                              >
                                {isSelected ? (
                                  <CheckSquare className="h-4 w-4 text-primary" />
                                ) : (
                                  <Square className="h-4 w-4 text-muted-foreground" />
                                )}
                              </button>
                            ) : (
                              <>
                                {/* mobile: ícono rol siempre visible.
                                    desktop: checkbox aparece en hover. */}
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleConvSelected(c.conv.id);
                                  }}
                                  className="hidden md:group-hover:flex md:focus-visible:flex shrink-0 items-center justify-center w-4 h-4 rounded"
                                  aria-label={t("hc_routesAppMessages.select")}
                                >
                                  <Square className="h-4 w-4 text-muted-foreground" />
                                </button>
                                <RoleIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0 md:group-hover:hidden" />
                              </>
                            )}
                            <span className="font-medium text-sm truncate flex-1">
                              {c.other.full_name ?? c.other.email ?? t("hc_routesAppMessages.user")}
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
                              <span className="italic">
                                {t("hc_routesAppMessages.noVisibleMessages")}
                              </span>
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
                                className="absolute right-1 top-2 h-8 w-8 p-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100"
                                onClick={(e) => e.stopPropagation()}
                                aria-label={t("hc_routesAppMessages.conversationActions")}
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-52">
                              {c.unread > 0 ? (
                                <DropdownMenuItem
                                  onClick={async () => {
                                    if (await markConvRead(c.conv.id)) await loadAll();
                                  }}
                                >
                                  <MailOpen className="h-4 w-4 mr-2" />
                                  {t("hc_routesAppMessages.markAsReadSingular")}
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onClick={async () => {
                                    if (await markConvUnread(c.conv.id)) await loadAll();
                                  }}
                                >
                                  <Mail className="h-4 w-4 mr-2" />
                                  {t("hc_routesAppMessages.markAsUnreadSingular")}
                                </DropdownMenuItem>
                              )}
                              {/* Entrar al modo selección. Disparador
                                  principal en mobile (no hay hover) — desktop
                                  también puede usarlo. */}
                              <DropdownMenuItem onClick={() => toggleConvSelected(c.conv.id)}>
                                <CheckSquare className="h-4 w-4 mr-2" />
                                {t("hc_routesAppMessages.select")}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => void clearConversation(c.conv.id)}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                {t("hc_routesAppMessages.delete")}
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

          {/* Panel de chat — en mobile se oculta cuando NO hay conv
              activa. En md+ siempre visible. */}
          <div
            className={cn(
              "flex-col min-h-[60dvh] max-h-[75dvh] md:flex",
              activeConvId ? "flex" : "hidden",
            )}
          >
            {!activeConv ? (
              <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
                {t("hc_routesAppMessages.selectOrStartConversation")}
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="flex items-center justify-between gap-2 px-3 sm:px-4 py-2.5 border-b">
                  {/* Back button: solo mobile — vuelve a la lista
                      cerrando activeConvId. En md+ no se necesita
                      porque la lista está siempre visible. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="md:hidden shrink-0 h-8 w-8 p-0"
                    onClick={() => setActiveConvId(null)}
                    aria-label={t("hc_routesAppMessages.backToList")}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm truncate flex items-center gap-1.5">
                      {(() => {
                        const RI = ROLE_ICON[activeConv.other.role_label];
                        return <RI className="h-3.5 w-3.5 text-muted-foreground" />;
                      })()}
                      {activeConv.other.full_name ??
                        activeConv.other.email ??
                        t("hc_routesAppMessages.user")}
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[9px] px-1 py-0 h-auto",
                          ROLE_BADGE_CLASS[activeConv.other.role_label],
                        )}
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
                      title={
                        selectMode
                          ? t("hc_routesAppMessages.exitSelection")
                          : t("hc_routesAppMessages.selectMessages")
                      }
                      aria-pressed={selectMode}
                    >
                      <CheckSquare className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive shrink-0"
                      onClick={() => void clearConversation(activeConv.conv.id)}
                      title={t("hc_routesAppMessages.deleteConversationOnlyMe")}
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
                      {t("hc_routesAppMessages.messagesSelected", {
                        count: selectedMessageIds.size,
                      })}
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
                        {t("hc_routesAppMessages.cancel")}
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
                        {t("hc_routesAppMessages.delete")}
                      </Button>
                    </div>
                  </div>
                )}

                {/* Búsqueda local */}
                <div className="px-3 py-2 border-b">
                  <div className="relative">
                    <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder={t("hc_routesAppMessages.searchInConversation")}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-7 h-8 text-xs"
                      aria-label={t("hc_routesAppMessages.searchInConversationAria")}
                    />
                  </div>
                </div>

                {/* Mensajes */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
                  {loadingMessages ? (
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <Spinner size="sm" /> {t("hc_routesAppMessages.loadingMessages")}
                    </div>
                  ) : visibleMessages.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic text-center py-8">
                      {searchQuery.trim()
                        ? t("hc_routesAppMessages.noSearchMatches")
                        : t("hc_routesAppMessages.noMessagesYet")}
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
                                    isSelected
                                      ? t("hc_routesAppMessages.deselectMessage")
                                      : t("hc_routesAppMessages.selectMessage")
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
                                        <X className="h-3 w-3 mr-1" /> {t("hc_routesAppMessages.cancel")}
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
                                        {t("hc_routesAppMessages.save")}
                                      </Button>
                                    </div>
                                  </div>
                                ) : (
                                  <>
                                    <p className="whitespace-pre-wrap break-words">
                                      {/* Si hay tags embebidos, los
                                          renderizamos como Link (chip
                                          clickeable con icon). Si no,
                                          fallback al render plano
                                          (incluye highlight de search
                                          si aplica). El parser maneja
                                          el caso mixto: texto + tag +
                                          texto + tag, etc. */}
                                      {parseMessageBody(m.body).map((seg, i) => {
                                        if (seg.kind === "tag") {
                                          const TagIcon =
                                            seg.tag.type === "workshop"
                                              ? Hammer
                                              : seg.tag.type === "exam"
                                                ? FileText
                                                : seg.tag.type === "project"
                                                  ? FolderKanban
                                                  : Hash;
                                          const role: "student" | "teacher" = isStaff
                                            ? "teacher"
                                            : "student";
                                          return (
                                            <Link
                                              key={i}
                                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                              to={tagRoute(seg.tag, role) as any}
                                              className={cn(
                                                "inline-flex items-center gap-1 rounded px-1.5 py-0.5 mx-0.5 text-xs font-medium border align-middle",
                                                mine
                                                  ? "bg-primary-foreground/15 border-primary-foreground/30 text-primary-foreground hover:bg-primary-foreground/25"
                                                  : "bg-primary/10 border-primary/30 text-primary hover:bg-primary/20",
                                              )}
                                              title={t("hc_routesAppMessages.openModuleTitle", {
                                                label: seg.tag.label,
                                              })}
                                            >
                                              <TagIcon className="h-3 w-3 shrink-0" />
                                              <span className="truncate max-w-[180px]">
                                                {seg.tag.label}
                                              </span>
                                            </Link>
                                          );
                                        }
                                        // Segment de texto: aplicamos
                                        // highlight de search si está activo.
                                        if (!searchQuery.trim()) {
                                          return <span key={i}>{seg.text}</span>;
                                        }
                                        return splitByMatch(seg.text, searchQuery).map((s, j) =>
                                          s.isMatch ? (
                                            <mark
                                              key={`${i}-${j}`}
                                              className={cn(
                                                "rounded px-0.5",
                                                mine
                                                  ? "bg-primary-foreground text-primary"
                                                  : "bg-yellow-200 text-foreground dark:bg-yellow-500/40",
                                              )}
                                            >
                                              {s.text}
                                            </mark>
                                          ) : (
                                            <span key={`${i}-${j}`}>{s.text}</span>
                                          ),
                                        );
                                      })}
                                    </p>
                                    {atts.length > 0 && (
                                      <MessageAttachments attachments={atts} inverted={mine} />
                                    )}
                                    <div className="flex items-center justify-between gap-2 mt-0.5">
                                      <p
                                        className={cn(
                                          "text-[9px] tabular-nums flex items-center gap-1",
                                          mine
                                            ? "text-primary-foreground/70"
                                            : "text-muted-foreground",
                                        )}
                                      >
                                        <span>
                                          {formatMessageTime(m.created_at)}
                                          {m.edited_at ? t("hc_routesAppMessages.editedSuffix") : ""}
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
                                            title={
                                              isReadByOther
                                                ? t("hc_routesAppMessages.read")
                                                : t("hc_routesAppMessages.sent")
                                            }
                                            aria-label={
                                              isReadByOther
                                                ? t("hc_routesAppMessages.read")
                                                : t("hc_routesAppMessages.sent")
                                            }
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
                                            title={t("hc_routesAppMessages.editMessage")}
                                            aria-label={t("hc_routesAppMessages.editMessageAria", {
                                              id: m.id,
                                            })}
                                          >
                                            <Pencil className="h-3 w-3" />
                                          </Button>
                                          <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon"
                                            className="h-5 w-5 text-primary-foreground hover:text-primary-foreground"
                                            onClick={() => void deleteMessage(m)}
                                            title={t("hc_routesAppMessages.deleteMessage")}
                                            aria-label={t("hc_routesAppMessages.deleteMessageAria", {
                                              id: m.id,
                                            })}
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

                {/* Composer + adjuntos.
                    Layout estilo Discord/Slack: textarea full-width arriba
                    y una toolbar abajo con los secundarios (#, 📎, 🕐) a la
                    izquierda + Send a la derecha. Antes los 4 botones
                    estaban stackeados verticalmente al lado del textarea
                    (flex-col), lo que ocupaba 4 filas de alto y dejaba
                    el chat en una columna apretada. Este layout corre
                    bien en mobile (los íconos no compiten con el textarea
                    por el ancho horizontal) y desktop por igual. */}
                <div className="border-t p-2 space-y-1.5">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => addFiles(e.target.files)}
                    aria-label={t("hc_routesAppMessages.attachFiles")}
                    data-testid="message-file-input"
                  />
                  {/* TagTextarea: textarea con autocomplete `#` para
                      etiquetar contenido + preview de tags. Ctrl/Cmd+
                      Enter envía. Placeholder explícito + tip debajo
                      cuando el body está vacío para que el usuario
                      descubra el mecanismo de etiquetado. */}
                  <TagTextarea
                    value={body}
                    onChange={setBody}
                    onSubmit={() => void send()}
                    placeholder={t("hc_routesAppMessages.composerPlaceholder")}
                    rows={2}
                    className="text-sm min-h-[2.5rem] resize-none"
                  />
                  {/* Tip de etiquetado — visible solo cuando el textarea
                      está vacío, así no satura cuando el usuario ya
                      escribió. Da un ejemplo concreto en línea para
                      reducir fricción de descubrimiento. */}
                  {!body.trim() && (
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1 px-0.5">
                      <Hash className="h-3 w-3 shrink-0" />
                      {t("hc_routesAppMessages.tagTipBefore")}{" "}
                      <code className="rounded bg-muted px-1">#</code>{" "}
                      {t("hc_routesAppMessages.tagTipMiddle")}{" "}
                      <code className="rounded bg-muted px-1">#VetCare</code>
                      {t("hc_routesAppMessages.tagTipAfter")}
                    </p>
                  )}
                  <div className="flex items-center gap-1">
                    {/* Etiquetar contenido: abre el picker con tabs por
                        tipo (taller/examen/proyecto). Alternativa al
                        trigger inline `#`. */}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 shrink-0"
                      onClick={() => setTagPickerOpen(true)}
                      disabled={sending}
                      title={t("hc_routesAppMessages.tagContentTooltip")}
                      aria-label={t("hc_routesAppMessages.tagContent")}
                    >
                      <Hash className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 p-0 shrink-0"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={sending || pendingFiles.length >= MESSAGE_ATTACHMENT_MAX_COUNT}
                      title={t("hc_routesAppMessages.attachFiles")}
                      aria-label={t("hc_routesAppMessages.attachFiles")}
                    >
                      <Paperclip className="h-4 w-4" />
                    </Button>
                    {/* Programar mensaje (solo staff): abre una fila con
                        DateTimePicker para enviar el mensaje más tarde.
                        Cuando el panel está abierto el botón se resalta
                        (variant secondary) para indicar el estado. */}
                    {isStaff && (
                      <Button
                        type="button"
                        size="sm"
                        variant={directScheduleOpen ? "secondary" : "ghost"}
                        className="h-8 w-8 p-0 shrink-0"
                        onClick={() => setDirectScheduleOpen((v) => !v)}
                        disabled={sending}
                        title={t("hc_routesAppMessages.scheduleMessageTooltip")}
                        aria-label={t("hc_routesAppMessages.scheduleMessage")}
                      >
                        <Clock className="h-4 w-4" />
                      </Button>
                    )}
                    {/* Indicador de adjuntos pendientes — visible en la
                        misma toolbar para ahorrar vertical. */}
                    {pendingFiles.length > 0 && (
                      <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums">
                        <Paperclip className="h-3 w-3" />
                        {pendingFiles.length}/{MESSAGE_ATTACHMENT_MAX_COUNT}
                      </span>
                    )}
                    {/* Spacer empuja Send a la derecha. */}
                    <div className="flex-1" />
                    <Button
                      onClick={() => void send()}
                      disabled={(!body.trim() && pendingFiles.length === 0) || sending}
                      className="h-8 gap-1 shrink-0"
                      size="sm"
                    >
                      {sending ? <Spinner size="xs" /> : <Send className="h-3.5 w-3.5" />}
                      <span className="hidden sm:inline">{t("hc_routesAppMessages.send")}</span>
                    </Button>
                  </div>
                  {/* Fila de programación del mensaje directo. */}
                  {isStaff && directScheduleOpen && (
                    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
                      <CalendarClock className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-xs text-muted-foreground">
                        {t("hc_routesAppMessages.sendOn")}
                      </span>
                      <div className="flex-1 min-w-[180px]">
                        <DateTimePicker value={directScheduleAt} onChange={setDirectScheduleAt} />
                      </div>
                      <Button
                        size="sm"
                        onClick={() => void scheduleDirect()}
                        disabled={!directScheduleAt || !body.trim()}
                      >
                        <CalendarClock className="h-3.5 w-3.5 mr-1" />
                        {t("hc_routesAppMessages.schedule")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDirectScheduleOpen(false);
                          setDirectScheduleAt("");
                        }}
                      >
                        {t("hc_routesAppMessages.cancel")}
                      </Button>
                    </div>
                  )}
                  {pendingFiles.length > 0 && (
                    <ul className="space-y-1" data-testid="message-pending-files">
                      {pendingFiles.map((f, idx) => (
                        <li
                          key={`${f.name}-${idx}`}
                          className="flex items-center gap-2 rounded border bg-muted/30 px-2 py-1 text-[11px] min-w-0"
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
                            title={t("hc_routesAppMessages.remove")}
                            aria-label={t("hc_routesAppMessages.removeFileAria", { name: f.name })}
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
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("hc_routesAppMessages.newConversation")}</DialogTitle>
            <DialogDescription>
              {t("hc_routesAppMessages.newConversationDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("hc_routesAppMessages.searchByNameEmailRole")}
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                className="pl-8"
              />
            </div>
            <div className="max-h-[50dvh] overflow-y-auto -mx-3">
              {contactsLoadError ? (
                <p className="text-sm text-destructive px-3 py-4 text-center">
                  {contactsLoadError}
                </p>
              ) : filteredContacts.length === 0 ? (
                <p className="text-sm text-muted-foreground italic px-3 py-4 text-center">
                  {contactSearch.trim()
                    ? t("hc_routesAppMessages.noMatchingContacts")
                    : contacts.length === 0
                      ? t("hc_routesAppMessages.noContactsYet")
                      : t("hc_routesAppMessages.noContactsAvailable")}
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
                              {c.full_name ?? c.email ?? t("hc_routesAppMessages.user")}
                            </p>
                            {c.email && (
                              <p className="text-[11px] text-muted-foreground truncate">
                                {c.email}
                              </p>
                            )}
                          </div>
                          <Badge
                            variant="outline"
                            className={cn(
                              "text-[9px] px-1 py-0 h-auto",
                              ROLE_BADGE_CLASS[c.role_label],
                            )}
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
          por cada alumno (kind='broadcast'), que dispara correo por
          destinatario (camino estándar send-email, respeta preferencias)
          y replica el mensaje en la conversación 1-a-1 de cada alumno
          (/app/messages). */}
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
              {t("hc_routesAppMessages.sendToAllStudents")}
            </DialogTitle>
            <DialogDescription>
              {t("hc_routesAppMessages.broadcastDialogDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <div className="flex items-center justify-between">
                <Label className="text-xs">{t("hc_routesAppMessages.courses")}</Label>
                {broadcastCourses.length > 0 && (
                  <button
                    type="button"
                    className="text-[11px] text-primary hover:underline disabled:opacity-50"
                    disabled={broadcastSending}
                    onClick={() =>
                      setBroadcastCourseIds(
                        broadcastCourseIds.length === broadcastCourses.length
                          ? []
                          : broadcastCourses.map((c) => c.id),
                      )
                    }
                  >
                    {broadcastCourseIds.length === broadcastCourses.length
                      ? t("hc_routesAppMessages.clear")
                      : t("hc_routesAppMessages.selectAll")}
                  </button>
                )}
              </div>
              {broadcastCourses.length === 0 ? (
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("hc_routesAppMessages.noCoursesForBroadcast")}
                </p>
              ) : (
                <div className="mt-1 max-h-44 overflow-y-auto rounded-md border divide-y">
                  {broadcastCourses.map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40 cursor-pointer text-sm min-w-0"
                    >
                      <Checkbox
                        checked={broadcastCourseIds.includes(c.id)}
                        onCheckedChange={() => toggleBroadcastCourse(c.id)}
                        disabled={broadcastSending}
                      />
                      <span className="flex-1 truncate">{c.name}</span>
                      {typeof c.recipient_count === "number" && (
                        <span
                          className={`text-[11px] shrink-0 ${
                            c.recipient_count === 0
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-muted-foreground"
                          }`}
                          title={
                            c.recipient_count === 0
                              ? t("hc_routesAppMessages.recipientZeroHint", {
                                  defaultValue:
                                    "No hay destinatarios reales (solo vos estás matriculado).",
                                })
                              : undefined
                          }
                        >
                          {t("hc_routesAppMessages.recipientCountShort", {
                            count: c.recipient_count,
                            defaultValue: "{{count}} dest.",
                          })}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              )}
              {broadcastCourseIds.length > 0 && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("hc_routesAppMessages.coursesSelectedHint", {
                    count: broadcastCourseIds.length,
                  })}
                </p>
              )}
              {/* Warning explícito: total de destinatarios = 0 (sum-without-
                  dedup, suficiente para detectar el caso "no llega a nadie").
                  Aparece cuando hay cursos seleccionados pero ninguno tiene
                  destinatarios reales. */}
              {broadcastCourseIds.length > 0 &&
                (() => {
                  const totalRecipients = broadcastCourses
                    .filter((c) => broadcastCourseIds.includes(c.id))
                    .reduce((acc, c) => acc + (c.recipient_count ?? 0), 0);
                  if (totalRecipients > 0) return null;
                  return (
                    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-100">
                      {t("hc_routesAppMessages.broadcastNoRecipients", {
                        defaultValue:
                          "Esta difusión no tiene destinatarios: los cursos seleccionados no tienen alumnos matriculados (excluyendo a vos como autor).",
                      })}
                    </div>
                  );
                })()}
            </div>

            <div>
              <Label className="text-xs">{t("hc_routesAppMessages.subject")}</Label>
              <Input
                value={broadcastSubject}
                onChange={(e) => setBroadcastSubject(e.target.value)}
                placeholder={t("hc_routesAppMessages.subjectPlaceholder")}
                maxLength={200}
                disabled={broadcastSending}
              />
              <p className="text-[10px] text-muted-foreground text-right mt-0.5">
                {broadcastSubject.length} / 200
              </p>
            </div>

            <div>
              <Label className="text-xs">{t("hc_routesAppMessages.message")}</Label>
              {/* TagTextarea: permite etiquetar contenido (#) también en
                  difusión. Los tags se replican como chips en el mensaje
                  de /app/messages; en la notif/correo se humanizan a
                  `#label` (edge → humanizeTags). */}
              <TagTextarea
                value={broadcastBody}
                onChange={setBroadcastBody}
                placeholder={t("hc_routesAppMessages.broadcastBodyPlaceholder")}
                rows={5}
                maxLength={10000}
                disabled={broadcastSending}
              />
              <p className="text-[10px] text-muted-foreground text-right mt-0.5">
                {broadcastBody.length} / 10000
              </p>
            </div>

            {/* Programar (opcional): si se elige fecha futura, el botón
                pasa a "Programar" e inserta en scheduled_messages; el cron
                la envía cuando vence. Vacío = enviar ahora. */}
            <div>
              <Label className="text-xs flex items-center gap-1.5">
                <CalendarClock className="h-3.5 w-3.5" />
                {t("hc_routesAppMessages.scheduleSendOptional")}
              </Label>
              <DateTimePicker
                value={broadcastScheduleAt}
                onChange={setBroadcastScheduleAt}
                disabled={broadcastSending}
              />
              {broadcastScheduleAt && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("hc_routesAppMessages.willBeSentAutomatically", {
                    when: formatDateTime(localToIso(broadcastScheduleAt)),
                  })}
                </p>
              )}
            </div>

            <div className="rounded-md border bg-amber-50/40 dark:bg-amber-500/5 border-amber-300/50 p-2 text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-2">
              <Megaphone className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                {t("hc_routesAppMessages.broadcastWarningBefore")}{" "}
                <strong>{t("hc_routesAppMessages.broadcastWarningBold")}</strong>
                {t("hc_routesAppMessages.broadcastWarningAfter")}
              </span>
            </div>
          </div>

          {/* Total real de destinatarios entre los cursos seleccionados — se
              usa para deshabilitar el botón "Programar"/"Enviar" cuando es
              cero (sino la difusión se "ejecuta" silenciosa sin notificar a
              nadie, porque la dispatch SQL excluye al creator). Sum-without-
              dedup: si un alumno está en 2 cursos seleccionados lo cuenta 2
              veces. No importa para el gate (0 sigue siendo 0); el dispatch
              real dedup por user_id. */}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              onClick={() => setBroadcastDialogOpen(false)}
              disabled={broadcastSending}
            >
              {t("hc_routesAppMessages.cancel")}
            </Button>
            <Button
              onClick={() => void (broadcastScheduleAt ? scheduleBroadcast() : sendBroadcast())}
              disabled={
                broadcastSending ||
                broadcastCourseIds.length === 0 ||
                !broadcastSubject.trim() ||
                !broadcastBody.trim() ||
                broadcastCourses
                  .filter((c) => broadcastCourseIds.includes(c.id))
                  .reduce((acc, c) => acc + (c.recipient_count ?? 0), 0) === 0
              }
            >
              {broadcastSending ? (
                <Spinner size="sm" className="mr-1" />
              ) : broadcastScheduleAt ? (
                <CalendarClock className="h-4 w-4 mr-1" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              {broadcastScheduleAt
                ? t("hc_routesAppMessages.schedule")
                : t("hc_routesAppMessages.sendToAll")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Picker para etiquetar contenido — insertado a nivel root del
          componente para que no compita con z-index del bubble. */}
      <MessageTagPicker open={tagPickerOpen} onOpenChange={setTagPickerOpen} onPick={insertTag} />

      {/* Mensajes programados — lista + cancelar + editar.
          Por default muestra SOLO `pending` (lo accionable). Toggle
          "Ver historial" trae sent/cancelled/failed. */}
      <Dialog
        open={scheduledDialogOpen}
        onOpenChange={(open) => {
          setScheduledDialogOpen(open);
          if (!open) cancelEditScheduled();
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
          <DialogHeader>
            {/* Header en 2 niveles: título + toggle al lado. ANTES tenía
                el toggle DENTRO del DialogTitle (que renderiza como h2),
                violando jerarquía semántica de headings. Ahora va como
                sibling: el h2 queda limpio, el toggle queda a la derecha
                con flex-wrap para no desbordar en mobile. */}
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <DialogTitle className="flex items-center gap-2">
                <CalendarClock className="h-4 w-4 text-cyan-500" />
                {t("hc_routesAppMessages.scheduledMessages")}
              </DialogTitle>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[11px]"
                onClick={() => {
                  setShowScheduledHistory((s) => !s);
                  void loadScheduled();
                }}
              >
                {showScheduledHistory
                  ? t("hc_routesAppMessages.onlyPending")
                  : t("hc_routesAppMessages.viewHistory")}
              </Button>
            </div>
            <DialogDescription>
              {showScheduledHistory
                ? t("hc_routesAppMessages.scheduledHistoryDescription")
                : t("hc_routesAppMessages.scheduledPendingDescription")}
            </DialogDescription>
          </DialogHeader>
          {/* Banner "Procesar pendientes ahora" — solo visible si hay
              filas pending atrasadas (send_at < now). Cuando el cron
              está al día, no aparece. Llama el RPC
              `request_dispatch_scheduled_messages` que reusa la misma
              función de dispatch + autz por fila. */}
          {scheduledItems.some(
            (it) => it.status === "pending" && new Date(it.send_at).getTime() < Date.now(),
          ) && (
            <div className="flex items-center gap-2 rounded-md border border-amber-300/40 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/20 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
              <p className="text-xs text-muted-foreground flex-1">
                {t("hc_routesAppMessages.overdueMessagesHint")}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs shrink-0"
                disabled={forcingDispatch}
                onClick={() => void forceDispatchNow()}
              >
                {forcingDispatch ? (
                  <Spinner size="xs" className="mr-1" />
                ) : (
                  <Zap className="h-3.5 w-3.5 mr-1" />
                )}
                {t("hc_routesAppMessages.processNow")}
              </Button>
            </div>
          )}
          <div className="max-h-[60dvh] overflow-y-auto">
            {scheduledLoading ? (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-6">
                <Spinner size="sm" /> {t("hc_routesAppMessages.loading")}
              </div>
            ) : scheduledItems.length === 0 ? (
              <EmptyState
                icon={CalendarClock}
                text={
                  showScheduledHistory
                    ? t("hc_routesAppMessages.noScheduledHistory")
                    : t("hc_routesAppMessages.noScheduledPending")
                }
                hint={
                  showScheduledHistory
                    ? undefined
                    : t("hc_routesAppMessages.scheduledEmptyHint")
                }
              />
            ) : (
              <ul className="space-y-2">
                {scheduledItems.map((it) => {
                  const sevColor =
                    it.status === "failed"
                      ? "text-destructive"
                      : it.status === "sent"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : it.status === "cancelled"
                          ? "text-muted-foreground"
                          : "text-foreground";
                  // Atrasado: status sigue 'pending' pero send_at ya pasó.
                  // Indica que el cron no levantó el job (pausado, error,
                  // o demora puntual). El usuario debería usar "Procesar
                  // ahora" para forzar el dispatch.
                  const isOverdue =
                    it.status === "pending" && new Date(it.send_at).getTime() < Date.now();
                  const isEditing = editingScheduledId === it.id;
                  // Label del kind: cubrimos los 3 modos. 'group' depende
                  // de la migración 20260605000000 (kind_check ampliado).
                  const kindLabel =
                    it.kind === "broadcast"
                      ? t("hc_routesAppMessages.kindBroadcast")
                      : it.kind === "group"
                        ? t("hc_routesAppMessages.kindGroup")
                        : t("hc_routesAppMessages.kindDirect");
                  return (
                    <li
                      key={it.id}
                      className={`rounded-md border p-3 space-y-1 ${
                        isOverdue && !isEditing
                          ? "border-amber-400/50 bg-amber-50/30 dark:bg-amber-500/5"
                          : ""
                      } ${isEditing ? "ring-2 ring-primary/40" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            {kindLabel}
                          </Badge>
                          <span className={`text-xs font-medium ${sevColor}`}>
                            {SCHEDULED_STATUS_LABEL[it.status]}
                          </span>
                          {isOverdue && !isEditing && (
                            <Badge
                              variant="outline"
                              className="text-[10px] shrink-0 border-amber-500/40 text-amber-700 dark:text-amber-400 bg-amber-500/10"
                            >
                              <AlertTriangle className="h-2.5 w-2.5 mr-0.5" />
                              {t("hc_routesAppMessages.overdue")}
                            </Badge>
                          )}
                        </div>
                        {!isEditing && (
                          <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                            {formatDateTime(it.send_at)}
                          </span>
                        )}
                      </div>

                      {/* Subject sigue siendo NO editable en v1: el editor
                          se enfoca en body + send_at (lo más común que se
                          quiere reprogramar). Si se necesita cambiar
                          subject, recomendamos cancelar + recrear. */}
                      {it.subject && !isEditing && (
                        <div className="text-sm font-medium truncate">{it.subject}</div>
                      )}

                      {isEditing ? (
                        <div className="space-y-2 pt-1">
                          <div>
                            <Label htmlFor={`edit-body-${it.id}`} required>
                              {t("hc_routesAppMessages.content")}
                            </Label>
                            <Textarea
                              id={`edit-body-${it.id}`}
                              value={editDraftBody}
                              onChange={(e) => setEditDraftBody(e.target.value)}
                              rows={3}
                              className="resize-y"
                            />
                          </div>
                          <div>
                            <Label htmlFor={`edit-sendat-${it.id}`} required>
                              {t("hc_routesAppMessages.rescheduleSend")}
                            </Label>
                            <DateTimePicker
                              id={`edit-sendat-${it.id}`}
                              value={editDraftSendAt}
                              onChange={setEditDraftSendAt}
                            />
                          </div>
                          <div className="flex justify-end gap-2 pt-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={cancelEditScheduled}
                              disabled={savingEdit}
                            >
                              {t("hc_routesAppMessages.discard")}
                            </Button>
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => void saveEditScheduled()}
                              disabled={
                                savingEdit ||
                                !editDraftBody.trim() ||
                                !validateScheduledSend(editDraftSendAt).ok
                              }
                            >
                              {savingEdit ? (
                                <Spinner size="xs" className="mr-1" />
                              ) : (
                                <Check className="h-3 w-3 mr-1" />
                              )}
                              {t("hc_routesAppMessages.save")}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-xs text-muted-foreground line-clamp-2">{it.body}</div>
                      )}

                      {it.status === "failed" && it.error && !isEditing && (
                        <div className="text-[11px] text-destructive">
                          {t("hc_routesAppMessages.errorPrefix", { error: it.error })}
                        </div>
                      )}
                      {it.status === "pending" && !isEditing && (
                        <div className="flex justify-end gap-1.5">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => beginEditScheduled(it)}
                          >
                            <Pencil className="h-3 w-3 mr-1" />
                            {t("hc_routesAppMessages.edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => void cancelScheduled(it.id)}
                          >
                            <X className="h-3 w-3 mr-1" />
                            {t("hc_routesAppMessages.cancel")}
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
