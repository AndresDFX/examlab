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
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  FileText,
  Hammer,
  FolderKanban,
  ArrowRight,
  MessageSquareText,
  Reply,
  User,
  Lock,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime } from "@/shared/lib/format";
import { threadsPendingTeacherResponse } from "@/modules/grading/feedback-stats";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

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
  studentUserId?: string;
  courseName?: string;
  lastComment?: {
    created_at: string;
    authorName: string;
    userId: string;
    authorRole: string | null;
  } | null;
};

/**
 * Modo de filtrado del modal:
 *   - "all" (default): muestra todas las conversaciones abiertas
 *     (closed=false). Es el card "Conversaciones abiertas" del dashboard.
 *   - "needsMyResponse": para el DOCENTE — threads cuyo ÚLTIMO comment
 *     no es de un docente (estudiante esperando mi respuesta).
 *   - "studentNeedsResponse": para el ESTUDIANTE — threads cuyo ÚLTIMO
 *     comment ES de un docente (yo, alumno, debo responder).
 */
export type FeedbackFilterMode = "all" | "needsMyResponse" | "studentNeedsResponse";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Default "all". */
  filterMode?: FeedbackFilterMode;
}

type GroupBy = "type" | "student";

export function OpenFeedbackModal({ open, onOpenChange, filterMode = "all" }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [groupBy, setGroupBy] = useState<GroupBy>("type");

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

      // Resolver ref → title + course_id (examen/taller/proyecto)
      const examIds = Array.from(new Set(Array.from(examQMap.values()).map((x) => x.exam_id)));
      const wsIds = Array.from(new Set(Array.from(wsQMap.values()).map((x) => x.workshop_id)));
      const pjIds = Array.from(new Set(Array.from(pjFMap.values()).map((x) => x.project_id)));
      const [exams, workshops, projects] = await Promise.all([
        examIds.length
          ? db.from("exams").select("id, title, course_id").in("id", examIds)
          : Promise.resolve({ data: [] }),
        wsIds.length
          ? db.from("workshops").select("id, title, course_id").in("id", wsIds)
          : Promise.resolve({ data: [] }),
        pjIds.length
          ? db.from("projects").select("id, title, course_id").in("id", pjIds)
          : Promise.resolve({ data: [] }),
      ]);
      const examInfoById = new Map<string, { title: string; course_id: string | null }>();
      ((exams.data ?? []) as any[]).forEach((x) =>
        examInfoById.set(x.id, { title: x.title, course_id: x.course_id ?? null }),
      );
      const wsInfoById = new Map<string, { title: string; course_id: string | null }>();
      ((workshops.data ?? []) as any[]).forEach((x) =>
        wsInfoById.set(x.id, { title: x.title, course_id: x.course_id ?? null }),
      );
      const pjInfoById = new Map<string, { title: string; course_id: string | null }>();
      ((projects.data ?? []) as any[]).forEach((x) =>
        pjInfoById.set(x.id, { title: x.title, course_id: x.course_id ?? null }),
      );

      // Resolver course names para mostrar contexto al docente.
      const courseIds = Array.from(
        new Set(
          [
            ...Array.from(examInfoById.values()).map((v) => v.course_id),
            ...Array.from(wsInfoById.values()).map((v) => v.course_id),
            ...Array.from(pjInfoById.values()).map((v) => v.course_id),
          ].filter(Boolean) as string[],
        ),
      );
      const courseNameById = new Map<string, string>();
      if (courseIds.length) {
        const { data: courses } = await db.from("courses").select("id, name").in("id", courseIds);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((courses ?? []) as any[]).forEach((c) => courseNameById.set(c.id, c.name));
      }

      // Último comentario por thread + autor + rol. `author_role` se usa
      // para el filtro rol-based de "needsMyResponse" (cualquier teacher
      // cuenta como respondido).
      const threadIds = rows.map((r) => r.id);
      const { data: comments } = await db
        .from("feedback_comments")
        .select("thread_id, user_id, body, author_role, created_at")
        .in("thread_id", threadIds)
        .order("created_at", { ascending: false });
      const lastByThread = new Map<
        string,
        { user_id: string; body: string; author_role: string | null; created_at: string }
      >();
      ((comments ?? []) as any[]).forEach((c) => {
        if (!lastByThread.has(c.thread_id)) {
          lastByThread.set(c.thread_id, {
            user_id: c.user_id,
            body: c.body,
            author_role: c.author_role ?? null,
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
        const { data: profs } = await db.from("profiles").select("id, full_name").in("id", userIds);
        ((profs ?? []) as any[]).forEach((p) => nameById.set(p.id, p.full_name));
      }

      const enriched: ThreadRow[] = rows.map((r) => {
        let refId: string | undefined;
        let refTitle: string | undefined;
        let qContent: string | undefined;
        let courseId: string | null | undefined;
        if (r.parent_kind === "exam") {
          const q = examQMap.get(r.question_id);
          refId = q?.exam_id;
          qContent = q?.content;
          const info = refId ? examInfoById.get(refId) : undefined;
          refTitle = info?.title;
          courseId = info?.course_id;
        } else if (r.parent_kind === "workshop") {
          const q = wsQMap.get(r.question_id);
          refId = q?.workshop_id;
          qContent = q?.content;
          const info = refId ? wsInfoById.get(refId) : undefined;
          refTitle = info?.title;
          courseId = info?.course_id;
        } else {
          const f = pjFMap.get(r.question_id);
          refId = f?.project_id;
          qContent = f?.title;
          const info = refId ? pjInfoById.get(refId) : undefined;
          refTitle = info?.title;
          courseId = info?.course_id;
        }
        const lastC = lastByThread.get(r.id);
        const studentUserId = subUserById.get(r.submission_id);
        return {
          ...r,
          refId,
          refTitle,
          questionTitle: qContent,
          studentName: studentUserId ? nameById.get(studentUserId) : undefined,
          studentUserId,
          courseName: courseId ? courseNameById.get(courseId) : undefined,
          lastComment: lastC
            ? {
                created_at: lastC.created_at,
                authorName: nameById.get(lastC.user_id) ?? t("hc_modulesGradingOpenFeedbackModal.userFallback"),
                userId: lastC.user_id,
                authorRole: lastC.author_role,
              }
            : null,
        };
      });

      // Filtrado por modo.
      //   - "needsMyResponse" (docente): threads cuyo último comment NO
      //     es de un docente (alguien — un estudiante — espera respuesta).
      //   - "studentNeedsResponse" (estudiante): threads cuyo último
      //     comment SÍ es de un docente (alumno debe responder).
      // Cualquier docente del curso cuenta como "respondido" —
      // ver feedback-stats.ts.
      let final = enriched;
      if (filterMode === "needsMyResponse" || filterMode === "studentNeedsResponse") {
        const allowed = threadsPendingTeacherResponse(
          enriched.map((t) => t.id),
          enriched
            .map((t) =>
              t.lastComment
                ? {
                    thread_id: t.id,
                    author_role: t.lastComment.authorRole,
                    created_at: t.lastComment.created_at,
                  }
                : null,
            )
            .filter(
              (x): x is { thread_id: string; author_role: string | null; created_at: string } =>
                x !== null,
            ),
        );
        // "needsMyResponse" = allowed (pendientes del docente);
        // "studentNeedsResponse" = inverso (pendientes del estudiante).
        final =
          filterMode === "needsMyResponse"
            ? enriched.filter((t) => allowed.has(t.id))
            : enriched.filter((t) => !allowed.has(t.id) && t.lastComment != null);
      }

      setThreads(final);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, filterMode]);

  /**
   * Cierra el thread directamente desde el modal — espeja la acción del
   * botón "Cerrar" que vive dentro del FeedbackThread, pero accesible
   * sin navegar a la entidad padre. Al cerrar, el thread sale del SELECT
   * (closed=false) y desaparece de la lista en el próximo refresh.
   * Hacemos un optimistic remove del state local para que la fila
   * desaparezca al instante.
   */
  const closeThread = async (t: ThreadRow) => {
    const { error } = await db
      .from("feedback_threads")
      .update({
        closed: true,
        closed_at: new Date().toISOString(),
      })
      .eq("id", t.id);
    if (error) {
      toast.error(friendlyError(error, i18n.t("hc_modulesGradingOpenFeedbackModal.closeError")));
      return;
    }
    // Optimistic: sacamos del state.
    setThreads((prev) => prev.filter((x) => x.id !== t.id));
    toast.success(
      i18n.t("toast.modules_grading_OpenFeedbackModal.conversationClosed", {
        defaultValue: "Conversación cerrada",
      }),
    );
    // Notify event para que el otro extremo (estudiante) vea el badge
    // actualizado y, si está, el FeedbackThread se cierre.
    void db.rpc("notify_feedback_event", {
      _thread_id: t.id,
      _event: "closed",
      _actor_role: "teacher",
    });
  };

  const goToThread = (t: ThreadRow) => {
    if (!t.refId) return;
    onOpenChange(false);
    if (t.parent_kind === "exam") {
      // monitor lee:
      //   ?student=USER_ID      → auto-abre el dialog de intentos.
      //   ?submission=SUB_ID    → auto-abre el dialog de respuestas
      //                           del intento (Eye en la fila).
      //   ?question=QUESTION_ID → scrollea + ring temporal a la card de
      //                           la pregunta dentro del dialog.
      navigate({
        to: "/app/teacher/monitor/$examId",
        params: { examId: t.refId },
        search: {
          ...(t.studentUserId ? { student: t.studentUserId } : {}),
          submission: t.submission_id,
          question: t.question_id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
    } else if (t.parent_kind === "workshop") {
      navigate({
        to: "/app/teacher/workshops",
        search: {
          workshop: t.refId,
          submission: t.submission_id,
          question: t.question_id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
    } else {
      navigate({
        to: "/app/teacher/projects",
        search: {
          project: t.refId,
          submission: t.submission_id,
          // En proyectos cada thread es por archivo (project_files.id).
          file: t.question_id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
    }
  };

  const groupsByType: Record<ParentKind, ThreadRow[]> = {
    exam: [],
    workshop: [],
    project: [],
  };
  threads.forEach((t) => groupsByType[t.parent_kind].push(t));

  // Agrupación por estudiante: el "id de grupo" es studentUserId si existe;
  // los threads cuyo dueño no se resolvió van a una sección "Sin estudiante".
  const studentGroupsMap = new Map<string, { name: string; threads: ThreadRow[] }>();
  threads.forEach((t) => {
    const key = t.studentUserId ?? "__unknown__";
    const name = t.studentName ?? i18n.t("hc_modulesGradingOpenFeedbackModal.unknownStudent");
    const g = studentGroupsMap.get(key);
    if (g) g.threads.push(t);
    else studentGroupsMap.set(key, { name, threads: [t] });
  });
  const studentGroups = Array.from(studentGroupsMap.entries())
    .map(([key, g]) => ({ key, ...g }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-xl max-h-[85dvh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {filterMode === "needsMyResponse" || filterMode === "studentNeedsResponse" ? (
              <Reply className="h-5 w-5" />
            ) : (
              <MessageSquareText className="h-5 w-5" />
            )}
            {filterMode === "needsMyResponse"
              ? t("hc_modulesGradingOpenFeedbackModal.titleNeedsMyResponse")
              : filterMode === "studentNeedsResponse"
                ? t("hc_modulesGradingOpenFeedbackModal.titleStudentNeedsResponse")
                : t("hc_modulesGradingOpenFeedbackModal.titleOpen")}
            {!loading && (
              <Badge variant="secondary" className="text-[10px]">
                {threads.length}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Spinner size="md" /> {t("hc_modulesGradingOpenFeedbackModal.loading")}
          </div>
        ) : threads.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {filterMode === "needsMyResponse"
              ? t("hc_modulesGradingOpenFeedbackModal.emptyNeedsMyResponse")
              : filterMode === "studentNeedsResponse"
                ? t("hc_modulesGradingOpenFeedbackModal.emptyStudentNeedsResponse")
                : t("hc_modulesGradingOpenFeedbackModal.emptyOpen")}
          </p>
        ) : (
          <div className="space-y-4 min-w-0">
            {/* Toggle de agrupación */}
            <div className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground mr-1">{t("hc_modulesGradingOpenFeedbackModal.groupBy")}</span>
              <Button
                size="sm"
                variant={groupBy === "type" ? "secondary" : "ghost"}
                className="h-7 px-2"
                onClick={() => setGroupBy("type")}
              >
                {t("hc_modulesGradingOpenFeedbackModal.groupByType")}
              </Button>
              <Button
                size="sm"
                variant={groupBy === "student" ? "secondary" : "ghost"}
                className="h-7 px-2"
                onClick={() => setGroupBy("student")}
              >
                {t("hc_modulesGradingOpenFeedbackModal.groupByStudent")}
              </Button>
            </div>

            {groupBy === "type" ? (
              <>
                {groupsByType.exam.length > 0 && (
                  <Section
                    icon={FileText}
                    title={t("hc_modulesGradingOpenFeedbackModal.sectionExams")}
                    color="text-violet-500 dark:text-violet-400"
                    count={groupsByType.exam.length}
                  >
                    {groupsByType.exam.map((t) => (
                      <ThreadRowItem
                        key={t.id}
                        thread={t}
                        onGo={() => goToThread(t)}
                        onClose={() => void closeThread(t)}
                      />
                    ))}
                  </Section>
                )}
                {groupsByType.workshop.length > 0 && (
                  <Section
                    icon={Hammer}
                    title={t("hc_modulesGradingOpenFeedbackModal.sectionWorkshops")}
                    color="text-amber-500 dark:text-amber-400"
                    count={groupsByType.workshop.length}
                  >
                    {groupsByType.workshop.map((t) => (
                      <ThreadRowItem
                        key={t.id}
                        thread={t}
                        onGo={() => goToThread(t)}
                        onClose={() => void closeThread(t)}
                      />
                    ))}
                  </Section>
                )}
                {groupsByType.project.length > 0 && (
                  <Section
                    icon={FolderKanban}
                    title={t("hc_modulesGradingOpenFeedbackModal.sectionProjects")}
                    color="text-rose-500 dark:text-rose-400"
                    count={groupsByType.project.length}
                  >
                    {groupsByType.project.map((t) => (
                      <ThreadRowItem
                        key={t.id}
                        thread={t}
                        onGo={() => goToThread(t)}
                        onClose={() => void closeThread(t)}
                      />
                    ))}
                  </Section>
                )}
              </>
            ) : (
              <>
                {studentGroups.map((g) => (
                  <Section
                    key={g.key}
                    icon={User}
                    title={g.name}
                    color="text-sky-500 dark:text-sky-400"
                    count={g.threads.length}
                  >
                    {g.threads.map((t) => (
                      <ThreadRowItem
                        key={t.id}
                        thread={t}
                        onGo={() => goToThread(t)}
                        onClose={() => void closeThread(t)}
                        hideStudent
                      />
                    ))}
                  </Section>
                ))}
              </>
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
    <div className="space-y-2 min-w-0">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${color}`} />
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="outline" className="text-[10px]">
          {count}
        </Badge>
      </div>
      <div className="space-y-1.5 min-w-0">{children}</div>
    </div>
  );
}

function ThreadRowItem({
  thread,
  onGo,
  onClose,
  hideStudent,
}: {
  thread: ThreadRow;
  onGo: () => void;
  onClose?: () => void;
  hideStudent?: boolean;
}) {
  const { t } = useTranslation();
  const lastWhen = thread.lastComment?.created_at ?? thread.created_at;
  const lastAuthor = thread.lastComment?.authorName;
  // En el modo "Por estudiante" el nombre ya es el header de la sección,
  // así que el título de la fila pasa a ser el ref (examen/taller/proyecto).
  const primary = hideStudent
    ? (thread.refTitle ?? t("hc_modulesGradingOpenFeedbackModal.deleted"))
    : (thread.studentName ?? t("hc_modulesGradingOpenFeedbackModal.student"));
  const secondary = hideStudent
    ? thread.courseName ?? ""
    : `${thread.courseName ? `${thread.courseName} · ` : ""}${thread.refTitle ?? t("hc_modulesGradingOpenFeedbackModal.deleted")}`;
  return (
    <div className="flex w-full min-w-0 items-center gap-2 rounded-md border p-2.5">
      <div className="min-w-0 flex-1 space-y-0.5 overflow-hidden">
        <div className="text-sm font-medium truncate">{primary}</div>
        <div className="text-xs text-muted-foreground truncate">{secondary}</div>
        {thread.questionTitle && (
          <div className="text-[11px] text-muted-foreground/80 truncate break-words">
            {thread.questionTitle}
          </div>
        )}
        <div className="text-[10px] text-muted-foreground/70 truncate tabular-nums">
          {lastAuthor ? t("hc_modulesGradingOpenFeedbackModal.lastAuthor", { author: lastAuthor }) : ""}
          {formatDateTime(lastWhen)}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {/* Cerrar inline: dismissea el thread sin navegar. Util cuando ya
            respondiste en otro lado o no requiere acción. La fila
            desaparece optimistamente y se persiste closed=true en DB. */}
        {onClose && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={onClose}
            aria-label={t("hc_modulesGradingOpenFeedbackModal.closeConversation")}
            title={t("hc_modulesGradingOpenFeedbackModal.closeConversation")}
          >
            <Lock className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onGo}>
          {t("hc_modulesGradingOpenFeedbackModal.go")} <ArrowRight className="h-3 w-3 ml-1" />
        </Button>
      </div>
    </div>
  );
}
