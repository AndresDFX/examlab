/**
 * Tutor IA personalizado por curso — un chat único persistente.
 *
 * El alumno tiene UNA sola conversación por curso (DB lo garantiza con
 * UNIQUE (user_id, course_id) en tutor_chat_sessions). En el primer
 * acceso se crea la sesión on-demand. Cuando el alumno quiere empezar
 * de cero usa "Limpiar conversación", que borra los mensajes pero
 * conserva la sesión.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import { Sparkles, Send, Trash2, Bot, User as UserIcon, AlertTriangle } from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";

export const Route = createFileRoute("/app/student/tutor/$courseId")({ component: TutorChat });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

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
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending]);

  // Cargar curso + sesión única (o crearla on-demand al primer mensaje)
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [{ data: c }, { data: s }] = await Promise.all([
        db.from("courses").select("id, name").eq("id", courseId).maybeSingle(),
        db
          .from("tutor_chat_sessions")
          .select("id")
          .eq("user_id", user.id)
          .eq("course_id", courseId)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      setCourse(c as { id: string; name: string } | null);
      const sid = (s as { id: string } | null)?.id ?? null;
      setSessionId(sid);
      if (sid) {
        const { data: msgs } = await db
          .from("tutor_chat_messages")
          .select("id, session_id, role, content, created_at")
          .eq("session_id", sid)
          .order("created_at", { ascending: true });
        if (!cancelled) setMessages((msgs ?? []) as Message[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, courseId]);

  const loadMessages = useCallback(async (sid: string) => {
    const { data } = await db
      .from("tutor_chat_messages")
      .select("id, session_id, role, content, created_at")
      .eq("session_id", sid)
      .order("created_at", { ascending: true });
    setMessages((data ?? []) as Message[]);
  }, []);

  const ensureSession = async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    if (!user) return null;
    const { data, error } = await db
      .from("tutor_chat_sessions")
      .insert({ user_id: user.id, course_id: courseId, title: null })
      .select("id")
      .maybeSingle();
    if (error || !data) {
      toast.error(friendlyError(error, "No se pudo iniciar la conversación"));
      return null;
    }
    const newId = (data as { id: string }).id;
    setSessionId(newId);
    return newId;
  };

  // ── Limpiar conversación: borra mensajes, conserva la sesión ─────────
  const clearConversation = async () => {
    if (!sessionId || messages.length === 0) return;
    const ok = await confirm({
      title: "¿Limpiar la conversación?",
      description:
        "Se borrarán todos los mensajes con el tutor para este curso. Esta acción no se puede deshacer.",
      confirmLabel: "Limpiar",
      tone: "destructive",
    });
    if (!ok) return;
    setClearing(true);
    const { error } = await db.from("tutor_chat_messages").delete().eq("session_id", sessionId);
    setClearing(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setMessages([]);
    toast.success("Conversación limpiada");
  };

  // ── Enviar mensaje ────────────────────────────────────────────────────
  const sendMessage = async () => {
    if (!user) return;
    const text = input.trim();
    if (!text) return;

    const sid = await ensureSession();
    if (!sid) return;

    setInput("");
    setSending(true);

    const optimisticUserMsg: Message = {
      id: `optimistic-${Date.now()}`,
      session_id: sid,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    try {
      const { data, error } = await supabase.functions.invoke("tutor-chat", {
        body: { sessionId: sid, message: text },
      });
      // Ver app.student.tutor.$courseId.tsx (sendMessage previo) y
      // shared/lib/edge-error.ts: invoke envuelve los non-2xx en
      // FunctionsHttpError genérico; el body real (con el mensaje
      // accionable, ej. API key inválida) vive en error.context.response.
      if (error) {
        const real = await extractEdgeError(error, data);
        throw new Error(real || "Error consultando al tutor");
      }
      if (data?.error) throw new Error(data.error);
      await loadMessages(sid);
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUserMsg.id));
      toast.error(e instanceof Error ? e.message : "Error consultando al tutor");
    } finally {
      setSending(false);
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <div className="container mx-auto space-y-4 p-4 sm:p-6">
      <PageHeader
        backTo="/app/student/courses"
        icon={<Sparkles className="h-6 w-6 text-indigo-500" />}
        title={course ? `Tutor IA · ${course.name}` : "Tutor IA"}
        subtitle="Te guío con el material del curso. No resuelvo ejercicios — explico el método para que tú llegues a la respuesta."
        actions={
          hasMessages ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void clearConversation()}
              disabled={clearing || sending}
            >
              {clearing ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1" />
              )}
              Limpiar conversación
            </Button>
          ) : null
        }
      />

      <Card className="flex flex-col max-h-[70vh]">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="text-center text-sm text-muted-foreground py-8">
              <Spinner size="md" /> Cargando…
            </div>
          ) : !hasMessages ? (
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
            disabled={sending || loading}
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
              disabled={sending || loading || !input.trim()}
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
