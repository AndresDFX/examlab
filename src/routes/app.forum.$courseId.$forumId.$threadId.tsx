/**
 * Foro Q&A — detalle de un hilo.
 *
 * Muestra la pregunta raíz + lista de respuestas. Permite:
 *   - Upvote toggle en pregunta y en cada respuesta (RPC `toggle_forum_upvote`)
 *   - Marcar/desmarcar respuesta oficial (solo docente del curso o admin)
 *   - Pin / Lock del hilo (solo docente)
 *   - Editar/borrar contenido propio
 *   - Responder (con Markdown editor simple)
 *
 * RLS protege el acceso a usuarios fuera del curso.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { ForumStatusBadge } from "@/modules/forum/ForumStatusBadge";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import {
  MessageSquareText,
  ArrowUp,
  Pin,
  Lock,
  Trash2,
  Send,
  Crown,
  Edit2,
  X,
  Save,
} from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";
import { ErrorState } from "@/components/ui/empty-state";
import i18n from "@/i18n";

export const Route = createFileRoute("/app/forum/$courseId/$forumId/$threadId")({
  component: ThreadDetail,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Thread {
  id: string;
  course_id: string;
  author_id: string | null;
  title: string;
  body: string;
  tags: string[];
  is_pinned: boolean;
  is_locked: boolean;
  official_reply_id: string | null;
  upvotes: number;
  reply_count: number;
  created_at: string;
  updated_at: string;
  author?: { full_name: string | null } | null;
}

interface Reply {
  id: string;
  thread_id: string;
  author_id: string | null;
  body: string;
  upvotes: number;
  is_official: boolean;
  created_at: string;
  updated_at: string;
  author?: { full_name: string | null } | null;
}

function ThreadDetail() {
  const { courseId, forumId, threadId } = Route.useParams();
  const { user, roles } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const isStaff = roles.includes("Admin") || roles.includes("Docente");

  const [thread, setThread] = useState<Thread | null>(null);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [myUpvotes, setMyUpvotes] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [newReply, setNewReply] = useState("");
  const [posting, setPosting] = useState(false);

  // Inline edit state — qué reply o thread está en edición
  const [editingThread, setEditingThread] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [editReplyBody, setEditReplyBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const [
      { data: t, error: tErr },
      { data: r, error: rErr },
      { data: u },
    ] = await Promise.all([
      db
        .from("forum_threads")
        .select(
          "id, course_id, author_id, title, body, tags, is_pinned, is_locked, official_reply_id, upvotes, reply_count, created_at, updated_at, author:profiles!forum_threads_author_id_fkey(full_name)",
        )
        .eq("id", threadId)
        .maybeSingle(),
      db
        .from("forum_replies")
        .select(
          "id, thread_id, author_id, body, upvotes, is_official, created_at, updated_at, author:profiles!forum_replies_author_id_fkey(full_name)",
        )
        .eq("thread_id", threadId)
        .order("is_official", { ascending: false })
        .order("upvotes", { ascending: false })
        .order("created_at", { ascending: true }),
      user
        ? db
            .from("forum_upvotes")
            .select("target_id, target_type")
            .eq("user_id", user.id)
        : Promise.resolve({ data: [] }),
    ]);
    if (tErr || rErr) {
      setLoadError(friendlyError(tErr ?? rErr, "No pudimos cargar este hilo."));
      setLoading(false);
      return;
    }
    setThread(t as Thread | null);
    setReplies((r ?? []) as Reply[]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMyUpvotes(new Set(((u ?? []) as any[]).map((row) => row.target_id)));
    setLoading(false);
  }, [threadId, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const isMyThread = !!thread && thread.author_id === user?.id;
  const canModerate = isStaff;

  // ── Upvote toggle ─────────────────────────────────────────────────
  const toggleUpvote = async (targetType: "thread" | "reply", targetId: string) => {
    const { data, error } = await db.rpc("toggle_forum_upvote", {
      _target_type: targetType,
      _target_id: targetId,
    });
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    // Update local state inmediato
    setMyUpvotes((prev) => {
      const next = new Set(prev);
      if (row?.upvoted) next.add(targetId);
      else next.delete(targetId);
      return next;
    });
    if (targetType === "thread" && thread) {
      setThread({ ...thread, upvotes: row?.total ?? thread.upvotes });
    } else {
      setReplies((rs) =>
        rs.map((r) => (r.id === targetId ? { ...r, upvotes: row?.total ?? r.upvotes } : r)),
      );
    }
  };

  // ── Mark official ──────────────────────────────────────────────────
  const toggleOfficial = async (replyId: string, makeOfficial: boolean) => {
    const { error } = await db.rpc("mark_forum_reply_official", {
      _reply_id: replyId,
      _official: makeOfficial,
    });
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      makeOfficial
        ? i18n.t("toast.routes_app_forum_courseId_forumId_threadId.replyMarkedOfficial", {
            defaultValue: "Respuesta destacada como oficial",
          })
        : i18n.t("toast.routes_app_forum_courseId_forumId_threadId.replyOfficialRemoved", {
            defaultValue: "Marca de oficial removida",
          }),
    );
    await load();
  };

  // ── Pin / Lock ─────────────────────────────────────────────────────
  const togglePin = async () => {
    if (!thread) return;
    const { error } = await db
      .from("forum_threads")
      .update({ is_pinned: !thread.is_pinned })
      .eq("id", thread.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setThread({ ...thread, is_pinned: !thread.is_pinned });
    toast.success(
      !thread.is_pinned
        ? i18n.t("toast.routes_app_forum_courseId_forumId_threadId.threadPinned", {
            defaultValue: "Hilo fijado",
          })
        : i18n.t("toast.routes_app_forum_courseId_forumId_threadId.threadUnpinned", {
            defaultValue: "Hilo desfijado",
          }),
    );
  };

  const toggleLock = async () => {
    if (!thread) return;
    // Confirmación simétrica al `toggleClosed` del foro-contenedor:
    // ambas direcciones piden confirm, con tono y mensaje distintos.
    //   - Cerrar (warning): impacta a estudiantes (RLS bloquea su INSERT).
    //   - Reabrir (default): trivialmente seguro, pero confirm sigue el
    //     mismo patrón para que el docente no se confunda viendo distinto
    //     comportamiento en el toggle del foro vs el del hilo.
    const isLocked = thread.is_locked;
    const ok = await confirm({
      title: isLocked ? "¿Reabrir este hilo?" : "¿Cerrar este hilo?",
      description: isLocked
        ? "Los estudiantes podrán volver a responder en este hilo."
        : "Los estudiantes no podrán publicar más respuestas. Tú y otros docentes sí pueden seguir respondiendo. Reabrirlo es inmediato.",
      tone: isLocked ? "default" : "warning",
      confirmLabel: isLocked ? "Reabrir" : "Cerrar",
    });
    if (!ok) return;
    const { error } = await db
      .from("forum_threads")
      .update({ is_locked: !thread.is_locked })
      .eq("id", thread.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setThread({ ...thread, is_locked: !thread.is_locked });
    toast.success(
      !thread.is_locked
        ? i18n.t("toast.routes_app_forum_courseId_forumId_threadId.threadLocked", {
            defaultValue: "Hilo cerrado",
          })
        : i18n.t("toast.routes_app_forum_courseId_forumId_threadId.threadUnlocked", {
            defaultValue: "Hilo reabierto",
          }),
    );
  };

  // ── Crear respuesta ────────────────────────────────────────────────
  const submitReply = async () => {
    if (!user || !thread) return;
    const body = newReply.trim();
    if (!body) return;
    setPosting(true);
    const { error } = await db.from("forum_replies").insert({
      thread_id: thread.id,
      author_id: user.id,
      body,
    });
    setPosting(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setNewReply("");
    toast.success(
      i18n.t("toast.routes_app_forum_courseId_forumId_threadId.replyPublished", {
        defaultValue: "Respuesta publicada",
      }),
    );
    await load();
  };

  // ── Edit thread ─────────────────────────────────────────────────────
  const startEditThread = () => {
    if (!thread) return;
    setEditTitle(thread.title);
    setEditBody(thread.body);
    setEditingThread(true);
  };

  const saveEditThread = async () => {
    if (!thread) return;
    const title = editTitle.trim();
    const body = editBody.trim();
    if (title.length < 3 || !body) {
      toast.error(
        i18n.t("toast.routes_app_forum_courseId_forumId_threadId.titleAndBodyRequired", {
          defaultValue: "Título y cuerpo son obligatorios",
        }),
      );
      return;
    }
    const { error } = await db
      .from("forum_threads")
      .update({ title, body })
      .eq("id", thread.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setThread({ ...thread, title, body });
    setEditingThread(false);
    toast.success(
      i18n.t("toast.routes_app_forum_courseId_forumId_threadId.questionUpdated", {
        defaultValue: "Pregunta actualizada",
      }),
    );
  };

  // ── Edit reply ──────────────────────────────────────────────────────
  const startEditReply = (r: Reply) => {
    setEditingReplyId(r.id);
    setEditReplyBody(r.body);
  };

  const saveEditReply = async () => {
    if (!editingReplyId) return;
    const body = editReplyBody.trim();
    if (!body) return;
    const { error } = await db
      .from("forum_replies")
      .update({ body })
      .eq("id", editingReplyId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setReplies((rs) => rs.map((r) => (r.id === editingReplyId ? { ...r, body } : r)));
    setEditingReplyId(null);
    setEditReplyBody("");
    toast.success(
      i18n.t("toast.routes_app_forum_courseId_forumId_threadId.replyUpdated", {
        defaultValue: "Respuesta actualizada",
      }),
    );
  };

  // ── Delete ──────────────────────────────────────────────────────────
  const deleteThread = async () => {
    if (!thread) return;
    const ok = await confirm({
      title: "¿Borrar la pregunta?",
      description: "Se borrarán también todas las respuestas. Esta acción no se puede deshacer.",
      confirmLabel: "Borrar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("forum_threads").delete().eq("id", thread.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.routes_app_forum_courseId_forumId_threadId.threadDeleted", {
        defaultValue: "Hilo borrado",
      }),
    );
    // Volvemos a la lista de hilos del foro (no a la lista de foros).
    navigate({ to: "/app/forum/$courseId/$forumId", params: { courseId, forumId } });
  };

  const deleteReply = async (replyId: string) => {
    const ok = await confirm({
      title: "¿Borrar respuesta?",
      description: "Esta acción no se puede deshacer.",
      confirmLabel: "Borrar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("forum_replies").delete().eq("id", replyId);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setReplies((rs) => rs.filter((r) => r.id !== replyId));
    toast.success(
      i18n.t("toast.routes_app_forum_courseId_forumId_threadId.replyDeleted", {
        defaultValue: "Respuesta borrada",
      }),
    );
  };

  if (loading) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <Spinner size="md" /> Cargando…
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="container mx-auto p-6">
        <ErrorState
          message="No pudimos cargar este hilo"
          hint={loadError}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Hilo no encontrado o sin permisos.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-4 p-4 sm:p-6">
      <PageHeader
        backTo="/app/forum/$courseId/$forumId"
        backParams={{ courseId, forumId }}
        icon={<MessageSquareText className="h-6 w-6 text-indigo-500" />}
        title={thread.title}
        subtitle={
          <>
            Por {thread.author?.full_name ?? "Anónimo"} · {formatDateTime(thread.created_at)}
            {thread.is_pinned && <ForumStatusBadge status="pinned" className="ml-2" />}
            {thread.is_locked && <ForumStatusBadge status="locked" className="ml-1" />}
          </>
        }
        actions={
          <div className="flex flex-wrap gap-1.5">
            {canModerate && (
              <>
                <Button size="sm" variant="outline" onClick={() => void togglePin()}>
                  <Pin className="h-3.5 w-3.5 mr-1" />
                  {thread.is_pinned ? "Desfijar" : "Fijar"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => void toggleLock()}>
                  <Lock className="h-3.5 w-3.5 mr-1" />
                  {thread.is_locked ? "Reabrir" : "Cerrar"}
                </Button>
              </>
            )}
            {(isMyThread || canModerate) && !editingThread && (
              <>
                <Button size="sm" variant="ghost" onClick={startEditThread}>
                  <Edit2 className="h-3.5 w-3.5 mr-1" />
                  Editar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => void deleteThread()}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />
                  Borrar
                </Button>
              </>
            )}
          </div>
        }
      />

      {/* Tags */}
      {thread.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {thread.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[10px]">
              #{tag}
            </Badge>
          ))}
        </div>
      )}

      {/* Pregunta */}
      <Card>
        <CardContent className="p-4 flex gap-3">
          <UpvoteButton
            count={thread.upvotes}
            active={myUpvotes.has(thread.id)}
            onClick={() => void toggleUpvote("thread", thread.id)}
          />
          <div className="flex-1 min-w-0">
            {editingThread ? (
              <div className="space-y-2">
                <input
                  className="w-full px-3 py-1.5 rounded border text-sm font-medium bg-background"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  maxLength={200}
                />
                <Textarea
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                  rows={8}
                  className="font-mono text-sm"
                  maxLength={20000}
                />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setEditingThread(false)}>
                    <X className="h-3.5 w-3.5 mr-1" />
                    Cancelar
                  </Button>
                  <Button size="sm" onClick={() => void saveEditThread()}>
                    <Save className="h-3.5 w-3.5 mr-1" />
                    Guardar
                  </Button>
                </div>
              </div>
            ) : (
              <div className="prose prose-sm dark:prose-invert max-w-none">
                <MarkdownInline>{thread.body}</MarkdownInline>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Respuestas */}
      <div className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          {replies.length} respuesta{replies.length === 1 ? "" : "s"}
        </h2>
        {replies.map((r) => {
          const isMine = r.author_id === user?.id;
          return (
            <Card
              key={r.id}
              className={
                r.is_official
                  ? "border-emerald-500/50 bg-emerald-500/5"
                  : undefined
              }
            >
              <CardContent className="p-4 flex gap-3">
                <UpvoteButton
                  count={r.upvotes}
                  active={myUpvotes.has(r.id)}
                  onClick={() => void toggleUpvote("reply", r.id)}
                />
                <div className="flex-1 min-w-0 space-y-2">
                  {r.is_official && <ForumStatusBadge status="official" />}
                  {editingReplyId === r.id ? (
                    <div className="space-y-2">
                      <Textarea
                        value={editReplyBody}
                        onChange={(e) => setEditReplyBody(e.target.value)}
                        rows={6}
                        className="font-mono text-sm"
                        maxLength={20000}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingReplyId(null)}
                        >
                          <X className="h-3.5 w-3.5 mr-1" />
                          Cancelar
                        </Button>
                        <Button size="sm" onClick={() => void saveEditReply()}>
                          <Save className="h-3.5 w-3.5 mr-1" />
                          Guardar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      <MarkdownInline>{r.body}</MarkdownInline>
                    </div>
                  )}
                  <div className="flex items-center justify-between flex-wrap gap-2 pt-1 border-t mt-2">
                    <div className="text-[11px] text-muted-foreground">
                      {r.author?.full_name ?? "Anónimo"} ·{" "}
                      {formatDateTime(r.created_at)}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {canModerate && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-[11px]"
                          onClick={() => void toggleOfficial(r.id, !r.is_official)}
                        >
                          <Crown className="h-3 w-3 mr-1" />
                          {r.is_official ? "Quitar oficial" : "Marcar oficial"}
                        </Button>
                      )}
                      {(isMine || canModerate) && editingReplyId !== r.id && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-[11px]"
                            onClick={() => startEditReply(r)}
                          >
                            <Edit2 className="h-3 w-3 mr-1" />
                            Editar
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-[11px] text-destructive"
                            onClick={() => void deleteReply(r.id)}
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Borrar
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Nueva respuesta */}
      {!thread.is_locked ? (
        <Card>
          <CardContent className="p-4 space-y-2">
            <h3 className="text-sm font-semibold">Tu respuesta</h3>
            <Textarea
              value={newReply}
              onChange={(e) => setNewReply(e.target.value)}
              rows={6}
              placeholder="Escribe tu respuesta. Soporta Markdown."
              className="font-mono text-sm"
              maxLength={20000}
            />
            <div className="flex justify-end">
              <Button onClick={() => void submitReply()} disabled={posting || !newReply.trim()}>
                {posting ? <Spinner size="sm" className="mr-1" /> : <Send className="h-4 w-4 mr-1" />}
                Publicar respuesta
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="p-4 text-sm text-center text-amber-700 dark:text-amber-300">
            <Lock className="h-4 w-4 inline mr-1" />
            Este hilo está cerrado. No se pueden agregar más respuestas.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function UpvoteButton({
  count,
  active,
  onClick,
}: {
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 flex flex-col items-center gap-0.5 w-10 rounded p-2 transition-colors ${
        active
          ? "bg-indigo-500/15 text-indigo-700 dark:text-indigo-300"
          : "hover:bg-muted text-muted-foreground"
      }`}
      title={active ? "Quitar voto" : "Votar"}
    >
      <ArrowUp className={`h-4 w-4 ${active ? "fill-current" : ""}`} />
      <span className="text-xs font-semibold tabular-nums">{count}</span>
    </button>
  );
}
