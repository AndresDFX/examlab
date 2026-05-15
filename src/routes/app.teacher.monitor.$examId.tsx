import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/lib/audit";
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
  Search,
  X as XIcon,
  Check,
  Bot,
  Users,
  ChevronRight,
  Pencil,
  Pause,
  Play,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { ConversationSection } from "@/components/ConversationSection";
import { computeIntegritySuggestion } from "@/lib/integrity";
import {
  countPendingByUser,
  rpcMarkAiReviewed,
  rpcMarkCopyReviewed,
  CollapsibleReasons,
  type IntegrityCopyPair,
  type IntegrityAiSignal,
} from "@/components/IntegrityReviewDialog";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Input } from "@/components/ui/input";
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
  /** Probabilidad 0..1 estimada por la IA de que la entrega sea generada
   * por IA. Se llena al calificar y se usa para sugerir penalizaciones
   * en el modal "Respuestas". */
  ai_detected_score: number | null;
  ai_detected_reasons: string | null;
  ai_detected: boolean | null;
  /** Marca de revisión de la sospecha IA por el docente. Si está
   *  poblada, la submission ya no se considera sospechosa por IA aunque
   *  ai_detected_score >= 0.6. */
  ai_review_at?: string | null;
  created_at: string;
  started_at: string | null;
  submitted_at: string | null;
  /** Tiempo extra concedido por el docente (segundos). 0 si no se ha
   * agregado. Se suma a la fecha fin teórica del intento. */
  extra_seconds: number;
  /** Retroalimentación general del examen escrita por el docente. Se
   * muestra al estudiante en la vista de revisión. */
  teacher_feedback?: string | null;
  profile?: { full_name: string; institutional_email: string };
};

/** Par de copia detectado entre dos estudiantes para una pregunta del
 * examen. El monitor lo carga una vez por examen y lo cruza por user_id
 * para sugerir penalización por plagio en el modal "Respuestas". */
type SimilarityPair = {
  id: string;
  question_id: string | null;
  user_a: string;
  user_b: string;
  score: number;
  reasons: string | null;
  reviewed_at?: string | null;
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
  // Buscador de la tabla principal de monitor — filtra por nombre/correo
  // del estudiante client-side. Persiste mientras el docente revisa la
  // pantalla (no se limpia automáticamente).
  const [monitorSearch, setMonitorSearch] = useState("");
  const [questions, setQuestions] = useState<Question[]>([]);
  // Pares de copia detectados (similarity_pairs) cruzados por user_id
  // para sugerir penalización por plagio en el modal "Respuestas". Se
  // recarga junto con las submissions.
  const [similarityPairs, setSimilarityPairs] = useState<SimilarityPair[]>([]);
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
  const [qOverrides, setQOverrides] = useState<
    Record<string, { score: number | null; feedback: string }>
  >({});
  const [savingQid, setSavingQid] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  // Retroalimentación general del examen (campo teacher_feedback de la submission).
  // Se llena al abrir el modal de respuestas y se guarda explícitamente.
  const [teacherFeedbackDraft, setTeacherFeedbackDraft] = useState("");
  const [teacherFeedbackSaving, setTeacherFeedbackSaving] = useState(false);
  // Estudiantes cuyo temporizador está actualmente pausado.
  // Se inicializa desde exam_timer_controls al cargar y se actualiza
  // optimísticamente al pausar/reanudar desde el monitor.
  const [pausedUserIds, setPausedUserIds] = useState<Set<string>>(new Set());
  // Comparación de copia entre dos estudiantes para una pregunta concreta.
  // Cuando está poblado, el modal "Respuestas" se ensancha y muestra un
  // panel lateral con la entrega del compañero a esa misma pregunta —
  // así el docente compara las dos respuestas lado a lado sin perder el
  // contexto de la calificación. La marca de revisión usa `pairId` y se
  // sincroniza con la fila de `similarity_pairs` (un único registro
  // compartido por ambos estudiantes), por lo que marcarla en cualquiera
  // de los dos modos refleja al otro al instante.
  const [comparisonForCopy, setComparisonForCopy] = useState<{
    peerUserId: string;
    peerSubmissionId: string;
    questionId: string;
    pairId: string;
  } | null>(null);

  const load = useCallback(async () => {
    const { data: e } = await (supabase as any)
      .from("exams")
      .select("*, course:courses(name, grade_scale_max, max_exam_attempts)")
      .eq("id", examId)
      .single();
    setExam(e);

    // extra_seconds aún no está en types.ts auto-generados; casteamos
    // a any para que el cliente lo selecte sin que el typing lo bloquee.
    // ai_detected_* habilita la sugerencia de nota por integridad.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: subs } = await (supabase as any)
      .from("submissions")
      .select(
        "id, user_id, status, focus_warnings, answers, ai_grade, final_override_grade, ai_detected, ai_detected_score, ai_detected_reasons, ai_review_at, created_at, started_at, submitted_at, extra_seconds, teacher_feedback",
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

    // Pares de copia detectados para este examen. RLS deja ver solo a
    // docente/admin del curso. Si nunca se corrió "Detectar copias"
    // viene vacío y la sugerencia se basa solo en el flag de IA.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: pairs } = await (supabase as any)
      .from("similarity_pairs")
      .select("id, question_id, user_a, user_b, score, reasons, reviewed_at")
      .eq("kind", "exam")
      .eq("ref_id", examId);
    setSimilarityPairs((pairs ?? []) as SimilarityPair[]);

    // Reconstruye qué estudiantes están pausados mirando el evento más
    // reciente de cada usuario en exam_timer_controls. Un usuario está
    // pausado si su última acción es "pause" (individual o heredada del
    // global). Se ignoran controles globales aquí — el estudiante los
    // aplica en el cliente vía realtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: timerCtrls } = await (supabase as any)
      .from("exam_timer_controls")
      .select("target_user_id, action")
      .eq("exam_id", examId)
      .order("created_at", { ascending: false });

    const pausedSet = new Set<string>();
    const seenUsers = new Set<string>();
    for (const ctrl of (timerCtrls ?? []) as { target_user_id: string | null; action: string }[]) {
      if (!ctrl.target_user_id) continue;
      if (seenUsers.has(ctrl.target_user_id)) continue;
      seenUsers.add(ctrl.target_user_id);
      if (ctrl.action === "pause") pausedSet.add(ctrl.target_user_id);
    }
    setPausedUserIds(pausedSet);
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
  // Resumen de hilos por (submissionId, questionId). Se usa en el modal
  // "Respuestas" para que cada question Card muestre en el trigger de
  // "Conversación" un badge con cuántos hilos abiertos hay y si alguno
  // espera respuesta del docente — sin tener que expandirla. La key es
  // `${submissionId}:${questionId}`.
  const [threadsByQ, setThreadsByQ] = useState<Record<string, { count: number; pending: boolean }>>(
    {},
  );
  // Lo extraemos en una función callable (no solo dentro del effect)
  // para que el `FeedbackThread` pueda invocarla via `onChanged` cuando
  // el docente cierra/reabre/agrega un comentario. Sin esto, los
  // contadores "Diálogo pendientes" / "openThreadsByUser" se quedaban
  // stale hasta que cambiaba `submissions` — bug reportado: al cerrar
  // un thread, el badge seguía marcando "1 pendiente".
  const reloadThreadCounts = useCallback(async () => {
    if (!submissions.length) {
      setOpenThreadsByUser({});
      setPendingReplyByUser({});
      setThreadsByQ({});
      return;
    }
    const subUserById = new Map(submissions.map((s) => [s.id, s.user_id]));
    const subIds = submissions.map((s) => s.id);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: threads } = await (supabase as any)
        .from("feedback_threads")
        .select("id, submission_id, question_id")
        .eq("parent_kind", "exam")
        .eq("closed", false)
        .in("submission_id", subIds);
      const threadsArr = (threads ?? []) as {
        id: string;
        submission_id: string;
        question_id: string;
      }[];
      const openCounts: Record<string, number> = {};
      const threadOwner = new Map<string, string>();
      // Agrupado por (submissionId, questionId) para el resumen en cada
      // question Card del modal.
      const threadsByQKey = new Map<string, { id: string }[]>();
      for (const t of threadsArr) {
        const uid = subUserById.get(t.submission_id);
        if (!uid) continue;
        openCounts[uid] = (openCounts[uid] ?? 0) + 1;
        threadOwner.set(t.id, uid);
        const key = `${t.submission_id}:${t.question_id}`;
        const arr = threadsByQKey.get(key) ?? [];
        arr.push({ id: t.id });
        threadsByQKey.set(key, arr);
      }
      setOpenThreadsByUser(openCounts);

      // Comments para determinar el ÚLTIMO autor de cada thread.
      const threadIds = threadsArr.map((t) => t.id);
      if (threadIds.length === 0) {
        setPendingReplyByUser({});
        setThreadsByQ({});
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: comments } = await (supabase as any)
        .from("feedback_comments")
        .select("thread_id, user_id, created_at")
        .in("thread_id", threadIds)
        .order("created_at", { ascending: false });
      const lastByThread = new Map<string, string>(); // thread_id → user_id del último comentario
      for (const c of (comments ?? []) as {
        thread_id: string;
        user_id: string;
        created_at: string;
      }[]) {
        if (!lastByThread.has(c.thread_id)) lastByThread.set(c.thread_id, c.user_id);
      }
      const pendingCounts: Record<string, number> = {};
      const pendingByThread = new Set<string>();
      for (const [threadId, ownerUid] of threadOwner.entries()) {
        const lastAuthor = lastByThread.get(threadId);
        // Pendiente si el último comentario lo escribió el ALUMNO
        // (dueño de la submission). Si todavía no hay comentarios,
        // tampoco lo contamos como pendiente — un thread vacío suele
        // ser ruido o un placeholder.
        if (lastAuthor && lastAuthor === ownerUid) {
          pendingCounts[ownerUid] = (pendingCounts[ownerUid] ?? 0) + 1;
          pendingByThread.add(threadId);
        }
      }
      setPendingReplyByUser(pendingCounts);

      // Aggregar a la forma final por (sub, q): count + has-pending.
      const byQ: Record<string, { count: number; pending: boolean }> = {};
      for (const [key, ths] of threadsByQKey.entries()) {
        byQ[key] = {
          count: ths.length,
          pending: ths.some((tt) => pendingByThread.has(tt.id)),
        };
      }
      setThreadsByQ(byQ);
    } catch (e) {
      console.warn("[monitor] reloadThreadCounts failed", e);
    }
  }, [submissions]);

  useEffect(() => {
    void reloadThreadCounts();
  }, [reloadThreadCounts]);

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

  // Sincroniza el draft de retroalimentación general cada vez que se
  // abre el modal de respuestas de un estudiante distinto.
  useEffect(() => {
    if (!viewingId) return;
    const sub = submissions.find((s) => s.id === viewingId);
    setTeacherFeedbackDraft(sub?.teacher_feedback ?? "");
  }, [viewingId]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Actualiza estado de pausa optimísticamente para reflejar el cambio
    // en el botón sin esperar al próximo load().
    if (targetUserId) {
      if (action === "pause") {
        setPausedUserIds((prev) => new Set([...prev, targetUserId]));
      } else if (action === "resume") {
        setPausedUserIds((prev) => {
          const next = new Set(prev);
          next.delete(targetUserId);
          return next;
        });
      }
    }
    setLoading(null);

    const labels: Record<string, string> = {
      pause: "Examen pausado",
      resume: "Examen reanudado",
      add_time: `+${Math.floor(extraSeconds / 60)} minuto(s) añadidos`,
    };
    toast.success(`${labels[action]} ${targetUserId ? "(estudiante)" : "(global)"}`);
  };

  const saveTeacherFeedback = async () => {
    if (!viewingSub) return;
    setTeacherFeedbackSaving(true);
    const { error } = await supabase
      .from("submissions")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .update({ teacher_feedback: teacherFeedbackDraft.trim() || null } as any)
      .eq("id", viewingSub.id);
    setTeacherFeedbackSaving(false);
    if (error) return toast.error(error.message);
    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === viewingSub.id
          ? { ...s, teacher_feedback: teacherFeedbackDraft.trim() || null }
          : s,
      ),
    );
    toast.success("Retroalimentación guardada");
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

  // saveOverride (input global de "Calificación final" del modal) fue
  // removido. La nota final ahora se recomputa automáticamente desde
  // las calificaciones por pregunta vía `saveQuestionScore` →
  // computeFinalGrade. El audit log de "grade.manual_override" sigue
  // existiendo en `gradebook` cuando el docente edita la nota desde
  // ahí (otra ruta), pero no hay override global desde el monitor.

  // Borra TODAS las advertencias de un intento: focus_warnings=0,
  // limpia __warning_events del JSON, y si el intento estaba en
  // status='sospechoso' lo regresa a 'completado' (porque sospechoso
  // se setea precisamente cuando supera el umbral de strikes).
  const clearAllWarnings = async (sub: Submission) => {
    const ok = await confirm({
      title: t("monitor.clearWarningsTitle"),
      description: t("monitor.clearWarningsBody"),
      confirmLabel: t("monitor.clearWarningsConfirm"),
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
    // Auditoría: borrar todas las advertencias es decisión sensible
    // (puede convertir un intento "sospechoso" en válido). Lo marcamos
    // warning con before/after para que quede rastro.
    void logEvent({
      action: "fraud.warnings_cleared_all",
      category: "fraud",
      severity: "warning",
      entityType: "submission",
      entityId: sub.id,
      courseId: exam?.course_id ?? null,
      metadata: {
        exam_id: exam?.id,
        student_id: sub.user_id,
        previous_warnings: sub.focus_warnings,
        previous_status: sub.status,
        new_status: nextStatus,
      },
    });
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
  };

  const viewingSub = useMemo(
    () => submissions.find((s) => s.id === viewingId) ?? null,
    [submissions, viewingId],
  );

  // ─── Datos de integridad académica (IA + Copia) ───
  // Sospechas IA por usuario: tomamos el intento con mayor score; la
  // señal IA es a nivel submission (no por pregunta). Hooks declarados
  // ANTES del early return de loading para no romper el orden de hooks.
  // Sospechas IA por pregunta. La edge function `ai-grade-submission`
  // guarda `ai_likelihood` y `ai_reasons` en cada entrada del
  // `__breakdown` del submission. Aquí los aplanamos a una lista por
  // submission/pregunta para poder filtrar por umbral, contar pendientes
  // y mostrarlos por pregunta en el modal de respuestas. La columna
  // `submissions.ai_review_at` (legacy) sigue actuando como "marcar TODO
  // como revisado" — si está poblada todas las preguntas se consideran
  // revisadas.
  type QuestionAiSignal = {
    submissionId: string;
    userId: string;
    questionId: string;
    score: number;
    reasons: string | null;
    /** Marca de revisión por pregunta. Vive dentro del breakdown JSON
     *  en `__breakdown[i].ai_review_at`. Si está null y el submission
     *  tampoco tiene `ai_review_at`, la pregunta cuenta como pendiente. */
    reviewedAt: string | null;
  };
  const aiSignalsByQuestion = useMemo<QuestionAiSignal[]>(() => {
    const out: QuestionAiSignal[] = [];
    for (const s of submissions) {
      const submissionReviewedAt = s.ai_review_at ?? null;
      const breakdown = Array.isArray(s.answers?.__breakdown)
        ? (s.answers.__breakdown as Array<{
            qid: string;
            ai_likelihood?: number;
            ai_reasons?: string;
            ai_review_at?: string | null;
          }>)
        : [];
      for (const b of breakdown) {
        const score = Number(b.ai_likelihood) || 0;
        if (score <= 0) continue;
        out.push({
          submissionId: s.id,
          userId: s.user_id,
          questionId: b.qid,
          score,
          reasons: b.ai_reasons ?? null,
          reviewedAt: submissionReviewedAt ?? b.ai_review_at ?? null,
        });
      }
    }
    return out;
  }, [submissions]);
  // Mapa: submissionId → questionId → señal IA para esa pregunta.
  // Antes lo agrupábamos por userId (max de N intentos), pero eso
  // ocultaba que cada intento puede tener su propia firma de IA. Al
  // viewer del modal le importa el intento concreto que abrió, así que
  // indexamos por submissionId y la lookup pasa a ser
  // `aiSignalsBySubmissionQuestion.get(viewingSub.id)?.get(q.id)`.
  // Para el peer en la comparación, usamos `peerSubmissionId`.
  const aiSignalsBySubmissionQuestion = useMemo(() => {
    const map = new Map<string, Map<string, QuestionAiSignal>>();
    for (const sig of aiSignalsByQuestion) {
      let inner = map.get(sig.submissionId);
      if (!inner) {
        inner = new Map();
        map.set(sig.submissionId, inner);
      }
      // Cada (submissionId, questionId) es único en el breakdown — no
      // hay colisiones que resolver con MAX. Sobrescribir es seguro.
      inner.set(sig.questionId, sig);
    }
    return map;
  }, [aiSignalsByQuestion]);
  const copyPairsByUser = useMemo(() => {
    const map = new Map<string, IntegrityCopyPair[]>();
    for (const p of similarityPairs) {
      for (const [u, peer] of [
        [p.user_a, p.user_b],
        [p.user_b, p.user_a],
      ] as const) {
        const arr = map.get(u) ?? [];
        arr.push({
          id: p.id,
          questionId: p.question_id,
          peerId: peer,
          score: Number(p.score) || 0,
          reasons: p.reasons,
          reviewedAt: p.reviewed_at ?? null,
        });
        map.set(u, arr);
      }
    }
    return map;
  }, [similarityPairs]);
  const { aiByUser: pendingAiByUser, copyByUser: pendingCopyByUser } = useMemo(
    () =>
      countPendingByUser(
        // Cuenta una entrada por (estudiante, pregunta) — así "Pendientes
        // IA" en el grid del monitor refleja preguntas con sospecha sin
        // revisar y no submissions. Si una submission tiene 3 preguntas
        // sospechosas, suma 3.
        aiSignalsByQuestion.map((s) => ({
          userId: s.userId,
          reviewedAt: s.reviewedAt,
          score: s.score,
        })),
        similarityPairs.map((p) => ({
          user_a: p.user_a,
          user_b: p.user_b,
          reviewed_at: p.reviewed_at ?? null,
          score: Number(p.score) || 0,
        })),
      ),
    [aiSignalsByQuestion, similarityPairs],
  );
  const questionLabelsForIntegrity = useMemo(() => {
    const map: Record<string, string> = {};
    for (const q of questions) {
      const label =
        `${t("exam.question")} ${q.position + 1}` +
        (q.content ? `: ${String(q.content).slice(0, 80)}` : "");
      map[q.id] = label;
    }
    return map;
  }, [questions, t]);

  if (!exam) return <p className="text-muted-foreground p-6">{t("common.loading")}</p>;

  const retryMode: RetryMode = ((exam as any).retry_mode as RetryMode) ?? "last";
  const maxAttempts = Math.max(
    1,
    Number((exam as any).max_attempts ?? exam.course?.max_exam_attempts ?? 1) || 1,
  );
  const gradeMax = Number(exam.course?.grade_scale_max ?? 5) || 5;

  const runDetectFraud = async () => {
    setDetecting(true);
    try {
      const { data, error } = await supabase.functions.invoke("detect-plagiarism", {
        body: { kind: "exam", refId: examId },
      });
      if (error) throw error;
      const summary = data as { pairs?: unknown[]; message?: string };
      const found = Array.isArray(summary?.pairs) ? summary.pairs.length : 0;
      if (found > 0) {
        toast.success(t("integrity.detectSuccess_other", { count: found }));
      } else {
        toast.message(t("integrity.detectNone"));
      }
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(t("integrity.detectError", { error: msg }));
    } finally {
      setDetecting(false);
    }
  };

  const toggleAiReviewedHandler = async (subId: string, currentlyReviewed: boolean) => {
    const ok = await rpcMarkAiReviewed("exam", subId, currentlyReviewed);
    if (ok) {
      setSubmissions((prev) =>
        prev.map((s) =>
          s.id === subId
            ? { ...s, ai_review_at: currentlyReviewed ? null : new Date().toISOString() }
            : s,
        ),
      );
      toast.success(currentlyReviewed ? t("monitor.deleteConfirmed") : t("integrity.reviewed"));
    }
    return ok;
  };

  /**
   * Marca/desmarca como revisada la sospecha IA de UNA pregunta dentro
   * de una submission. La marca vive dentro del JSON `answers.__breakdown`
   * (campo `ai_review_at` por entry). No usamos la columna submission-level
   * `ai_review_at` para evitar borrar/forzar el estado de TODAS las
   * preguntas de la submission al marcar solo una.
   */
  const toggleQuestionAiReviewedHandler = async (
    submissionId: string,
    questionId: string,
    currentlyReviewed: boolean,
  ) => {
    const sub = submissions.find((s) => s.id === submissionId);
    if (!sub) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const answers: Record<string, any> = { ...((sub.answers as Record<string, any>) ?? {}) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const breakdown: Array<Record<string, any>> = Array.isArray(answers.__breakdown)
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [...(answers.__breakdown as Array<Record<string, any>>)]
      : [];
    const idx = breakdown.findIndex((b) => b.qid === questionId);
    if (idx < 0) return false;
    breakdown[idx] = {
      ...breakdown[idx],
      ai_review_at: currentlyReviewed ? null : new Date().toISOString(),
    };
    answers.__breakdown = breakdown;
    const { error } = await supabase.from("submissions").update({ answers }).eq("id", submissionId);
    if (error) {
      toast.error(error.message);
      return false;
    }
    setSubmissions((prev) => prev.map((s) => (s.id === submissionId ? { ...s, answers } : s)));
    toast.success(currentlyReviewed ? t("monitor.deleteConfirmed") : t("integrity.reviewed"));
    return true;
  };

  const toggleCopyReviewedHandler = async (pairId: string, currentlyReviewed: boolean) => {
    const ok = await rpcMarkCopyReviewed(pairId, currentlyReviewed);
    if (ok) {
      setSimilarityPairs((prev) =>
        prev.map((p) =>
          p.id === pairId
            ? { ...p, reviewed_at: currentlyReviewed ? null : new Date().toISOString() }
            : p,
        ),
      );
      toast.success(currentlyReviewed ? t("monitor.deleteConfirmed") : t("integrity.reviewed"));
    }
    return ok;
  };

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

  // Filtrado client-side por nombre o correo institucional. El estado
  // `monitorSearch` se declara abajo donde viven los demás useState; acá
  // solo derivamos. Si el buscador está vacío, devuelve todos los rows.
  const monitorQuery = monitorSearch.trim().toLowerCase();
  const filteredStudentRows = monitorQuery
    ? studentRows.filter((r) => {
        const name = (r.profile?.full_name ?? "").toLowerCase();
        const email = (r.profile?.institutional_email ?? "").toLowerCase();
        return name.includes(monitorQuery) || email.includes(monitorQuery);
      })
    : studentRows;

  const inProgressStudents = studentRows.filter((r) => r.inProgress);
  const completedStudents = studentRows.filter((r) => !r.inProgress && r.finishedAttempts.length);

  const deleteOneAttempt = async (sub: Submission) => {
    const ok = await confirm({
      title: t("monitor.deleteAttemptTitle", { date: formatDateTime(sub.created_at) }),
      description: t("monitor.deleteAttemptBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("submissions").delete().eq("id", sub.id);
    if (error) return toast.error(error.message);
    toast.success(t("monitor.deleteConfirmed"));
    void load();
  };

  const deleteAllAttempts = async (row: StudentRow) => {
    const ok = await confirm({
      title: t("monitor.deleteAllAttemptsTitle", { name: row.profile?.full_name ?? "" }),
      description: t("monitor.deleteAllAttemptsBody_other", { count: row.attempts.length }),
      confirmLabel: t("monitor.deleteAllAttemptsConfirm"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase
      .from("submissions")
      .delete()
      .eq("exam_id", examId)
      .eq("user_id", row.userId);
    if (error) return toast.error(error.message);
    toast.success(t("monitor.deleteConfirmed"));
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

      {/* Integrity / Fraud detection top card */}
      <Card>
        <CardHeader>
          <div className="space-y-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-primary" />
              {t("integrity.title")}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{t("integrity.subtitle")}</p>
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex flex-wrap items-center gap-2">
                {(() => {
                  const aiCount = aiSignalsByQuestion.filter(
                    (s) => s.score >= 0.6 && !s.reviewedAt,
                  ).length;
                  const copyPairsCount = similarityPairs.filter(
                    (p) => Number(p.score) >= 0.6 && !p.reviewed_at,
                  ).length;
                  const totalPending = aiCount + copyPairsCount;
                  const hasAny = aiSignalsByQuestion.length > 0 || similarityPairs.length > 0;
                  if (!hasAny)
                    return (
                      <span className="text-xs text-muted-foreground">
                        {t("integrity.summaryEmpty")}
                      </span>
                    );
                  return (
                    <>
                      <Badge variant="outline" className="text-[11px]">
                        {t("integrity.summaryAi_other", { count: aiSignalsByQuestion.length })}
                      </Badge>
                      <Badge variant="outline" className="text-[11px]">
                        {t("integrity.summaryCopy_other", { count: similarityPairs.length })}
                      </Badge>
                      {totalPending > 0 ? (
                        <Badge
                          variant="outline"
                          className="text-[11px] bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300"
                        >
                          {t("integrity.summaryPending_other", { count: totalPending })}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="text-[11px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                        >
                          <Check className="h-3 w-3 mr-1" />
                          {t("integrity.summaryAllReviewed")}
                        </Badge>
                      )}
                    </>
                  );
                })()}
              </div>
              <Button
                size="sm"
                variant="default"
                onClick={runDetectFraud}
                disabled={detecting}
                className="shrink-0"
              >
                {detecting ? (
                  <Spinner size="sm" className="mr-1.5" />
                ) : (
                  <Search className="h-3.5 w-3.5 mr-1.5" />
                )}
                {detecting ? t("integrity.detecting") : t("integrity.detectButton")}
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Live submissions */}
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              En progreso ({inProgressStudents.length}) · Completados ({completedStudents.length})
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={load}>
              <Clock className="h-4 w-4 mr-1" /> Actualizar
            </Button>
          </div>
          {studentRows.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  value={monitorSearch}
                  onChange={(e) => setMonitorSearch(e.target.value)}
                  placeholder="Buscar estudiante por nombre o correo…"
                  className="h-8 pl-8 pr-8 text-xs"
                />
                {monitorSearch && (
                  <button
                    type="button"
                    onClick={() => setMonitorSearch("")}
                    aria-label="Limpiar búsqueda"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {monitorSearch && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {filteredStudentRows.length} de {studentRows.length}
                </span>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("roles.Estudiante")}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  <span className="inline-flex items-center gap-1">
                    {t("monitor.columns.attempts")}
                    <HelpHint>{t("monitor.columns.attemptsHint")}</HelpHint>
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    {t("common.status")}
                    <HelpHint>{t("monitor.columns.statusHint")}</HelpHint>
                  </span>
                </TableHead>
                <TableHead className="hidden md:table-cell">
                  <span className="inline-flex items-center gap-1">
                    {t("monitor.columns.question")}
                    <HelpHint>{t("monitor.columns.questionHint")}</HelpHint>
                  </span>
                </TableHead>
                <TableHead>{t("monitor.columns.grade")}</TableHead>
                <TableHead className="hidden lg:table-cell">
                  <span className="inline-flex items-center gap-1">
                    {t("monitor.columns.strikes")}
                    <HelpHint>{t("monitor.columns.strikesHint")}</HelpHint>
                  </span>
                </TableHead>
                <TableHead>
                  <span className="inline-flex items-center gap-1">
                    {t("monitor.columns.dialog")}
                    <HelpHint>{t("monitor.columns.dialogHint")}</HelpHint>
                  </span>
                </TableHead>
                <TableHead className="hidden lg:table-cell text-center">
                  <span className="inline-flex items-center gap-1 justify-center">
                    {t("integrity.pendingAi")}
                    <HelpHint>{t("integrity.pendingAiHint")}</HelpHint>
                  </span>
                </TableHead>
                <TableHead className="hidden lg:table-cell text-center">
                  <span className="inline-flex items-center gap-1 justify-center">
                    {t("integrity.pendingCopy")}
                    <HelpHint>{t("integrity.pendingCopyHint")}</HelpHint>
                  </span>
                </TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {studentRows.length === 0 && (
                <TableEmpty colSpan={10} text="Ningún estudiante ha iniciado el examen aún." />
              )}
              {studentRows.length > 0 && filteredStudentRows.length === 0 && (
                <TableEmpty colSpan={10} text="Ningún estudiante coincide con la búsqueda." />
              )}
              {filteredStudentRows.map((row) => {
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
                      {(() => {
                        // Estado derivado "chequeado": si el estudiante
                        // está sospechoso pero el docente revisó la
                        // sospecha IA y todos los pares de copia donde
                        // aparece, mostramos un badge verde en vez del
                        // rojo de "sospechoso". El status crudo en DB
                        // sigue siendo "sospechoso" — esto es solo UI.
                        if (inProg) return <StatusBadge status="en_progreso" />;
                        if (latest.status === "sospechoso") {
                          const aiReviewed = latest.ai_review_at != null;
                          const myPairs = similarityPairs.filter(
                            (p) => p.user_a === row.userId || p.user_b === row.userId,
                          );
                          const allPairsReviewed =
                            myPairs.length === 0
                              ? true
                              : myPairs.every((p) => p.reviewed_at != null);
                          // Si hay sospecha IA (score >= 0.6), exige
                          // ai_review_at; si nunca hubo IA flagged, no.
                          const aiSuspected = (latest.ai_detected_score ?? 0) >= 0.6;
                          const aiOk = !aiSuspected || aiReviewed;
                          if (aiOk && allPairsReviewed) {
                            return <StatusBadge status="chequeado" />;
                          }
                        }
                        return <StatusBadge status={latest.status} />;
                      })()}
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
                    <TableCell className="hidden lg:table-cell text-center">
                      {(() => {
                        const n = pendingAiByUser.get(row.userId) ?? 0;
                        if (n === 0)
                          return <span className="text-xs text-muted-foreground">—</span>;
                        return (
                          <Badge
                            variant="outline"
                            className="text-[11px] bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300"
                          >
                            <Bot className="h-3 w-3 mr-1" />
                            {n}
                          </Badge>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-center">
                      {(() => {
                        const n = pendingCopyByUser.get(row.userId) ?? 0;
                        if (n === 0)
                          return <span className="text-xs text-muted-foreground">—</span>;
                        return (
                          <Badge
                            variant="outline"
                            className="text-[11px] bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-300"
                          >
                            <Users className="h-3 w-3 mr-1" />
                            {n}
                          </Badge>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {inProg && (() => {
                          const isPaused = pausedUserIds.has(row.userId);
                          const pauseKey = isPaused ? `resume-${row.userId}` : `pause-${row.userId}`;
                          return (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                sendTimerControl(isPaused ? "resume" : "pause", row.userId)
                              }
                              disabled={loading === pauseKey}
                              title={isPaused ? "Reanudar examen" : "Pausar examen"}
                              className={isPaused ? "text-amber-600 hover:text-amber-700" : ""}
                            >
                              {loading === pauseKey ? (
                                <Spinner size="sm" />
                              ) : isPaused ? (
                                <Play className="h-3.5 w-3.5" />
                              ) : (
                                <Pause className="h-3.5 w-3.5" />
                              )}
                              <span className="ml-1 text-[11px]">
                                {isPaused ? "Reanudar" : "Pausar"}
                              </span>
                            </Button>
                          );
                        })()}
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

      <Dialog
        open={viewingId != null}
        onOpenChange={(o) => {
          if (!o) {
            setViewingId(null);
            // Cerramos también el panel de comparación: si el docente
            // cierra el modal principal, no tiene sentido conservar el
            // contexto del compañero en memoria.
            setComparisonForCopy(null);
          }
        }}
      >
        <DialogContent
          // max-w-5xl en modo simple para evitar scroll horizontal
          // (las cards de pregunta + grading inputs + AI/copia colapsados
          // necesitan más ancho del que daba 3xl). En modo comparación
          // expandimos a 7xl para acomodar dos columnas cómodamente.
          className={comparisonForCopy ? "max-w-7xl" : "max-w-5xl"}
        >
          <DialogHeader>
            <DialogTitle>Respuestas de {viewingSub?.profile?.full_name ?? "—"}</DialogTitle>
            <DialogDescription>
              {viewingSub?.profile?.institutional_email} · Estado: {statusLabel(viewingSub?.status)}
              {" · "}
              <span className="font-medium">Decimales con coma (ej. 4,5).</span>
            </DialogDescription>
          </DialogHeader>

          {viewingSub && (
            // Layout único: flex row con altura fija (h-[65vh]) +
            // overflow-hidden — esto ata la ScrollArea a una altura
            // concreta para que muestre scrollbar interno cuando el
            // contenido (advertencias + por-pregunta) excede la
            // ventana. Cuando no hay comparación, ScrollArea ocupa el
            // ancho completo (basis-full); cuando sí, toma media y el
            // peer panel ocupa la otra mitad.
            //
            // Antes usábamos `display: contents` para "desaparecer" el
            // wrapper sin comparación, pero eso dejaba a ScrollArea
            // sin un padre con altura concreta y radix no pintaba la
            // barra. Mismo layout en ambos casos resuelve el problema.
            <div className="flex gap-3 h-[65vh] overflow-hidden">
              {/* Antes: <ScrollArea> de radix. Su Viewport interno
                  envuelve los hijos en un `display: table` con
                  `min-width: 100%`, lo que hace que un Monaco Editor
                  (sin `width` explícito) o cualquier hijo "wide" expanda
                  la celda de tabla. El resultado: el texto del enunciado,
                  el feedback de IA y las razones de copia se renderizaban
                  más anchos que el viewport y quedaban cortados a la
                  derecha sin scrollbar. El panel peer ya usaba este
                  patrón con div plano + overflow-y-auto y funcionaba
                  bien — lo replicamos. */}
              <div
                className={`overflow-y-auto pr-4 flex-1 min-w-0 ${
                  comparisonForCopy ? "basis-1/2" : ""
                }`}
              >
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

                  {/* Retroalimentación general del examen */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <MessageSquareText className="h-4 w-4 text-primary" />
                        Retroalimentación general del examen
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <Textarea
                        placeholder="Escribe una retroalimentación general para el estudiante sobre su desempeño en el examen…"
                        value={teacherFeedbackDraft}
                        onChange={(e) => setTeacherFeedbackDraft(e.target.value)}
                        rows={3}
                      />
                      <div className="flex justify-end">
                        <Button
                          size="sm"
                          onClick={saveTeacherFeedback}
                          disabled={teacherFeedbackSaving}
                        >
                          {teacherFeedbackSaving ? (
                            <Spinner size="sm" className="mr-1" />
                          ) : (
                            <Save className="h-3.5 w-3.5 mr-1" />
                          )}
                          Guardar retroalimentación
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  {questions.length === 0 && (
                    <p className="text-sm text-muted-foreground">Este examen no tiene preguntas.</p>
                  )}
                  {(() => {
                    const breakdown: BreakdownItem[] = Array.isArray(
                      viewingSub.answers?.__breakdown,
                    )
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
                              <span className="font-semibold">Pregunta {idx + 1}</span>
                              <Badge variant="outline" className="text-[10px]">
                                {q.type}
                              </Badge>
                              {q.language && (
                                <Badge variant="secondary" className="text-[10px]">
                                  {q.language}
                                </Badge>
                              )}
                              {/* Score badge a la derecha. Si hay override
                                  manual, lo mostramos en color primary
                                  con ícono de lápiz para que sea claro
                                  que la nota fue ajustada por el docente
                                  y no la propuesta por IA. Antes era un
                                  span de texto plano y "manual: X" se
                                  perdía visualmente al lado del marcador. */}
                              <div className="ml-auto flex items-center gap-1.5 tabular-nums">
                                {override != null ? (
                                  <>
                                    <Badge
                                      variant="outline"
                                      className="text-[10px] text-muted-foreground line-through decoration-muted-foreground/60"
                                      title="Nota original de la IA — reemplazada por la manual"
                                    >
                                      {bd?.earned ?? "—"} / {q.points}
                                    </Badge>
                                    <Badge className="text-[10px] bg-primary/15 text-primary border border-primary/30 hover:bg-primary/20">
                                      <Pencil className="h-2.5 w-2.5 mr-1" />
                                      {override.score} / {q.points}
                                    </Badge>
                                  </>
                                ) : (
                                  <Badge variant="outline" className="text-[10px]">
                                    {bd?.earned ?? "—"} / {q.points}
                                  </Badge>
                                )}
                              </div>
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

                            {/* Retroalimentación de la IA. Antes era un border-l
                                fino sobre fondo neutro — se confundía con el
                                texto de la respuesta. Ahora una card con tinte
                                azul + ícono Sparkles para que sea claro a primer
                                vistazo que es OUTPUT del modelo, no parte de la
                                respuesta del alumno. */}
                            {bd?.feedback && (
                              <div className="rounded-md border border-blue-300/60 bg-blue-50/40 dark:bg-blue-500/5 dark:border-blue-500/25 p-2 space-y-1">
                                <div className="flex items-center gap-1.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
                                  <Sparkles className="h-3 w-3" />
                                  <span>{t("integrity.aiFeedbackLabel")}</span>
                                </div>
                                <div className="text-xs whitespace-pre-wrap text-foreground/90">
                                  {bd.feedback}
                                </div>
                              </div>
                            )}

                            {q.expected_rubric && (
                              <details className="text-xs rounded-md border border-border/60 bg-muted/20 p-2">
                                <summary className="cursor-pointer text-muted-foreground font-medium">
                                  {t("integrity.rubricLabel")}
                                </summary>
                                <p className="mt-2 whitespace-pre-wrap text-foreground/80">
                                  {q.expected_rubric}
                                </p>
                              </details>
                            )}

                            {/* Sospecha IA detectada para ESTA pregunta. La edge
                              function `ai-grade-submission` guarda
                              `ai_likelihood` y `ai_reasons` por entry del
                              breakdown; también persistimos `ai_review_at`
                              dentro del breakdown cuando el docente marca la
                              pregunta como revisada. Solo mostramos cuando
                              ai_likelihood >= 0.6 (mismo umbral que el resto). */}
                            {(() => {
                              // Lookup por submissionId — cada intento del
                              // estudiante tiene su propia firma de IA por
                              // pregunta. El docente verá la del intento
                              // que abrió, no un agregado de todos los intentos.
                              const sig = aiSignalsBySubmissionQuestion
                                .get(viewingSub.id)
                                ?.get(q.id);
                              if (!sig || sig.score < 0.6) return null;
                              const reviewed = sig.reviewedAt != null;
                              return (
                                // Collapsible para uniformidad con la sección
                                // de copias por pregunta. Default cerrado para
                                // mantener la card limpia; el docente lo abre
                                // si quiere leer las razones de la IA.
                                <Collapsible defaultOpen={false}>
                                  <div className="rounded-md border border-amber-300 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-2 space-y-2">
                                    <CollapsibleTrigger asChild>
                                      <button
                                        type="button"
                                        className="w-full flex items-center gap-2 text-[11px] font-medium text-amber-700 dark:text-amber-300 group"
                                      >
                                        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                                        <Bot className="h-3 w-3" />
                                        <span>{t("integrity.aiSection")}</span>
                                        <Badge
                                          variant={
                                            sig.score >= 0.85
                                              ? "destructive"
                                              : sig.score >= 0.7
                                                ? "default"
                                                : "secondary"
                                          }
                                          className="text-[10px] ml-auto"
                                        >
                                          {Math.round(sig.score * 100)}%
                                        </Badge>
                                        {reviewed && (
                                          <Badge
                                            variant="outline"
                                            className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                                          >
                                            <Check className="h-3 w-3 mr-1" />
                                            {t("integrity.reviewed")}
                                          </Badge>
                                        )}
                                      </button>
                                    </CollapsibleTrigger>
                                    <CollapsibleContent className="space-y-2">
                                      <CollapsibleReasons text={sig.reasons} />
                                      {/* Botón con outline + fondo del bg
                                          contrarestando el card amber, así
                                          se ve claro en dark + light. Antes
                                          era `variant="ghost"` y desaparecía
                                          contra el fondo ámbar de la sección. */}
                                      <div className="flex justify-end pt-1 border-t border-amber-300/30">
                                        {reviewed ? (
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7 text-[11px] bg-background"
                                            onClick={() =>
                                              toggleQuestionAiReviewedHandler(
                                                sig.submissionId,
                                                q.id,
                                                true,
                                              )
                                            }
                                          >
                                            {t("integrity.reopen")}
                                          </Button>
                                        ) : (
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7 text-[11px] bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                                            onClick={() =>
                                              toggleQuestionAiReviewedHandler(
                                                sig.submissionId,
                                                q.id,
                                                false,
                                              )
                                            }
                                          >
                                            <Check className="h-3 w-3 mr-1" />
                                            {t("integrity.markReviewed")}
                                          </Button>
                                        )}
                                      </div>
                                    </CollapsibleContent>
                                  </div>
                                </Collapsible>
                              );
                            })()}

                            {/* Posibles copias detectadas en ESTA pregunta. Se filtra
                              por question_id; no incluye los pares "overall" (sin
                              question_id), que se muestran en el resumen del modal.
                              Va dentro de un Collapsible porque puede haber varios
                              peers (3-4 en grupos copy-prone) y ocupaba demasiado
                              espacio expandido por defecto. Mostramos el count +
                              similitud máxima en el trigger para que el docente
                              decida si valía la pena abrir. */}
                            {(() => {
                              const userPairs = copyPairsByUser.get(viewingSub.user_id) ?? [];
                              const qPairs = userPairs.filter((p) => p.questionId === q.id);
                              if (qPairs.length === 0) return null;
                              const userNamesLocal = Object.fromEntries(
                                studentRows.map((r) => [r.userId, r.profile?.full_name ?? "—"]),
                              );
                              const maxScore = qPairs.reduce((m, p) => Math.max(m, p.score), 0);
                              const pendingCount = qPairs.filter((p) => !p.reviewedAt).length;
                              return (
                                <Collapsible
                                  // Default expanded SOLO si hay pendientes — los
                                  // ya-revisados arrancan colapsados para reducir
                                  // ruido visual en intentos sin alertas activas.
                                  // Siempre colapsado por defecto: el docente lo
                                  // abre solo si quiere ver el detalle. Mantiene
                                  // la pregunta limpia visualmente cuando hay
                                  // varios peers o muchas preguntas con copia.
                                  defaultOpen={false}
                                >
                                  <div className="rounded-md border border-amber-300 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-2 space-y-2">
                                    <CollapsibleTrigger asChild>
                                      <button
                                        type="button"
                                        className="w-full flex items-center gap-2 text-[11px] font-medium text-amber-700 dark:text-amber-300 group"
                                      >
                                        <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
                                        <Users className="h-3 w-3" />
                                        <span>{t("integrity.copySection")}</span>
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] ml-auto"
                                          title={t("integrity.copyScore")}
                                        >
                                          {qPairs.length} · {Math.round(maxScore * 100)}%
                                        </Badge>
                                        {pendingCount > 0 && (
                                          <Badge
                                            variant="outline"
                                            className="text-[10px] bg-amber-500/15 border-amber-500/30 text-amber-700 dark:text-amber-300"
                                          >
                                            {pendingCount}{" "}
                                            {t("integrity.summaryPending_other", {
                                              count: pendingCount,
                                            })
                                              .replace(`${pendingCount} `, "")
                                              .toLowerCase()}
                                          </Badge>
                                        )}
                                      </button>
                                    </CollapsibleTrigger>
                                    <CollapsibleContent className="space-y-1.5">
                                      {qPairs
                                        .slice()
                                        .sort((a, b) => b.score - a.score)
                                        .map((p) => (
                                          <div
                                            key={p.id}
                                            className="rounded border bg-background p-1.5 text-xs space-y-1"
                                          >
                                            <div className="flex items-center gap-2 flex-wrap">
                                              <span className="font-medium">
                                                {userNamesLocal[p.peerId] ?? p.peerId.slice(0, 8)}
                                              </span>
                                              <Badge
                                                variant={
                                                  p.score >= 0.85
                                                    ? "destructive"
                                                    : p.score >= 0.7
                                                      ? "default"
                                                      : "secondary"
                                                }
                                                className="text-[10px]"
                                              >
                                                {Math.round(p.score * 100)}%
                                              </Badge>
                                              {/* "Ver entrega de [peer]" — abre un panel lateral
                                              en el mismo modal con la respuesta del compañero
                                              a esta pregunta. Solo aparece si tenemos su
                                              submission cargada (presente en studentRows). */}
                                              {(() => {
                                                const peerRow = studentRows.find(
                                                  (r) => r.userId === p.peerId,
                                                );
                                                if (!peerRow) return null;
                                                const isActive =
                                                  comparisonForCopy?.peerUserId === p.peerId &&
                                                  comparisonForCopy?.questionId === q.id;
                                                return (
                                                  <Button
                                                    size="sm"
                                                    variant={isActive ? "secondary" : "outline"}
                                                    className="h-7 text-[11px]"
                                                    onClick={() =>
                                                      setComparisonForCopy(
                                                        isActive
                                                          ? null
                                                          : {
                                                              peerUserId: p.peerId,
                                                              peerSubmissionId: peerRow.latest.id,
                                                              questionId: q.id,
                                                              pairId: p.id,
                                                            },
                                                      )
                                                    }
                                                    // Tooltip mantiene el nombre completo,
                                                    // pero el label visible es corto para
                                                    // que no empuje al botón "Marcar
                                                    // revisada" fuera de la pantalla.
                                                    title={t("integrity.openPeer", {
                                                      name:
                                                        userNamesLocal[p.peerId] ??
                                                        p.peerId.slice(0, 8),
                                                    })}
                                                  >
                                                    <Eye className="h-3 w-3 mr-1" />
                                                    {isActive
                                                      ? t("integrity.closeCompare")
                                                      : t("integrity.openPeerShort")}
                                                  </Button>
                                                );
                                              })()}
                                              <div className="ml-auto">
                                                {p.reviewedAt ? (
                                                  <Badge
                                                    variant="outline"
                                                    className="text-[11px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300 h-7 px-2"
                                                  >
                                                    <Check className="h-3 w-3 mr-1" />
                                                    {t("integrity.reviewed")}
                                                    <button
                                                      type="button"
                                                      className="ml-2 underline text-muted-foreground hover:text-foreground"
                                                      onClick={() =>
                                                        toggleCopyReviewedHandler(p.id, true)
                                                      }
                                                    >
                                                      {t("integrity.reopen")}
                                                    </button>
                                                  </Badge>
                                                ) : (
                                                  // Mismo tratamiento que el botón AI: outline
                                                  // con fondo emerald translúcido — antes era
                                                  // ghost y se perdía contra el card ámbar.
                                                  <Button
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-7 text-[11px] bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                                                    onClick={() =>
                                                      toggleCopyReviewedHandler(p.id, false)
                                                    }
                                                  >
                                                    <Check className="h-3 w-3 mr-1" />
                                                    {t("integrity.markReviewed")}
                                                  </Button>
                                                )}
                                              </div>
                                            </div>
                                            <CollapsibleReasons text={p.reasons} />
                                          </div>
                                        ))}
                                    </CollapsibleContent>
                                  </div>
                                </Collapsible>
                              );
                            })()}

                            {/* Sugerencia de nota por integridad para ESTA pregunta.
                                Combina la firma IA del breakdown con el max score de
                                copia entre pares para esta misma pregunta. Si alguna
                                señal supera 0.6, calcula `bd.earned × (1 − severity)`
                                y muestra un botón para precargar el input manual.
                                Antes esta sugerencia solo existía a nivel submission;
                                el docente tenía que estimar a ojo qué descontar de
                                cada pregunta. */}
                            {(() => {
                              const aiSig = aiSignalsBySubmissionQuestion
                                .get(viewingSub.id)
                                ?.get(q.id);
                              const userPairs = copyPairsByUser.get(viewingSub.user_id) ?? [];
                              const qPairs = userPairs.filter((p) => p.questionId === q.id);
                              const plagiarismMax =
                                qPairs.length > 0
                                  ? qPairs.reduce((m, p) => Math.max(m, p.score), 0)
                                  : null;
                              const currentRaw = bd?.earned != null ? Number(bd.earned) : null;
                              // Si la nota actual es 0 o no existe, no hay nada que
                              // penalizar — la sugerencia sería 0 y no aporta valor.
                              if (currentRaw == null || currentRaw <= 0) return null;
                              const sug = computeIntegritySuggestion(
                                currentRaw,
                                aiSig?.score ?? null,
                                plagiarismMax,
                              );
                              if (!sug) return null;
                              const aiPct = Math.round((aiSig?.score ?? 0) * 100);
                              const cpPct = Math.round((plagiarismMax ?? 0) * 100);
                              return (
                                <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300/70 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-2 text-[11px]">
                                  <AlertTriangle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-300" />
                                  <span className="font-medium text-amber-700 dark:text-amber-300">
                                    {t("integrity.perQuestionSuggestion")}
                                  </span>
                                  <span className="font-semibold tabular-nums">
                                    {sug.suggested.toLocaleString("es-CO")} / {q.points}
                                  </span>
                                  <Badge variant="outline" className="text-[10px]">
                                    {sug.source === "ai"
                                      ? `IA ${aiPct}%`
                                      : sug.source === "plagio"
                                        ? `Copia ${cpPct}%`
                                        : `IA ${aiPct}% + Copia ${cpPct}%`}
                                  </Badge>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-6 text-[11px] ml-auto bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300"
                                    onClick={() =>
                                      setQOverrides((prev) => ({
                                        ...prev,
                                        [q.id]: {
                                          ...(prev[q.id] ?? {
                                            score: null,
                                            feedback: "",
                                          }),
                                          score: sug.suggested,
                                        },
                                      }))
                                    }
                                  >
                                    {t("integrity.applySuggestion")}
                                  </Button>
                                </div>
                              );
                            })()}

                            <div className="border-t pt-2 space-y-2">
                              {/* Header de sección. Antes el bloque de
                                  calificación manual venía pegado al
                                  contenido sin etiqueta — el docente
                                  tenía que adivinar que ese input era
                                  donde va la nota final. Ahora un label
                                  pequeño de sección lo deja explícito. */}
                              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                <Pencil className="h-3 w-3" />
                                <span>{t("integrity.gradingSection")}</span>
                              </div>
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
                                <ConversationSection
                                  parentKind="exam"
                                  questionId={q.id}
                                  submissionId={viewingSub.id}
                                  summary={threadsByQ[`${viewingSub.id}:${q.id}`]}
                                  conversationLabel={t("integrity.conversation")}
                                  pendingLabel={t("integrity.conversationPending")}
                                  onChanged={() => void reloadThreadCounts()}
                                />
                              )}
                            </div>
                          </CardContent>
                        </Card>
                      );
                    });
                  })()}
                </div>
              </div>
              {comparisonForCopy &&
                viewingSub &&
                (() => {
                  // Panel lateral de comparación: muestra la respuesta del
                  // compañero a LA MISMA pregunta + sus señales IA + el botón
                  // "Marcar revisada" sobre el MISMO `pair.id` que el panel
                  // izquierdo. Como `similarity_pairs.id` es compartido, el
                  // toggle se sincroniza automáticamente para ambos lados via
                  // el `setSimilarityPairs` que hace `toggleCopyReviewedHandler`.
                  const peerSub = submissions.find(
                    (s) => s.id === comparisonForCopy.peerSubmissionId,
                  );
                  const peerName =
                    studentRows.find((r) => r.userId === comparisonForCopy.peerUserId)?.profile
                      ?.full_name ?? "—";
                  const q = questions.find((qq) => qq.id === comparisonForCopy.questionId);
                  if (!peerSub || !q) return null;
                  const peerAns = (peerSub.answers as Record<string, unknown>)?.[q.id];
                  // Lookup también por submissionId — el peer tiene su
                  // propio breakdown con firma de IA por pregunta.
                  const peerAiSig = aiSignalsBySubmissionQuestion
                    .get(comparisonForCopy.peerSubmissionId)
                    ?.get(q.id);
                  const pair = similarityPairs.find((p) => p.id === comparisonForCopy.pairId);
                  return (
                    <div className="basis-1/2 flex-1 min-w-0 border-l pl-3 max-h-[55vh] overflow-y-auto">
                      <div className="space-y-3">
                        <div className="flex items-start justify-between gap-2 pb-2 border-b">
                          <div>
                            <div className="text-sm font-semibold flex items-center gap-2">
                              <Eye className="h-4 w-4 text-primary" />
                              {t("integrity.compareTitle", { name: peerName })}
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              {t("integrity.compareSubtitle")}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => setComparisonForCopy(null)}
                          >
                            {t("integrity.closeCompare")}
                          </Button>
                        </div>

                        <div className="text-sm whitespace-pre-wrap text-foreground">
                          {q.content}
                        </div>

                        {/* Respuesta del compañero, mismo render que el panel izquierdo
                        según el tipo de pregunta. Read-only siempre. */}
                        {q.type === "cerrada" && Array.isArray(q.options?.choices) ? (
                          <div className="space-y-1">
                            {(q.options.choices as string[]).map((c, i) => {
                              const isStudent = peerAns === i;
                              const isCorrect = q.options?.correct_index === i;
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
                        ) : q.type === "codigo" || q.type === "java_gui" ? (
                          <CodeEditor
                            value={
                              peerAns == null || peerAns === ""
                                ? "// Sin responder"
                                : typeof peerAns === "string"
                                  ? peerAns
                                  : JSON.stringify(peerAns, null, 2)
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
                          <div className="rounded border bg-muted/30 p-2 text-xs whitespace-pre-wrap font-mono min-h-[40px]">
                            {peerAns == null || peerAns === "" ? (
                              <span className="text-muted-foreground italic">Sin responder</span>
                            ) : typeof peerAns === "string" ? (
                              peerAns
                            ) : (
                              JSON.stringify(peerAns, null, 2)
                            )}
                          </div>
                        )}

                        {/* Sospecha IA del COMPAÑERO para esta pregunta. */}
                        {peerAiSig && peerAiSig.score >= 0.6 && (
                          <div className="rounded-md border border-amber-300 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-2 space-y-1">
                            <div className="flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                              <Bot className="h-3 w-3" />
                              {t("integrity.aiSection")}
                              <Badge
                                variant={
                                  peerAiSig.score >= 0.85
                                    ? "destructive"
                                    : peerAiSig.score >= 0.7
                                      ? "default"
                                      : "secondary"
                                }
                                className="text-[10px] ml-1"
                              >
                                {Math.round(peerAiSig.score * 100)}%
                              </Badge>
                            </div>
                            <CollapsibleReasons text={peerAiSig.reasons} />
                          </div>
                        )}

                        {/* Marca de revisión del MISMO pair.id (compartido). */}
                        {pair && (
                          <div className="rounded-md border bg-background p-2 flex items-center justify-between gap-2">
                            <div className="text-[11px] text-muted-foreground">
                              <Users className="h-3 w-3 inline mr-1" />
                              {Math.round(Number(pair.score) * 100)}%
                            </div>
                            {pair.reviewed_at ? (
                              <Badge
                                variant="outline"
                                className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                              >
                                <Check className="h-3 w-3 mr-1" />
                                {t("integrity.reviewed")}
                                <button
                                  type="button"
                                  className="ml-1 underline text-muted-foreground"
                                  onClick={() => toggleCopyReviewedHandler(pair.id, true)}
                                >
                                  {t("integrity.reopen")}
                                </button>
                              </Badge>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-[11px]"
                                onClick={() => toggleCopyReviewedHandler(pair.id, false)}
                              >
                                <Check className="h-3 w-3 mr-1" />
                                {t("integrity.markReviewed")}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
            </div>
          )}

          <DialogFooter className="flex-col sm:flex-row sm:items-center gap-2 border-t pt-3">
            {viewingSub && (
              <>
                {/* Resumen compacto de notas del intento. La distinción
                    "IA" vs "Final" no era clara — ahora cada uno tiene
                    su HelpHint, label largo y color para diferenciarlo:
                      - IA (azul):    nota propuesta por el modelo en
                                      automatic grading. Es el baseline.
                      - Final (verde):override del docente — si está
                                      poblado pisa la de IA en gradebook,
                                      reportes y nota efectiva del curso.
                    Cuando no hay override, Final refleja la IA. */}
                <div className="flex flex-wrap items-center gap-3 text-xs sm:mr-auto">
                  <span className="inline-flex items-center gap-1 rounded-md border border-blue-500/30 bg-blue-500/10 px-2 py-1 text-blue-700 dark:text-blue-300">
                    <Sparkles className="h-3 w-3" aria-hidden />
                    <span className="font-medium">Nota IA</span>
                    <HelpHint side="top">
                      Nota propuesta automáticamente por la IA al calificar el intento. Es el
                      baseline del modelo — sirve como referencia pero NO se usa para el gradebook
                      si el docente puso una nota Final manual.
                    </HelpHint>
                    <span className="font-semibold tabular-nums">{viewingSub.ai_grade ?? "—"}</span>
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
                    <Check className="h-3 w-3" aria-hidden />
                    <span className="font-medium">Nota Final</span>
                    <HelpHint side="top">
                      Nota efectiva del intento — la que aparece en gradebook, reportes y nota del
                      curso. Si pones un valor manual abajo (override) toma ese; si no, hereda la
                      nota de IA. Cambiarla aquí pisa la calificación automática.
                    </HelpHint>
                    <span className="font-semibold tabular-nums">
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
                {/* Override global manual (DecimalInput + "Guardar
                    calificación") fue removido: la calificación final
                    ahora se recomputa automáticamente desde las notas
                    por pregunta (ver `saveQuestionScore` →
                    computeFinalGrade), y la retroalimentación vive en
                    cada pregunta. No queremos un atajo global que
                    contradiga las notas por pregunta. */}
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
