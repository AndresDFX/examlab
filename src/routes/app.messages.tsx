/**
 * Módulo de mensajería interna 1-a-1.
 *
 * Reglas (implementadas vía RLS + RPC `can_message`):
 *   - Cualquier par que comparta curso puede mensajearse (cualquier
 *     combinación de roles: estudiante/docente).
 *   - Cualquier usuario puede mensajear a Admin y viceversa.
 *
 * Borrado asimétrico: "Eliminar conversación" llama a la RPC
 * `clear_conversation`, que setea cleared_at en MI lado. El otro usuario
 * la sigue viendo intacta. Si me llega un mensaje posterior, la conv
 * "resucita" para mí (los mensajes anteriores quedan ocultos por la
 * policy de SELECT en `messages`).
 *
 * Realtime: nos suscribimos a INSERTs en `messages` y a INSERT/UPDATE en
 * `conversations` para que la lista se actualice sin polling.
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
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ConfirmDialog";
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
} from "lucide-react";
import {
  groupMessagesByDay,
  formatMessageTime,
  previewBody,
  shouldStackWithPrevious,
  type MessageLite,
} from "@/lib/messaging";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/messages")({ component: MessagesPage });

// `conversations`, `messages` y las RPC no están en los types generados
// todavía — la migración es nueva. Usamos `any` puntual hasta regenerar.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface ConversationRow {
  id: string;
  user_a: string;
  user_b: string;
  user_a_cleared_at: string | null;
  user_b_cleared_at: string | null;
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
  /** El "otro" usuario (el que NO soy yo). */
  other: MessageableUser;
  /** Último mensaje visible para mí (respeta cleared_at). null si todos
   *  los mensajes son anteriores al clear (conv "borrada" para mí). */
  lastMessage: MessageLite | null;
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
  const [conversations, setConversations] = useState<ConversationEnriched[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageLite[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [contactSearch, setContactSearch] = useState("");

  // Scroll-to-bottom al cargar mensajes o recibir uno nuevo.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, activeConvId]);

  /** Carga la lista de contactos + conversaciones del usuario. */
  const loadAll = async () => {
    if (!myUserId) return;
    setLoading(true);
    try {
      const [contactsRes, convsRes] = await Promise.all([
        db.rpc("list_messageable_users"),
        db.from("conversations").select("*").order("created_at", { ascending: false }),
      ]);
      const contactsList = (contactsRes.data ?? []) as MessageableUser[];
      const convList = (convsRes.data ?? []) as ConversationRow[];
      setContacts(contactsList);

      // Para cada conv: encuentra el "otro" usuario en contacts (o llena
      // con datos mínimos si por alguna razón no apareció en la lista),
      // y trae el último mensaje visible.
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
        // El último mensaje lo trae con la RLS aplicada — solo los
        // posteriores a MI cleared_at.
        const { data: lastMsgs } = await db
          .from("messages")
          .select("*")
          .eq("conversation_id", c.id)
          .order("created_at", { ascending: false })
          .limit(1);
        enriched.push({
          conv: c,
          other,
          lastMessage: (lastMsgs?.[0] as MessageLite | undefined) ?? null,
        });
      }
      // Ordenar conversaciones por timestamp del último mensaje visible
      // (descendente). Conversaciones sin mensaje visible (recién creadas
      // o totalmente borradas) van al final por `created_at`.
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

  // Realtime: cuando llega un INSERT en messages dirigido a una conv mía,
  // recargamos previews (y mensajes si la conv está activa).
  useEffect(() => {
    if (!myUserId) return;
    const channel = supabase
      .channel(`messaging-${myUserId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages" },
        (payload: { new: MessageLite }) => {
          const m = payload.new;
          // Si es de la conv activa, append; siempre actualizar previews.
          if (activeConvId && m.conversation_id === activeConvId) {
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          }
          void loadAll();
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "conversations" },
        () => {
          void loadAll();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myUserId, activeConvId]);

  // Cargar mensajes cuando cambia la conv activa.
  useEffect(() => {
    if (!activeConvId) {
      setMessages([]);
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
          toast.error(error.message);
          setMessages([]);
          return;
        }
        setMessages((data ?? []) as MessageLite[]);
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeConvId]);

  const send = async () => {
    if (!activeConvId || !myUserId) return;
    const text = body.trim();
    if (!text) return;
    setSending(true);
    try {
      const { data, error } = await db
        .from("messages")
        .insert({ conversation_id: activeConvId, sender_id: myUserId, body: text })
        .select("*")
        .single();
      if (error || !data) {
        toast.error(error?.message ?? "No se pudo enviar el mensaje");
        return;
      }
      setMessages((prev) =>
        prev.some((m) => m.id === (data as MessageLite).id) ? prev : [...prev, data as MessageLite],
      );
      setBody("");
      // refresh previews
      void loadAll();
    } finally {
      setSending(false);
    }
  };

  const openConversationWith = async (otherUserId: string) => {
    if (!myUserId) return;
    const { data, error } = await db.rpc("open_conversation", { _other: otherUserId });
    if (error || !data) {
      toast.error(error?.message ?? "No se pudo abrir la conversación");
      return;
    }
    const convId = data as string;
    setNewDialogOpen(false);
    setContactSearch("");
    await loadAll();
    setActiveConvId(convId);
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
      toast.error(error.message);
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
  const dayGroups = useMemo(() => groupMessagesByDay(messages), [messages]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <MessageSquare className="h-6 w-6 text-cyan-400 dark:text-cyan-300" />
          Mensajes
        </h1>
        <Button size="sm" onClick={() => setNewDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          Nueva conversación
        </Button>
      </div>

      <Card>
        <CardContent className="p-0 grid md:grid-cols-[280px_1fr] min-h-[60vh]">
          {/* Lista de conversaciones */}
          <div className="border-r min-h-[60vh] max-h-[75vh] overflow-y-auto">
            {loading ? (
              <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
                <Spinner size="sm" /> Cargando…
              </div>
            ) : conversations.length === 0 ? (
              <EmptyState
                title="Sin conversaciones"
                description="Inicia una conversación con alguien de tus cursos o con un Admin."
              />
            ) : (
              <ul className="divide-y">
                {conversations.map((c) => {
                  const RoleIcon = ROLE_ICON[c.other.role_label];
                  const isActive = c.conv.id === activeConvId;
                  return (
                    <li key={c.conv.id}>
                      <button
                        type="button"
                        onClick={() => setActiveConvId(c.conv.id)}
                        className={cn(
                          "w-full text-left px-3 py-2.5 hover:bg-muted/40 transition-colors",
                          isActive && "bg-primary/5 border-l-2 border-primary",
                        )}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <RoleIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="font-medium text-sm truncate flex-1">
                            {c.other.full_name ?? c.other.email ?? "Usuario"}
                          </span>
                          <Badge
                            variant="outline"
                            className={cn("text-[9px] px-1 py-0 h-auto", ROLE_BADGE_CLASS[c.other.role_label])}
                          >
                            {c.other.role_label}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate">
                          {previewBody(c.lastMessage?.body, 50) || (
                            <span className="italic">Sin mensajes visibles</span>
                          )}
                        </p>
                        {c.lastMessage && (
                          <p className="text-[10px] text-muted-foreground/70 mt-0.5 tabular-nums">
                            {formatDateTime(c.lastMessage.created_at)}
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
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

                {/* Mensajes */}
                <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
                  {loadingMessages ? (
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <Spinner size="sm" /> Cargando mensajes…
                    </div>
                  ) : messages.length === 0 ? (
                    <p className="text-sm text-muted-foreground italic text-center py-8">
                      Aún no hay mensajes. Escribe el primero ↓
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
                          return (
                            <div
                              key={m.id}
                              className={cn(
                                "flex",
                                mine ? "justify-end" : "justify-start",
                                stack ? "mt-0.5" : "mt-1.5",
                              )}
                            >
                              <div
                                className={cn(
                                  "max-w-[75%] rounded-lg px-3 py-1.5 text-sm shadow-sm",
                                  mine
                                    ? "bg-primary text-primary-foreground rounded-br-sm"
                                    : "bg-muted text-foreground rounded-bl-sm",
                                )}
                              >
                                <p className="whitespace-pre-wrap break-words">{m.body}</p>
                                <p
                                  className={cn(
                                    "text-[9px] mt-0.5 tabular-nums",
                                    mine ? "text-primary-foreground/70" : "text-muted-foreground",
                                  )}
                                >
                                  {formatMessageTime(m.created_at)}
                                </p>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>

                {/* Composer */}
                <div className="border-t p-2 flex gap-2">
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
                  <Button
                    onClick={() => void send()}
                    disabled={!body.trim() || sending}
                    className="self-end h-9"
                  >
                    {sending ? <Spinner size="xs" /> : <Send className="h-4 w-4" />}
                  </Button>
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
              {filteredContacts.length === 0 ? (
                <p className="text-sm text-muted-foreground italic px-3 py-4 text-center">
                  No hay contactos disponibles.
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
    </div>
  );
}
