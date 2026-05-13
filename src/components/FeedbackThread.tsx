/**
 * FeedbackThread — caja de comentarios entre estudiante y docente sobre
 * la retroalimentación de UNA pregunta. Sirve para los 3 módulos
 * (examen / taller / proyecto) vía polimorfismo.
 *
 * - Carga el hilo (si existe) por (parent_kind, question_id, submission_id).
 * - Lista los comentarios cronológicamente.
 * - Si el hilo NO está cerrado, muestra textarea para responder.
 * - Si el usuario es docente, expone botón de Cerrar / Reabrir.
 * - El primer comentario crea el hilo; comentarios posteriores se enlazan
 *   por thread_id.
 *
 * RLS hace cumplir que solo el dueño de la entrega o un docente del
 * curso vean / escriban; ver migración 20260503210000_feedback_threads.
 */
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  MessageSquare,
  Lock,
  Unlock,
  Send,
  Pencil,
  Trash2,
  Check,
  X,
  Paperclip,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime } from "@/lib/format";
import { toast } from "sonner";
import { useConfirm } from "@/components/ConfirmDialog";
import { FeedbackCommentAttachments } from "@/components/FeedbackCommentAttachments";
import {
  buildAttachmentPath,
  FEEDBACK_ATTACHMENT_MAX_COUNT,
  formatAttachmentSize,
  safeAttachmentName,
  validateAttachmentFile,
  type AttachmentRow,
} from "@/lib/feedback-attachments";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type FeedbackParentKind = "exam" | "workshop" | "project";

type Thread = {
  id: string;
  parent_kind: FeedbackParentKind;
  question_id: string;
  submission_id: string;
  closed: boolean;
  closed_at: string | null;
  closed_by: string | null;
  created_at: string;
};

type Comment = {
  id: string;
  thread_id: string;
  user_id: string;
  body: string;
  created_at: string;
  /** 'student' | 'teacher' — rol con el que se escribió el comentario. */
  author_role?: string | null;
  profile?: { full_name: string | null; institutional_email: string | null } | null;
  /** Adjuntos cargados desde feedback_attachments en el mismo round-trip
   *  del load(). Vacío si el comment no tiene archivos. */
  attachments?: AttachmentRow[];
};

interface Props {
  parentKind: FeedbackParentKind;
  questionId: string;
  submissionId: string;
  /** Si true, muestra controles de cerrar / reabrir. Default false. */
  isTeacher?: boolean;
  className?: string;
  /** Callback opcional que se dispara cuando el thread cambia de estado
   *  (cerrar/reabrir, nuevo comentario, edit, delete). Útil para que el
   *  caller refresque sus contadores agregados (ej. "diálogos pendientes"
   *  en el monitor docente). Best-effort: nunca falla la operación
   *  principal si el callback tira. */
  onChanged?: () => void;
}

export function FeedbackThread({
  parentKind,
  questionId,
  submissionId,
  isTeacher = false,
  className,
  onChanged,
}: Props) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [thread, setThread] = useState<Thread | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  /** Archivos seleccionados por el usuario para adjuntar al PRÓXIMO
   *  comment. Se suben recién después de que `send()` cree el comment
   *  (necesitamos el id para armar el path `<user>/<comment>/<file>`). */
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  /** Cache por comment_id para forzar re-render del listado cuando se
   *  borra un adjunto sin recargar todo el hilo. */
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
      if (merged.length > FEEDBACK_ATTACHMENT_MAX_COUNT) {
        toast.error(`Máximo ${FEEDBACK_ATTACHMENT_MAX_COUNT} archivos por comentario.`);
        return merged.slice(0, FEEDBACK_ATTACHMENT_MAX_COUNT);
      }
      return merged;
    });
    // Limpiamos el input para que el mismo archivo pueda re-seleccionarse
    // tras quitarlo (el input nativo no dispara `change` si el archivo
    // ya estaba).
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removePendingFile = (idx: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
  };

  /** Sube los archivos pendientes al bucket + inserta filas en
   *  feedback_attachments. Idempotente por archivo: si uno falla, los
   *  demás siguen — el caller decide si revertir. Devuelve el set de
   *  AttachmentRow creados para append-optimista en la UI. */
  const uploadPendingFiles = async (commentId: string): Promise<AttachmentRow[]> => {
    if (pendingFiles.length === 0 || !user) return [];
    const created: AttachmentRow[] = [];
    for (const file of pendingFiles) {
      const safe = safeAttachmentName(file.name);
      const path = buildAttachmentPath(user.id, commentId, file.name);
      const up = await supabase.storage.from("feedback-attachments").upload(path, file, {
        upsert: false,
        contentType: file.type || "application/octet-stream",
      });
      if (up.error) {
        console.warn("[FeedbackThread] upload attachment", up.error);
        toast.error(`No se pudo subir ${safe}: ${up.error.message}`);
        continue;
      }
      const { data, error } = await db
        .from("feedback_attachments")
        .insert({
          comment_id: commentId,
          path,
          name: safe,
          mime_type: file.type || null,
          size_bytes: file.size,
          uploaded_by: user.id,
        })
        .select("*")
        .single();
      if (error || !data) {
        console.warn("[FeedbackThread] insert attachment row", error);
        // El archivo quedó en el bucket pero sin row — lo borramos para
        // no dejar huérfano.
        await supabase.storage.from("feedback-attachments").remove([path]);
        toast.error(`No se pudo registrar ${safe}: ${error?.message ?? "desconocido"}`);
        continue;
      }
      created.push(data as AttachmentRow);
    }
    return created;
  };

  const startEdit = (c: Comment) => {
    setEditingId(c.id);
    setEditingText(c.body);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditingText("");
  };
  const saveEdit = async () => {
    if (!editingId) return;
    const trimmed = editingText.trim();
    if (!trimmed) {
      toast.error("El comentario no puede estar vacío");
      return;
    }
    setSavingEdit(true);
    try {
      const { error } = await db
        .from("feedback_comments")
        .update({ body: trimmed })
        .eq("id", editingId);
      if (error) {
        console.error("[FeedbackThread] update comment", error);
        toast.error(error.message ?? "No se pudo editar el comentario");
        return;
      }
      setComments((prev) => prev.map((c) => (c.id === editingId ? { ...c, body: trimmed } : c)));
      cancelEdit();
    } finally {
      setSavingEdit(false);
    }
  };

  const removeComment = async (c: Comment) => {
    const ok = await confirm({
      title: "Eliminar comentario",
      description: "Se eliminará tu comentario de forma permanente.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    setDeletingId(c.id);
    try {
      const { error } = await db.from("feedback_comments").delete().eq("id", c.id);
      if (error) {
        console.error("[FeedbackThread] delete comment", error);
        toast.error(error.message ?? "No se pudo eliminar el comentario");
        return;
      }
      setComments((prev) => prev.filter((x) => x.id !== c.id));
    } finally {
      setDeletingId(null);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const { data: t, error: tErr } = await db
        .from("feedback_threads")
        .select("*")
        .eq("parent_kind", parentKind)
        .eq("question_id", questionId)
        .eq("submission_id", submissionId)
        .maybeSingle();
      if (tErr) {
        console.error("[FeedbackThread] load thread", tErr);
        setThread(null);
        setComments([]);
        return;
      }
      setThread((t as Thread | null) ?? null);
      if (!t) {
        setComments([]);
        return;
      }
      // No usamos un join `profile:profiles(...)` porque
      // feedback_comments.user_id apunta a auth.users(id), no a
      // profiles(id), y PostgREST no infiere FKs transitivas.
      // Devolvía PGRST200 silencioso y la lista quedaba vacía.
      // En su lugar: traer comentarios y perfiles por separado.
      // Intentamos con author_role primero; si la migración de esa
      // columna aún no se aplicó en este entorno, retry sin ella.
      let rawComments: unknown[] | null = null;
      const first = await db
        .from("feedback_comments")
        .select("id, thread_id, user_id, body, created_at, author_role")
        .eq("thread_id", (t as Thread).id)
        .order("created_at", { ascending: true });
      if (first.error) {
        const code = (first.error as { code?: string }).code;
        // 42703 = undefined_column en Postgres; PGRST204 también
        // aparece cuando PostgREST no encuentra la columna.
        if (code === "42703" || code === "PGRST204") {
          console.warn("[FeedbackThread] author_role column missing; falling back");
          const second = await db
            .from("feedback_comments")
            .select("id, thread_id, user_id, body, created_at")
            .eq("thread_id", (t as Thread).id)
            .order("created_at", { ascending: true });
          if (second.error) {
            console.error("[FeedbackThread] load comments", second.error);
            setComments([]);
            return;
          }
          rawComments = second.data ?? [];
        } else {
          console.error("[FeedbackThread] load comments", first.error);
          setComments([]);
          return;
        }
      } else {
        rawComments = first.data ?? [];
      }
      const list = (rawComments ?? []) as Comment[];
      if (!list) {
        setComments([]);
        return;
      }
      const userIds = Array.from(new Set(list.map((c) => c.user_id)));
      let profilesById = new Map<
        string,
        { full_name: string | null; institutional_email: string | null }
      >();
      if (userIds.length > 0) {
        const { data: profs } = await db
          .from("profiles")
          .select("id, full_name, institutional_email")
          .in("id", userIds);
        profilesById = new Map(
          (
            (profs ?? []) as Array<{
              id: string;
              full_name: string | null;
              institutional_email: string | null;
            }>
          ).map((p) => [
            p.id,
            { full_name: p.full_name, institutional_email: p.institutional_email },
          ]),
        );
      }
      // Adjuntos por comment_id — un solo round-trip para todos los
      // comments del hilo. Si la migración aún no se aplicó en este
      // entorno la consulta falla 42P01/PGRST205; tratamos eso como
      // "no hay adjuntos" para no romper el thread legacy.
      const commentIds = list.map((c) => c.id);
      const attachmentsByCommentId = new Map<string, AttachmentRow[]>();
      if (commentIds.length > 0) {
        const attRes = await db
          .from("feedback_attachments")
          .select("*")
          .in("comment_id", commentIds)
          .order("created_at", { ascending: true });
        if (attRes.error) {
          const code = (attRes.error as { code?: string }).code;
          if (code !== "42P01" && code !== "PGRST205") {
            console.warn("[FeedbackThread] load attachments", attRes.error);
          }
        } else {
          for (const row of (attRes.data ?? []) as AttachmentRow[]) {
            const arr = attachmentsByCommentId.get(row.comment_id) ?? [];
            arr.push(row);
            attachmentsByCommentId.set(row.comment_id, arr);
          }
        }
      }

      setComments(
        list.map((c) => ({
          ...c,
          profile: profilesById.get(c.user_id) ?? null,
          attachments: attachmentsByCommentId.get(c.id) ?? [],
        })),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentKind, questionId, submissionId]);

  const send = async () => {
    // El comment necesita un body O al menos un adjunto. Permitir
    // adjunto-sin-texto cubre el caso "el estudiante manda una captura
    // por sí sola" — la app ya no exige escribir un texto vacío para
    // poder compartir un archivo.
    const hasBody = body.trim().length > 0;
    const hasFiles = pendingFiles.length > 0;
    if (!hasBody && !hasFiles) return;
    if (!user) return;
    const text = hasBody ? body.trim() : "(adjuntos)";
    setSending(true);
    try {
      let t = thread;
      if (!t) {
        const { data, error } = await db
          .from("feedback_threads")
          .insert({
            parent_kind: parentKind,
            question_id: questionId,
            submission_id: submissionId,
          })
          .select("*")
          .single();
        if (error || !data) {
          console.error("[FeedbackThread] insert thread", error);
          toast.error(error?.message ?? "No se pudo abrir la conversación");
          return;
        }
        t = data as Thread;
        setThread(t);
      }
      // Insertamos pidiendo la fila de vuelta para que la UI optimista
      // tenga el id real y created_at del servidor — evita pintar un
      // comentario "fantasma" si load() después se queda corto.
      let inserted: Comment | null = null;
      const firstInsert = await db
        .from("feedback_comments")
        .insert({
          thread_id: t.id,
          user_id: user.id,
          body: text,
          author_role: isTeacher ? "teacher" : "student",
        })
        .select("id, thread_id, user_id, body, created_at, author_role")
        .single();
      if (firstInsert.error) {
        const code = (firstInsert.error as { code?: string }).code;
        if (code === "42703" || code === "PGRST204") {
          // Migración de author_role aún no aplicada — insertamos sin él.
          const fallback = await db
            .from("feedback_comments")
            .insert({ thread_id: t.id, user_id: user.id, body: text })
            .select("id, thread_id, user_id, body, created_at")
            .single();
          if (fallback.error || !fallback.data) {
            console.error("[FeedbackThread] insert comment", fallback.error);
            toast.error(fallback.error?.message ?? "No se pudo enviar el comentario");
            return;
          }
          inserted = fallback.data as Comment;
        } else {
          console.error("[FeedbackThread] insert comment", firstInsert.error);
          toast.error(firstInsert.error.message ?? "No se pudo enviar el comentario");
          return;
        }
      } else {
        inserted = firstInsert.data as Comment;
      }
      if (!inserted) {
        toast.error("No se pudo enviar el comentario");
        return;
      }
      // Subir archivos pendientes (si los hay) antes del append optimista
      // para que la UI pinte el comment ya con sus adjuntos en su lugar
      // — sin el "flash" de comment sin attachments y luego con ellos.
      const uploadedAttachments = await uploadPendingFiles((inserted as Comment).id);

      // Optimistic append: aunque load() falle por algún motivo, el
      // estudiante ve su comentario inmediatamente.
      setComments((prev) => [
        ...prev,
        {
          ...(inserted as Comment),
          author_role: isTeacher ? "teacher" : "student",
          profile: {
            full_name: user.user_metadata?.full_name ?? null,
            institutional_email: user.email ?? null,
          },
          attachments: uploadedAttachments,
        },
      ]);
      setBody("");
      setPendingFiles([]);
      // Refresca en background para tomar nombres reales desde profiles
      // (si user_metadata.full_name está vacío) y comentarios concurrentes.
      void load();
      // Notificar al caller que el thread cambió — el monitor docente
      // usa esto para refrescar el contador "diálogos pendientes" sin
      // esperar a que cambien las submissions. Best-effort.
      try {
        onChanged?.();
      } catch (_) {
        /* ignore */
      }
      // Notificar al otro lado de la conversación. Fire-and-forget:
      // si el RPC falla (p. ej. la migración aún no corrió), el
      // comentario igual quedó persistido y se ve.
      void db
        .rpc("notify_feedback_event", {
          _thread_id: t.id,
          _event: "comment",
          _actor_role: isTeacher ? "teacher" : "student",
        })
        .then(({ error: rpcErr }: { error: unknown }) => {
          if (rpcErr) console.warn("[FeedbackThread] notify rpc", rpcErr);
        });
    } finally {
      setSending(false);
    }
  };

  const toggleClosed = async () => {
    if (!thread || !user) return;
    const next = !thread.closed;
    const { error } = await db
      .from("feedback_threads")
      .update({
        closed: next,
        closed_at: next ? new Date().toISOString() : null,
        closed_by: next ? user.id : null,
      })
      .eq("id", thread.id);
    if (error) return toast.error(error.message);
    toast.success(next ? "Conversación cerrada" : "Conversación reabierta");
    await load();
    // Avisa al caller que cambió el estado del thread (refresca el
    // badge "Diálogo pendientes" en el monitor sin esperar al próximo
    // cambio de submissions).
    try {
      onChanged?.();
    } catch (_) {
      /* ignore */
    }
    void db
      .rpc("notify_feedback_event", {
        _thread_id: thread.id,
        _event: next ? "closed" : "reopened",
        _actor_role: "teacher",
      })
      .then(({ error: rpcErr }: { error: unknown }) => {
        if (rpcErr) console.warn("[FeedbackThread] notify rpc", rpcErr);
      });
  };

  const closed = !!thread?.closed;

  return (
    <div className={"rounded-md border bg-muted/20 p-3 space-y-2 " + (className ?? "")}>
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium flex items-center gap-1.5">
          <MessageSquare className="h-3 w-3" />
          Conversación
          {comments.length > 0 && (
            <span className="text-muted-foreground font-normal">({comments.length})</span>
          )}
          {closed && (
            <Badge variant="secondary" className="text-[9px] ml-1">
              Cerrada
            </Badge>
          )}
        </div>
        {isTeacher && thread && (
          <Button size="sm" variant="ghost" onClick={toggleClosed} className="h-6 text-[11px]">
            {closed ? <Unlock className="h-3 w-3 mr-1" /> : <Lock className="h-3 w-3 mr-1" />}
            {closed ? "Reabrir" : "Cerrar"}
          </Button>
        )}
      </div>

      {loading && (
        <p className="text-xs text-muted-foreground">
          <Spinner size="xs" inline className="mr-1" />
          Cargando…
        </p>
      )}

      {!loading && comments.length === 0 && (
        <p className="text-xs text-muted-foreground italic">
          {closed
            ? "Sin comentarios. La conversación está cerrada."
            : "Sin comentarios. Sé el primero en responder a esta retroalimentación."}
        </p>
      )}

      {!loading && comments.length > 0 && (
        <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
          {comments.map((c) => {
            const mine = c.user_id === user?.id;
            const isTeacherComment = c.author_role === "teacher";
            const isEditing = editingId === c.id;
            const isDeletingThis = deletingId === c.id;
            return (
              <div
                key={c.id}
                className={
                  "text-xs rounded-md border p-2 " +
                  (isTeacherComment
                    ? "bg-amber-500/5 border-amber-500/30"
                    : mine
                      ? "bg-primary/5 border-primary/20"
                      : "bg-background")
                }
              >
                <div className="flex items-center justify-between mb-1 gap-2">
                  <span className="font-medium truncate flex items-center gap-1.5">
                    {c.profile?.full_name ?? "Usuario"}
                    <Badge
                      variant="outline"
                      className={
                        "text-[9px] px-1 py-0 h-auto " +
                        (isTeacherComment
                          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30"
                          : "bg-primary/10 text-primary border-primary/30")
                      }
                    >
                      {isTeacherComment ? "Docente" : "Estudiante"}
                    </Badge>
                    {mine && (
                      <span className="text-muted-foreground font-normal text-[10px]">· tú</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {formatDateTime(c.created_at)}
                    </span>
                    {mine && !isEditing && !closed && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5"
                          onClick={() => startEdit(c)}
                          title="Editar"
                          disabled={isDeletingThis}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 text-destructive hover:text-destructive"
                          onClick={() => removeComment(c)}
                          title="Eliminar"
                          disabled={isDeletingThis}
                        >
                          {isDeletingThis ? <Spinner size="xs" /> : <Trash2 className="h-3 w-3" />}
                        </Button>
                      </>
                    )}
                  </span>
                </div>
                {isEditing ? (
                  <div className="space-y-1.5">
                    <Textarea
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      rows={2}
                      className="text-xs min-h-[2.5rem]"
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
                        className="h-6 text-[11px]"
                        onClick={cancelEdit}
                        disabled={savingEdit}
                      >
                        <X className="h-3 w-3 mr-1" />
                        Cancelar
                      </Button>
                      <Button
                        size="sm"
                        className="h-6 text-[11px]"
                        onClick={() => void saveEdit()}
                        disabled={savingEdit || !editingText.trim()}
                      >
                        {savingEdit ? (
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
                    <p className="whitespace-pre-wrap">{c.body}</p>
                    {c.attachments && c.attachments.length > 0 && (
                      <FeedbackCommentAttachments
                        attachments={c.attachments}
                        closed={closed}
                        onChanged={() => void load()}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!closed && !loading && user && (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={2}
              placeholder={comments.length === 0 ? "Escribe tu comentario…" : "Responder…"}
              className="text-xs min-h-[2.5rem]"
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
                data-testid="feedback-file-input"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9 px-2"
                onClick={() => fileInputRef.current?.click()}
                disabled={sending || pendingFiles.length >= FEEDBACK_ATTACHMENT_MAX_COUNT}
                title="Adjuntar archivos"
                aria-label="Adjuntar archivos"
              >
                <Paperclip className="h-3 w-3" />
              </Button>
              <Button
                size="sm"
                onClick={() => void send()}
                disabled={(!body.trim() && pendingFiles.length === 0) || sending}
                className="h-9"
              >
                {sending ? <Spinner size="xs" /> : <Send className="h-3 w-3" />}
              </Button>
            </div>
          </div>
          {pendingFiles.length > 0 && (
            <ul className="space-y-1" data-testid="feedback-pending-files">
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
      )}

      {closed && (
        <p className="text-[11px] text-muted-foreground italic">
          El docente cerró esta conversación.
        </p>
      )}
    </div>
  );
}
