/**
 * Asistente IA de plataforma — chat único persistente, para TODOS los roles.
 *
 * Clon del Tutor IA del estudiante pero SIN curso: el usuario pregunta CÓMO
 * usar ExamLab y la IA responde anclada a la documentación de uso
 * (platform_kb_docs). El edge `platform-support-chat` adapta la KB + el prompt
 * al ROL ACTIVO que enviamos en el body.
 *
 * Cada usuario tiene UNA sola conversación (DB lo garantiza con UNIQUE user_id
 * en platform_support_sessions). Se crea on-demand al primer mensaje.
 * "Limpiar conversación" borra los mensajes y conserva la sesión.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import { Bot, Send, Trash2, User as UserIcon, AlertTriangle } from "lucide-react";
import { ErrorState } from "@/components/ui/empty-state";
import { formatDateTime } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export function PlatformAssistantChat() {
  const { t } = useTranslation();
  const { user, profile } = useAuth();
  const activeRole = useActiveRole();
  const confirm = useConfirm();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadErrorFallback = t("supportAssistant.loadErrorFallback", {
    defaultValue: "No pudimos cargar el asistente.",
  });
  const askErrorFallback = t("supportAssistant.askErrorFallback", {
    defaultValue: "No pudimos consultar al asistente.",
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending]);

  // Cargar la sesión única (o dejarla para crear on-demand al primer mensaje).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data: s, error: sErr } = await db
          .from("platform_support_sessions")
          .select("id")
          .eq("user_id", user.id)
          .maybeSingle();
        if (cancelled) return;
        if (sErr) {
          setLoadError(friendlyError(sErr, loadErrorFallback));
          return;
        }
        const sid = (s as { id: string } | null)?.id ?? null;
        setSessionId(sid);
        if (sid) {
          const { data: msgs } = await db
            .from("platform_support_messages")
            .select("id, session_id, role, content, created_at")
            .eq("session_id", sid)
            .order("created_at", { ascending: true });
          if (!cancelled) setMessages((msgs ?? []) as Message[]);
        }
      } catch (e) {
        if (!cancelled) setLoadError(friendlyError(e, loadErrorFallback));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, retryNonce, loadErrorFallback]);

  const loadMessages = useCallback(async (sid: string) => {
    const { data } = await db
      .from("platform_support_messages")
      .select("id, session_id, role, content, created_at")
      .eq("session_id", sid)
      .order("created_at", { ascending: true });
    setMessages((data ?? []) as Message[]);
  }, []);

  const ensureSession = async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    if (!user) return null;
    const { data, error } = await db
      .from("platform_support_sessions")
      .insert({ user_id: user.id, tenant_id: profile?.tenant_id ?? null, title: null })
      .select("id")
      .maybeSingle();
    if (error || !data) {
      toast.error(
        friendlyError(
          error,
          t("supportAssistant.startErrorFallback", {
            defaultValue: "No pudimos iniciar la conversación.",
          }),
        ),
      );
      return null;
    }
    const newId = (data as { id: string }).id;
    setSessionId(newId);
    return newId;
  };

  // ── Limpiar conversación: borra mensajes, conserva la sesión ──────────
  const clearConversation = async () => {
    if (!sessionId || messages.length === 0) return;
    const ok = await confirm({
      title: t("supportAssistant.clearTitle", { defaultValue: "Limpiar conversación" }),
      description: t("supportAssistant.clearDesc", {
        defaultValue:
          "Se borrarán todos los mensajes de este chat. Esta acción no se puede deshacer.",
      }),
      confirmLabel: t("supportAssistant.clearConfirm", { defaultValue: "Limpiar" }),
      tone: "destructive",
    });
    if (!ok) return;
    setClearing(true);
    const { error } = await db
      .from("platform_support_messages")
      .delete()
      .eq("session_id", sessionId);
    setClearing(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setMessages([]);
    toast.success(t("supportAssistant.cleared", { defaultValue: "Conversación limpiada" }));
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
      // role = rol ACTIVO → el edge adapta la KB + el prompt a lo que ese rol
      // puede hacer. Si el usuario no lo posee, el edge cae a su rol de mayor alcance.
      const { data, error } = await supabase.functions.invoke("platform-support-chat", {
        body: { sessionId: sid, message: text, role: activeRole ?? undefined },
      });
      if (error) {
        const real = await extractEdgeError(error, data);
        throw new Error(real || askErrorFallback);
      }
      if (data?.error) throw new Error(data.error);
      await loadMessages(sid);
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUserMsg.id));
      toast.error(friendlyError(e, askErrorFallback));
    } finally {
      setSending(false);
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <div className="container mx-auto space-y-4 p-4 sm:p-6">
      <PageHeader
        icon={<Bot className="h-6 w-6 text-indigo-500" />}
        title={t("supportAssistant.title", { defaultValue: "Asistente de la plataforma" })}
        subtitle={t("supportAssistant.subtitle", {
          defaultValue:
            "Pregunta cómo usar ExamLab. Responde con la documentación de la plataforma, adaptada a tu rol.",
        })}
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
              {t("supportAssistant.clear", { defaultValue: "Limpiar conversación" })}
            </Button>
          ) : null
        }
      />

      {loadError && (
        <ErrorState
          message={t("supportAssistant.loadErrorTitle", {
            defaultValue: "No pudimos cargar el asistente",
          })}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      )}

      <Card className="flex flex-col max-h-[70dvh]">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading ? (
            <div className="text-center text-sm text-muted-foreground py-8">
              <Spinner size="md" /> {t("common.loading", { defaultValue: "Cargando…" })}
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
                {t("supportAssistant.thinking", { defaultValue: "El asistente está pensando…" })}
              </div>
            </div>
          )}
        </div>

        <div className="border-t p-3 space-y-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("supportAssistant.inputPlaceholder", {
              defaultValue: "Ej.: ¿Cómo entrego un taller? ¿Cómo veo mis notas?",
            })}
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
          <div className="flex items-center justify-end gap-2">
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
              {t("supportAssistant.send", { defaultValue: "Enviar" })}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

function EmptyChat() {
  const { t } = useTranslation();
  return (
    <div className="text-center py-12 space-y-3">
      <div className="mx-auto w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center">
        <Bot className="h-8 w-8 text-indigo-500" />
      </div>
      <h2 className="text-base font-semibold">
        {t("supportAssistant.emptyTitle", { defaultValue: "Tu asistente de la plataforma" })}
      </h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        {t("supportAssistant.emptyBody", {
          defaultValue:
            "Pregúntame cómo usar ExamLab según tu rol: entregar tareas, ver notas, crear cursos y evaluaciones, configurar la IA, y más. Respondo con la documentación de ExamLab.",
        })}
      </p>
      <div className="text-[11px] text-muted-foreground flex items-center justify-center gap-1 pt-2">
        <AlertTriangle className="h-3 w-3" />
        {t("supportAssistant.emptyHint", {
          defaultValue:
            "Si algo no está en la documentación, te sugeriré a quién consultar.",
        })}
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
      <div
        className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
          isUser
            ? "bg-primary/15 text-primary"
            : "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
        }`}
      >
        {isUser ? <UserIcon className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className={`flex-1 max-w-[80%] ${isUser ? "text-right" : ""}`}>
        <Badge
          variant="outline"
          className={`text-[10px] ${
            isUser ? "" : "border-indigo-500/40 text-indigo-700 dark:text-indigo-300"
          }`}
        >
          {isUser
            ? t("supportAssistant.roleYou", { defaultValue: "Tú" })
            : t("supportAssistant.roleAssistant", { defaultValue: "Asistente" })}
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
