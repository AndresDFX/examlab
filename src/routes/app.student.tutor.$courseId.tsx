/**
 * Tutor IA personalizado por curso.
 *
 * El estudiante chatea con una IA que conoce el contexto del curso
 * (descripción + contenidos generados). El docente puede personalizar
 * el system prompt vía ai_prompts(use_case='tutor_chat').
 *
 * Sesiones persistidas — el estudiante puede continuar conversaciones
 * anteriores desde el sidebar. Cada sesión es un hilo aislado.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { RowAction } from "@/components/ui/row-action";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import {
  Sparkles,
  Send,
  Plus,
  Trash2,
  MessageSquare,
  Bot,
  User as UserIcon,
  AlertTriangle,
} from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";
import { extractEdgeError } from "@/shared/lib/edge-error";

export const Route = createFileRoute("/app/student/tutor/$courseId")({ component: TutorChat });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Session {
  id: string;
  course_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

function TutorChat() {
  const { courseId } = Route.useParams();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [course, setCourse] = useState<{ id: string; name: string } | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll al fondo cuando llegan mensajes nuevos
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending]);

  // Cargar curso + sesiones
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoadingSessions(true);
      const [{ data: c }, { data: s }] = await Promise.all([
        db.from("courses").select("id, name").eq("id", courseId).maybeSingle(),
        db
          .from("tutor_chat_sessions")
          .select("id, course_id, title, created_at, updated_at")
          .eq("user_id", user.id)
          .eq("course_id", courseId)
          .eq("archived", false)
          .order("updated_at", { ascending: false }),
      ]);
      if (cancelled) return;
      setCourse(c as { id: string; name: string } | null);
      const ss = (s ?? []) as Session[];
      setSessions(ss);
      // Si hay sesiones, abrir la más reciente; si no, dejar null para mostrar onboarding
      if (ss.length > 0) setActiveSessionId(ss[0].id);
      setLoadingSessions(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, courseId]);

  // Cargar mensajes de la sesión activa
  const loadMessages = useCallback(async (sessionId: string) => {
    setLoadingMessages(true);
    const { data } = await db
      .from("tutor_chat_messages")
      .select("id, session_id, role, content, created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });
    setMessages((data ?? []) as Message[]);
    setLoadingMessages(false);
  }, []);

  useEffect(() => {
    if (activeSessionId) {
      void loadMessages(activeSessionId);
    } else {
      setMessages([]);
    }
  }, [activeSessionId, loadMessages]);

  // ── Crear sesión nueva ────────────────────────────────────────────
  const createSession = async () => {
    if (!user) return;
    const { data, error } = await db
      .from("tutor_chat_sessions")
      .insert({ user_id: user.id, course_id: courseId, title: null })
      .select("id, course_id, title, created_at, updated_at")
      .maybeSingle();
    if (error || !data) {
      toast.error(error?.message ?? "No se pudo crear la conversación");
      return;
    }
    const newSession = data as Session;
    setSessions((prev) => [newSession, ...prev]);
    setActiveSessionId(newSession.id);
    setMessages([]);
  };

  // ── Borrar sesión ─────────────────────────────────────────────────
  const deleteSession = async (sessionId: string) => {
    const ok = await confirm({
      title: "¿Borrar esta conversación?",
      description: "Se perderán todos los mensajes. Esta acción no se puede deshacer.",
      confirmLabel: "Borrar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("tutor_chat_sessions").delete().eq("id", sessionId);
    if (error) {
      toast.error(error.message);
      return;
    }
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    if (activeSessionId === sessionId) {
      setActiveSessionId(null);
      setMessages([]);
    }
    toast.success("Conversación borrada");
  };

  // ── Enviar mensaje ────────────────────────────────────────────────
  const sendMessage = async () => {
    if (!user) return;
    const text = input.trim();
    if (!text) return;
    let sessionId = activeSessionId;

    // Si no hay sesión activa, crearla on-the-fly
    if (!sessionId) {
      const { data, error } = await db
        .from("tutor_chat_sessions")
        .insert({ user_id: user.id, course_id: courseId, title: null })
        .select("id, course_id, title, created_at, updated_at")
        .maybeSingle();
      if (error || !data) {
        toast.error(error?.message ?? "No se pudo crear la conversación");
        return;
      }
      sessionId = data.id;
      setSessions((prev) => [data as Session, ...prev]);
      setActiveSessionId(sessionId);
    }

    setInput("");
    setSending(true);

    // Push optimista del mensaje del usuario
    const optimisticUserMsg: Message = {
      id: `optimistic-${Date.now()}`,
      session_id: sessionId!,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    try {
      const { data, error } = await supabase.functions.invoke("tutor-chat", {
        body: { sessionId, message: text },
      });
      // El edge retorna `status: 500` con `{ error: "mensaje..." }` cuando
      // la API key del provider está inválida (o cualquier otro fallo).
      // `supabase.functions.invoke` envuelve cualquier non-2xx en un
      // FunctionsHttpError genérico ("Edge Function returned a non-2xx
      // status code") y deja el body real en `error.context.response`.
      // `extractEdgeError(error, data)` lee ese body y devuelve el
      // mensaje útil — caemos al genérico solo si no se puede extraer.
      if (error) {
        const real = await extractEdgeError(error, data);
        throw new Error(real || "Error consultando al tutor");
      }
      if (data?.error) throw new Error(data.error);

      // Re-cargar los mensajes reales (incluye el del usuario + assistant persistidos por la edge)
      await loadMessages(sessionId!);

      // Si era el primer mensaje y no hay título aún, generar uno simple desde el texto
      const isFirst = messages.length === 0;
      if (isFirst) {
        const autoTitle = text.slice(0, 60) + (text.length > 60 ? "…" : "");
        await db.from("tutor_chat_sessions").update({ title: autoTitle }).eq("id", sessionId);
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, title: autoTitle } : s)),
        );
      }
    } catch (e) {
      // Quitar el optimista y mostrar error
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUserMsg.id));
      toast.error(e instanceof Error ? e.message : "Error consultando al tutor");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="container mx-auto space-y-4 p-4 sm:p-6">
      <PageHeader
        backTo="/app/student/courses"
        icon={<Sparkles className="h-6 w-6 text-indigo-500" />}
        title={course ? `Tutor IA · ${course.name}` : "Tutor IA"}
        subtitle="Te guío con el material del curso. No resuelvo ejercicios — explico el método para que tú llegues a la respuesta."
        actions={
          <Button size="sm" onClick={() => void createSession()}>
            <Plus className="h-4 w-4 mr-1" />
            Nueva conversación
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Sidebar: sesiones */}
        <Card className="lg:col-span-1 max-h-[70vh] overflow-y-auto">
          <CardContent className="p-2">
            {loadingSessions ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                <Spinner size="sm" inline /> Cargando…
              </div>
            ) : sessions.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground text-center">
                Aún no tienes conversaciones. Escribe tu primera pregunta abajo.
              </div>
            ) : (
              <ul className="space-y-1">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => setActiveSessionId(s.id)}
                      className={`w-full text-left rounded p-2 hover:bg-muted/60 transition-colors ${
                        activeSessionId === s.id ? "bg-muted" : ""
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">
                            {s.title ?? "Conversación sin título"}
                          </div>
                          <div className="text-[10px] text-muted-foreground">
                            {formatDateTime(s.updated_at)}
                          </div>
                        </div>
                        <RowAction
                          label="Borrar conversación"
                          icon={Trash2}
                          tone="destructive"
                          onClick={(e) => {
                            e?.stopPropagation?.();
                            void deleteSession(s.id);
                          }}
                        />
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Chat principal */}
        <Card className="lg:col-span-3 flex flex-col max-h-[70vh]">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {loadingMessages ? (
              <div className="text-center text-sm text-muted-foreground py-8">
                <Spinner size="md" /> Cargando mensajes…
              </div>
            ) : messages.length === 0 ? (
              <EmptyChat />
            ) : (
              messages.map((m) => <MessageBubble key={m.id} message={m} />)
            )}
            {sending && (
              <div className="flex items-start gap-2 text-muted-foreground text-sm">
                <Bot className="h-4 w-4 mt-0.5" />
                <div className="flex items-center gap-2">
                  <Spinner size="sm" />
                  El tutor está pensando…
                </div>
              </div>
            )}
          </div>

          <div className="border-t p-3 space-y-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="¿En qué te ayudo? Pregúntame sobre cualquier tema del curso…"
              rows={3}
              className="resize-none text-sm"
              maxLength={4000}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!sending) void sendMessage();
                }
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted-foreground">
                Enter para enviar · Shift+Enter para salto de línea
              </span>
              <Button
                size="sm"
                onClick={() => void sendMessage()}
                disabled={sending || !input.trim()}
              >
                {sending ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <Send className="h-4 w-4 mr-1" />
                )}
                Enviar
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="text-center py-12 space-y-3">
      <div className="mx-auto w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center">
        <Sparkles className="h-8 w-8 text-indigo-500" />
      </div>
      <h2 className="text-base font-semibold">Soy tu tutor de IA</h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        Conozco el material de este curso. Pregúntame por conceptos, ejercicios, dudas de
        clase — te guío para que tú llegues a la respuesta.
      </p>
      <div className="text-[11px] text-muted-foreground flex items-center justify-center gap-1 pt-2">
        <AlertTriangle className="h-3 w-3" />
        No reemplazo a tu docente ni doy soluciones exactas a tareas.
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          isUser ? "bg-primary/15 text-primary" : "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
        }`}
      >
        {isUser ? <UserIcon className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className={`flex-1 max-w-[80%] ${isUser ? "text-right" : ""}`}>
        <Badge
          variant="outline"
          className={`text-[10px] ${isUser ? "" : "border-indigo-500/40 text-indigo-700 dark:text-indigo-300"}`}
        >
          {isUser ? "Tú" : "Tutor"}
        </Badge>
        <div
          className={`mt-1 rounded-lg p-3 text-sm inline-block text-left ${
            isUser ? "bg-primary/10" : "bg-muted/60"
          }`}
        >
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <MarkdownInline>{message.content}</MarkdownInline>
          </div>
        </div>
        <div className="text-[10px] text-muted-foreground mt-1">
          {formatDateTime(message.created_at)}
        </div>
      </div>
    </div>
  );
}
