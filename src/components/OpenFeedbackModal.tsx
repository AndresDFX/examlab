/**
 * Modal "Conversaciones abiertas" del dashboard del docente.
 *
 * Lista los `feedback_threads` con `closed=false` que el docente puede
 * ver (RLS filtra por curso vía `is_question_course_teacher`).
 *
 * Para cada thread:
 *   - Resuelve el ref_id (exam_id / workshop_id / project_id) desde
 *     questions / workshop_questions / project_files según parent_kind.
 *   - Trae último comentario + autor.
 *   - Click → navega al deep-link que abre el dialog correspondiente,
 *     reusando el mismo formato que la RPC notify_feedback_event arma
 *     para las notificaciones de comentario.
 *
 * Queries planas + joins en JS — evita el problema que tenía el modal
 * anterior con embeds anidados (PostgREST devolvía 0 filas a veces por
 * schema cache).
 */
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  FileText,
  Hammer,
  FolderKanban,
  ArrowRight,
  Loader2,
  MessageSquareText,
} from "lucide-react";
import { formatDateTime } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type ParentKind = "exam" | "workshop" | "project";

type ThreadRow = {
  id: string;
  parent_kind: ParentKind;
  question_id: string;
  submission_id: string;
  created_at: string;
  // resueltos en JS
  refId?: string;
  refTitle?: string;
  questionTitle?: string;
  studentName?: string;
  lastComment?: { body: string; created_at: string; authorName: string } | null;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OpenFeedbackModal({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [threads, setThreads] = useState<ThreadRow[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: rawThreads, error } = await db
        .from("feedback_threads")
        .select("id, parent_kind, question_id, submission_id, created_at")
        .eq("closed", false)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) {
        console.warn("[OpenFeedbackModal]", error);
      }
      if (cancelled) return;

      const rows = (rawThreads ?? []) as Array<{
        id: string;
        parent_kind: ParentKind;
        question_id: string;
        submission_id: string;
        created_at: string;
      }>;
      if (rows.length === 0) {
        setThreads([]);
        setLoading(false);
        return;
      }

      // Resolver questions/files → ref_id (exam_id / workshop_id / project_id)
      // y title de la pregunta. Tres tablas distintas según parent_kind.
      const examQIds = rows.filter((r) => r.parent_kind === "exam").map((r) => r.question_id);
      const wsQIds = rows.filter((r) => r.parent_kind === "workshop").map((r) => r.question_id);
      const pjFileIds = rows.filter((r) => r.parent_kind === "project").map((r) => r.question_id);

      const [examQs, wsQs, pjFs] = await Promise.all([
        examQIds.length
          ? db.from("questions").select("id, exam_id, content").in("id", examQIds)
          : Promise.resolve({ data: [] }),
        wsQIds.length
          ? db.from("workshop_questions").select("id, workshop_id, content").in("id", wsQIds)
          : Promise.resolve({ data: [] }),
        pjFileIds.length
          ? db.from("project_files").select("id, project_id, title").in("id", pjFileIds)
          : Promise.resolve({ data: [] }),
      ]);

      const examQMap = new Map<string, { exam_id: string; content: string }>();
      ((examQs.data ?? []) as any[]).forEach((q) =>
        examQMap.set(q.id, { exam_id: q.exam_id, content: q.content }),
      );
      const wsQMap = new Map<string, { workshop_id: string; content: string }>();
      ((wsQs.data ?? []) as any[]).forEach((q) =>
        wsQMap.set(q.id, { workshop_id: q.workshop_id, content: q.content }),
      );
      const pjFMap = new Map<string, { project_id: string; title: string }>();
      ((pjFs.data ?? []) as any[]).forEach((f) =>
        pjFMap.set(f.id, { project_id: f.project_id, title: f.title }),
      );

      // Resolver ref → title (examen/taller/proyecto)
      const examIds = Array.from(new Set(Array.from(examQMap.values()).map((x) => x.exam_id)));
      const wsIds = Array.from(new Set(Array.from(wsQMap.values()).map((x) => x.workshop_id)));
      const pjIds = Array.from(new Set(Array.from(pjFMap.values()).map((x) => x.project_id)));
      const [exams, workshops, projects] = await Promise.all([
        examIds.length
          ? db.from("exams").select("id, title").in("id", examIds)
          : Promise.resolve({ data: [] }),
        wsIds.length
          ? db.from("workshops").select("id, title").in("id", wsIds)
          : Promise.resolve({ data: [] }),
        pjIds.length
          ? db.from("projects").select("id, title").in("id", pjIds)
          : Promise.resolve({ data: [] }),
      ]);
      const examTitleById = new Map<string, string>();
      ((exams.data ?? []) as any[]).forEach((x) => examTitleById.set(x.id, x.title));
      const wsTitleById = new Map<string, string>();
      ((workshops.data ?? []) as any[]).forEach((x) => wsTitleById.set(x.id, x.title));
      const pjTitleById = new Map<string, string>();
      ((projects.data ?? []) as any[]).forEach((x) => pjTitleById.set(x.id, x.title));

      // Último comentario por thread + autor
      const threadIds = rows.map((r) => r.id);
      const { data: comments } = await db
        .from("feedback_comments")
        .select("thread_id, user_id, body, created_at")
        .in("thread_id", threadIds)
        .order("created_at", { ascending: false });
      const lastByThread = new Map<
        string,
        { user_id: string; body: string; created_at: string }
      >();
      ((comments ?? []) as any[]).forEach((c) => {
        if (!lastByThread.has(c.thread_id)) {
          lastByThread.set(c.thread_id, {
            user_id: c.user_id,
            body: c.body,
            created_at: c.created_at,
          });
        }
      });

      // Profiles de últimos autores + de dueños de submissions (para mostrar nombre del estudiante)
      const submissionIds = rows.map((r) => r.submission_id);
      const examSubIds = rows.filter((r) => r.parent_kind === "exam").map((r) => r.submission_id);
      const wsSubIds = rows.filter((r) => r.parent_kind === "workshop").map((r) => r.submission_id);
      const pjSubIds = rows.filter((r) => r.parent_kind === "project").map((r) => r.submission_id);
      void submissionIds;

      const [examSubs, wsSubs, pjSubs] = await Promise.all([
        examSubIds.length
          ? db.from("submissions").select("id, user_id").in("id", examSubIds)
          : Promise.resolve({ data: [] }),
        wsSubIds.length
          ? db.from("workshop_submissions").select("id, user_id").in("id", wsSubIds)
          : Promise.resolve({ data: [] }),
        pjSubIds.length
          ? db.from("project_submissions").select("id, user_id").in("id", pjSubIds)
          : Promise.resolve({ data: [] }),
      ]);
      const subUserById = new Map<string, string>();
      ((examSubs.data ?? []) as any[]).forEach((s) => subUserById.set(s.id, s.user_id));
      ((wsSubs.data ?? []) as any[]).forEach((s) => subUserById.set(s.id, s.user_id));
      ((pjSubs.data ?? []) as any[]).forEach((s) => subUserById.set(s.id, s.user_id));

      const userIds = Array.from(
        new Set([
          ...Array.from(lastByThread.values()).map((c) => c.user_id),
          ...Array.from(subUserById.values()),
        ]),
      );
      const nameById = new Map<string, string>();
      if (userIds.length) {
        const { data: profs } = await db
          .from("profiles")
          .select("id, full_name")
          .in("id", userIds);
        ((profs ?? []) as any[]).forEach((p) => nameById.set(p.id, p.full_name));
      }

      const enriched: ThreadRow[] = rows.map((r) => {
        let refId: string | undefined;
        let refTitle: string | undefined;
        let qContent: string | undefined;
        if (r.parent_kind === "exam") {
          const q = examQMap.get(r.question_id);
          refId = q?.exam_id;
          qContent = q?.content;
          if (refId) refTitle = examTitleById.get(refId);
        } else if (r.parent_kind === "workshop") {
          const q = wsQMap.get(r.question_id);
          refId = q?.workshop_id;
          qContent = q?.content;
          if (refId) refTitle = wsTitleById.get(refId);
        } else {
          const f = pjFMap.get(r.question_id);
          refId = f?.project_id;
          qContent = f?.title;
          if (refId) refTitle = pjTitleById.get(refId);
        }
        const lastC = lastByThread.get(r.id);
        const studentUserId = subUserById.get(r.submission_id);
        return {
          ...r,
          refId,
          refTitle,
          questionTitle: qContent,
          studentName: studentUserId ? nameById.get(studentUserId) : undefined,
          lastComment: lastC
            ? {
                body: lastC.body,
                created_at: lastC.created_at,
                authorName: nameById.get(lastC.user_id) ?? "Usuario",
              }
            : null,
        };
      });

      setThreads(enriched);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const goToThread = (t: ThreadRow) => {
    if (!t.refId) return;
    onOpenChange(false);
    if (t.parent_kind === "exam") {
      navigate({ to: "/app/teacher/monitor/$examId", params: { examId: t.refId } });
    } else if (t.parent_kind === "workshop") {
      navigate({
        to: "/app/teacher/workshops",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        search: { workshop: t.refId, submission: t.submission_id } as any,
      });
    } else {
      navigate({
        to: "/app/teacher/projects",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        search: { project: t.refId, submission: t.submission_id } as any,
      });
    }
  };

  const groups: Record<ParentKind, ThreadRow[]> = {
    exam: [],
    workshop: [],
    project: [],
  };
  threads.forEach((t) => groups[t.parent_kind].push(t));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareText className="h-5 w-5" />
            Conversaciones abiertas
            {!loading && (
              <Badge variant="secondary" className="text-[10px]">
                {threads.length}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : threads.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No hay conversaciones abiertas 🎉
          </p>
        ) : (
          <div className="space-y-4">
            {groups.exam.length > 0 && (
              <Section
                icon={FileText}
                title="Exámenes"
                color="text-violet-500 dark:text-violet-400"
                count={groups.exam.length}
              >
                {groups.exam.map((t) => (
                  <ThreadRowItem key={t.id} thread={t} onGo={() => goToThread(t)} />
                ))}
              </Section>
            )}
            {groups.workshop.length > 0 && (
              <Section
                icon={Hammer}
                title="Talleres"
                color="text-amber-500 dark:text-amber-400"
                count={groups.workshop.length}
              >
                {groups.workshop.map((t) => (
                  <ThreadRowItem key={t.id} thread={t} onGo={() => goToThread(t)} />
                ))}
              </Section>
            )}
            {groups.project.length > 0 && (
              <Section
                icon={FolderKanban}
                title="Proyectos"
                color="text-rose-500 dark:text-rose-400"
                count={groups.project.length}
              >
                {groups.project.map((t) => (
                  <ThreadRowItem key={t.id} thread={t} onGo={() => goToThread(t)} />
                ))}
              </Section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({
  icon: Icon,
  title,
  color,
  count,
  children,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: any;
  title: string;
  color: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${color}`} />
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="outline" className="text-[10px]">
          {count}
        </Badge>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function ThreadRowItem({ thread, onGo }: { thread: ThreadRow; onGo: () => void }) {
  const lastBody = thread.lastComment?.body ?? "(sin comentarios)";
  const lastWhen = thread.lastComment?.created_at ?? thread.created_at;
  return (
    <div className="flex items-start gap-2 rounded-md border p-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">
          {thread.refTitle ?? "(eliminado)"}
        </div>
        <div className="text-xs text-muted-foreground truncate">
          {thread.studentName ?? "Estudiante"}
          {thread.questionTitle ? ` · ${thread.questionTitle}` : ""}
        </div>
        <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
          <span className="font-medium">
            {thread.lastComment?.authorName ?? "—"}:
          </span>{" "}
          {lastBody}
        </div>
        <div className="text-[10px] text-muted-foreground/70 mt-0.5">
          {formatDateTime(lastWhen)}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onGo}>
        Ir <ArrowRight className="h-3 w-3 ml-1" />
      </Button>
    </div>
  );
}
