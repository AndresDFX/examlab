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
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Lock, Unlock, Send, Loader2 } from "lucide-react";
import { toast } from "sonner";

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
};

interface Props {
  parentKind: FeedbackParentKind;
  questionId: string;
  submissionId: string;
  /** Si true, muestra controles de cerrar / reabrir. Default false. */
  isTeacher?: boolean;
  className?: string;
}

export function FeedbackThread({
  parentKind,
  questionId,
  submissionId,
  isTeacher = false,
  className,
}: Props) {
  const { user } = useAuth();
  const [thread, setThread] = useState<Thread | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

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
          console.warn(
            "[FeedbackThread] author_role column missing; falling back",
          );
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
          ((profs ?? []) as Array<{
            id: string;
            full_name: string | null;
            institutional_email: string | null;
          }>).map((p) => [p.id, { full_name: p.full_name, institutional_email: p.institutional_email }]),
        );
      }
      setComments(
        list.map((c) => ({
          ...c,
          profile: profilesById.get(c.user_id) ?? null,
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
    if (!body.trim() || !user) return;
    const text = body.trim();
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
        },
      ]);
      setBody("");
      // Refresca en background para tomar nombres reales desde profiles
      // (si user_metadata.full_name está vacío) y comentarios concurrentes.
      void load();
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
          <Loader2 className="inline h-3 w-3 animate-spin mr-1" />
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
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {new Date(c.created_at).toLocaleString()}
                  </span>
                </div>
                <p className="whitespace-pre-wrap">{c.body}</p>
              </div>
            );
          })}
        </div>
      )}

      {!closed && !loading && user && (
        <div className="flex gap-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            placeholder={
              comments.length === 0 ? "Escribe tu comentario…" : "Responder…"
            }
            className="text-xs min-h-[2.5rem]"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button
            size="sm"
            onClick={() => void send()}
            disabled={!body.trim() || sending}
            className="self-end h-9"
          >
            {sending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Send className="h-3 w-3" />
            )}
          </Button>
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
