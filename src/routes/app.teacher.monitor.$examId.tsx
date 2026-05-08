import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import {
  Clock,
  AlertTriangle,
  Sparkles,
  Trash2,
  Eye,
  Save,
  TimerReset,
  MessageSquareText,
} from "lucide-react";
import { warningLabel, warningEventTimestamp, type WarningEvent } from "@/utils/proctoring";
import { statusLabel } from "@/utils/status-labels";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableEmpty } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/format";
import {
  computeFinalGrade,
  type BreakdownItem as GradeBreakdown,
  type ManualOverride as GradeManual,
} from "@/utils/grade";
import { computeAttemptGrade, retryModeLabel, type RetryMode } from "@/utils/exam-attempts";
import { useConfirm } from "@/components/ConfirmDialog";
import { FeedbackThread } from "@/components/FeedbackThread";
import { FraudPanel } from "@/components/FraudPanel";
import { DecimalInput } from "@/components/ui/decimal-input";
import { RowAction } from "@/components/ui/row-action";
import { CodeRunOutput } from "@/components/CodeRunOutput";
import { CodeEditor, type CodeLanguage } from "@/components/CodeEditor";

export const Route = createFileRoute("/app/teacher/monitor/$examId")({
  component: ExamMonitor,
  validateSearch: (s: Record<string, unknown>) => ({
    student: typeof s.student === "string" ? s.student : undefined,
    submission: typeof s.submission === "string" ? s.submission : undefined,
    question: typeof s.question === "string" ? s.question : undefined,
  }),
});

type Submission = {
  id: string;
  user_id: string;
  status: string;
  focus_warnings: number;
  answers: any;
  ai_grade: number | null;
  final_override_grade: number | null;
  created_at: string;
  started_at: string | null;
  submitted_at: string | null;
  /** Tiempo extra concedido por el docente (segundos). 0 si no se ha
   * agregado. Se suma a la fecha fin teórica del intento. */
  extra_seconds: number;
  profile?: { full_name: string; institutional_email: string };
};

type Question = {
  id: string;
  type: string;
  content: string;
  options: any;
  points: number;
  position: number;
  expected_rubric: string | null;
  language?: string | null;
};

type BreakdownItem = {
  qid: string;
  type?: string;
  points: number;
  earned: number;
  feedback?: string;
};

type ManualOverride = { score: number; feedback?: string };

const isFinalStatus = (s: string) => s === "completado" || s === "sospechoso";

/**
 * Calcula la fecha fin de un intento. Para intentos terminados es
 * `submitted_at`; para intentos en curso es `min(exam.end_time,
 * started_at + time_limit*60s) + extra_seconds`. El extra_seconds
 * lo concede el docente con el botón +5m del monitor.
 */
function computeAttemptEnd(
  sub: { submitted_at: string | null; started_at: string | null; extra_seconds?: number },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exam: any,
): Date | null {
  if (sub.submitted_at) return new Date(sub.submitted_at);
  if (!sub.started_at) return null;
  const startedAt = new Date(sub.started_at).getTime();
  const timeLimitMs = Number(exam?.time_limit_minutes ?? 0) * 60_000;
  const examEnd = exam?.end_time ? new Date(exam.end_time).getTime() : Infinity;
  const naturalEnd = Math.min(examEnd, startedAt + timeLimitMs);
  return new Date(naturalEnd + (sub.extra_seconds ?? 0) * 1000);
}

function ExamMonitor() {
  const { examId } = Route.useParams();
  const { user } = useAuth();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const [exam, setExam] = useState<any>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState<string | null>(null);
  const [aiGradingId, setAiGradingId] = useState<string | null>(null);
  const [aiGradingQid, setAiGradingQid] = useState<string | null>(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [attemptsForUser, setAttemptsForUser] = useState<string | null>(null);
  // Una sola vez al cargar: si la URL trae ?student=USER_ID (link de
  // notificación de feedback), abrimos el modal de intentos de ese
  // estudiante en cuanto haya datos. Sin esto el docente caía en el
  // grid genérico y tenía que buscar al estudiante a mano.
  const [autoOpenedFromUrl, setAutoOpenedFromUrl] = useState(false);
  // Question_id a destacar dentro del modal "Respuestas" cuando el
  // deep-link viene del modal de Conversaciones abiertas. Aplica un
  // ring temporal y scroll a la card de la pregunta.
  const [highlightQuestionId, setHighlightQuestionId] = useState<string | null>(null);
  const [overrideValue, setOverrideValue] = useState<number | null>(null);
  const [savingOverride, setSavingOverride] = useState(false);
  const [qOverrides, setQOverrides] = useState<
    Record<string, { score: number | null; feedback: string }>
  >({});
  const [savingQid, setSavingQid] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: e } = await (supabase as any)
      .from("exams")
      .select("*, course:courses(name, grade_scale_max, max_exam_attempts)")
      .eq("id", examId)
      .single();
    setExam(e);

    // extra_seconds aún no está en types.ts auto-generados; casteamos
    // a any para que el cliente lo selecte sin que el typing lo bloquee.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: subs } = await (supabase as any)
      .from("submissions")
      .select(
        "id, user_id, status, focus_warnings, answers, ai_grade, final_override_grade, created_at, started_at, submitted_at, extra_seconds",
      )
      .eq("exam_id", examId)
      .order("created_at", { ascending: true });

    if (subs?.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const subsArr = subs as any[];
      const userIds = Array.from(new Set(subsArr.map((s) => s.user_id as string)));
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      setSubmissions(
        subsArr.map((s) => ({ ...s, profile: profileMap.get(s.user_id) })) as Submission[],
      );
    } else {
      setSubmissions([]);
    }
  }, [examId]);

  const loadQuestions = useCallback(async () => {
    const { data } = await supabase
      .from("questions")
      .select("id, type, content, options, points, position, expected_rubric, language")
      .eq("exam_id", examId)
      .order("position", { ascending: true });
    setQuestions((data ?? []) as Question[]);
  }, [examId]);

  // Conteo de conversaciones abiertas y de "respuestas pendientes" por
  // estudiante en este examen.
  //   - openThreadsByUser: total de threads con closed=false del alumno.
  //   - pendingReplyByUser: subconjunto donde la ÚLTIMA comment fue del
  //     alumno → el docente debe responder. Si el último comentario es
  //     del docente, esperamos al alumno y no cuenta como pendiente.
  // Se carga cuando cambian las submissions. (Si en el futuro queremos
  // realtime, suscribimos a feedback_comments filtrado por thread_id IN
  // (...) — por ahora un load on submissions-change es suficiente para
  // el flujo de revisión).
  const [openThreadsByUser, setOpenThreadsByUser] = useState<Record<string, number>>({});
  const [pendingReplyByUser, setPendingReplyByUser] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!submissions.length) {
      setOpenThreadsByUser({});
      setPendingReplyByUser({});
      return;
    }
    const subUserById = new Map(submissions.map((s) => [s.id, s.user_id]));
    const subIds = submissions.map((s) => s.id);
    let cancelled = false;
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: threads } = await (supabase as any)
        .from("feedback_threads")
        .select("id, submission_id")
        .eq("parent_kind", "exam")
        .eq("closed", false)
        .in("submission_id", subIds);
      if (cancelled) return;
      const threadsArr = (threads ?? []) as { id: string; submission_id: string }[];
      const openCounts: Record<string, number> = {};
      const threadOwner = new Map<string, string>();
      for (const t of threadsArr) {
        const uid = subUserById.get(t.submission_id);
        if (!uid) continue;
        openCounts[uid] = (openCounts[uid] ?? 0) + 1;
        threadOwner.set(t.id, uid);
      }
      setOpenThreadsByUser(openCounts);

      // Comments para determinar el ÚLTIMO autor de cada thread.
      const threadIds = threadsArr.map((t) => t.id);
      if (threadIds.length === 0) {
        setPendingReplyByUser({});
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: comments } = await (supabase as any)
        .from("feedback_comments")
        .select("thread_id, user_id, created_at")
        .in("thread_id", threadIds)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      const lastByThread = new Map<string, string>(); // thread_id → user_id del último comentario
      for (const c of (comments ?? []) as {
        thread_id: string;
        user_id: string;
        created_at: string;
      }[]) {
        if (!lastByThread.has(c.thread_id)) lastByThread.set(c.thread_id, c.user_id);
      }
      const pendingCounts: Record<string, number> = {};
      for (const [threadId, ownerUid] of threadOwner.entries()) {
        const lastAuthor = lastByThread.get(threadId);
        // Pendiente si el último comentario lo escribió el ALUMNO
        // (dueño de la submission). Si todavía no hay comentarios,
        // tampoco lo contamos como pendiente — un thread vacío suele
        // ser ruido o un placeholder.
        if (lastAuthor && lastAuthor === ownerUid) {
          pendingCounts[ownerUid] = (pendingCounts[ownerUid] ?? 0) + 1;
        }
      }
      setPendingReplyByUser(pendingCounts);
    })();
    return () => {
      cancelled = true;
    };
  }, [submissions]);

  // Deep-link desde notificación o modal "Conversaciones abiertas":
  //   ?student=USER_ID      → abre el modal de intentos del estudiante.
  //   ?submission=SUB_ID    → además abre el modal "Respuestas" para
  //                           ese intento (Eye en la fila).
  //   ?question=Q_ID        → además scrollea + ring temporal a la card
  //                           de esa pregunta dentro del modal.
  // Solo se intenta una vez; espera a tener al menos un submission
  // cargado para no saltar a un estudiante sin datos.
  useEffect(() => {
    if (autoOpenedFromUrl || submissions.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const studentParam = params.get("student");
    const submissionParam = params.get("submission");
    const questionParam = params.get("question");
    if (studentParam) {
      setAttemptsForUser(studentParam);
    }
    if (submissionParam) {
      const sub = submissions.find((s) => s.id === submissionParam);
      if (sub) {
        openView(sub);
      }
    }
    if (questionParam) {
      setHighlightQuestionId(questionParam);
    }
    // Limpia los params para que un refresh no re-dispare.
    if (studentParam || submissionParam || questionParam) {
      const url = new URL(window.location.href);
      url.searchParams.delete("student");
      url.searchParams.delete("submission");
      url.searchParams.delete("question");
      window.history.replaceState({}, "", url.toString());
    }
    setAutoOpenedFromUrl(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissions, autoOpenedFromUrl]);

  // Scroll + ring temporal a la pregunta destacada cuando el modal
  // "Respuestas" ya está abierto (viewingId presente). Se limpia tras
  // 3.5s y al cerrar el modal para no re-disparar.
  useEffect(() => {
    if (!viewingId || !highlightQuestionId) return;
    const t = setTimeout(() => {
      const el = document.getElementById(`exam-q-${highlightQuestionId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
    const clear = setTimeout(() => setHighlightQuestionId(null), 3500);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [viewingId, highlightQuestionId]);

  useEffect(() => {
    load();
    loadQuestions();
    const interval = setInterval(load, 10000);

    const channel = supabase
      .channel(`monitor-submissions-${examId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "submissions",
          filter: `exam_id=eq.${examId}`,
        },
        () => {
          void load();
        },
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      void supabase.removeChannel(channel);
    };
  }, [load, loadQuestions, examId]);

  const sendTimerControl = async (
    action: "pause" | "resume" | "add_time",
    targetUserId: string | null,
    extraSeconds = 0,
  ) => {
    if (!user) return;
    const key = `${action}-${targetUserId ?? "global"}`;
    setLoading(key);
    const { error } = await supabase.from("exam_timer_controls").insert({
      exam_id: examId,
      target_user_id: targetUserId,
      action,
      extra_seconds: extraSeconds,
      created_by: user.id,
    });
    if (error) {
      setLoading(null);
      return toast.error(error.message);
    }

    // Para add_time: persistimos el extra en la submission del estudiante
    // para que el monitor muestre la fecha fin diferente y sobreviva
    // refreshes (no depender solo del realtime hook del estudiante).
    if (action === "add_time" && targetUserId && extraSeconds > 0) {
      const inProg = submissions.find(
        (s) => s.user_id === targetUserId && s.status === "en_progreso",
      );
      if (inProg) {
        const nextExtra = (inProg.extra_seconds ?? 0) + extraSeconds;
        const { error: subErr } = await supabase
          .from("submissions")
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .update({ extra_seconds: nextExtra } as any)
          .eq("id", inProg.id);
        if (subErr) {
          setLoading(null);
          return toast.error(subErr.message);
        }
        setSubmissions((prev) =>
          prev.map((s) => (s.id === inProg.id ? { ...s, extra_seconds: nextExtra } : s)),
        );
      }
    }
    // Para add_time global: aplicamos el extra a todos los intentos
    // en curso (la fecha fin de cada uno se corre por igual).
    if (action === "add_time" && !targetUserId && extraSeconds > 0) {
      const inProgIds = submissions.filter((s) => s.status === "en_progreso").map((s) => s.id);
      if (inProgIds.length) {
        // Una sola query por id — postgres no soporta UPDATE con
        // expresión sobre el campo via JS client de manera idiomática
        // sin RPC, así que lo hacemos uno por uno.
        for (const id of inProgIds) {
          const cur = submissions.find((s) => s.id === id);
          const nextExtra = (cur?.extra_seconds ?? 0) + extraSeconds;
          await supabase
            .from("submissions")
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .update({ extra_seconds: nextExtra } as any)
            .eq("id", id);
        }
        setSubmissions((prev) =>
          prev.map((s) =>
            s.status === "en_progreso"
              ? { ...s, extra_seconds: (s.extra_seconds ?? 0) + extraSeconds }
              : s,
          ),
        );
      }
    }
    setLoading(null);

    const labels: Record<string, string> = {
      pause: "Temporizador pausado",
      resume: "Temporizador reanudado",
      add_time: `+${Math.floor(extraSeconds / 60)} minuto(s) añadidos`,
    };
    toast.success(`${labels[action]} ${targetUserId ? "(estudiante)" : "(global)"}`);
  };

  const reGradeWithAI = async (sub: Submission, questionId?: string) => {
    if (questionId) setAiGradingQid(questionId);
    else setAiGradingId(sub.id);
    try {
      const { data, error } = await supabase.functions.invoke("ai-grade-submission", {
        body: questionId ? { submissionId: sub.id, questionId } : { submissionId: sub.id },
      });
      if (error || data?.error) {
        toast.error(data?.error ?? error?.message ?? "Error al calificar con IA");
        return;
      }
      toast.success(
        questionId ? "Pregunta recalificada con IA" : "Examen recalificado con IA correctamente",
      );
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Error desconocido");
    } finally {
      setAiGradingId(null);
      setAiGradingQid(null);
    }
  };

  // (deleteSubmission ahora vive en deleteOneAttempt / deleteAllAttempts dentro del dialog)

  const openView = (sub: Submission) => {
    setViewingId(sub.id);
    const cur = sub.final_override_grade ?? sub.ai_grade;
    setOverrideValue(cur != null ? Number(cur) : null);
    const manual: Record<string, ManualOverride> = sub.answers?.__manual_overrides ?? {};
    const next: Record<string, { score: number | null; feedback: string }> = {};
    for (const [qid, v] of Object.entries(manual)) {
      next[qid] = {
        score: v.score != null ? Number(v.score) : null,
        feedback: v.feedback ?? "",
      };
    }
    setQOverrides(next);
  };

  const saveOverride = async (sub: Submission) => {
    const numValue = overrideValue;
    if (numValue != null && (Number.isNaN(numValue) || numValue < 0 || numValue > 5)) {
      toast.error("La calificación debe ser un número entre 0 y 5");
      return;
    }
    setSavingOverride(true);
    const { error } = await supabase
      .from("submissions")
      .update({ final_override_grade: numValue })
      .eq("id", sub.id);
    setSavingOverride(false);
    if (error) return toast.error(error.message);
    toast.success(
      numValue == null ? "Calificación manual eliminada" : "Calificación guardada correctamente",
    );
    setSubmissions((prev) =>
      prev.map((s) => (s.id === sub.id ? { ...s, final_override_grade: numValue } : s)),
    );
  };

  // Borra TODAS las advertencias de un intento: focus_warnings=0,
  // limpia __warning_events del JSON, y si el intento estaba en
  // status='sospechoso' lo regresa a 'completado' (porque sospechoso
  // se setea precisamente cuando supera el umbral de strikes).
  const clearAllWarnings = async (sub: Submission) => {
    const ok = await confirm({
      title: "Limpiar advertencias",
      description:
        "Se eliminarán todas las advertencias de este intento. " +
        (sub.status === "sospechoso"
          ? "Como el intento está marcado como sospechoso, se regresará a estado 'completado'. "
          : "") +
        "Esta acción no se puede deshacer.",
      confirmLabel: "Limpiar",
      tone: "warning",
    });
    if (!ok) return;
    const prevAnswers = sub.answers ?? {};
    const { __warning_events: _evs, ...rest } = prevAnswers;
    void _evs;
    const nextAnswers = rest;
    const nextStatus = sub.status === "sospechoso" ? "completado" : sub.status;
    const { error } = await supabase
      .from("submissions")
      .update({ focus_warnings: 0, answers: nextAnswers, status: nextStatus })
      .eq("id", sub.id);
    if (error) return toast.error(error.message);
    toast.success("Advertencias eliminadas");
    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === sub.id ? { ...s, focus_warnings: 0, answers: nextAnswers, status: nextStatus } : s,
      ),
    );
  };

  // Borra UNA advertencia puntual del array de eventos. focus_warnings
  // se decrementa para mantener consistencia con la longitud del array.
  // Si tras decrementar el intento ya no supera el umbral y estaba en
  // sospechoso, lo regresamos a completado.
  const clearOneWarning = async (sub: Submission, idx: number) => {
    const prevAnswers = sub.answers ?? {};
    const events = (prevAnswers.__warning_events ?? []) as WarningEvent[];
    if (idx < 0 || idx >= events.length) return;
    const nextEvents = events.filter((_, i) => i !== idx);
    const nextAnswers = { ...prevAnswers, __warning_events: nextEvents };
    const nextWarnings = Math.max(0, (sub.focus_warnings ?? 0) - 1);
    const examMax = exam?.max_warnings ?? 3;
    const nextStatus =
      sub.status === "sospechoso" && nextWarnings < examMax ? "completado" : sub.status;
    const { error } = await supabase
      .from("submissions")
      .update({
        focus_warnings: nextWarnings,
        answers: nextAnswers,
        status: nextStatus,
      })
      .eq("id", sub.id);
    if (error) return toast.error(error.message);
    toast.success("Advertencia eliminada");
    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === sub.id
          ? {
              ...s,
              focus_warnings: nextWarnings,
              answers: nextAnswers,
              status: nextStatus,
            }
          : s,
      ),
    );
  };

  const saveQuestionOverride = async (sub: Submission, q: Question) => {
    const entry = qOverrides[q.id] ?? { score: null, feedback: "" };
    const numScore: number | null = entry.score;
    if (numScore != null && (Number.isNaN(numScore) || numScore < 0 || numScore > q.points)) {
      toast.error(`La calificación debe estar entre 0 y ${q.points}`);
      return;
    }
    setSavingQid(q.id);
    const prevAnswers = sub.answers ?? {};
    const prevManual: Record<string, ManualOverride> = {
      ...(prevAnswers.__manual_overrides ?? {}),
    };
    if (numScore == null) {
      delete prevManual[q.id];
    } else {
      prevManual[q.id] = { score: numScore, feedback: entry.feedback || undefined };
    }
    const nextAnswers = { ...prevAnswers, __manual_overrides: prevManual };

    const breakdown: GradeBreakdown[] = Array.isArray(prevAnswers.__breakdown)
      ? prevAnswers.__breakdown
      : [];
    const recomputed = computeFinalGrade(
      questions.map((qq) => ({ id: qq.id, points: qq.points })),
      breakdown,
      prevManual as Record<string, GradeManual>,
      exam?.course?.grade_scale_max ?? 5,
    );

    const { error } = await supabase
      .from("submissions")
      .update({ answers: nextAnswers, final_override_grade: recomputed })
      .eq("id", sub.id);
    setSavingQid(null);
    if (error) return toast.error(error.message);
    toast.success(
      numScore == null
        ? "Calificación por pregunta eliminada"
        : "Calificación por pregunta guardada",
    );

    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === sub.id ? { ...s, answers: nextAnswers, final_override_grade: recomputed } : s,
      ),
    );
    setOverrideValue(recomputed != null ? Number(recomputed) : null);
  };

  const viewingSub = useMemo(
    () => submissions.find((s) => s.id === viewingId) ?? null,
    [submissions, viewingId],
  );

  if (!exam) return <p className="text-muted-foreground p-6">{t("common.loading")}</p>;

  const retryMode: RetryMode = ((exam as any).retry_mode as RetryMode) ?? "last";
  const maxAttempts = Math.max(
    1,
    Number((exam as any).max_attempts ?? exam.course?.max_exam_attempts ?? 1) || 1,
  );

  // Agrupar submissions por estudiante (un estudiante = N intentos)
  type StudentRow = {
    userId: string;
    profile?: { full_name: string; institutional_email: string };
    attempts: Submission[]; // ordenadas asc por created_at
    finishedAttempts: Submission[];
    inProgress?: Submission;
    latest: Submission;
    effectiveGrade: number | null;
    attemptsUsed: number;
    currentNumber: number; // 1-based para mostrar "Intento N"
  };
  const studentMap = new Map<string, Submission[]>();
  for (const s of submissions) {
    const arr = studentMap.get(s.user_id) ?? [];
    arr.push(s);
    studentMap.set(s.user_id, arr);
  }
  const studentRows: StudentRow[] = Array.from(studentMap.entries()).map(([uid, arr]) => {
    const sorted = [...arr].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    );
    const finished = sorted.filter((s) => isFinalStatus(s.status));
    const inProg = sorted.find((s) => s.status === "en_progreso");
    const latest = sorted[sorted.length - 1];
    const eff = computeAttemptGrade(
      finished.map((s) => ({
        status: s.status,
        ai_grade: s.ai_grade,
        final_override_grade: s.final_override_grade,
        created_at: s.created_at,
      })),
      retryMode,
    );
    return {
      userId: uid,
      profile: latest.profile,
      attempts: sorted,
      finishedAttempts: finished,
      inProgress: inProg,
      latest,
      effectiveGrade: eff,
      attemptsUsed: finished.length,
      currentNumber: sorted.length,
    };
  });
  studentRows.sort((a, b) =>
    (a.profile?.full_name ?? "").localeCompare(b.profile?.full_name ?? ""),
  );

  const inProgressStudents = studentRows.filter((r) => r.inProgress);
  const completedStudents = studentRows.filter((r) => !r.inProgress && r.finishedAttempts.length);

  const deleteOneAttempt = async (sub: Submission) => {
    const ok = await confirm({
      title: `Eliminar intento del ${formatDateTime(sub.created_at)}`,
      description:
        "Se eliminará este intento de forma permanente. La calificación efectiva del examen se recalculará según el modo de reintento.",
      confirmLabel: "Eliminar intento",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("submissions").delete().eq("id", sub.id);
    if (error) return toast.error(error.message);
    toast.success("Intento eliminado");
    void load();
  };

  const deleteAllAttempts = async (row: StudentRow) => {
    const ok = await confirm({
      title: `Eliminar todos los intentos de ${row.profile?.full_name ?? "este estudiante"}`,
      description: `Se eliminarán ${row.attempts.length} intento(s) de forma permanente. El estudiante podrá iniciar un nuevo intento.`,
      confirmLabel: "Eliminar todos",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase
      .from("submissions")
      .delete()
      .eq("exam_id", examId)
      .eq("user_id", row.userId);
    if (error) return toast.error(error.message);
    toast.success("Intentos eliminados");
    setAttemptsForUser(null);
    void load();
  };

  const attemptsRow = attemptsForUser
    ? (studentRows.find((r) => r.userId === attemptsForUser) ?? null)
    : null;

  return (
    <div className="space-y-5">
      <PageHeader
        backTo="/app/teacher/exams"
        backLabel={t("common.back")}
        title={`${t("monitor.title")}: ${exam.title}`}
        subtitle={
          <>
            {exam.course?.name} · Modo de reintento:{" "}
            <span className="font-medium">{retryModeLabel(retryMode)}</span> · Máx. intentos:{" "}
            {maxAttempts}
          </>
        }
      />

      {/* Live submissions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              En progreso ({inProgressStudents.length}) · Completados ({completedStudents.length})
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={load}>
              <Clock className="h-4 w-4 mr-1" /> Actualizar
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("roles.Estudiante")}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  <span className="inline-flex items-center gap-1">
                    Intentos
                    <HelpHint>
                      Intento actual / máximo permitido por examen. Click para gestionar los
                      intentos del estudiante.
                    </HelpHint>
                  </span>
                </TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead className="hidden md:table-cell">
                  <span className="inline-flex items-center gap-1">
                    Pregunta
                    <HelpHint>
                      Pregunta actual del intento en curso (índice / total). Se actualiza con cada
                      autosave del estudiante.
                    </HelpHint>
                  </span>
                </TableHead>
                <TableHead>Nota</TableHead>
                <TableHead className="hidden lg:table-cell">
                  <span className="inline-flex items-center gap-1">
                    Strikes
                    <HelpHint>
                      Advertencias acumuladas (cambio de pestaña, copiar/pegar, salir de pantalla
                      completa, etc.). Al llegar al máximo del examen el intento se marca como
                      sospechoso.
                    </HelpHint>
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    Diálogo
                    <HelpHint>
                      <strong className="text-amber-600 dark:text-amber-400">Ámbar</strong>:
                      conversaciones abiertas con el estudiante.{" "}
                      <strong className="text-destructive">Rojo</strong>: conversaciones esperando
                      tu respuesta. Click para abrir el panel de comentarios.
                    </HelpHint>
                  </span>
                </TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {studentRows.length === 0 && (
                <TableEmpty colSpan={8} text="Ningún estudiante ha iniciado el examen aún." />
              )}
              {studentRows.map((row) => {
                const latest = row.latest;
                const inProg = !!row.inProgress;
                // Pregunta actual del intento en curso. Persistida por el
                // taker en answers.__current_idx en cada autosave (1.5s).
                const currentIdx =
                  inProg && typeof row.inProgress?.answers?.__current_idx === "number"
                    ? (row.inProgress.answers.__current_idx as number)
                    : null;
                return (
                  <TableRow key={row.userId}>
                    <TableCell>
                      <div className="font-medium">{row.profile?.full_name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.profile?.institutional_email}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <button
                        type="button"
                        className="text-sm font-medium underline-offset-2 hover:underline tabular-nums"
                        onClick={() => setAttemptsForUser(row.userId)}
                        title="Ver y gestionar intentos"
                      >
                        {row.currentNumber}/{maxAttempts}
                      </button>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={inProg ? "en_progreso" : latest.status} />
                    </TableCell>
                    <TableCell className="text-sm tabular-nums hidden md:table-cell">
                      {inProg && currentIdx != null && questions.length > 0 ? (
                        <span>
                          {Math.min(currentIdx + 1, questions.length)}/{questions.length}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {row.effectiveGrade == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="font-medium">{row.effectiveGrade}</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <Badge
                        variant={latest.focus_warnings > 0 ? "destructive" : "outline"}
                        className="text-[10px] tabular-nums"
                      >
                        {latest.focus_warnings}/3
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {/* Diálogo: combina "conversaciones abiertas" (ámbar)
                          y "respuestas pendientes del docente" (rojo) en una
                          sola celda. El badge rojo es subset del ámbar; lo
                          mostramos al lado para que el docente vea de un
                          vistazo cuántos hay y cuántos lo esperan. */}
                      {(() => {
                        const open = openThreadsByUser[row.userId] ?? 0;
                        const pending = pendingReplyByUser[row.userId] ?? 0;
                        if (open === 0 && pending === 0) {
                          return <span className="text-xs text-muted-foreground">—</span>;
                        }
                        return (
                          <div className="flex items-center gap-1">
                            {open > 0 && (
                              <button
                                type="button"
                                onClick={() => openView(latest)}
                                title={`${open} conversación(es) abierta(s)`}
                                className="inline-flex items-center gap-1 rounded-md border border-amber-400/60 bg-amber-400/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-400/25 transition-colors"
                              >
                                <MessageSquareText className="h-3 w-3" />
                                <span className="tabular-nums">{open}</span>
                              </button>
                            )}
                            {pending > 0 && (
                              <button
                                type="button"
                                onClick={() => openView(latest)}
                                title={`${pending} conversación(es) esperan tu respuesta`}
                                className="inline-flex items-center gap-1 rounded-md border border-destructive/60 bg-destructive/15 px-1.5 py-0.5 text-[11px] font-semibold text-destructive hover:bg-destructive/25 transition-colors"
                              >
                                <AlertTriangle className="h-3 w-3" />
                                <span className="tabular-nums">{pending}</span>
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {inProg && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => sendTimerControl("add_time", row.userId, 5 * 60)}
                            disabled={loading === `add_time-${row.userId}`}
                            title="Agregar 5 minutos a este estudiante"
                          >
                            {loading === `add_time-${row.userId}` ? (
                              <Spinner size="sm" />
                            ) : (
                              <TimerReset className="h-3.5 w-3.5" />
                            )}
                            <span className="ml-1 text-[11px]">+5m</span>
                          </Button>
                        )}
                        <RowAction
                          label="Ver intentos"
                          icon={Eye}
                          onClick={() => setAttemptsForUser(row.userId)}
                        />
                        {row.attempts.length > 0 && (
                          <RowAction
                            label={
                              row.attempts.length === 1
                                ? "Eliminar el intento del estudiante"
                                : `Eliminar los ${row.attempts.length} intentos del estudiante`
                            }
                            icon={Trash2}
                            tone="destructive"
                            onClick={() => deleteAllAttempts(row)}
                          />
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <FraudPanel
        kind="exam"
        refId={exam.id}
        userNames={Object.fromEntries(
          studentRows.map((r) => [r.userId, r.profile?.full_name ?? "—"]),
        )}
      />

      {/* Dialog: lista de intentos del estudiante */}
      <Dialog open={attemptsForUser != null} onOpenChange={(o) => !o && setAttemptsForUser(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Intentos de {attemptsRow?.profile?.full_name ?? "—"}</DialogTitle>
            <DialogDescription>
              {attemptsRow?.profile?.institutional_email} · {attemptsRow?.attemptsUsed ?? 0}{" "}
              finalizado(s) · {attemptsRow?.currentNumber ?? 0} de {maxAttempts} usados · Modo:{" "}
              {retryModeLabel(retryMode)}
            </DialogDescription>
          </DialogHeader>
          {attemptsRow && (
            <div className="space-y-3">
              <div className="rounded-md border p-3 flex items-center justify-between">
                <div className="text-sm">
                  Calificación efectiva:{" "}
                  <span className="font-semibold">{attemptsRow.effectiveGrade ?? "—"}</span>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => deleteAllAttempts(attemptsRow)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> Eliminar todos
                </Button>
              </div>
              <ScrollArea className="max-h-[55vh] pr-3">
                <div className="space-y-2">
                  {attemptsRow.attempts.map((a, idx) => {
                    const grade = a.final_override_grade ?? a.ai_grade;
                    const isFinal = isFinalStatus(a.status);
                    const endAt = computeAttemptEnd(a, exam);
                    const extraMin = Math.round((a.extra_seconds ?? 0) / 60);
                    return (
                      <div
                        key={a.id}
                        className="rounded-md border p-3 flex items-center justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <span>Intento {idx + 1}</span>
                            <StatusBadge status={a.status} />
                            {extraMin > 0 && (
                              <Badge variant="secondary" className="text-[10px]">
                                <TimerReset className="h-3 w-3 mr-0.5" />+{extraMin}m extra
                              </Badge>
                            )}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 text-xs text-muted-foreground tabular-nums">
                            <div>
                              <span className="text-foreground/60">Inicio:</span>{" "}
                              {formatDateTime(a.started_at ?? a.created_at)}
                            </div>
                            <div>
                              <span className="text-foreground/60">
                                {a.submitted_at ? "Fin:" : "Fin previsto:"}
                              </span>{" "}
                              {endAt ? formatDateTime(endAt) : "—"}
                            </div>
                          </div>
                          <div className="text-xs">
                            Calificación:{" "}
                            <span className="font-medium tabular-nums">
                              {grade != null ? grade : "—"}
                            </span>{" "}
                            · Advertencias: {a.focus_warnings}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {isFinal && (
                            <RowAction
                              label="Ver respuestas y calificar"
                              icon={Eye}
                              onClick={() => openView(a)}
                            />
                          )}
                          <RowAction
                            label="Eliminar este intento"
                            icon={Trash2}
                            tone="destructive"
                            onClick={() => deleteOneAttempt(a)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={viewingId != null} onOpenChange={(o) => !o && setViewingId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Respuestas de {viewingSub?.profile?.full_name ?? "—"}</DialogTitle>
            <DialogDescription>
              {viewingSub?.profile?.institutional_email} · Estado: {statusLabel(viewingSub?.status)}
              {" · "}
              <span className="font-medium">Decimales con coma (ej. 4,5).</span>
            </DialogDescription>
          </DialogHeader>

          {viewingSub && (
            <ScrollArea className="max-h-[55vh] pr-4">
              <div className="space-y-4">
                {(() => {
                  const events = (viewingSub.answers?.__warning_events ?? []) as WarningEvent[];
                  if (!events.length) return null;
                  return (
                    <Card className="border-destructive/40 bg-destructive/5">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center justify-between gap-2">
                          <span className="flex items-center gap-2">
                            <AlertTriangle className="h-4 w-4 text-destructive" />
                            Eventos de advertencia ({events.length})
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => clearAllWarnings(viewingSub)}
                            title="Limpiar todas las advertencias del intento"
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Limpiar todas
                          </Button>
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="text-xs space-y-1">
                        {events.map((ev, i) => {
                          const ts = warningEventTimestamp(ev);
                          return (
                            <div key={i} className="flex items-center gap-2">
                              <span className="text-muted-foreground tabular-nums">
                                {formatDateTime(ts)}
                              </span>
                              <span className="font-medium">{warningLabel(ev.type)}</span>
                              {typeof ev.questionIdx === "number" && (
                                <span className="text-muted-foreground">
                                  · pregunta {ev.questionIdx + 1}
                                </span>
                              )}
                              <RowAction
                                label="Eliminar esta advertencia"
                                icon={Trash2}
                                tone="destructive"
                                onClick={() => clearOneWarning(viewingSub, i)}
                              />
                            </div>
                          );
                        })}
                      </CardContent>
                    </Card>
                  );
                })()}

                {questions.length === 0 && (
                  <p className="text-sm text-muted-foreground">Este examen no tiene preguntas.</p>
                )}
                {(() => {
                  const breakdown: BreakdownItem[] = Array.isArray(viewingSub.answers?.__breakdown)
                    ? viewingSub.answers.__breakdown
                    : [];
                  const byId = new Map(breakdown.map((b) => [b.qid, b]));
                  const manual: Record<string, ManualOverride> =
                    viewingSub.answers?.__manual_overrides ?? {};
                  return questions.map((q, idx) => {
                    const ans = viewingSub.answers?.[q.id];
                    const correctIdx = q.options?.correct_index;
                    const choices = q.options?.choices as string[] | undefined;
                    const bd = byId.get(q.id);
                    const override = manual[q.id];
                    const qEntry = qOverrides[q.id] ?? { score: null, feedback: "" };
                    return (
                      <Card
                        key={q.id}
                        id={`exam-q-${q.id}`}
                        className={
                          highlightQuestionId === q.id ? "ring-2 ring-primary/60" : undefined
                        }
                      >
                        <CardHeader className="pb-2">
                          <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
                            <span>Pregunta {idx + 1}</span>
                            <Badge variant="outline" className="text-[10px]">
                              {q.type}
                            </Badge>
                            {q.language && (
                              <Badge variant="secondary" className="text-[10px]">
                                {q.language}
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground ml-auto">
                              {bd ? `${bd.earned}` : "—"} / {q.points}
                              {override && (
                                <span className="ml-1 text-primary">
                                  (manual: {override.score})
                                </span>
                              )}
                            </span>
                          </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-2 text-sm">
                          <div className="text-foreground whitespace-pre-wrap">{q.content}</div>

                          {q.type === "cerrada" && choices && (
                            <div className="space-y-1">
                              {choices.map((c, i) => {
                                const isStudent = ans === i;
                                const isCorrect = correctIdx === i;
                                return (
                                  <div
                                    key={i}
                                    className={`text-xs p-1.5 rounded border ${
                                      isCorrect ? "border-success bg-success/10" : "border-border"
                                    } ${isStudent ? "ring-1 ring-primary" : ""}`}
                                  >
                                    <span className="font-mono mr-2">
                                      {String.fromCharCode(65 + i)}.
                                    </span>
                                    {c}
                                    {isStudent && (
                                      <Badge variant="outline" className="ml-2 text-[9px]">
                                        elegida
                                      </Badge>
                                    )}
                                    {isCorrect && (
                                      <Badge className="ml-1 text-[9px] bg-success text-success-foreground">
                                        correcta
                                      </Badge>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}

                          {/* Respuesta del estudiante:
                              - codigo / java_gui → editor Monaco read-only
                                (numeración de líneas + syntax highlighting),
                                igual a lo que el alumno tenía en pantalla.
                              - resto → bloque pre con texto plano. */}
                          {q.type === "codigo" || q.type === "java_gui" ? (
                            <CodeEditor
                              value={
                                ans == null || ans === ""
                                  ? "// Sin responder"
                                  : typeof ans === "string"
                                    ? ans
                                    : JSON.stringify(ans, null, 2)
                              }
                              onChange={() => {}}
                              language={(q.language as CodeLanguage) ?? "java"}
                              readOnly
                              showLanguageSelector={false}
                              showRunButton={false}
                              hideHints
                              height="220px"
                            />
                          ) : (
                            q.type !== "cerrada" && (
                              <div className="rounded border bg-muted/30 p-2 text-xs whitespace-pre-wrap font-mono min-h-[40px]">
                                {ans == null || ans === "" ? (
                                  <span className="text-muted-foreground italic">
                                    Sin responder
                                  </span>
                                ) : typeof ans === "string" ? (
                                  ans
                                ) : (
                                  JSON.stringify(ans, null, 2)
                                )}
                              </div>
                            )
                          )}

                          {/* Líneas del compilador / consola: para preguntas de
                              código mostramos la última ejecución registrada
                              en code_executions del estudiante. Permite al
                              docente ver qué imprimió el programa sin tener
                              que correrlo a mano. */}
                          {(q.type === "codigo" || q.type === "java_gui") && (
                            <CodeRunOutput
                              submissionId={viewingSub.id}
                              questionId={q.id}
                              userId={viewingSub.user_id}
                            />
                          )}

                          {bd?.feedback && (
                            <div className="text-xs text-muted-foreground border-l-2 border-primary/40 pl-2">
                              <span className="font-medium text-foreground">IA:</span> {bd.feedback}
                            </div>
                          )}

                          {q.expected_rubric && (
                            <details className="text-xs">
                              <summary className="cursor-pointer text-muted-foreground">
                                Rúbrica
                              </summary>
                              <p className="mt-1 whitespace-pre-wrap">{q.expected_rubric}</p>
                            </details>
                          )}

                          <div className="border-t pt-2 space-y-2">
                            <div className="flex items-center gap-2">
                              <DecimalInput
                                min={0}
                                max={q.points}
                                placeholder={`Calificación manual 0-${q.points}`}
                                value={qEntry.score}
                                onChange={(v) =>
                                  setQOverrides((prev) => ({
                                    ...prev,
                                    [q.id]: {
                                      ...(prev[q.id] ?? { score: null, feedback: "" }),
                                      score: v,
                                    },
                                  }))
                                }
                                className="w-28 h-8 text-xs"
                              />
                              <Button
                                size="sm"
                                variant="default"
                                onClick={() => saveQuestionOverride(viewingSub, q)}
                                disabled={savingQid === q.id}
                                className="h-8"
                              >
                                {savingQid === q.id ? (
                                  <Spinner size="sm" className="mr-1" />
                                ) : (
                                  <Save className="h-3.5 w-3.5 mr-1" />
                                )}
                                Guardar
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => reGradeWithAI(viewingSub, q.id)}
                                disabled={aiGradingQid === q.id || aiGradingId === viewingSub.id}
                                className="h-8"
                                title="Calificar esta pregunta con IA"
                              >
                                {aiGradingQid === q.id ? (
                                  <Spinner size="sm" className="mr-1" />
                                ) : (
                                  <Sparkles className="h-3.5 w-3.5 mr-1" />
                                )}
                                IA
                              </Button>
                            </div>
                            <Textarea
                              placeholder="Retroalimentación manual (opcional)"
                              value={qEntry.feedback}
                              onChange={(e) =>
                                setQOverrides((prev) => ({
                                  ...prev,
                                  [q.id]: {
                                    ...(prev[q.id] ?? { score: null, feedback: "" }),
                                    feedback: e.target.value,
                                  },
                                }))
                              }
                              className="text-xs min-h-[50px]"
                            />
                            {viewingSub && (
                              <FeedbackThread
                                parentKind="exam"
                                questionId={q.id}
                                submissionId={viewingSub.id}
                                isTeacher
                              />
                            )}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  });
                })()}
              </div>
            </ScrollArea>
          )}

          <DialogFooter className="flex-col sm:flex-row sm:items-center gap-2 border-t pt-3">
            {viewingSub && (
              <>
                <div className="flex items-center gap-2 text-xs text-muted-foreground sm:mr-auto">
                  <span>
                    IA:{" "}
                    <span className="font-medium text-foreground">
                      {viewingSub.ai_grade ?? "—"}
                    </span>
                  </span>
                  <span>·</span>
                  <span>
                    Final:{" "}
                    <span className="font-medium text-foreground">
                      {viewingSub.final_override_grade ?? viewingSub.ai_grade ?? "—"}
                    </span>
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reGradeWithAI(viewingSub)}
                  disabled={aiGradingId === viewingSub.id}
                >
                  {aiGradingId === viewingSub.id ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1" />
                  )}
                  Recalificar todo con IA
                </Button>
                <div className="flex items-center gap-1">
                  <DecimalInput
                    min={0}
                    max={5}
                    placeholder="Calificación 0-5"
                    value={overrideValue}
                    onChange={setOverrideValue}
                    className="w-24 h-8 text-sm"
                  />
                  <Button
                    size="sm"
                    onClick={() => saveOverride(viewingSub)}
                    disabled={savingOverride}
                  >
                    {savingOverride ? (
                      <Spinner size="sm" className="mr-1" />
                    ) : (
                      <Save className="h-3.5 w-3.5 mr-1" />
                    )}
                    Guardar calificación
                  </Button>
                </div>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
