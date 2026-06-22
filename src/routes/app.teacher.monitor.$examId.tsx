import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import { aiGradeOrEnqueue, PENDING_AI_FEEDBACK } from "@/modules/ai/ai-grading";
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
  Search,
  X as XIcon,
  Check,
  Bot,
  Users,
  ChevronRight,
  ChevronDown,
  Pencil,
  Pause,
  Play,
  BrainCircuit,
} from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { warningLabel, warningEventTimestamp, type WarningEvent } from "@/modules/exams/proctoring";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { statusLabel } from "@/shared/utils/status-labels";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableEmpty } from "@/components/ui/empty-state";
import {
  useMultiSelect,
  MultiSelectCheckbox,
  MultiSelectHeaderCheckbox,
  MultiSelectToolbar,
} from "@/components/ui/multi-select";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/shared/lib/format";
import {
  computeFinalGrade,
  type BreakdownItem as GradeBreakdown,
  type ManualOverride as GradeManual,
} from "@/modules/grading/grade";
import { computeAttemptGrade, retryModeLabel, type RetryMode } from "@/modules/exams/exam-attempts";
import { applyClearOneWarning, applyClearAllWarnings } from "@/modules/exams/exam-session";
import { isExamOpen } from "@/modules/exams/exam-time";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { ConversationSection } from "@/modules/grading/ConversationSection";
import { computeIntegritySuggestion, mentionsAiPenalty } from "@/modules/exams/integrity";
import {
  countPendingByUser,
  rpcMarkCopyReviewed,
  CollapsibleReasons,
  type IntegrityCopyPair,
} from "@/modules/exams/IntegrityReviewDialog";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Input } from "@/components/ui/input";
import { RowAction } from "@/components/ui/row-action";
import { CodeRunOutput } from "@/modules/code/CodeRunOutput";
import { CodeEditor, type CodeLanguage } from "@/modules/code/CodeEditor";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

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
 * Convierte el valor crudo de `submissions.answers[qid]` en un string
 * legible para mostrar en el modal de revisión de recalificación. El
 * shape depende del tipo de pregunta:
 *   - cerrada (single): número = índice de opción, o "" si no respondió.
 *   - cerrada_multi:    array de índices de opción seleccionados.
 *   - abierta / codigo / diagrama / java_gui: string libre con el contenido.
 *
 * Retorna null cuando no hay nada útil que mostrar (respuesta vacía),
 * para que el caller omita el bloque entero en vez de renderizar un
 * cuadro con "Sin respuesta" repetido por toda la lista.
 */
function formatStudentAnswer(
  raw: unknown,
  qType: string | undefined,
  question: Question | undefined,
): string | null {
  if (raw == null) return null;
  if (qType === "cerrada") {
    const idx = typeof raw === "number" ? raw : Number(raw);
    if (Number.isNaN(idx)) return null;
    // `options` puede ser array de strings o array de objetos según
    // cómo guarde el docente. Aceptamos ambos formatos defensivamente.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (question?.options as any) ?? [];
    const arr: unknown[] = Array.isArray(opts) ? opts : (opts.options ?? []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opt = arr[idx] as any;
    const label =
      typeof opt === "string"
        ? opt
        : (opt?.text ??
          opt?.label ??
          i18n.t("hc_routesAppTeacherMonitorExamId.optionN", { n: idx + 1 }));
    return i18n.t("hc_routesAppTeacherMonitorExamId.markedOption", { n: idx + 1, label });
  }
  if (qType === "cerrada_multi") {
    const arr = Array.isArray(raw) ? raw : [];
    if (arr.length === 0) return i18n.t("hc_routesAppTeacherMonitorExamId.noSelection");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (question?.options as any) ?? [];
    const optsArr: unknown[] = Array.isArray(opts) ? opts : (opts.options ?? []);
    const labels = arr.map((i) => {
      const n = typeof i === "number" ? i : Number(i);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opt = optsArr[n] as any;
      const label = typeof opt === "string" ? opt : (opt?.text ?? opt?.label ?? "?");
      return `(${n + 1}) ${label}`;
    });
    return i18n.t("hc_routesAppTeacherMonitorExamId.markedMultiOptions", {
      count: arr.length,
      labels: labels.join(" · "),
    });
  }
  // Tipos de texto libre — abierta, codigo, diagrama, java_gui, python_gui.
  const text = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  return text.trim() ? text : null;
}

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
  // Gate de IA: si el modo global es async y el docente no tiene
  // override activo, muestra dialog "Activar / Encolar / Cancelar"
  // antes de cada acción IA (re-grade single, batch re-grade,
  // detect-plagiarism). El componente GateDialog se monta UNA VEZ
  // al final del JSX.
  const aiGate = useAiAuthorizationGate();
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
  // Preview de recálculo "Todo con IA": guardamos lo que el edge devolvió
  // en dryRun + el snapshot anterior para mostrar OLD vs NEW en un dialog.
  // El docente decide aplicar o descartar. Si aplica, hacemos UPDATE directo
  // con `proposed_update` (no se vuelve a llamar a la IA).
  const [reGradePreview, setReGradePreview] = useState<{
    submissionId: string;
    grade: number;
    breakdown: Array<{
      qid: string;
      type?: string;
      points?: number;
      earned?: number;
      feedback?: string;
      ai_likelihood?: number;
      ai_reasons?: string;
    }>;
    proposed_update: Record<string, unknown>;
    previous: {
      ai_grade: number | null;
      final_override_grade: number | null;
      status: string;
      ai_detected: boolean | null;
      ai_detected_score: number | null;
      breakdown: Array<{
        qid: string;
        earned?: number;
        points?: number;
        feedback?: string;
      }> | null;
    };
    ai_likelihood: number;
    ai_reasons: string;
  } | null>(null);
  const [applyingReGrade, setApplyingReGrade] = useState(false);
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
  // ── Recalificación batch del último intento de TODOS los estudiantes ──
  // El handler `runRegradeLatestAll` invoca el edge function en modo
  // dryRun por cada último-intento finalizado, junta las propuestas en
  // este array y abre el modal `regradeAllOpen` para que el docente
  // apruebe en lote. `applyingBulk` evita doble-click mientras corren
  // los UPDATEs en serie.
  type RegradeRow = {
    submissionId: string;
    userId: string;
    studentName: string;
    previousGrade: number | null;
    suggestedGrade: number;
    aiLikelihood: number;
    aiReasons: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    proposedUpdate: Record<string, any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    breakdown: Array<Record<string, any>>;
    // queued solo aplica al path async (job creado en ai_grading_queue).
    // cancelled aplica cuando el docente aborta el batch a mitad de
    // camino — preservamos las filas ya procesadas y marcamos el resto.
    status: "pending" | "approving" | "approved" | "failed" | "queued" | "cancelled";
    error?: string;
  };
  const [regradeAllOpen, setRegradeAllOpen] = useState(false);
  const [regradeAllRows, setRegradeAllRows] = useState<RegradeRow[]>([]);
  const [regradeAllLoading, setRegradeAllLoading] = useState(false);
  const [regradeAllProgress, setRegradeAllProgress] = useState({ done: 0, total: 0 });
  // Modo del batch en curso. `sync` = dryRun + modal de revisión + aplicar
  // en lote. `async` = encolar N jobs en ai_grading_queue + cierre directo.
  // Determina la copy + qué botones se muestran en el footer.
  const [regradeMode, setRegradeMode] = useState<"sync" | "async">("sync");
  // Nombre del estudiante actualmente en proceso — alimenta el header
  // "Procesando: X" mientras `regradeAllLoading=true`. Antes solo se
  // veía un placeholder estático "Generando propuestas con IA…" que no
  // daba feedback de avance real.
  const [regradeCurrentStudent, setRegradeCurrentStudent] = useState<string | null>(null);
  // AbortController para cancelar el batch en curso. Se setea al
  // arrancar `runRegradeLatestAll` y se chequea en cada iteración del
  // for-loop. Cancelar no aborta las llamadas IA YA en vuelo (el costo
  // de tokens ya está consumido por Gemini), pero detiene las que aún
  // no salieron y deja el modal en estado interactivo.
  const regradeAbortRef = useRef<AbortController | null>(null);
  const [applyingBulk, setApplyingBulk] = useState(false);
  // IDs de submissions cuya fila del dialog de recalificación está
  // expandida. Cada fila expandida muestra el breakdown pregunta-por-
  // pregunta: enunciado, respuesta del alumno, nota propuesta y
  // retroalimentación IA. Permite al docente decidir el "Aplicar" con
  // contexto en vez de apretar el botón a ciegas.
  const [regradeExpanded, setRegradeExpanded] = useState<Set<string>>(new Set());
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
      .is("deleted_at", null)
      .maybeSingle();
    setExam(e ?? null);

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
      return toast.error(friendlyError(error));
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
          return toast.error(friendlyError(subErr));
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
      pause: t("hc_routesAppTeacherMonitorExamId.examPaused"),
      resume: t("hc_routesAppTeacherMonitorExamId.examResumed"),
      add_time: t("hc_routesAppTeacherMonitorExamId.minutesAdded", {
        n: Math.floor(extraSeconds / 60),
      }),
    };
    toast.success(
      i18n.t("toast.routes_app_teacher_monitor_examId.timerControlApplied", {
        defaultValue: "{{label}} {{scope}}",
        label: labels[action],
        scope: targetUserId
          ? t("hc_routesAppTeacherMonitorExamId.scopeStudent")
          : t("hc_routesAppTeacherMonitorExamId.scopeGlobal"),
      }),
    );
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
    if (error) return toast.error(friendlyError(error));
    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === viewingSub.id
          ? { ...s, teacher_feedback: teacherFeedbackDraft.trim() || null }
          : s,
      ),
    );
    toast.success(
      i18n.t("toast.routes_app_teacher_monitor_examId.feedbackSaved", {
        defaultValue: "Retroalimentación guardada",
      }),
    );
  };

  const reGradeWithAI = async (sub: Submission, questionId?: string) => {
    // Gate IA: si modo async sin override, pedimos confirmación
    // (activar override / encolar / cancelar). Si cancela, return.
    const decision = await aiGate.ensureAuthorized();
    if (decision === "cancel") return;
    if (questionId) setAiGradingQid(questionId);
    else setAiGradingId(sub.id);
    try {
      // Recalificar TODO el examen → dryRun primero. Mostramos al docente
      // OLD vs NEW antes de pisar la nota. Recalificar una pregunta puntual
      // se aplica de inmediato (cambio chico, fácil de revertir con override).
      const useDryRun = !questionId;
      const { data, error } = await supabase.functions.invoke("ai-grade-submission", {
        body: questionId
          ? { submissionId: sub.id, questionId }
          : { submissionId: sub.id, dryRun: true },
      });
      if (error || data?.error) {
        // Extrae el mensaje real del response body (no el genérico
        // "Edge Function returned a non-2xx status code").
        const detail = await extractEdgeError(error, data);
        toast.error(detail || t("hc_routesAppTeacherMonitorExamId.aiGradeError"));
        return;
      }
      if (useDryRun && data?.dryRun) {
        // Abrimos el dialog de preview — el docente decide si aplicar.
        setReGradePreview({
          submissionId: sub.id,
          grade: Number(data.grade) || 0,
          breakdown: data.breakdown ?? [],
          proposed_update: data.proposed_update ?? {},
          previous: data.previous ?? {
            ai_grade: sub.ai_grade,
            final_override_grade: sub.final_override_grade,
            status: sub.status,
            ai_detected: sub.ai_detected ?? null,
            ai_detected_score: sub.ai_detected_score ?? null,
            breakdown: (sub.answers?.__breakdown ?? null) as Array<{
              qid: string;
              earned?: number;
              points?: number;
              feedback?: string;
            }> | null,
          },
          ai_likelihood: Number(data.ai_likelihood) || 0,
          ai_reasons: data.ai_reasons ?? "",
        });
        return;
      }
      // Single-question path (sin dryRun): la pregunta ya fue actualizada
      // en DB por el edge function — refrescamos.
      // Auditoría enriquecida con el breakdown completo y los errores
      // por pregunta (si los hubo) para que el admin pueda diagnosticar
      // sin tener que entrar al modal.
      type BreakdownItem = {
        qid: string;
        earned?: number;
        points?: number;
        feedback?: string;
        ai_error?: unknown;
      };
      const bd = (data?.breakdown ?? []) as BreakdownItem[];
      const failed = bd.filter((b) => b.ai_error != null);
      void logEvent({
        action: "ai_grading.completed",
        category: "grading",
        severity: failed.length > 0 ? "warning" : "info",
        entityType: "submission",
        entityId: sub.id,
        metadata: {
          examId,
          questionId: questionId ?? null,
          grade: data?.grade ?? null,
          ai_likelihood: data?.ai_likelihood ?? null,
          ai_reasons: data?.ai_reasons ?? null,
          breakdown: bd,
          failed_questions: failed,
          failed_count: failed.length,
        },
      });
      // Recalificación por pregunta: además de mostrar el AI feedback en
      // `bd.feedback` (panel "Retroalimentación IA"), precargamos la
      // retroalimentación manual del docente con ese mismo texto, así
      // puede editarlo y guardarlo como feedback oficial sin retipear.
      // Si el textarea ya tenía algo distinto, APENDEAMOS para no perder
      // lo que el docente había escrito.
      if (questionId) {
        const newAiFeedback = bd.find((b) => b.qid === questionId)?.feedback?.trim();
        if (newAiFeedback) {
          setQOverrides((prev) => {
            const existing = prev[questionId] ?? { score: null, feedback: "" };
            const prior = (existing.feedback ?? "").trim();
            const merged =
              !prior || prior === newAiFeedback
                ? newAiFeedback
                : `${prior}\n\n— Recalificación con IA —\n${newAiFeedback}`;
            return {
              ...prev,
              [questionId]: { ...existing, feedback: merged },
            };
          });
        }
      }
      toast.success(
        i18n.t("toast.routes_app_teacher_monitor_examId.questionRegradedWithAi", {
          defaultValue: "Pregunta recalificada con IA",
        }),
      );
      load();
    } catch (e: any) {
      toast.error(friendlyError(e, t("hc_routesAppTeacherMonitorExamId.unknownError")));
    } finally {
      setAiGradingId(null);
      setAiGradingQid(null);
    }
  };

  // Aplica el preview cacheado: UPDATE directo a submissions con el snapshot
  // que devolvió el edge en dryRun. NO se vuelve a invocar IA, así que es
  // gratis e idempotente.
  const applyReGrade = async () => {
    if (!reGradePreview) return;
    setApplyingReGrade(true);
    try {
      // El proposed_update viene del edge function con el nuevo
      // __breakdown (incluye feedback IA por pregunta) pero NO toca
      // __manual_overrides. Para que el textarea "Retroalimentación
      // manual" del docente quede precargado con el comentario IA
      // (mismo patrón que el regrade por-pregunta), apilamos los
      // feedbacks de cada breakdown sobre los overrides existentes.
      //
      // Reglas:
      //  - Si no había override para esa pregunta → creamos uno con
      //    el feedback IA y el score AI como nota propuesta.
      //  - Si había override con feedback vacío → solo seteamos feedback.
      //  - Si había feedback distinto → APENDEAMOS bajo un separador
      //    para no perder lo que el docente había escrito.
      const proposed = reGradePreview.proposed_update as {
        answers?: Record<string, unknown> & {
          __breakdown?: Array<{
            qid: string;
            earned?: number;
            feedback?: string;
          }>;
          __manual_overrides?: Record<string, { score: number; feedback?: string }>;
        };
        [k: string]: unknown;
      };
      const proposedAnswers = (proposed.answers ?? {}) as Record<string, unknown> & {
        __breakdown?: Array<{ qid: string; earned?: number; feedback?: string }>;
        __manual_overrides?: Record<string, { score: number; feedback?: string }>;
      };
      const newBreakdown = proposedAnswers.__breakdown ?? [];
      const prevOverrides: Record<string, { score: number; feedback?: string }> = {
        ...(proposedAnswers.__manual_overrides ?? {}),
      };
      const SEP = "\n\n— Recalificación con IA —\n";
      for (const b of newBreakdown) {
        const aiFb = b.feedback?.trim();
        if (!aiFb) continue;
        const cur = prevOverrides[b.qid];
        if (!cur) {
          // No había override — no creamos uno con score (eso fuerza
          // un final_override_grade que cambia el ranking). Solo
          // creamos override SI el docente ya había puesto algo.
          // El feedback IA seguirá visible vía bd.feedback (panel
          // "Retroalimentación IA"). Esto evita pisar la nota
          // automática del breakdown con un override accidental.
          continue;
        }
        const prior = (cur.feedback ?? "").trim();
        cur.feedback =
          !prior || prior === aiFb
            ? aiFb
            : prior.includes(SEP.trim())
              ? `${prior.split(SEP)[0].trim()}${SEP}${aiFb}`
              : `${prior}${SEP}${aiFb}`;
      }
      const payload = {
        ...proposed,
        answers: { ...proposedAnswers, __manual_overrides: prevOverrides },
      };

      const { error } = await supabase
        .from("submissions")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(payload as any)
        .eq("id", reGradePreview.submissionId);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      // Capturamos los errores per-pregunta del breakdown para audit.
      type BreakdownItem = {
        qid: string;
        earned?: number;
        points?: number;
        feedback?: string;
        ai_error?: unknown;
      };
      const bd = (reGradePreview.breakdown ?? []) as BreakdownItem[];
      const failed = bd.filter((b) => b.ai_error != null);
      void logEvent({
        action: "ai_grading.completed",
        category: "grading",
        severity: failed.length > 0 ? "warning" : "info",
        entityType: "submission",
        entityId: reGradePreview.submissionId,
        metadata: {
          examId,
          questionId: null,
          grade: reGradePreview.grade,
          previous_grade: reGradePreview.previous.ai_grade,
          ai_likelihood: reGradePreview.ai_likelihood,
          ai_reasons: reGradePreview.ai_reasons,
          breakdown: bd,
          failed_questions: failed,
          failed_count: failed.length,
          mode: "dry_run_accepted",
        },
      });
      toast.success(
        i18n.t("toast.routes_app_teacher_monitor_examId.newGradeApplied", {
          defaultValue: "Nueva calificación aplicada",
        }),
      );
      setReGradePreview(null);
      load();
    } finally {
      setApplyingReGrade(false);
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
  // Limpia __warning_events del JSON y pone focus_warnings a 0.
  // Si el intento estaba en 'sospechoso' (por alcanzar el umbral de strikes)
  // lo regresa a 'en_progreso' y limpia submitted_at para que el estudiante
  // pueda reingresar al examen.
  const clearAllWarnings = async (sub: Submission) => {
    const prevAnswers = sub.answers ?? {};
    const events = (prevAnswers.__warning_events ?? []) as WarningEvent[];
    const examOpen = exam
      ? isExamOpen({ start_time: exam.start_time, end_time: exam.end_time })
      : false;
    const result = applyClearAllWarnings({
      status: sub.status,
      focusWarnings: sub.focus_warnings ?? 0,
      events,
      examMaxWarnings: exam?.max_warnings ?? 3,
      examIsOpen: examOpen,
    });
    const ok = await confirm({
      title: t("monitor.clearWarningsTitle"),
      description: result.restoredToInProgress
        ? t("hc_routesAppTeacherMonitorExamId.clearAllWarningsRestoreBody")
        : result.closedAsCompletado
          ? t("hc_routesAppTeacherMonitorExamId.clearAllWarningsClosedBody")
          : t("monitor.clearWarningsBody"),
      confirmLabel: t("monitor.clearWarningsConfirm"),
      tone: "warning",
    });
    if (!ok) return;
    const { __warning_events: _evs, ...rest } = prevAnswers;
    void _evs;
    const nextAnswers = rest;
    const updatePayload: Record<string, unknown> = {
      focus_warnings: result.focusWarnings,
      answers: nextAnswers,
      status: result.status,
    };
    if (result.clearSubmittedAt) updatePayload.submitted_at = null;
    const { error } = await supabase
      .from("submissions")
      .update(updatePayload as never)
      .eq("id", sub.id);
    if (error) return toast.error(friendlyError(error));
    // Auditoría: borrar advertencias es decisión sensible — rastro con before/after.
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
        new_status: result.status,
      },
    });
    toast.success(
      result.restoredToInProgress
        ? t("hc_routesAppTeacherMonitorExamId.warningsClearedRestored")
        : t("hc_routesAppTeacherMonitorExamId.warningsCleared"),
    );
    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === sub.id
          ? {
              ...s,
              focus_warnings: result.focusWarnings,
              answers: nextAnswers,
              status: result.status,
              submitted_at: result.clearSubmittedAt ? null : s.submitted_at,
            }
          : s,
      ),
    );
  };

  // Borra UNA advertencia puntual del array de eventos. focus_warnings
  // se decrementa para mantener consistencia con la longitud del array.
  // Si tras decrementar el intento ya no supera el umbral y estaba en
  // sospechoso, lo regresamos a en_progreso (+ limpiamos submitted_at)
  // para que el estudiante pueda reingresar al examen.
  const clearOneWarning = async (sub: Submission, idx: number) => {
    const prevAnswers = sub.answers ?? {};
    const events = (prevAnswers.__warning_events ?? []) as WarningEvent[];
    const examOpen = exam
      ? isExamOpen({ start_time: exam.start_time, end_time: exam.end_time })
      : false;
    const result = applyClearOneWarning(
      {
        status: sub.status,
        focusWarnings: sub.focus_warnings ?? 0,
        events,
        examMaxWarnings: exam?.max_warnings ?? 3,
        examIsOpen: examOpen,
      },
      idx,
    );
    if (idx < 0 || idx >= events.length) return;
    const nextAnswers = { ...prevAnswers, __warning_events: result.events };
    const updatePayload: Record<string, unknown> = {
      focus_warnings: result.focusWarnings,
      answers: nextAnswers,
      status: result.status,
    };
    if (result.clearSubmittedAt) updatePayload.submitted_at = null;
    const { error } = await supabase
      .from("submissions")
      .update(updatePayload as never)
      .eq("id", sub.id);
    if (error) return toast.error(friendlyError(error));
    toast.success(
      result.restoredToInProgress
        ? t("hc_routesAppTeacherMonitorExamId.warningClearedRestored")
        : result.closedAsCompletado
          ? t("hc_routesAppTeacherMonitorExamId.warningClearedClosed")
          : t("hc_routesAppTeacherMonitorExamId.warningCleared"),
    );
    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === sub.id
          ? {
              ...s,
              focus_warnings: result.focusWarnings,
              answers: nextAnswers,
              status: result.status,
              submitted_at: result.clearSubmittedAt ? null : s.submitted_at,
            }
          : s,
      ),
    );
  };

  const saveQuestionOverride = async (sub: Submission, q: Question) => {
    const entry = qOverrides[q.id] ?? { score: null, feedback: "" };
    const numScore: number | null = entry.score;
    if (numScore != null && (Number.isNaN(numScore) || numScore < 0 || numScore > q.points)) {
      toast.error(
        i18n.t("toast.routes_app_teacher_monitor_examId.gradeOutOfRange", {
          defaultValue: "La calificación debe estar entre 0 y {{max}}",
          max: q.points,
        }),
      );
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
    if (error) return toast.error(friendlyError(error));
    toast.success(
      numScore == null
        ? t("hc_routesAppTeacherMonitorExamId.questionGradeRemoved")
        : t("hc_routesAppTeacherMonitorExamId.questionGradeSaved"),
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

  // ── Multi-select para recalificar un subset ──
  // Útil cuando el docente NO confía en N entregas puntuales o cuando
  // los jobs de esas N se desencolaron. Trabaja sobre las submissions
  // "latest" por estudiante con status FINAL (los únicos que el batch
  // puede recalificar). Replicamos un mini-derivado de studentRows
  // acá porque studentRows se calcula DESPUÉS del early return — los
  // hooks deben llamarse SIEMPRE, antes de cualquier return.
  const selectableSubmissions = useMemo(() => {
    const FINAL = new Set(["completado", "sospechoso", "calificado", "requiere_revision"]);
    const latestByUser = new Map<string, Submission>();
    for (const s of submissions) {
      const cur = latestByUser.get(s.user_id);
      if (!cur || new Date(s.created_at).getTime() > new Date(cur.created_at).getTime()) {
        latestByUser.set(s.user_id, s);
      }
    }
    const q = monitorSearch.trim().toLowerCase();
    return Array.from(latestByUser.values()).filter((s) => {
      if (!FINAL.has(s.status)) return false;
      if (!q) return true;
      const name = (s.profile?.full_name ?? "").toLowerCase();
      const email = (s.profile?.institutional_email ?? "").toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }, [submissions, monitorSearch]);
  const monitorSel = useMultiSelect(selectableSubmissions);

  if (!exam) return <p className="text-muted-foreground p-6">{t("common.loading")}</p>;

  const retryMode: RetryMode = ((exam as any).retry_mode as RetryMode) ?? "last";
  const maxAttempts = Math.max(
    1,
    Number((exam as any).max_attempts ?? exam.course?.max_exam_attempts ?? 1) || 1,
  );

  // Selecciona el último intento finalizado por estudiante. "Finalizado"
  // incluye calificado, ai_revisado, entregado, sospechoso, suspendido —
  // cualquier estado que NO sea en_progreso ni iniciado. El docente puede
  // querer recalificar incluso un "sospechoso" para regenerar feedback.
  const FINAL_FOR_REGRADE = new Set([
    "entregado",
    "calificado",
    "ai_revisado",
    "sospechoso",
    "suspendido",
    "requiere_revision",
  ]);

  // Detecta si una submission YA tiene feedback que documenta penalidad
  // por uso de IA — en cuyo caso re-escanear con IA es desperdicio de
  // tokens (el docente ya decidió). Revisa el feedback global de la
  // submission y el feedback manual de cada pregunta dentro del JSON
  // `__manual_overrides`.
  const submissionHasAiPenaltyFeedback = (sub: Submission): boolean => {
    if (mentionsAiPenalty(sub.teacher_feedback ?? null)) return true;
    const manual = (sub.answers?.__manual_overrides ?? {}) as Record<string, { feedback?: string }>;
    for (const qid in manual) {
      if (mentionsAiPenalty(manual[qid]?.feedback)) return true;
    }
    return false;
  };

  const pickLatestFinalized = (
    opts: { skipAiPenalized?: boolean } = {},
  ): { targets: Submission[]; skipped: Submission[] } => {
    const targets: Submission[] = [];
    const skipped: Submission[] = [];
    for (const r of studentRows) {
      if (!r.latest || !FINAL_FOR_REGRADE.has(r.latest.status)) continue;
      if (opts.skipAiPenalized && submissionHasAiPenaltyFeedback(r.latest)) {
        skipped.push(r.latest);
        continue;
      }
      targets.push(r.latest);
    }
    return { targets, skipped };
  };

  const runDetectFraud = async () => {
    // Gate IA: detect-plagiarism también consume cuota Gemini.
    const decision = await aiGate.ensureAuthorized();
    if (decision === "cancel") return;
    setDetecting(true);
    try {
      // Solo el último intento de cada estudiante. Si un alumno tuvo 3
      // intentos y mejoró en el tercero, comparar contra el primer borrador
      // genera falsos positivos. El edge function respeta este filtro.
      // Omitimos además las entregas donde el docente YA documentó
      // penalidad por IA en el feedback — no aporta nada re-escanear
      // y gasta tokens.
      const { targets, skipped } = pickLatestFinalized({ skipAiPenalized: true });
      const submissionIds = targets.map((s) => s.id);
      if (skipped.length > 0) {
        toast.message(
          t("hc_routesAppTeacherMonitorExamId.submissionsSkippedAiPenalty", {
            count: skipped.length,
          }),
        );
      }
      const { data, error } = await supabase.functions.invoke("detect-plagiarism", {
        body: { kind: "exam", refId: examId, submissionIds },
      });
      // Extraer el body real del FunctionsHttpError antes de throw:
      // sin esto, `error.message` es el genérico "Edge Function
      // returned a non-2xx status code" y el catch de abajo muestra
      // ese ruido al docente en vez del motivo real (rate limit,
      // permission, etc.).
      if (error || (data as { error?: string })?.error) {
        const detail = await extractEdgeError(error, data);
        throw new Error(detail || t("hc_routesAppTeacherMonitorExamId.detectPlagiarismError"));
      }
      const summary = data as { pairs?: unknown[]; message?: string };
      const found = Array.isArray(summary?.pairs) ? summary.pairs.length : 0;
      void logEvent({
        action: "ai_plagiarism.detected",
        category: "fraud",
        severity: found > 0 ? "warning" : "info",
        entityType: "exam",
        entityId: examId,
        metadata: { pairs_found: found },
      });
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

  // ── Recalificar último intento (batch) ──
  // Itera el último intento finalizado de cada estudiante, invoca
  // `ai-grade-submission` en dryRun para obtener la propuesta SIN
  // aplicarla, y abre un modal donde el docente revisa y aprueba en
  // lote. Costo IA: 1 llamada por estudiante con intento finalizado.
  //
  // `explicitTargets`: si se pasa, NO usa pickLatestFinalized — usa
  // exactamente esos submissions. Útil para el flujo de multi-select
  // donde el docente eligió un subset (ej. solo los 3 que cree mal
  // calificados, o los que se desencolaron). En ese caso TAMPOCO
  // filtramos por skipAiPenalized: el docente eligió manualmente, no
  // tiene sentido descartarle algo que pidió.
  const runRegradeLatestAll = async (explicitTargets?: Submission[]) => {
    // Gate IA: el batch es el caso más caro (1 call por estudiante).
    const decision = await aiGate.ensureAuthorized();
    if (decision === "cancel") return;
    // Saltamos entregas cuyo feedback YA documenta penalidad por IA —
    // ahí el docente ya decidió y re-escanear con IA es gasto puro de
    // tokens (1 call Gemini ≈ ~1.5K tokens). Si el docente quiere
    // forzar el re-escaneo, basta con que cambie el texto del feedback
    // (ej. agregue "(re-evaluar)") para que la heurística falle.
    const { targets, skipped } = explicitTargets
      ? { targets: explicitTargets, skipped: [] as Submission[] }
      : pickLatestFinalized({ skipAiPenalized: true });
    if (targets.length === 0) {
      if (skipped.length > 0) {
        toast.message(
          t("hc_routesAppTeacherMonitorExamId.allSubmissionsHaveAiPenalty", {
            count: skipped.length,
          }),
        );
      } else {
        toast.message(t("hc_routesAppTeacherMonitorExamId.noFinalizedAttempts"));
      }
      return;
    }
    if (skipped.length > 0) {
      toast.message(
        t("hc_routesAppTeacherMonitorExamId.submissionsSkippedAiPenalty", {
          count: skipped.length,
        }),
      );
    }

    // Abort controller compartido por ambos paths — el botón Cancelar
    // del modal lo dispara y el for-loop chequea `signal.aborted` en
    // cada iteración. Las llamadas IA YA en vuelo no se abortan (su
    // costo de tokens ya está consumido), pero las siguientes no salen.
    const abortCtrl = new AbortController();
    regradeAbortRef.current = abortCtrl;
    const signal = abortCtrl.signal;

    setRegradeAllRows([]);
    setRegradeAllProgress({ done: 0, total: targets.length });
    setRegradeAllLoading(true);
    setRegradeCurrentStudent(null);
    setRegradeAllOpen(true);

    const studentNameFor = (userId: string) =>
      studentRows.find((r) => r.userId === userId)?.profile?.full_name ?? "—";

    // ── Path ASYNC: el docente eligió "Continuar en cola" en el gate.
    // Encolamos N jobs en `ai_grading_queue`. La edge function persiste
    // internamente (Caso A — escribe submissions directo) cuando el
    // worker drene. NO ofrecemos revisión previa porque async no
    // soporta dryRun. El modal muestra el progreso del encolado y el
    // estado final por estudiante.
    if (decision === "proceed-async") {
      setRegradeMode("async");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminDb = supabase as any;
      const rows: RegradeRow[] = [];
      for (const sub of targets) {
        if (signal.aborted) break;
        const studentName = studentNameFor(sub.user_id);
        setRegradeCurrentStudent(studentName);
        try {
          await adminDb
            .from("submissions")
            .update({ ai_feedback: PENDING_AI_FEEDBACK, ai_grade: null })
            .eq("id", sub.id);
          const result = await aiGradeOrEnqueue({
            // "exam_submission" (NO "exam_full") para deduplicar contra el job
            // del submit del alumno: el dedup de ai_grading_queue es por
            // (target_table, target_row_id, KIND). Con kinds distintos la misma
            // entrega se calificaba dos veces (doble gasto IA). El worker no
            // ramifica por kind. Ver grade-submission.ts.
            kind: "exam_submission",
            invokeTarget: "ai-grade-submission",
            body: { submissionId: sub.id },
            target: {
              table: "submissions",
              rowId: sub.id,
              fieldGrade: "ai_grade",
              fieldFeedback: "ai_feedback",
              courseId: (exam as { course_id?: string } | null)?.course_id ?? null,
            },
          });
          rows.push({
            submissionId: sub.id,
            userId: sub.user_id,
            studentName,
            previousGrade: sub.final_override_grade ?? sub.ai_grade ?? null,
            suggestedGrade: 0,
            aiLikelihood: 0,
            aiReasons: "",
            proposedUpdate: {},
            breakdown: [],
            status: result.error ? "failed" : "queued",
            error: result.error,
          });
        } catch (e) {
          rows.push({
            submissionId: sub.id,
            userId: sub.user_id,
            studentName,
            previousGrade: sub.final_override_grade ?? sub.ai_grade ?? null,
            suggestedGrade: 0,
            aiLikelihood: 0,
            aiReasons: "",
            proposedUpdate: {},
            breakdown: [],
            status: "failed",
            error: e instanceof Error ? e.message : String(e),
          });
        }
        setRegradeAllRows([...rows]);
        setRegradeAllProgress((p) => ({ ...p, done: p.done + 1 }));
      }
      // Si quedó cancelado a mitad, marcar las que faltaron por procesar
      // para que el docente vea claro qué quedó fuera.
      if (signal.aborted) {
        const processedIds = new Set(rows.map((r) => r.submissionId));
        for (const sub of targets) {
          if (processedIds.has(sub.id)) continue;
          rows.push({
            submissionId: sub.id,
            userId: sub.user_id,
            studentName: studentNameFor(sub.user_id),
            previousGrade: sub.final_override_grade ?? sub.ai_grade ?? null,
            suggestedGrade: 0,
            aiLikelihood: 0,
            aiReasons: "",
            proposedUpdate: {},
            breakdown: [],
            status: "cancelled",
          });
        }
        setRegradeAllRows([...rows]);
      }
      setRegradeAllLoading(false);
      setRegradeCurrentStudent(null);
      const queued = rows.filter((r) => r.status === "queued").length;
      const failed = rows.filter((r) => r.status === "failed").length;
      const cancelled = rows.filter((r) => r.status === "cancelled").length;
      if (queued > 0) {
        // Mensaje sin "cada hora": en este proyecto el cron no corre
        // por defecto, así que el docente debe procesar la cola
        // manualmente desde el módulo Cola cuando quiera ver las notas.
        toast.success(
          i18n.t("toast.routes_app_teacher_monitor_examId.jobsQueued", {
            defaultValue:
              "{{count}} job(s) encolado(s). Procesa la cola desde el módulo Cola o espera a la tarea programada.",
            count: queued,
          }),
        );
      }
      if (failed > 0) {
        toast.error(
          i18n.t("toast.routes_app_teacher_monitor_examId.jobsQueueFailed", {
            defaultValue: "{{count}} job(s) no se pudieron encolar — reintenta más tarde.",
            count: failed,
          }),
        );
      }
      if (cancelled > 0) {
        toast.info(
          i18n.t("toast.routes_app_teacher_monitor_examId.jobsQueueCancelled", {
            defaultValue: "Cancelado: {{count}} job(s) no se encolaron.",
            count: cancelled,
          }),
        );
      }
      void load();
      return;
    }

    // ── Path SYNC: modo sync global O override activo. Conserva el
    // flujo dryRun → modal de revisión → aplicar lote.
    setRegradeMode("sync");
    const rows: RegradeRow[] = [];
    for (const sub of targets) {
      if (signal.aborted) break;
      const studentName = studentNameFor(sub.user_id);
      setRegradeCurrentStudent(studentName);
      try {
        const { data, error } = await supabase.functions.invoke("ai-grade-submission", {
          body: { submissionId: sub.id, dryRun: true },
        });
        if (error || (data && (data as { error?: string }).error)) {
          const detail = await extractEdgeError(error, data);
          rows.push({
            submissionId: sub.id,
            userId: sub.user_id,
            studentName,
            previousGrade: sub.final_override_grade ?? sub.ai_grade ?? null,
            suggestedGrade: 0,
            aiLikelihood: 0,
            aiReasons: "",
            proposedUpdate: {},
            breakdown: [],
            status: "failed",
            error: detail || t("hc_routesAppTeacherMonitorExamId.unknownError"),
          });
        } else {
          const d = data as {
            grade?: number;
            ai_likelihood?: number;
            ai_reasons?: string;
            proposed_update?: Record<string, unknown>;
            breakdown?: Array<Record<string, unknown>>;
          };
          rows.push({
            submissionId: sub.id,
            userId: sub.user_id,
            studentName,
            previousGrade: sub.final_override_grade ?? sub.ai_grade ?? null,
            suggestedGrade: Number(d.grade) || 0,
            aiLikelihood: Number(d.ai_likelihood) || 0,
            aiReasons: d.ai_reasons ?? "",
            proposedUpdate: d.proposed_update ?? {},
            breakdown: d.breakdown ?? [],
            status: "pending",
          });
        }
      } catch (e) {
        rows.push({
          submissionId: sub.id,
          userId: sub.user_id,
          studentName,
          previousGrade: sub.final_override_grade ?? sub.ai_grade ?? null,
          suggestedGrade: 0,
          aiLikelihood: 0,
          aiReasons: "",
          proposedUpdate: {},
          breakdown: [],
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        });
      }
      // Actualizamos incrementalmente para que el docente vea progreso
      // sin esperar a que terminen todos.
      setRegradeAllRows([...rows]);
      setRegradeAllProgress((p) => ({ ...p, done: p.done + 1 }));
    }
    setRegradeAllLoading(false);
    setRegradeCurrentStudent(null);
    const failed = rows.filter((r) => r.status === "failed").length;
    if (signal.aborted) {
      const okCount = rows.length - failed;
      toast.info(
        i18n.t("toast.routes_app_teacher_monitor_examId.regradeCancelled", {
          defaultValue:
            "Cancelado en {{done}}/{{total}}. {{ok}} propuesta(s) listas para revisar.",
          done: rows.length,
          total: targets.length,
          ok: okCount,
        }),
      );
    } else if (failed > 0) {
      toast.warning(
        i18n.t("toast.routes_app_teacher_monitor_examId.regradeReadyWithErrors", {
          defaultValue: "Recalificación lista. {{ok}} ok, {{failed}} con error.",
          ok: rows.length - failed,
          failed,
        }),
      );
    } else {
      toast.success(
        i18n.t("toast.routes_app_teacher_monitor_examId.regradeReady", {
          defaultValue: "Recalificación lista. {{count}} propuestas para revisar.",
          count: rows.length,
        }),
      );
    }
    void logEvent({
      action: "ai_grading.batch_dryrun",
      category: "grading",
      severity: "info",
      entityType: "exam",
      entityId: examId,
      metadata: {
        total: rows.length,
        failed,
        ok: rows.length - failed,
      },
    });
  };

  // Aplica UNA fila del preview batch. Reutiliza la lógica de merge de
  // __manual_overrides con feedback IA que ya implementamos en
  // `applyReGrade` (single).
  const applyRegradeRow = async (idx: number) => {
    const row = regradeAllRows[idx];
    if (!row || row.status !== "pending") return false;
    setRegradeAllRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, status: "approving" } : r)),
    );
    try {
      const proposedAnswers = (row.proposedUpdate.answers ?? {}) as Record<string, unknown> & {
        __breakdown?: Array<{ qid: string; feedback?: string }>;
        __manual_overrides?: Record<string, { score: number; feedback?: string }>;
      };
      const overrides: Record<string, { score: number; feedback?: string }> = {
        ...(proposedAnswers.__manual_overrides ?? {}),
      };
      const SEP = "\n\n— Recalificación con IA —\n";
      for (const b of proposedAnswers.__breakdown ?? []) {
        const aiFb = b.feedback?.trim();
        if (!aiFb) continue;
        const cur = overrides[b.qid];
        if (!cur) continue;
        const prior = (cur.feedback ?? "").trim();
        cur.feedback =
          !prior || prior === aiFb
            ? aiFb
            : prior.includes(SEP.trim())
              ? `${prior.split(SEP)[0].trim()}${SEP}${aiFb}`
              : `${prior}${SEP}${aiFb}`;
      }
      const payload = {
        ...row.proposedUpdate,
        answers: { ...proposedAnswers, __manual_overrides: overrides },
      };
      const { error } = await supabase
        .from("submissions")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update(payload as any)
        .eq("id", row.submissionId);
      if (error) {
        setRegradeAllRows((prev) =>
          prev.map((r, i) => (i === idx ? { ...r, status: "failed", error: error.message } : r)),
        );
        return false;
      }
      setRegradeAllRows((prev) =>
        prev.map((r, i) => (i === idx ? { ...r, status: "approved" } : r)),
      );
      return true;
    } catch (e) {
      setRegradeAllRows((prev) =>
        prev.map((r, i) =>
          i === idx
            ? { ...r, status: "failed", error: e instanceof Error ? e.message : String(e) }
            : r,
        ),
      );
      return false;
    }
  };

  const applyAllRegrade = async () => {
    setApplyingBulk(true);
    try {
      let ok = 0;
      for (let i = 0; i < regradeAllRows.length; i++) {
        if (regradeAllRows[i].status !== "pending") continue;
        const r = await applyRegradeRow(i);
        if (r) ok++;
      }
      void logEvent({
        action: "ai_grading.batch_applied",
        category: "grading",
        severity: "warning",
        entityType: "exam",
        entityId: examId,
        metadata: { applied: ok, total: regradeAllRows.length },
      });
      if (ok > 0)
        toast.success(
          i18n.t("toast.routes_app_teacher_monitor_examId.gradesApplied", {
            defaultValue: "{{count}} nota(s) aplicada(s).",
            count: ok,
          }),
        );
      await load();
    } finally {
      setApplyingBulk(false);
    }
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
      toast.error(friendlyError(error));
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

  // Helper de bulk re-grade. NO es hook (los hooks `useMemo` +
  // `useMultiSelect` se llaman ANTES del early return — ver bloque
  // `selectableSubmissions` arriba). Solo encadena la lógica.
  const runRegradeSelected = async () => {
    const selectedSubs = selectableSubmissions.filter((s) => monitorSel.isSelected(s.id));
    if (selectedSubs.length === 0) return;
    await runRegradeLatestAll(selectedSubs);
    monitorSel.clear();
  };

  const deleteOneAttempt = async (sub: Submission) => {
    const ok = await confirm({
      title: t("monitor.deleteAttemptTitle", { date: formatDateTime(sub.created_at) }),
      description: t("monitor.deleteAttemptBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("submissions").delete().eq("id", sub.id);
    if (error) return toast.error(friendlyError(error));
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
    if (error) return toast.error(friendlyError(error));
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
            {exam.course?.name} · {t("hc_routesAppTeacherMonitorExamId.retryModeLabel")}{" "}
            <span className="font-medium">{retryModeLabel(retryMode)}</span> ·{" "}
            {t("hc_routesAppTeacherMonitorExamId.maxAttemptsLabel")} {maxAttempts}
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
              <div className="flex items-center gap-2 shrink-0">
                {/* Hint inline para invitar al multi-select cuando hay
                    seleccionables y aún ninguno marcado. Sin esto el
                    docente no descubre los checkboxes de la izquierda
                    y termina recalificando a todos los estudiantes
                    aunque quería solo unos pocos. Aparece como pista
                    sutil; desaparece apenas marca algo (entonces el
                    MultiSelectToolbar toma el relevo). */}
                {selectableSubmissions.length > 0 && monitorSel.count === 0 && (
                  <span className="text-[11px] text-muted-foreground hidden md:inline-flex items-center gap-1">
                    <span aria-hidden>↙</span>
                    {t("hc_routesAppTeacherMonitorExamId.multiSelectHint")}
                  </span>
                )}
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => void runRegradeLatestAll()}
                  disabled={regradeAllLoading || detecting}
                  title={t("hc_routesAppTeacherMonitorExamId.regradeLatestButtonTitle")}
                >
                  {regradeAllLoading ? (
                    <Spinner size="sm" className="mr-1.5" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {regradeAllLoading
                    ? t("hc_routesAppTeacherMonitorExamId.regradingProgress", {
                        done: regradeAllProgress.done,
                        total: regradeAllProgress.total,
                      })
                    : t("hc_routesAppTeacherMonitorExamId.regradeLatestButton")}
                </Button>
                <Button
                  size="sm"
                  variant="default"
                  onClick={runDetectFraud}
                  disabled={detecting || regradeAllLoading}
                >
                  {detecting ? (
                    <Spinner size="sm" className="mr-1.5" />
                  ) : (
                    <BrainCircuit className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  {detecting ? t("integrity.detecting") : t("integrity.detectButton")}
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Live submissions */}
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              {t("hc_routesAppTeacherMonitorExamId.inProgressCount", {
                count: inProgressStudents.length,
              })}{" "}
              ·{" "}
              {t("hc_routesAppTeacherMonitorExamId.completedCount", {
                count: completedStudents.length,
              })}
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={load}>
              <Clock className="h-4 w-4 mr-1" /> {t("hc_routesAppTeacherMonitorExamId.refresh")}
            </Button>
          </div>
          {studentRows.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1 max-w-sm">
                <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                <Input
                  value={monitorSearch}
                  onChange={(e) => setMonitorSearch(e.target.value)}
                  placeholder={t("hc_routesAppTeacherMonitorExamId.searchPlaceholder")}
                  className="h-8 pl-8 pr-8 text-xs"
                />
                {monitorSearch && (
                  <button
                    type="button"
                    onClick={() => setMonitorSearch("")}
                    aria-label={t("hc_routesAppTeacherMonitorExamId.clearSearch")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <XIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              {monitorSearch && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {t("hc_routesAppTeacherMonitorExamId.filteredCount", {
                    shown: filteredStudentRows.length,
                    total: studentRows.length,
                  })}
                </span>
              )}
            </div>
          )}
        </CardHeader>
        {/* Toolbar de bulk recalificación. Solo aparece con >=1 seleccionado.
            "Recalificar" acá NO borra — corre el mismo flujo que el botón
            global pero solo sobre los IDs marcados. Usamos `actionLabel`
            del design system para sobrescribir el "Eliminar" default. */}
        <MultiSelectToolbar
          count={monitorSel.count}
          onClear={monitorSel.clear}
          onDelete={() => void runRegradeSelected()}
          entityNameSingular={t("hc_routesAppTeacherMonitorExamId.entityStudentSingular")}
          entityNamePlural={t("hc_routesAppTeacherMonitorExamId.entityStudentPlural")}
          actionLabel={t("hc_routesAppTeacherMonitorExamId.regradeWithAiAction")}
          actionIcon={Sparkles}
        />
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  {selectableSubmissions.length > 0 && (
                    <MultiSelectHeaderCheckbox state={monitorSel} />
                  )}
                </TableHead>
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
                <TableEmpty
                  colSpan={11}
                  text={t("hc_routesAppTeacherMonitorExamId.emptyNoStudentsStarted")}
                />
              )}
              {studentRows.length > 0 && filteredStudentRows.length === 0 && (
                <TableEmpty
                  colSpan={11}
                  text={t("hc_routesAppTeacherMonitorExamId.emptyNoSearchMatch")}
                />
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
                // El checkbox de fila solo aplica a estudiantes con un
                // `latest` en estado final (los seleccionables para
                // recalificación). El resto recibe un placeholder vacío
                // para mantener la columna alineada.
                const isSelectable =
                  !!latest &&
                  (latest.status === "completado" ||
                    latest.status === "sospechoso" ||
                    latest.status === "calificado" ||
                    latest.status === "requiere_revision");
                return (
                  <TableRow
                    key={row.userId}
                    data-state={latest && monitorSel.isSelected(latest.id) ? "selected" : undefined}
                  >
                    <TableCell className="w-10">
                      {isSelectable && latest ? (
                        <MultiSelectCheckbox id={latest.id} state={monitorSel} />
                      ) : (
                        <div className="w-4 shrink-0" aria-hidden="true" />
                      )}
                    </TableCell>
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
                        title={t("hc_routesAppTeacherMonitorExamId.viewManageAttempts")}
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
                                title={t("hc_routesAppTeacherMonitorExamId.openConversations", {
                                  count: open,
                                })}
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
                                title={t("hc_routesAppTeacherMonitorExamId.pendingConversations", {
                                  count: pending,
                                })}
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
                        {inProg &&
                          (() => {
                            const isPaused = pausedUserIds.has(row.userId);
                            const pauseKey = isPaused
                              ? `resume-${row.userId}`
                              : `pause-${row.userId}`;
                            return (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() =>
                                  sendTimerControl(isPaused ? "resume" : "pause", row.userId)
                                }
                                disabled={loading === pauseKey}
                                title={
                                  isPaused
                                    ? t("hc_routesAppTeacherMonitorExamId.resumeExamTitle")
                                    : t("hc_routesAppTeacherMonitorExamId.pauseExamTitle")
                                }
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
                                  {isPaused
                                    ? t("hc_routesAppTeacherMonitorExamId.resume")
                                    : t("hc_routesAppTeacherMonitorExamId.pause")}
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
                            title={t("hc_routesAppTeacherMonitorExamId.add5MinutesTitle")}
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
                          label={t("hc_routesAppTeacherMonitorExamId.viewAttempts")}
                          icon={Eye}
                          onClick={() => setAttemptsForUser(row.userId)}
                        />
                        {row.attempts.length > 0 && (
                          <RowAction
                            label={
                              row.attempts.length === 1
                                ? t("hc_routesAppTeacherMonitorExamId.deleteStudentAttempt")
                                : t("hc_routesAppTeacherMonitorExamId.deleteStudentAttempts", {
                                    count: row.attempts.length,
                                  })
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
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {t("hc_routesAppTeacherMonitorExamId.attemptsOf", {
                name: attemptsRow?.profile?.full_name ?? "—",
              })}
            </DialogTitle>
            <DialogDescription>
              {attemptsRow?.profile?.institutional_email} ·{" "}
              {t("hc_routesAppTeacherMonitorExamId.finalizedCount", {
                count: attemptsRow?.attemptsUsed ?? 0,
              })}{" "}
              ·{" "}
              {t("hc_routesAppTeacherMonitorExamId.usedOfMax", {
                used: attemptsRow?.currentNumber ?? 0,
                max: maxAttempts,
              })}{" "}
              · {t("hc_routesAppTeacherMonitorExamId.modeLabel")} {retryModeLabel(retryMode)}
            </DialogDescription>
          </DialogHeader>
          {attemptsRow && (
            <div className="space-y-3">
              <div className="rounded-md border p-3 flex items-center justify-between">
                <div className="text-sm">
                  {t("hc_routesAppTeacherMonitorExamId.effectiveGrade")}{" "}
                  <span className="font-semibold">{attemptsRow.effectiveGrade ?? "—"}</span>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => deleteAllAttempts(attemptsRow)}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1" />{" "}
                  {t("hc_routesAppTeacherMonitorExamId.deleteAll")}
                </Button>
              </div>
              <ScrollArea className="max-h-[55dvh] pr-3">
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
                            <span>
                              {t("hc_routesAppTeacherMonitorExamId.attemptN", { n: idx + 1 })}
                            </span>
                            <StatusBadge status={a.status} />
                            {extraMin > 0 && (
                              <Badge variant="secondary" className="text-[10px]">
                                <TimerReset className="h-3 w-3 mr-0.5" />
                                {t("hc_routesAppTeacherMonitorExamId.extraMinutesBadge", {
                                  n: extraMin,
                                })}
                              </Badge>
                            )}
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 text-xs text-muted-foreground tabular-nums">
                            <div>
                              <span className="text-foreground/60">
                                {t("hc_routesAppTeacherMonitorExamId.startLabel")}
                              </span>{" "}
                              {formatDateTime(a.started_at ?? a.created_at)}
                            </div>
                            <div>
                              <span className="text-foreground/60">
                                {a.submitted_at
                                  ? t("hc_routesAppTeacherMonitorExamId.endLabel")
                                  : t("hc_routesAppTeacherMonitorExamId.endPlannedLabel")}
                              </span>{" "}
                              {endAt ? formatDateTime(endAt) : "—"}
                            </div>
                          </div>
                          <div className="text-xs">
                            {t("hc_routesAppTeacherMonitorExamId.gradeLabel")}{" "}
                            <span className="font-medium tabular-nums">
                              {grade != null ? grade : "—"}
                            </span>{" "}
                            · {t("hc_routesAppTeacherMonitorExamId.warningsLabel")}{" "}
                            {a.focus_warnings}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {isFinal && (
                            <RowAction
                              label={t("hc_routesAppTeacherMonitorExamId.viewAnswersAndGrade")}
                              icon={Eye}
                              onClick={() => openView(a)}
                            />
                          )}
                          <RowAction
                            label={t("hc_routesAppTeacherMonitorExamId.deleteThisAttempt")}
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
          className={
            comparisonForCopy
              ? "max-w-[calc(100vw-2rem)] sm:max-w-7xl"
              : "max-w-[calc(100vw-2rem)] sm:max-w-5xl"
          }
        >
          <DialogHeader>
            <DialogTitle>
              {t("hc_routesAppTeacherMonitorExamId.answersOf", {
                name: viewingSub?.profile?.full_name ?? "—",
              })}
            </DialogTitle>
            <DialogDescription>
              {viewingSub?.profile?.institutional_email} ·{" "}
              {t("hc_routesAppTeacherMonitorExamId.statusLabel")} {statusLabel(viewingSub?.status)}
              {" · "}
              <span className="font-medium">
                {t("hc_routesAppTeacherMonitorExamId.decimalsHint")}
              </span>
            </DialogDescription>
          </DialogHeader>

          {viewingSub && (
            // Layout único: flex row con altura fija (h-[65dvh]) +
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
            <div className="flex gap-3 h-[65dvh] overflow-hidden">
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
                              {t("hc_routesAppTeacherMonitorExamId.warningEventsTitle", {
                                count: events.length,
                              })}
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => clearAllWarnings(viewingSub)}
                              title={t("hc_routesAppTeacherMonitorExamId.clearAllWarningsTitle")}
                            >
                              <Trash2 className="h-3 w-3 mr-1" />
                              {t("hc_routesAppTeacherMonitorExamId.clearAll")}
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
                                    ·{" "}
                                    {t("hc_routesAppTeacherMonitorExamId.questionN", {
                                      n: ev.questionIdx + 1,
                                    })}
                                  </span>
                                )}
                                <RowAction
                                  label={t("hc_routesAppTeacherMonitorExamId.deleteThisWarning")}
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
                        {t("hc_routesAppTeacherMonitorExamId.generalFeedbackTitle")}
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <Textarea
                        placeholder={t(
                          "hc_routesAppTeacherMonitorExamId.generalFeedbackPlaceholder",
                        )}
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
                          {t("hc_routesAppTeacherMonitorExamId.saveFeedback")}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>

                  {questions.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      {t("hc_routesAppTeacherMonitorExamId.examNoQuestions")}
                    </p>
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
                              <span className="font-semibold">
                                {t("hc_routesAppTeacherMonitorExamId.questionN", { n: idx + 1 })}
                              </span>
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
                                      title={t("hc_routesAppTeacherMonitorExamId.originalAiGradeTitle")}
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
                            <MarkdownInline>{q.content}</MarkdownInline>

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
                                          {t("hc_routesAppTeacherMonitorExamId.chosen")}
                                        </Badge>
                                      )}
                                      {isCorrect && (
                                        <Badge className="ml-1 text-[9px] bg-success text-success-foreground">
                                          {t("hc_routesAppTeacherMonitorExamId.correct")}
                                        </Badge>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}

                            {q.type === "cerrada_multi" && choices && (
                              <div className="space-y-1">
                                {(() => {
                                  const correctIndices = Array.isArray(q.options?.correct_indices)
                                    ? (q.options!.correct_indices as number[])
                                    : [];
                                  const studentMulti = Array.isArray(ans) ? (ans as number[]) : [];
                                  return choices.map((c, i) => {
                                    const isStudent = studentMulti.includes(i);
                                    const isCorrect = correctIndices.includes(i);
                                    return (
                                      <div
                                        key={i}
                                        className={`text-xs p-1.5 rounded border ${
                                          isCorrect
                                            ? "border-success bg-success/10"
                                            : "border-border"
                                        } ${isStudent ? "ring-1 ring-primary" : ""}`}
                                      >
                                        <span className="font-mono mr-2">
                                          {String.fromCharCode(65 + i)}.
                                        </span>
                                        {c}
                                        {isStudent && (
                                          <Badge variant="outline" className="ml-2 text-[9px]">
                                            {t("hc_routesAppTeacherMonitorExamId.chosen")}
                                          </Badge>
                                        )}
                                        {isCorrect && (
                                          <Badge className="ml-1 text-[9px] bg-success text-success-foreground">
                                            {t("hc_routesAppTeacherMonitorExamId.correct")}
                                          </Badge>
                                        )}
                                      </div>
                                    );
                                  });
                                })()}
                              </div>
                            )}

                            {/* Respuesta del estudiante:
                              - codigo / java_gui → editor Monaco read-only
                                (numeración de líneas + syntax highlighting),
                                igual a lo que el alumno tenía en pantalla.
                              - resto → bloque pre con texto plano. */}
                            {q.type === "codigo" ||
                            q.type === "java_gui" ||
                            q.type === "python_gui" ? (
                              <CodeEditor
                                value={
                                  ans == null || ans === ""
                                    ? t("hc_routesAppTeacherMonitorExamId.codeNoAnswer")
                                    : typeof ans === "string"
                                      ? ans
                                      : JSON.stringify(ans, null, 2)
                                }
                                onChange={() => {}}
                                language={
                                  q.type === "python_gui"
                                    ? "python"
                                    : q.type === "java_gui"
                                      ? "java"
                                      : ((q.language as CodeLanguage) ?? "java")
                                }
                                readOnly
                                showLanguageSelector={false}
                                showRunButton={false}
                                hideHints
                                height="220px"
                              />
                            ) : (
                              q.type !== "cerrada" &&
                              q.type !== "cerrada_multi" && (
                                <div className="rounded border bg-muted/30 p-2 text-xs whitespace-pre-wrap font-mono min-h-[40px]">
                                  {ans == null || ans === "" ? (
                                    <span className="text-muted-foreground italic">
                                      {t("hc_routesAppTeacherMonitorExamId.noAnswer")}
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
                            {(q.type === "codigo" ||
                              q.type === "java_gui" ||
                              q.type === "python_gui") && (
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
                                <div className="text-xs text-foreground/90">
                                  <MarkdownInline>{bd.feedback}</MarkdownInline>
                                </div>
                              </div>
                            )}

                            {q.expected_rubric && (
                              <details className="text-xs rounded-md border border-border/60 bg-muted/20 p-2">
                                <summary className="cursor-pointer text-muted-foreground font-medium">
                                  {t("integrity.rubricLabel")}
                                </summary>
                                <div className="mt-2 text-foreground/80">
                                  <MarkdownInline>{q.expected_rubric}</MarkdownInline>
                                </div>
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
                                    {/* Header: trigger del collapsible + acción
                                        "Marcar revisada" SIEMPRE visible al lado
                                        del título — antes vivía dentro del
                                        CollapsibleContent y el docente tenía que
                                        expandir el panel solo para llegar al
                                        botón. Mismo patrón que las copias por
                                        pregunta (Users icon). */}
                                    <div className="flex items-center gap-2">
                                      <CollapsibleTrigger asChild>
                                        <button
                                          type="button"
                                          className="flex-1 flex items-center gap-2 text-[11px] font-medium text-amber-700 dark:text-amber-300 group min-w-0"
                                        >
                                          <ChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90 shrink-0" />
                                          <Bot className="h-3 w-3 shrink-0" />
                                          <span className="truncate">
                                            {t("integrity.aiSection")}
                                          </span>
                                          <Badge
                                            variant={
                                              sig.score >= 0.85
                                                ? "destructive"
                                                : sig.score >= 0.7
                                                  ? "default"
                                                  : "secondary"
                                            }
                                            className="text-[10px] ml-auto shrink-0"
                                          >
                                            {Math.round(sig.score * 100)}%
                                          </Badge>
                                        </button>
                                      </CollapsibleTrigger>
                                      {reviewed ? (
                                        <Badge
                                          variant="outline"
                                          className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300 h-7 px-2 shrink-0"
                                        >
                                          <Check className="h-3 w-3 mr-1" />
                                          {t("integrity.reviewed")}
                                          <button
                                            type="button"
                                            className="ml-2 underline text-muted-foreground hover:text-foreground"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              toggleQuestionAiReviewedHandler(
                                                sig.submissionId,
                                                q.id,
                                                true,
                                              );
                                            }}
                                          >
                                            {t("integrity.reopen")}
                                          </button>
                                        </Badge>
                                      ) : (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="h-7 text-[11px] bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/40 text-emerald-700 dark:text-emerald-300 shrink-0"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            toggleQuestionAiReviewedHandler(
                                              sig.submissionId,
                                              q.id,
                                              false,
                                            );
                                          }}
                                        >
                                          <Check className="h-3 w-3 mr-1" />
                                          {t("integrity.markReviewed")}
                                        </Button>
                                      )}
                                    </div>
                                    <CollapsibleContent>
                                      <CollapsibleReasons text={sig.reasons} />
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
                                cada pregunta.
                                Las preguntas de opción múltiple (`cerrada`/`cerrada_multi`)
                                se validan determinísticamente contra `correct_index` —
                                no aplican señales de IA ni de copia, así que skip. */}
                            {q.type !== "cerrada" &&
                              q.type !== "cerrada_multi" &&
                              (() => {
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
                                // Peers a comparar inline en el banner. Solo
                                // tiene sentido cuando la señal incluye copia
                                // (sug.source === 'plagio' o 'ambas'). Ordenamos
                                // por score desc y limitamos a 3 para no romper
                                // el layout en cards angostas. Si hay más,
                                // mostramos "+N" y el docente puede abrir la
                                // sección de copias colapsable que lista todos.
                                const compareablePeers =
                                  sug.source === "ai"
                                    ? []
                                    : qPairs
                                        .slice()
                                        .sort((a, b) => b.score - a.score)
                                        .map((p) => {
                                          const peerRow = studentRows.find(
                                            (r) => r.userId === p.peerId,
                                          );
                                          if (!peerRow) return null;
                                          return {
                                            pair: p,
                                            peerSubmissionId: peerRow.latest.id,
                                            peerName: peerRow.profile?.full_name ?? "—",
                                          };
                                        })
                                        .filter(
                                          (
                                            x,
                                          ): x is {
                                            pair: (typeof qPairs)[number];
                                            peerSubmissionId: string;
                                            peerName: string;
                                          } => x != null,
                                        );
                                const peersToShow = compareablePeers.slice(0, 3);
                                const peersHidden = compareablePeers.length - peersToShow.length;
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
                                        ? t("hc_routesAppTeacherMonitorExamId.sourceAi", {
                                            pct: aiPct,
                                          })
                                        : sug.source === "plagio"
                                          ? t("hc_routesAppTeacherMonitorExamId.sourceCopy", {
                                              pct: cpPct,
                                            })
                                          : t("hc_routesAppTeacherMonitorExamId.sourceBoth", {
                                              aiPct,
                                              cpPct,
                                            })}
                                    </Badge>
                                    {/* Comparar con peers de copia inline.
                                      Antes solo aparecía dentro del collapsible
                                      de "Copias por pregunta" (oculto por
                                      defecto), así que el docente tenía que
                                      abrirlo para acceder. Acá la acción está
                                      al alcance del primer scan visual. */}
                                    {peersToShow.map(({ pair, peerSubmissionId, peerName }) => {
                                      const isActive =
                                        comparisonForCopy?.pairId === pair.id &&
                                        comparisonForCopy?.questionId === q.id;
                                      return (
                                        <Button
                                          key={pair.id}
                                          size="sm"
                                          variant={isActive ? "secondary" : "outline"}
                                          className="h-6 text-[11px]"
                                          onClick={() => {
                                            if (isActive) {
                                              setComparisonForCopy(null);
                                            } else {
                                              setComparisonForCopy({
                                                peerUserId: pair.peerId,
                                                peerSubmissionId,
                                                questionId: q.id,
                                                pairId: pair.id,
                                              });
                                            }
                                          }}
                                          title={t(
                                            "hc_routesAppTeacherMonitorExamId.compareWithPeer",
                                            {
                                              name: peerName,
                                              pct: Math.round(pair.score * 100),
                                            },
                                          )}
                                        >
                                          <Eye className="h-3 w-3 mr-1" />
                                          {isActive
                                            ? t("integrity.closeCompare")
                                            : peerName.split(" ")[0]}
                                        </Button>
                                      );
                                    })}
                                    {peersHidden > 0 && (
                                      <span className="text-[10px] text-muted-foreground">
                                        {t("hc_routesAppTeacherMonitorExamId.morePeers", {
                                          count: peersHidden,
                                        })}
                                      </span>
                                    )}
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-6 text-[11px] ml-auto bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/40 text-amber-700 dark:text-amber-300"
                                      onClick={() => {
                                        // Compone la retroalimentación SOLO con las
                                        // razones reales (IA y/o copia), sin prefijo
                                        // "Sugerencia automática por integridad" ni
                                        // etiquetas "IA:"/"Copia:". El docente luego
                                        // puede editar el texto libremente. Si ya
                                        // había feedback, lo REEMPLAZAMOS — la
                                        // sugerencia es la nueva fuente de verdad y
                                        // acumular era confuso visualmente.
                                        const aiReasons = aiSig?.reasons?.trim();
                                        const copyReasons = qPairs
                                          .map((p) => p.reasons?.trim())
                                          .filter((r): r is string => !!r);
                                        const parts: string[] = [];
                                        if (aiReasons && sug.source !== "plagio") {
                                          parts.push(aiReasons);
                                        }
                                        if (copyReasons.length > 0 && sug.source !== "ai") {
                                          parts.push(copyReasons.join("\n"));
                                        }
                                        const composed = parts.join("\n\n");
                                        setQOverrides((prev) => {
                                          const existing = prev[q.id] ?? {
                                            score: null,
                                            feedback: "",
                                          };
                                          return {
                                            ...prev,
                                            [q.id]: {
                                              ...existing,
                                              score: sug.suggested,
                                              feedback: composed,
                                            },
                                          };
                                        });
                                      }}
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
                                  placeholder={t(
                                    "hc_routesAppTeacherMonitorExamId.manualGradePlaceholder",
                                    { max: q.points },
                                  )}
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
                                  {t("hc_routesAppTeacherMonitorExamId.save")}
                                </Button>
                                {/* Recalificar con IA solo aplica a preguntas que SE
                                    califican con IA (abierta, código, diagrama,
                                    java_gui, codigo_zip). Las de opción múltiple se
                                    validan determinísticamente contra correct_index/
                                    correct_indices — un re-grade no aporta nada y
                                    confunde al docente. */}
                                {q.type !== "cerrada" && q.type !== "cerrada_multi" && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => reGradeWithAI(viewingSub, q.id)}
                                    disabled={
                                      aiGradingQid === q.id || aiGradingId === viewingSub.id
                                    }
                                    className="h-8"
                                    title={t("hc_routesAppTeacherMonitorExamId.regradeQuestionTitle")}
                                  >
                                    {aiGradingQid === q.id ? (
                                      <Spinner size="sm" className="mr-1" />
                                    ) : (
                                      <Sparkles className="h-3.5 w-3.5 mr-1" />
                                    )}
                                    {t("hc_routesAppTeacherMonitorExamId.regrade")}
                                  </Button>
                                )}
                              </div>
                              <Textarea
                                placeholder={t(
                                  "hc_routesAppTeacherMonitorExamId.manualFeedbackPlaceholder",
                                )}
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
                    <div className="basis-1/2 flex-1 min-w-0 border-l pl-3 max-h-[55dvh] overflow-y-auto">
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
                                      {t("hc_routesAppTeacherMonitorExamId.chosen")}
                                    </Badge>
                                  )}
                                  {isCorrect && (
                                    <Badge className="ml-1 text-[9px] bg-success text-success-foreground">
                                      {t("hc_routesAppTeacherMonitorExamId.correct")}
                                    </Badge>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        ) : q.type === "cerrada_multi" && Array.isArray(q.options?.choices) ? (
                          <div className="space-y-1">
                            {(() => {
                              const peerMulti = Array.isArray(peerAns) ? (peerAns as number[]) : [];
                              const correctIndices = Array.isArray(q.options?.correct_indices)
                                ? (q.options!.correct_indices as number[])
                                : [];
                              return (q.options.choices as string[]).map((c, i) => {
                                const isStudent = peerMulti.includes(i);
                                const isCorrect = correctIndices.includes(i);
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
                                        {t("hc_routesAppTeacherMonitorExamId.chosen")}
                                      </Badge>
                                    )}
                                    {isCorrect && (
                                      <Badge className="ml-1 text-[9px] bg-success text-success-foreground">
                                        {t("hc_routesAppTeacherMonitorExamId.correct")}
                                      </Badge>
                                    )}
                                  </div>
                                );
                              });
                            })()}
                          </div>
                        ) : q.type === "codigo" ||
                          q.type === "java_gui" ||
                          q.type === "python_gui" ? (
                          <CodeEditor
                            value={
                              peerAns == null || peerAns === ""
                                ? t("hc_routesAppTeacherMonitorExamId.codeNoAnswer")
                                : typeof peerAns === "string"
                                  ? peerAns
                                  : JSON.stringify(peerAns, null, 2)
                            }
                            onChange={() => {}}
                            language={
                              q.type === "python_gui"
                                ? "python"
                                : q.type === "java_gui"
                                  ? "java"
                                  : ((q.language as CodeLanguage) ?? "java")
                            }
                            readOnly
                            showLanguageSelector={false}
                            showRunButton={false}
                            hideHints
                            height="220px"
                          />
                        ) : (
                          <div className="rounded border bg-muted/30 p-2 text-xs whitespace-pre-wrap font-mono min-h-[40px]">
                            {peerAns == null || peerAns === "" ? (
                              <span className="text-muted-foreground italic">
                                {t("hc_routesAppTeacherMonitorExamId.noAnswer")}
                              </span>
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
                    <span className="font-medium">
                      {t("hc_routesAppTeacherMonitorExamId.aiGradeLabel")}
                    </span>
                    <HelpHint side="top">
                      {t("hc_routesAppTeacherMonitorExamId.aiGradeHint")}
                    </HelpHint>
                    <span className="font-semibold tabular-nums">{viewingSub.ai_grade ?? "—"}</span>
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300">
                    <Check className="h-3 w-3" aria-hidden />
                    <span className="font-medium">
                      {t("hc_routesAppTeacherMonitorExamId.finalGradeLabel")}
                    </span>
                    <HelpHint side="top">
                      {t("hc_routesAppTeacherMonitorExamId.finalGradeHint")}
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
                  {t("hc_routesAppTeacherMonitorExamId.regradeAllWithAi")}
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

      {/* Modal de recalificación batch del último intento de TODOS los
          estudiantes. Para cada uno, dryRun de `ai-grade-submission` →
          lista con nota previa / nota propuesta / approve por fila o en
          lote. Reduce el costo de tokens vs. recalificar uno por uno y
          le da al docente una vista consolidada antes de aceptar. */}
      <Dialog
        open={regradeAllOpen}
        onOpenChange={(open) => {
          if (!open && !regradeAllLoading && !applyingBulk) {
            setRegradeAllOpen(false);
          }
        }}
      >
        {/* hideCloseButton: el footer ya tiene "Cerrar" (+ "Cancelar"
            mientras corre + "Aprobar todas" en modo sync). La X de la
            esquina duplicaba el control y confundía con "Cancelar". */}
        <DialogContent
          className="max-w-[calc(100vw-2rem)] sm:max-w-4xl max-h-[88dvh] overflow-hidden flex flex-col"
          hideCloseButton
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              {regradeMode === "async"
                ? t("hc_routesAppTeacherMonitorExamId.batchQueueTitle")
                : t("hc_routesAppTeacherMonitorExamId.batchRegradeTitle")}
              {(regradeAllLoading || regradeAllProgress.total > 0) && (
                <span className="text-xs font-normal text-muted-foreground">
                  · {regradeAllProgress.done}/{regradeAllProgress.total}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          {/* Barra de progreso + nombre del estudiante en curso. Reemplaza
              el placeholder estático "Generando propuestas con IA…" que
              no daba feedback de avance. Se mantiene visible mientras
              hay un batch corriendo o ya terminó (para que el docente
              vea el resumen N/N completos). */}
          {regradeAllProgress.total > 0 && (
            <div className="space-y-1.5">
              <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-primary transition-[width] duration-200"
                  style={{
                    width: `${
                      regradeAllProgress.total === 0
                        ? 0
                        : Math.min(100, (regradeAllProgress.done / regradeAllProgress.total) * 100)
                    }%`,
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">
                  {regradeAllLoading && regradeCurrentStudent
                    ? regradeMode === "async"
                      ? t("hc_routesAppTeacherMonitorExamId.queueingStudent", {
                          name: regradeCurrentStudent,
                        })
                      : t("hc_routesAppTeacherMonitorExamId.processingStudent", {
                          name: regradeCurrentStudent,
                        })
                    : !regradeAllLoading && regradeAllProgress.done === regradeAllProgress.total
                      ? regradeMode === "async"
                        ? t("hc_routesAppTeacherMonitorExamId.queueingDone")
                        : t("hc_routesAppTeacherMonitorExamId.proposalsReady")
                      : t("hc_routesAppTeacherMonitorExamId.starting")}
                </span>
                <span className="tabular-nums shrink-0">
                  {regradeAllProgress.done}/{regradeAllProgress.total}
                </span>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto -mx-4 px-4">
            {regradeAllRows.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">
                {regradeAllLoading
                  ? regradeMode === "async"
                    ? t("hc_routesAppTeacherMonitorExamId.queueingJobs")
                    : t("hc_routesAppTeacherMonitorExamId.generatingProposals")
                  : t("hc_routesAppTeacherMonitorExamId.noResults")}
              </div>
            ) : (
              <div className="border rounded-md divide-y">
                {regradeAllRows.map((row, idx) => {
                  const prev = row.previousGrade;
                  const delta = prev != null ? row.suggestedGrade - Number(prev) : null;
                  const isExpanded = regradeExpanded.has(row.submissionId);
                  // Acceso a las respuestas del estudiante (el edge function
                  // las devuelve dentro de `proposed_update.answers`). Sirve
                  // para mostrar al docente QUÉ respondió cuando expande.
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const proposedAnswers = (row.proposedUpdate as any)?.answers ?? {};
                  const canExpand = row.breakdown.length > 0;
                  const toggleExpand = () =>
                    setRegradeExpanded((prev) => {
                      const next = new Set(prev);
                      if (next.has(row.submissionId)) next.delete(row.submissionId);
                      else next.add(row.submissionId);
                      return next;
                    });
                  return (
                    <div key={row.submissionId} className="text-sm">
                      <div className="px-3 py-2 flex items-center gap-3">
                        <button
                          type="button"
                          onClick={toggleExpand}
                          disabled={!canExpand}
                          className="shrink-0 p-0.5 hover:bg-muted rounded disabled:opacity-30 disabled:cursor-not-allowed"
                          aria-label={
                            isExpanded
                              ? t("hc_routesAppTeacherMonitorExamId.collapse")
                              : t("hc_routesAppTeacherMonitorExamId.expand")
                          }
                          title={
                            canExpand
                              ? t("hc_routesAppTeacherMonitorExamId.viewStudentAnswersBreakdown")
                              : t("hc_routesAppTeacherMonitorExamId.noBreakdownAvailable")
                          }
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{row.studentName}</div>
                          {row.aiLikelihood > 0 && (
                            <div className="text-[10px] text-muted-foreground">
                              {t("hc_routesAppTeacherMonitorExamId.aiFraudPct", {
                                pct: (row.aiLikelihood * 100).toFixed(0),
                              })}
                            </div>
                          )}
                          {row.status === "failed" && row.error && (
                            <div className="text-[10px] text-destructive mt-0.5">
                              {t("hc_routesAppTeacherMonitorExamId.errorPrefix", {
                                error: row.error,
                              })}
                            </div>
                          )}
                        </div>
                        {/* Columnas de nota previa / propuesta solo
                            tienen sentido en modo SYNC (donde se hizo
                            dryRun y hay una propuesta numérica). En modo
                            ASYNC el job está encolado, no hay propuesta
                            todavía — ocultamos el bloque para no mostrar
                            "0.00 → 0.00" engañoso. */}
                        {regradeMode === "sync" && (
                          <>
                            <div className="text-xs text-muted-foreground tabular-nums w-20 text-right">
                              {prev != null ? Number(prev).toFixed(2) : "—"}
                            </div>
                            <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                            <div
                              className={`text-sm font-semibold tabular-nums w-16 text-right ${
                                delta != null
                                  ? delta > 0
                                    ? "text-emerald-600 dark:text-emerald-400"
                                    : delta < 0
                                      ? "text-destructive"
                                      : ""
                                  : ""
                              }`}
                            >
                              {row.suggestedGrade.toFixed(2)}
                            </div>
                          </>
                        )}
                        <div className="w-28 flex justify-end">
                          {row.status === "approved" ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 dark:text-emerald-300"
                            >
                              <Check className="h-3 w-3 mr-1" />
                              {t("hc_routesAppTeacherMonitorExamId.applied")}
                            </Badge>
                          ) : row.status === "queued" ? (
                            <Badge
                              variant="outline"
                              className="text-[10px] bg-sky-500/10 text-sky-700 border-sky-500/30 dark:text-sky-300"
                            >
                              <Clock className="h-3 w-3 mr-1" />
                              {t("hc_routesAppTeacherMonitorExamId.queued")}
                            </Badge>
                          ) : row.status === "cancelled" ? (
                            <Badge variant="outline" className="text-[10px] text-muted-foreground">
                              {t("hc_routesAppTeacherMonitorExamId.cancelled")}
                            </Badge>
                          ) : row.status === "failed" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled
                              className="h-7 text-[11px]"
                            >
                              {t("hc_routesAppTeacherMonitorExamId.errorLabel")}
                            </Button>
                          ) : row.status === "approving" ? (
                            <Spinner size="sm" />
                          ) : (
                            // status === "pending" — único caso con botón
                            // de acción. En modo async las filas NO entran
                            // a pending (van directo a queued/failed/cancelled),
                            // así que esto solo aparece en modo sync.
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void applyRegradeRow(idx)}
                              disabled={applyingBulk}
                              className="h-7 text-[11px]"
                            >
                              <Check className="h-3 w-3 mr-1" />
                              {t("hc_routesAppTeacherMonitorExamId.apply")}
                            </Button>
                          )}
                        </div>
                      </div>
                      {/* Desglose por pregunta — visible al expandir. El
                          docente revisa enunciado + respuesta del alumno +
                          nota IA + retroalimentación antes de aplicar la
                          propuesta. No es editable acá (eso se hace luego
                          desde "Aplicar" → modal de respuestas). */}
                      {isExpanded && canExpand && (
                        <div className="px-3 pb-3 pt-1 bg-muted/30 border-t space-y-2">
                          {row.breakdown.map((b, bi) => {
                            const qid = b.qid as string;
                            const q = questions.find((x) => x.id === qid);
                            const studentAnswer = proposedAnswers[qid];
                            const studentAnswerStr =
                              typeof studentAnswer === "string"
                                ? studentAnswer
                                : studentAnswer != null
                                  ? JSON.stringify(studentAnswer)
                                  : "";
                            const earned = (b.earned as number | undefined) ?? 0;
                            const points = (b.points as number | undefined) ?? q?.points ?? 0;
                            const fb = (b.feedback as string | undefined) ?? "";
                            const aiLike = (b.ai_likelihood as number | undefined) ?? null;
                            return (
                              <div
                                key={`${row.submissionId}-${qid}-${bi}`}
                                className="rounded-md border bg-background p-2.5 space-y-1.5"
                              >
                                <div className="flex items-start gap-2">
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] tabular-nums shrink-0"
                                  >
                                    {bi + 1}
                                  </Badge>
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[11px] text-muted-foreground line-clamp-2">
                                      {q?.content ??
                                        t("hc_routesAppTeacherMonitorExamId.questionNotFound")}
                                    </div>
                                  </div>
                                  <span className="text-[11px] font-semibold tabular-nums shrink-0">
                                    {Number(earned).toFixed(2)}/{Number(points).toFixed(2)}
                                  </span>
                                </div>
                                {studentAnswerStr && (
                                  <div className="rounded border bg-muted/40 px-2 py-1.5">
                                    <div className="text-[10px] font-medium text-muted-foreground mb-0.5">
                                      {t("hc_routesAppTeacherMonitorExamId.studentAnswer")}
                                    </div>
                                    <div className="text-[11px] whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
                                      {studentAnswerStr.slice(0, 800)}
                                      {studentAnswerStr.length > 800 && "…"}
                                    </div>
                                  </div>
                                )}
                                {fb && (
                                  <div className="rounded border-l-2 border-primary/40 bg-primary/5 pl-2 py-1">
                                    <div className="text-[10px] font-medium text-foreground mb-0.5">
                                      {t("hc_routesAppTeacherMonitorExamId.aiFeedback")}
                                    </div>
                                    <div className="text-[11px] text-muted-foreground whitespace-pre-wrap">
                                      {fb}
                                    </div>
                                  </div>
                                )}
                                {aiLike != null && aiLike >= 0.6 && (
                                  <Badge
                                    variant="destructive"
                                    className="text-[10px]"
                                    title={t("hc_routesAppTeacherMonitorExamId.aiDetectedTitle")}
                                  >
                                    <Bot className="h-2.5 w-2.5 mr-1" />
                                    {t("hc_routesAppTeacherMonitorExamId.aiDetectedPct", {
                                      pct: (aiLike * 100).toFixed(0),
                                    })}
                                  </Badge>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter className="flex-shrink-0 pt-2 border-t">
            {/* Cancelar el batch en curso. Aborta el for-loop entre
                iteraciones — las llamadas IA YA enviadas a Gemini siguen
                (costo no recuperable) pero las que aún no salieron se
                saltan. El modal queda abierto con los resultados
                parciales para revisión. */}
            {regradeAllLoading && (
              <Button
                variant="ghost"
                className="mr-auto text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => regradeAbortRef.current?.abort()}
                disabled={regradeAbortRef.current?.signal.aborted ?? false}
              >
                <XIcon className="h-4 w-4 mr-1" />
                {t("hc_routesAppTeacherMonitorExamId.cancel")}
              </Button>
            )}
            <Button
              variant="ghost"
              onClick={() => setRegradeAllOpen(false)}
              disabled={regradeAllLoading || applyingBulk}
            >
              {t("hc_routesAppTeacherMonitorExamId.close")}
            </Button>
            {/* "Aprobar todas" solo aplica al modo SYNC (las filas tienen
                propuestas dryRun que aprobar). En modo ASYNC los jobs ya
                están encolados — no hay nada que aprobar acá; el modal
                actúa como confirmación visual del progreso. */}
            {regradeMode === "sync" && (
              <Button
                onClick={() => void applyAllRegrade()}
                disabled={
                  regradeAllLoading ||
                  applyingBulk ||
                  !regradeAllRows.some((r) => r.status === "pending")
                }
              >
                {applyingBulk ? (
                  <Spinner size="sm" className="mr-1.5" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                )}
                {t("hc_routesAppTeacherMonitorExamId.approveAll")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview de recálculo "Todo con IA". Muestra OLD vs NEW antes de
          aplicar para que el docente revise. La aplicación es un UPDATE
          directo con el snapshot ya calculado — NO re-invoca a la IA. */}
      <Dialog
        open={reGradePreview !== null}
        onOpenChange={(open) => {
          if (!open && !applyingReGrade) setReGradePreview(null);
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] overflow-hidden flex flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-indigo-500" />
              {t("hc_routesAppTeacherMonitorExamId.regradeReviewTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("hc_routesAppTeacherMonitorExamId.regradeReviewDescription")}
            </DialogDescription>
          </DialogHeader>
          {reGradePreview && (
            // flex-1 + overflow-y-auto: si el examen tiene 20+ preguntas
            // el detalle por pregunta crece y antes desbordaba la
            // ventana, recortando preguntas del final. Ahora el modal
            // tiene altura fija (max-h-[90dvh]) con scroll interno; el
            // header y el footer quedan pinned.
            <div className="space-y-4 flex-1 overflow-y-auto -mx-6 px-6 pb-2">
              {/* Resumen OLD vs NEW */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-lg border bg-muted/30 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
                    {t("hc_routesAppTeacherMonitorExamId.currentGrade")}
                  </div>
                  <div className="text-2xl font-semibold tabular-nums">
                    {reGradePreview.previous.final_override_grade ??
                      reGradePreview.previous.ai_grade ??
                      "—"}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {reGradePreview.previous.final_override_grade != null
                      ? t("hc_routesAppTeacherMonitorExamId.teacherManualOverride")
                      : t("hc_routesAppTeacherMonitorExamId.previousAiGrade")}
                  </div>
                </div>
                <div className="rounded-lg border border-indigo-500/40 bg-indigo-500/5 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-indigo-700 dark:text-indigo-300 mb-1">
                    {t("hc_routesAppTeacherMonitorExamId.aiProposedGrade")}
                  </div>
                  <div className="text-2xl font-semibold tabular-nums text-indigo-700 dark:text-indigo-300">
                    {reGradePreview.grade}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {(() => {
                      const prev =
                        reGradePreview.previous.final_override_grade ??
                        reGradePreview.previous.ai_grade;
                      if (prev == null)
                        return t("hc_routesAppTeacherMonitorExamId.noPreviousGrade");
                      const delta = reGradePreview.grade - Number(prev);
                      if (Math.abs(delta) < 0.005)
                        return t("hc_routesAppTeacherMonitorExamId.noChange");
                      const sign = delta > 0 ? "+" : "";
                      return t("hc_routesAppTeacherMonitorExamId.difference", {
                        value: `${sign}${delta.toFixed(2)}`,
                      });
                    })()}
                  </div>
                </div>
              </div>

              {/* Señal IA actualizada */}
              {(reGradePreview.ai_likelihood > 0 || reGradePreview.ai_reasons) && (
                <div className="rounded-lg border p-3 text-xs space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">
                      {t("hc_routesAppTeacherMonitorExamId.aiSuspicion")}
                    </span>
                    <span className="tabular-nums">
                      {(reGradePreview.ai_likelihood * 100).toFixed(0)}%
                    </span>
                  </div>
                  {reGradePreview.ai_reasons && (
                    <p className="text-muted-foreground whitespace-pre-line">
                      {reGradePreview.ai_reasons}
                    </p>
                  )}
                </div>
              )}

              {/* Breakdown por pregunta. Sin ScrollArea anidado: el body
                  del Dialog ya tiene `flex-1 overflow-y-auto`, agregar
                  un Radix ScrollArea adentro capturaba el wheel event
                  y bloqueaba el scroll del modal — el usuario veía la
                  lista truncada sin poder scrollear. Un único scroll
                  (el del body del modal) maneja bien hasta 50+
                  preguntas sin cortarse. */}
              {reGradePreview.breakdown.length > 0 && (
                <div className="rounded-lg border">
                  <div className="px-3 py-2 border-b bg-muted/30 text-xs font-medium flex items-center justify-between">
                    <span>{t("hc_routesAppTeacherMonitorExamId.detailPerQuestion")}</span>
                    <span className="text-[10px] text-muted-foreground font-normal">
                      {t("hc_routesAppTeacherMonitorExamId.questionsCount", {
                        count: reGradePreview.breakdown.length,
                      })}
                    </span>
                  </div>
                  <div className="divide-y">
                    {reGradePreview.breakdown.map((b, i) => {
                      const prev = reGradePreview.previous.breakdown?.find((p) => p.qid === b.qid);
                      const prevEarned = prev?.earned ?? null;
                      const newEarned = b.earned ?? 0;
                      const changed =
                        prevEarned == null || Math.abs(Number(prevEarned) - newEarned) > 0.005;
                      // Pregunta original (enunciado, opciones) y
                      // respuesta del estudiante. El edge devuelve las
                      // respuestas en `proposed_update.answers` —
                      // mismo shape que `submissions.answers` JSONB.
                      // Mostrarlos acá da al docente contexto completo
                      // para decidir si acepta la nueva nota sin tener
                      // que abrir otro modal.
                      const question = questions.find((q) => q.id === b.qid);
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const answers = (reGradePreview.proposed_update as any)?.answers ?? {};
                      const answerValue = answers[b.qid];
                      const answerText = formatStudentAnswer(answerValue, b.type, question);
                      return (
                        <div
                          key={b.qid}
                          className={`px-3 py-2.5 text-xs space-y-2 ${changed ? "bg-amber-500/5" : ""}`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">
                              {t("hc_routesAppTeacherMonitorExamId.questionN", { n: i + 1 })}
                              {b.type && (
                                <span className="ml-1 text-muted-foreground font-normal">
                                  · {b.type}
                                </span>
                              )}
                            </span>
                            <span className="tabular-nums">
                              {prevEarned != null ? (
                                <span className="text-muted-foreground">
                                  {Number(prevEarned).toFixed(2)} →{" "}
                                </span>
                              ) : null}
                              <span className={changed ? "font-semibold" : ""}>
                                {newEarned.toFixed(2)}
                              </span>
                              <span className="text-muted-foreground"> / {b.points ?? 0}</span>
                            </span>
                          </div>

                          {/* Enunciado de la pregunta. line-clamp-3 para
                              no inflar el listado; si el enunciado es
                              largo, hover muestra el title con el texto
                              completo. */}
                          {question?.content && (
                            <div className="rounded border bg-muted/30 px-2 py-1.5">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                                {t("hc_routesAppTeacherMonitorExamId.statement")}
                              </div>
                              <p
                                className="whitespace-pre-wrap line-clamp-3 text-foreground/90"
                                title={question.content}
                              >
                                {question.content}
                              </p>
                            </div>
                          )}

                          {/* Respuesta del estudiante. `max-h-32
                              overflow-y-auto` permite respuestas largas
                              (código de 200 líneas) sin reventar el
                              modal — scroll interno del bloque, no del
                              modal. Font mono para que el código se
                              alinee. */}
                          {answerText && (
                            <div className="rounded border bg-background px-2 py-1.5">
                              <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">
                                {t("hc_routesAppTeacherMonitorExamId.studentAnswer")}
                              </div>
                              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] max-h-32 overflow-y-auto text-foreground/90">
                                {answerText}
                              </pre>
                            </div>
                          )}

                          {/* Feedback IA (lo que ya estaba) — sin
                              line-clamp para que el docente vea el
                              razonamiento completo. */}
                          {b.feedback && (
                            <div className="rounded border border-indigo-500/30 bg-indigo-500/5 px-2 py-1.5">
                              <div className="text-[10px] uppercase tracking-wide text-indigo-700 dark:text-indigo-300 mb-0.5">
                                {t("hc_routesAppTeacherMonitorExamId.aiFeedback")}
                              </div>
                              <p className="whitespace-pre-wrap text-foreground/90">{b.feedback}</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter className="shrink-0 border-t pt-3">
            <Button
              variant="ghost"
              onClick={() => setReGradePreview(null)}
              disabled={applyingReGrade}
            >
              {t("hc_routesAppTeacherMonitorExamId.discard")}
            </Button>
            <Button onClick={() => void applyReGrade()} disabled={applyingReGrade}>
              {applyingReGrade ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Check className="h-4 w-4 mr-1" />
              )}
              {t("hc_routesAppTeacherMonitorExamId.applyNewGrade")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Gate IA — montado UNA VEZ. Captura las llamadas a
          aiGate.ensureAuthorized() de los handlers de reGradeWithAI,
          runDetectFraud y runRegradeLatestAll. */}
      <aiGate.GateDialog />
    </div>
  );
}
