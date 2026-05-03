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
    const { data: t } = await db
      .from("feedback_threads")
      .select("*")
      .eq("parent_kind", parentKind)
      .eq("question_id", questionId)
      .eq("submission_id", submissionId)
      .maybeSingle();
    setThread((t as Thread | null) ?? null);
    if (t) {
      const { data: cs } = await db
        .from("feedback_comments")
        .select("*, profile:profiles(full_name, institutional_email)")
        .eq("thread_id", (t as Thread).id)
        .order("created_at", { ascending: true });
      setComments((cs ?? []) as Comment[]);
    } else {
      setComments([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentKind, questionId, submissionId]);

  const send = async () => {
    if (!body.trim() || !user) return;
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
          toast.error(error?.message ?? "No se pudo abrir la conversación");
          return;
        }
        t = data as Thread;
        setThread(t);
      }
      const { error } = await db
        .from("feedback_comments")
        .insert({ thread_id: t.id, user_id: user.id, body: body.trim() });
      if (error) {
        toast.error(error.message);
        return;
      }
      setBody("");
      await load();
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
            return (
              <div
                key={c.id}
                className={
                  "text-xs rounded-md border p-2 " +
                  (mine ? "bg-primary/5 border-primary/20" : "bg-background")
                }
              >
                <div className="flex items-center justify-between mb-1 gap-2">
                  <span className="font-medium truncate">
                    {c.profile?.full_name ?? "Usuario"}
                    {mine && (
                      <span className="text-muted-foreground font-normal"> · tú</span>
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
