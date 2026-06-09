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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Sparkles, Send, Trash2, Bot, User as UserIcon, AlertTriangle, FileText, X } from "lucide-react";
import { ErrorState } from "@/components/ui/empty-state";
import { formatDateTime } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { findActiveTagQuery } from "@/modules/messaging/message-tags";
import { isReferenceableFile } from "@/modules/contents/material-extract";
import { cn } from "@/shared/lib/utils";
import i18n from "@/i18n";

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

/** Un archivo de contenido del curso que el estudiante puede referenciar con #. */
interface CourseFile {
  contentId: string;
  contentName: string;
  fileName: string;
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Referenciar archivos del curso con # (autocomplete estilo Slack) ──
  const [courseFiles, setCourseFiles] = useState<CourseFile[]>([]);
  const [referenced, setReferenced] = useState<CourseFile[]>([]);
  const [tagQuery, setTagQuery] = useState<{ query: string; start: number } | null>(null);
  const [tagIndex, setTagIndex] = useState(0);

  const suggestions = useMemo(() => {
    if (!tagQuery) return [];
    const q = tagQuery.query.toLowerCase();
    return courseFiles
      .filter((f) => `${f.fileName} ${f.contentName}`.toLowerCase().includes(q))
      .slice(0, 8);
  }, [tagQuery, courseFiles]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, sending]);

  // Cargar curso + sesión única (o crearla on-demand al primer mensaje)
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [{ data: c, error: cErr }, { data: s }, { data: contents }] = await Promise.all([
          db.from("courses").select("id, name").eq("id", courseId).maybeSingle(),
          db
            .from("tutor_chat_sessions")
            .select("id")
            .eq("user_id", user.id)
            .eq("course_id", courseId)
            .maybeSingle(),
          // Contenidos del curso para el picker de # (solo done, no papelera).
          db
            .from("generated_contents")
            .select("id, display_name, topic, files")
            .eq("course_id", courseId)
            .eq("status", "done")
            .is("deleted_at", null)
            .order("updated_at", { ascending: false })
            .limit(30),
        ]);
        if (cancelled) return;
        if (cErr) {
          setLoadError(friendlyError(cErr, "No pudimos cargar el tutor de este curso."));
          return;
        }
        setCourse(c as { id: string; name: string } | null);
        // Aplanar los archivos referenciables (texto/código/notebook/office).
        const files: CourseFile[] = [];
        for (const row of (contents ?? []) as Array<{
          id: string;
          display_name: string | null;
          topic: string | null;
          files: Array<{ name?: string }> | null;
        }>) {
          const contentName = (row.display_name || row.topic || "Contenido").trim();
          for (const f of Array.isArray(row.files) ? row.files : []) {
            if (f?.name && isReferenceableFile(f.name)) {
              files.push({ contentId: row.id, contentName, fileName: String(f.name) });
            }
          }
        }
        setCourseFiles(files);
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
      } catch (e) {
        if (!cancelled) setLoadError(friendlyError(e, "No pudimos cargar el tutor de este curso."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, courseId, retryNonce]);

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
    toast.success(i18n.t("toast.routes_app_student_tutor_courseId.conversationCleared", { defaultValue: "Conversación limpiada" }));
  };

  // ── Referenciar un archivo del curso: reemplaza el "#query" por
  // "#<archivo> " y lo agrega a la lista de referenciados (chips). ──────────
  const selectFile = (f: CourseFile) => {
    if (!tagQuery) return;
    const short = f.fileName.length > 32 ? f.fileName.slice(0, 32) + "…" : f.fileName;
    const before = input.slice(0, tagQuery.start);
    const after = input.slice(tagQuery.start + 1 + tagQuery.query.length);
    const insert = `#${short} `;
    const next = before + insert + after;
    setInput(next);
    setTagQuery(null);
    setReferenced((prev) =>
      prev.some((r) => r.contentId === f.contentId && r.fileName === f.fileName)
        ? prev
        : [...prev, f],
    );
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const pos = (before + insert).length;
      el.setSelectionRange(pos, pos);
    });
  };

  // ── Enviar mensaje ────────────────────────────────────────────────────
  const sendMessage = async () => {
    if (!user) return;
    const text = input.trim();
    if (!text) return;

    const sid = await ensureSession();
    if (!sid) return;

    const refsForSend = referenced.map((r) => ({ contentId: r.contentId, name: r.fileName }));
    setInput("");
    setTagQuery(null);
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
        body: {
          sessionId: sid,
          message: text,
          ...(refsForSend.length > 0 ? { referencedFiles: refsForSend } : {}),
        },
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
      // Las referencias aplican al mensaje enviado; se limpian para el próximo.
      setReferenced([]);
    } catch (e) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUserMsg.id));
      toast.error(friendlyError(e, "Error consultando al tutor"));
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

      {loadError && (
        <ErrorState
          message="No pudimos cargar el tutor"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      )}

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
          {referenced.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[11px] text-muted-foreground mr-0.5">Material referenciado:</span>
              {referenced.map((f, i) => (
                <Badge key={`${f.contentId}-${f.fileName}-${i}`} variant="secondary" className="gap-1 text-[10px] max-w-[220px]">
                  <FileText className="h-3 w-3 shrink-0" />
                  <span className="truncate">{f.fileName}</span>
                  <button
                    type="button"
                    aria-label={`Quitar ${f.fileName}`}
                    className="ml-0.5 rounded-sm hover:bg-foreground/10 p-0.5"
                    onClick={() => setReferenced((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="relative">
            {tagQuery && suggestions.length > 0 && (
              <div className="absolute bottom-full mb-1 left-0 right-0 z-20 max-h-56 overflow-y-auto rounded-md border bg-popover shadow-md">
                {suggestions.map((f, i) => (
                  <button
                    key={`${f.contentId}-${f.fileName}`}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectFile(f);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-accent",
                      i === tagIndex && "bg-accent",
                    )}
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
                    <span className="truncate font-medium">{f.fileName}</span>
                    <span className="truncate text-muted-foreground">· {f.contentName}</span>
                  </button>
                ))}
              </div>
            )}
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                const val = e.target.value;
                setInput(val);
                const caret = e.target.selectionStart ?? val.length;
                setTagQuery(findActiveTagQuery(val, caret));
                setTagIndex(0);
              }}
              placeholder="¿En qué te ayudo? Escribe # para referenciar material del curso…"
              rows={3}
              className="resize-none text-sm"
              maxLength={4000}
              disabled={sending || loading}
              onKeyDown={(e) => {
                if (tagQuery && suggestions.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setTagIndex((i) => (i + 1) % suggestions.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setTagIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    selectFile(suggestions[tagIndex]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setTagQuery(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!sending) void sendMessage();
                }
              }}
            />
          </div>
          <div className="flex items-center justify-end sm:justify-between gap-2">
            <span className="hidden sm:inline text-[11px] text-muted-foreground">
              Enter para enviar · Shift+Enter salto de línea · <span className="font-medium">#</span> referencia material
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
