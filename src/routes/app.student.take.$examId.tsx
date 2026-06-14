import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useRealtimeTimer } from "@/hooks/use-realtime-timer";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useMaximized } from "@/hooks/use-maximized";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  AlertTriangle,
  Clock,
  Maximize2,
  Minimize2,
  Send,
  Pause,
  WifiOff,
  FileText,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { CodeEditor, type CodeLanguage, getStarterCode } from "@/modules/code/CodeEditor";
import { CodeRunnerPicker, type CodeRunnerProvider } from "@/modules/code/CodeRunnerPicker";
import { DiagramEditor } from "@/modules/code/DiagramEditor";
import { JavaGuiRunner, JAVA_GUI_STARTER, JAVAFX_STARTER } from "@/modules/code/JavaGuiRunner";
import { PythonGuiRunner, PYTHON_GUI_STARTER } from "@/modules/code/PythonGuiRunner";
import {
  saveAnswersLocally,
  isOnline,
  setupOfflineSync,
  clearLocalAnswers,
} from "@/modules/exams/offline-sync";
import { useTranslation } from "react-i18next";
import {
  computeSecondsLeft,
  computeSecondsLeftRelative,
  isExamOpen,
} from "@/modules/exams/exam-time";
import { MAX_WARNINGS, shouldMarkSuspicious, warningLabel } from "@/modules/exams/proctoring";
import { useCourseLanguage } from "@/hooks/use-course-language";
import { useApprovedExamNote } from "@/modules/exams/ExamNotesManager";
import { logEvent } from "@/shared/lib/audit";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import {
  computeExtraSeconds,
  applyExtraTime,
  restoreQuestionIndex,
} from "@/modules/exams/exam-session";
import { runJavaInBrowser, CANCELLED_SENTINEL } from "@/modules/code/run-java";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { retryModeLabel, type RetryMode } from "@/modules/exams/exam-attempts";
import { aiGradeOrEnqueue, QUEUED_STUDENT_TITLE } from "@/modules/ai/ai-grading";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

export const Route = createFileRoute("/app/student/take/$examId")({ component: TakeExam });

type Question = {
  id: string;
  type: string;
  content: string;
  options: any;
  points: number;
  position: number;
  language?: string | null;
  starter_code?: string | null;
};
type Exam = {
  id: string;
  title: string;
  time_limit_minutes: number;
  navigation_type: string;
  shuffle_enabled: boolean;
  start_time: string;
  end_time: string;
  course_id: string;
  schedule_type?: string | null;
  /** Cantidad de strikes antes de marcar el intento como sospechoso. */
  max_warnings?: number | null;
  /** Máximo de intentos permitidos (>=1). Si es 1 o null, no se muestra contador. */
  max_attempts?: number | null;
  /** Modo de cálculo de la nota final entre intentos: last_only / average / highest. */
  retry_mode?: string | null;
  /** Populated via join `course:courses(language)` when available. */
  course?: { language?: string | null; max_exam_attempts?: number | null } | null;
};

function getOrCreateLocalSession(examId: string): string {
  const key = `examlab_exam_session_${examId}`;
  let sid = localStorage.getItem(key);
  if (!sid) {
    sid = crypto.randomUUID();
    localStorage.setItem(key, sid);
  }
  return sid;
}

/** Considera contestada la celda según tipo (incluye plantilla de código si no hubo edición). */
function isQuestionAnswered(q: Question, answers: Record<string, unknown>): boolean {
  const v = answers[q.id];
  if (q.type === "cerrada") {
    return typeof v === "number" && v >= 0;
  }
  if (q.type === "cerrada_multi") {
    if (!Array.isArray(v) || v.length === 0) return false;
    const min = Number(q.options?.min_selections);
    if (Number.isFinite(min) && min > 0 && v.length < min) return false;
    return true;
  }
  if (q.type === "codigo" || q.type === "java_gui" || q.type === "python_gui") {
    // Si no hay starter_code en la BD pero la pregunta es Java codigo,
    // el editor muestra JAVA_STARTER por defecto — eso cuenta como
    // tener contenido visible (se persistirá en mergeStarterCodeAnswers).
    const starter =
      (q.starter_code ?? "").trim() || (q.type === "codigo" ? getStarterCode(q.language) : "");
    const code = (typeof v === "string" ? v : "").trim() || starter.trim();
    return code.length > 0;
  }
  if (q.type === "diagrama") {
    return typeof v === "string" && v.trim().length > 0;
  }
  return typeof v === "string" && v.trim().length > 0;
}

function getUnansweredIndices(questions: Question[], answers: Record<string, unknown>): number[] {
  const out: number[] = [];
  questions.forEach((q, i) => {
    if (!isQuestionAnswered(q, answers)) out.push(i);
  });
  return out;
}

/** Persiste plantilla de código como respuesta si el estudiante no escribió nada (para entrega correcta). */
function mergeStarterCodeAnswers(
  questions: Question[],
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...answers };
  for (const q of questions) {
    if (q.type !== "codigo" && q.type !== "java_gui" && q.type !== "python_gui") continue;
    const cur = next[q.id];
    const empty = cur === undefined || cur === null || String(cur).trim() === "";
    if (!empty) continue;
    // Fallback al starter_code de la pregunta. Si no hay y la pregunta
    // es Java codigo, usa JAVA_STARTER (mismo template que ve el alumno
    // por defecto en el editor) para que la entrega no llegue vacía.
    const fallback = (q.starter_code ?? "").trim()
      ? q.starter_code
      : q.type === "codigo"
        ? getStarterCode(q.language) || null
        : null;
    if (fallback) next[q.id] = fallback;
  }
  return next;
}

function TakeExam() {
  const { t } = useTranslation();
  const { examId } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [exam, setExam] = useState<Exam | null>(null);
  // Force i18n language to the course's configured language while the student
  // is taking the exam; restored when the hook unmounts.
  useCourseLanguage(exam?.course?.language ?? null);
  // Configuración del examen para advertencias. Si el docente no
  // personalizó max_warnings cae al default de proctoring (3).
  const maxWarnings = exam?.max_warnings ?? MAX_WARNINGS;
  const [questions, setQuestions] = useState<Question[]>([]);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [submissionStartedAt, setSubmissionStartedAt] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [started, setStarted] = useState(false);
  // Bandera global (app_settings.require_exam_fullscreen). Si el Admin la
  // desactivó, el examen corre en ventana normal: no se llama a
  // requestFullscreen, no se muestra el overlay de re-entrada y los strikes
  // por fullscreen_exit no aplican. Default true (comportamiento histórico).
  const [requireFullscreen, setRequireFullscreen] = useState(true);
  // Tope global (app_settings.max_open_answer_chars) para el Textarea de
  // respuestas tipo `abierta`. Default 500 — fuerza respuestas concisas
  // y mantiene bajo el costo de tokens de la IA. El admin lo modifica
  // desde Settings (rango 100..50000).
  const [maxOpenChars, setMaxOpenChars] = useState(500);
  const [warnings, setWarnings] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  // Modal de confirmación para "Siguiente" en navegación secuencial:
  // el alumno debe entender explícitamente que no podrá regresar.
  const [confirmNextOpen, setConfirmNextOpen] = useState(false);
  const [codeOutputs, setCodeOutputs] = useState<Record<string, string>>({});
  const [runningCode, setRunningCode] = useState<Record<string, boolean>>({});
  const [offline, setOffline] = useState(!isOnline());
  const [submitModal, setSubmitModal] = useState<{
    open: boolean;
    unansweredIndices: number[];
  }>({ open: false, unansweredIndices: [] });
  const [notesOpen, setNotesOpen] = useState(true);
  const [blockedBySession, setBlockedBySession] = useState(false);
  // Preferencia "tamaño completo" del área de resolución (compartida con el
  // taller via la misma clave). Ensancha el contenedor de max-w-3xl a todo el
  // ancho disponible para tener más espacio (ej. preguntas de código).
  const [maximized, toggleMaximized] = useMaximized("examlab_assessment_maximized");
  /** Número del intento actual (1-based) y total. Null cuando max_attempts=1. */
  const [attemptInfo, setAttemptInfo] = useState<{ current: number; total: number } | null>(null);
  const [manualLeaveOpen, setManualLeaveOpen] = useState(false);
  const approvedNote = useApprovedExamNote(examId, user?.id);
  const submittedRef = useRef(false);
  const sessionIdRef = useRef<string>("");
  const submissionIdRef = useRef<string | null>(null);
  const warningsRef = useRef(0);
  const answersRef = useRef<Record<string, any>>({});
  // Cache the Supabase access token so beforeunload can use it in a keepalive fetch
  const authTokenRef = useRef<string | null>(null);
  const warningEventsRef = useRef<Array<{ type: string; at: string; questionIdx: number | null }>>(
    [],
  );
  // Bandera de "el estudiante ya está properly dentro del examen". Se
  // activa la primera vez que `document.fullscreenElement` se vuelve
  // truthy (sea por startExam o por click en el overlay de Reanudar).
  // Antes de que se active, los strikes se SUPRIMEN — cubre el caso de
  // un alumno que reanuda un intento (status en_progreso, recarga, le
  // borraron 1 strike, etc.) y todavía no entró a pantalla completa:
  // cualquier blur/fullscreenchange/etc en esta ventana es parte del
  // flujo de entrada, no abuso. Una vez activado, el proctoring queda
  // estricto y suma strikes normalmente.
  const hasEverEnteredFullscreenRef = useRef(false);
  // Indice de la pregunta visible. Se persiste en answers.__current_idx
  // en cada autosave para que el monitor del docente pueda mostrar
  // "Pregunta X de Y" en tiempo real para los intentos en curso.
  const currentIdxRef = useRef(0);
  // Ref para datos del examen necesarios en callbacks (evita closures stale).
  const examRef = useRef<Exam | null>(null);
  const submissionStartedAtRef = useRef<string | null>(null);
  // Proveedor de ejecución de código activo (leído de code_execution_settings al
  // montar). Mantenemos un `ref` (para closures estables) y un `state`
  // (para que la UI del selector pueda mostrar cuál es el default).
  const codeExecProviderRef = useRef<string>("onlinecompiler");
  const [defaultCodeProvider, setDefaultCodeProvider] = useState<string>("onlinecompiler");

  // Override por pregunta — el estudiante puede elegir otro runner si el
  // default falla durante el examen. La key es `questionId`; el valor es
  // uno de los providers válidos. `undefined` o ausencia = usar default.
  // Se persiste en localStorage por (submissionId, questionId) para que
  // sobreviva refresh de página mid-examen sin pedirle de nuevo al
  // estudiante elegir.
  const [runnerOverride, setRunnerOverride] = useState<Record<string, string>>({});

  // AbortControllers por pregunta para soportar Cancelar ejecución.
  // Cuando el estudiante pulsa "Cancelar", abortamos el controller y la
  // promesa del run se resuelve con el sentinel `CANCELLED_SENTINEL`,
  // liberando el botón. NO matamos el worker remoto (CheerpJ no expone
  // API de kill, y el edge function ya está ejecutando server-side) —
  // simplemente abandonamos la respuesta. Es lo más cerca que se puede
  // llegar a "cancel" sin tener que reload.
  const runAbortersRef = useRef<Record<string, AbortController>>({});

  // Carga el proveedor de ejecución de código una vez al montar (fire-and-forget).
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("code_execution_settings")
      .select("provider")
      .eq("is_active", true)
      .maybeSingle()
      .then(({ data }: { data: { provider: string } | null }) => {
        if (data?.provider) {
          codeExecProviderRef.current = data.provider;
          setDefaultCodeProvider(data.provider);
        }
      });
  }, []);

  // Sidebar nav links in AppLayout dispatch this event when the exam is in progress
  // (useBlocker only intercepts router-level navigation from within the route subtree).
  useEffect(() => {
    if (!started) return;
    const handler = () => setManualLeaveOpen(true);
    window.addEventListener("examlab:navAttempt", handler);
    return () => window.removeEventListener("examlab:navAttempt", handler);
  }, [started]);

  // Cache Supabase access token for synchronous use in beforeunload keepalive fetch
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      authTokenRef.current = data.session?.access_token ?? null;
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_, session) => {
      authTokenRef.current = session?.access_token ?? null;
    });
    return () => subscription.unsubscribe();
  }, []);

  // Keep refs in sync with state for synchronous reads in event handlers
  useEffect(() => {
    warningsRef.current = warnings;
  }, [warnings]);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);
  useEffect(() => {
    currentIdxRef.current = currentIdx;
  }, [currentIdx]);
  useEffect(() => {
    examRef.current = exam;
  }, [exam]);
  useEffect(() => {
    submissionStartedAtRef.current = submissionStartedAt;
  }, [submissionStartedAt]);

  // Update state AND ref synchronously so blur/suspend handlers never read
  // stale answers between a keystroke and the next render commit.
  const updateAnswer = useCallback((questionId: string, value: any) => {
    const next = { ...answersRef.current, [questionId]: value };
    answersRef.current = next;
    setAnswers(next);
  }, []);

  // Offline sync setup
  useEffect(() => {
    const handleOnline = () => setOffline(false);
    const handleOffline = () => setOffline(true);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Lanza la limpieza de IndexedDB en background. NO mostramos toast:
    // setupOfflineSync corre tanto en un evento `online` real como al
    // cargar la página, y en el segundo caso típicamente solo limpia
    // estado zombie de sesiones previas — el "X respuesta(s)
    // sincronizada(s)" confundía al estudiante porque sugería que se
    // habían recuperado datos cuando solo se borró basura local.
    const cleanup = setupOfflineSync();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      cleanup();
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    (async () => {
      // `courses.language` se introduce en migraciones recientes; cast hasta refrescar tipos.
      // Setting global de pantalla completa. Lo leemos en paralelo al
      // fetch del examen — si falla, asumimos true (más seguro).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const settingsPromise = (supabase as any)
        .from("app_settings")
        .select("require_exam_fullscreen, max_open_answer_chars")
        .maybeSingle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: examData, error: eErr } = await (supabase as any)
        .from("exams")
        .select("*, course:courses(language, max_exam_attempts)")
        .eq("id", examId)
        .is("deleted_at", null)
        .single();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let e: any = examData;
      void settingsPromise.then(
        ({
          data: s,
        }: {
          data: {
            require_exam_fullscreen?: boolean;
            max_open_answer_chars?: number;
          } | null;
        }) => {
          if (s && typeof s.require_exam_fullscreen === "boolean") {
            setRequireFullscreen(s.require_exam_fullscreen);
          }
          if (s && typeof s.max_open_answer_chars === "number" && s.max_open_answer_chars > 0) {
            setMaxOpenChars(s.max_open_answer_chars);
          }
        },
      );
      if (eErr || !e) {
        // Si el fallo es de red (offline / blip transitorio), no botamos
        // al estudiante — dejamos el spinner y reintentamos en 2s. Su
        // intento en curso sigue intacto en DB; al reconectar podrá
        // reanudar sin perder respuestas.
        const msg = (eErr as { message?: string } | null)?.message ?? "";
        const isNetwork = !navigator.onLine || /fetch|network/i.test(msg);
        if (isNetwork) {
          toast.warning(
            i18n.t("toast.routes_app_student_take_examId.offlineRetrying", {
              defaultValue: "Sin conexión. Reintentando… tus respuestas guardadas siguen seguras.",
            }),
          );
          setTimeout(() => window.location.reload(), 2000);
          return;
        }
        toast.error(
          i18n.t("toast.routes_app_student_take_examId.examNotFound", {
            defaultValue: "Examen no encontrado",
          }),
        );
        navigate({ to: "/app/student/exams" });
        return;
      }
      // Calcular tiempo extra concedido a este estudiante para no expulsarlo
      // si el docente extendió su ventana más allá del end_time original.
      // Se hace antes del gate isExamOpen para que la comprobación use
      // el end_time efectivo (original + extras acumulados).
      const { data: timerCtrls } = await supabase
        .from("exam_timer_controls")
        .select("action, extra_seconds, target_user_id")
        .eq("exam_id", examId)
        .or(`target_user_id.is.null,target_user_id.eq.${user.id}`);
      const extraSeconds = computeExtraSeconds(timerCtrls ?? []);
      if (extraSeconds > 0) {
        e = { ...e, end_time: applyExtraTime(e.end_time, extraSeconds) };
      }

      if (!isExamOpen({ start_time: e.start_time, end_time: e.end_time })) {
        toast.error(
          i18n.t("toast.routes_app_student_take_examId.examNotAvailableNow", {
            defaultValue: "Este examen no está disponible ahora",
          }),
        );
        navigate({ to: "/app/student/exams" });
        return;
      }
      // Bloquea draft (no publicado) y closed (cerrado manualmente por
      // el docente) aunque la ventana de fechas esté abierta. Si por
      // alguna razón la columna no llegó (migración pendiente), tratamos
      // como published.
      const examStatus = (e.status ?? "published") as string;
      if (examStatus !== "published") {
        toast.error(
          examStatus === "draft"
            ? i18n.t("toast.routes_app_student_take_examId.examNotPublished", {
                defaultValue: "Este examen aún no está publicado",
              })
            : i18n.t("toast.routes_app_student_take_examId.examClosedByTeacher", {
                defaultValue: "Este examen fue cerrado por el docente",
              }),
        );
        navigate({ to: "/app/student/exams" });
        return;
      }
      const { data: asg } = await supabase
        .from("exam_assignments")
        .select("id")
        .eq("exam_id", examId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (!asg) {
        toast.error(
          i18n.t("toast.routes_app_student_take_examId.notAssignedToExam", {
            defaultValue: "No estás asignado a este examen",
          }),
        );
        navigate({ to: "/app/student/exams" });
        return;
      }
      let { data: qs } = await supabase
        .from("questions")
        .select("*")
        .eq("exam_id", examId)
        .order("position");
      if (e.shuffle_enabled && qs) qs = [...qs].sort(() => Math.random() - 0.5);
      setQuestions(qs ?? []);

      // Reintentos: contar todas las submissions del estudiante para este examen
      const { data: subs } = await supabase
        .from("submissions")
        .select("*")
        .eq("exam_id", examId)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });
      const allSubs = subs ?? [];
      const inProgress = allSubs.find((s: any) => s.status === "en_progreso");
      // Un intento solo cuenta cuando ya tiene calificación (ai_grade o
      // final_override_grade). Una submission `completado` aún sin nota
      // sigue editable — el alumno puede reanudarla y re-entregar antes
      // de que la IA o el docente le pongan calificación. Misma regla
      // que workshops/proyectos: el contador no sube hasta que hay
      // feedback. La "ungraded submitted" más reciente se promueve a
      // intento reanudable más abajo.
      // SOSPECHOSO siempre cuenta como intento gastado, AUNQUE no tenga
      // nota: el status `sospechoso` se setea cuando el alumno excedió
      // MAX_WARNINGS de proctoring y la submission se cerró
      // automáticamente. Permitir reanudarla burlaría el proctoring.
      // `completado` sin nota SÍ es reanudable (el alumno entregó
      // limpio y todavía no hay feedback).
      const finishedCount = allSubs.filter(
        (s: any) =>
          s.status === "sospechoso" ||
          (s.status === "completado" && (s.ai_grade != null || s.final_override_grade != null)),
      ).length;
      // Solo `completado` SIN calificación es reanudable. `sospechoso`
      // queda bloqueado para revisión del docente — el alumno no puede
      // re-editar para "limpiar" su entrega marcada por proctoring.
      const resumableUngraded = allSubs.find(
        (s: any) =>
          s.status === "completado" && s.ai_grade == null && s.final_override_grade == null,
      );
      const maxAttempts = Math.max(
        1,
        Number(e.max_attempts ?? e.course?.max_exam_attempts ?? 1) || 1,
      );
      // Persistir intento actual para mostrar badge en el header.
      // Solo mostramos cuando maxAttempts > 1 (sin sentido si es intento único).
      if (maxAttempts > 1) {
        setAttemptInfo({ current: finishedCount + 1, total: maxAttempts });
      }

      // Session lock: ensure only one device can present this exam at a time
      const localSessionId = getOrCreateLocalSession(examId);
      sessionIdRef.current = localSessionId;

      // Submission a reanudar: prioridad al en_progreso. Si no hay pero
      // existe una entregada SIN calificar, esa también es reanudable
      // (el alumno puede editar y re-entregar antes del feedback).
      // Volvemos su status a `en_progreso` para que toda la lógica
      // posterior (autosave, session lock, submit) opere igual.
      const resumeTarget = inProgress ?? resumableUngraded ?? null;
      if (resumeTarget) {
        // Si era una entregada sin calificar, la rehidratamos a
        // en_progreso para que el alumno la edite. Limpiamos
        // `submitted_at` para que no quede el timestamp anterior y
        // marcamos el cambio antes de tocar UI state. También
        // cancelamos cualquier job IA pendiente apuntando a esta
        // submission: sin esto, el worker en vuelo podría calificar
        // la versión vieja mientras el alumno edita.
        if (resumeTarget === resumableUngraded) {
          await supabase
            .from("submissions")
            .update({ status: "en_progreso", submitted_at: null })
            .eq("id", resumeTarget.id);
          // Best-effort: si la RPC falla, igual seguimos — el peor caso
          // es que el grader IA produzca una nota desfasada que el
          // alumno verá al re-entregar (la nueva entrega re-encolará).
          await (supabase as any).rpc("cancel_pending_ai_jobs_for_submission", {
            _submission_id: resumeTarget.id,
          });
          toast.info(
            i18n.t("toast.routes_app_student_take_examId.previousSubmissionReopened", {
              defaultValue:
                "Tu entrega anterior aún no fue calificada — la reabrimos para que sigas editando antes de re-entregar.",
            }),
          );
        }
        // Session lock via answers.__session_id + updated_at (no extra columns needed).
        // The autosave keeps updated_at fresh every 1.5s while a device is active.
        // If another device owns the session and updated_at is <10s old → block.
        const existingAnswers = (resumeTarget.answers as Record<string, any>) ?? {};
        const storedSession = existingAnswers.__session_id as string | undefined;
        const updatedAt = new Date((resumeTarget as any).updated_at).getTime();
        const ageMs = Date.now() - updatedAt;

        if (storedSession && storedSession !== localSessionId && ageMs < 10_000) {
          setExam(e);
          setBlockedBySession(true);
          return;
        }

        // Claim the session: inject our session ID into answers (persisted by next autosave)
        const claimedAnswers = { ...existingAnswers, __session_id: localSessionId };
        answersRef.current = claimedAnswers;

        // Reanudar el intento en curso (o re-abrir la entrega sin calificar)
        setSubmissionId(resumeTarget.id);
        submissionIdRef.current = resumeTarget.id;
        setSubmissionStartedAt((resumeTarget as any).started_at ?? null);
        setAnswers(claimedAnswers);
        const persistedWarnings = resumeTarget.focus_warnings ?? 0;
        setWarnings(persistedWarnings);
        warningsRef.current = persistedWarnings;
        const persistedEvents = Array.isArray(existingAnswers.__warning_events)
          ? existingAnswers.__warning_events
          : [];
        warningEventsRef.current = persistedEvents;
        // Restaurar la pregunta donde el estudiante se quedó
        const persistedIdx = restoreQuestionIndex(existingAnswers);
        setCurrentIdx(persistedIdx);
        currentIdxRef.current = persistedIdx;
        setExam(e);
        setStarted(true);
        return;
      }

      if (finishedCount >= maxAttempts) {
        toast.info(
          maxAttempts === 1
            ? i18n.t("toast.routes_app_student_take_examId.alreadyCompletedExam", {
                defaultValue: "Ya completaste este examen",
              })
            : i18n.t("toast.routes_app_student_take_examId.allAttemptsUsed", {
                defaultValue: "Ya usaste tus {{maxAttempts}} intentos para este examen",
                maxAttempts,
              }),
        );
        navigate({ to: "/app/student/exams" });
        return;
      }

      // Quedan intentos disponibles → mostrar pantalla de inicio
      if (finishedCount > 0) {
        toast.info(
          i18n.t("toast.routes_app_student_take_examId.attemptNotice", {
            defaultValue:
              "Intento {{current}} de {{maxAttempts}}. Tu calificación anterior se reemplazará por la de este intento.",
            current: finishedCount + 1,
            maxAttempts,
          }),
        );
      }
      setExam(e);
    })();
    // Dep en `user?.id` y no `user` — useAuth emite un objeto nuevo en
    // varios eventos (rehidratación de sesión, refresh de token, etc.)
    // aunque el usuario sea el mismo. Con `user` como dep el toast de
    // "Intento X de Y" se mostraba 2-3 veces seguidas al cargar la
    // pantalla. Con `user?.id` solo se reevalúa cuando cambia el
    // usuario real. `navigate` se quita de deps porque es estable
    // referencialmente en TanStack Router y no aporta nada.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId, user?.id]);

  const startExam = async () => {
    if (!user || !exam) return;
    let sid = submissionId;
    if (!sid) {
      // Guard against race condition: both devices on the start screen simultaneously.
      const { data: existing } = await supabase
        .from("submissions")
        .select("id, answers, updated_at, started_at")
        .eq("exam_id", examId)
        .eq("user_id", user.id)
        .eq("status", "en_progreso")
        .maybeSingle();

      if (existing) {
        const existingAnswers = (existing.answers as Record<string, any>) ?? {};
        const storedSession = existingAnswers.__session_id as string | undefined;
        const ageMs = Date.now() - new Date((existing as any).updated_at).getTime();

        if (storedSession && storedSession !== sessionIdRef.current && ageMs < 10_000) {
          setBlockedBySession(true);
          return;
        }
        // Take over
        const claimedAnswers = { ...existingAnswers, __session_id: sessionIdRef.current };
        sid = existing.id;
        setSubmissionId(sid);
        submissionIdRef.current = sid;
        setSubmissionStartedAt((existing as any).started_at ?? null);
        setAnswers(claimedAnswers);
        answersRef.current = claimedAnswers;
      }

      if (!sid) {
        // Clear stale IndexedDB data from a previous (deleted) session so the
        // offline sync doesn't show a misleading toast on this fresh start.
        await clearLocalAnswers(examId);
        const initialAnswers = { __session_id: sessionIdRef.current };
        const { data, error } = await supabase
          .from("submissions")
          .insert({
            exam_id: examId,
            user_id: user.id,
            answers: initialAnswers,
            status: "en_progreso",
          })
          .select()
          .single();
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
        sid = data.id;
        setSubmissionId(sid);
        submissionIdRef.current = sid;
        setSubmissionStartedAt((data as any).started_at ?? new Date().toISOString());
        answersRef.current = initialAnswers;
        setAnswers(initialAnswers);
        void logEvent({
          action: "exam_started",
          category: "exam",
          severity: "info",
          entityType: "submission",
          entityId: sid,
          entityName: exam.title,
          metadata: { examId },
        });
      }
    }
    // Si el Admin desactivó el FS obligatorio (modo depuración), saltamos
    // el flujo de fullscreen y arrancamos en ventana normal. Igualmente
    // marcamos hasEverEnteredFullscreenRef=true para que el proctoring
    // (blur, copy, etc.) sí funcione desde ya — solo desactivamos los
    // strikes por fullscreen_exit en el onFsChange más abajo.
    if (!requireFullscreen) {
      hasEverEnteredFullscreenRef.current = true;
      setStarted(true);
      return;
    }
    // Pantalla completa OBLIGATORIA: si no se puede entrar, no iniciar el examen.
    // Esto cubre: navegador sin soporte, usuario rechazó el prompt, embebido sin permiso.
    //
    // Caso especial iOS: Safari pre-16.4 NO soporta Fullscreen API en
    // elementos no-<video>. iOS 16.4+ sí, pero solo si la app está
    // instalada como PWA ("Añadir a pantalla de inicio") O en Safari
    // con el toggle "Webkit Fullscreen API" habilitado en Avanzado.
    // Por eso el mensaje de error guía a esos paths concretos.
    const isIOS =
      typeof navigator !== "undefined" &&
      (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && "ontouchend" in document));
    const fullscreenHelpText = isIOS
      ? t("hc_routesAppStudentTakeExamId.fullscreenHelpIOS")
      : t("hc_routesAppStudentTakeExamId.fullscreenHelpDesktop");

    try {
      await document.documentElement.requestFullscreen?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(
        i18n.t("toast.routes_app_student_take_examId.examRequiresFullscreen", {
          defaultValue: "Este examen requiere pantalla completa. {{help}}",
          help: fullscreenHelpText,
        }),
        {
          duration: 10000,
        },
      );
      void logEvent({
        action: "exam_fullscreen_denied",
        category: "exam",
        severity: "warning",
        entityType: "submission",
        entityId: sid,
        entityName: exam.title,
        metadata: { examId, stage: "start", error: msg, isIOS },
      });
      return;
    }
    // Verifica que realmente entró (algunos navegadores resuelven la promise sin activar fullscreen)
    if (!document.fullscreenElement) {
      toast.error(
        i18n.t("toast.routes_app_student_take_examId.couldNotActivateFullscreen", {
          defaultValue: "No se pudo activar pantalla completa. {{help}}",
          help: fullscreenHelpText,
        }),
        {
          duration: 10000,
        },
      );
      void logEvent({
        action: "exam_fullscreen_denied",
        category: "exam",
        severity: "warning",
        entityType: "submission",
        entityId: sid,
        entityName: exam.title,
        metadata: { examId, stage: "start", reason: "no_fullscreen_element", isIOS },
      });
      return;
    }
    // Confirmamos entrada a FS antes de armar started → el proctoring
    // arranca estricto desde el primer render.
    hasEverEnteredFullscreenRef.current = true;
    setStarted(true);
  };

  // Si reanudamos un examen (recarga de página, status en_progreso) entramos
  // a started=true sin pasar por startExam y por ende sin gesture user para
  // requestFullscreen. En ese caso mostramos el overlay para que el estudiante
  // re-entre vía botón (gesture válido).
  // Skip cuando el Admin desactivó el FS obligatorio.
  useEffect(() => {
    if (!started) return;
    if (!requireFullscreen) return;
    if (!document.fullscreenElement) {
      setFsExited(true);
    }
  }, [started, requireFullscreen]);

  // Estado del overlay de re-entrada a pantalla completa
  const [fsExited, setFsExited] = useState(false);
  const reenterFullscreen = async () => {
    try {
      await document.documentElement.requestFullscreen?.();
      // El click en "Reanudar" del overlay cuenta como entrada válida —
      // activamos el proctoring estricto. Si el alumno sale luego, sí
      // cuenta como strike normal.
      hasEverEnteredFullscreenRef.current = true;
      setFsExited(false);
    } catch (e) {
      console.warn("re-enter fullscreen failed", e);
    }
  };

  // Persistir respuestas inmediatamente (autosave, entrega, tiempo agotado)
  const saveAnswersNow = useCallback(async () => {
    if (!submissionIdRef.current) return;
    const currentAnswers = {
      ...answersRef.current,
      // Persistimos el índice de la pregunta visible para que el
      // monitor del docente pueda mostrar "Pregunta X de Y" en tiempo
      // real para los intentos en curso (vía postgres_changes).
      __current_idx: currentIdxRef.current,
    };
    const currentWarnings = warningsRef.current;
    if (isOnline()) {
      await supabase
        .from("submissions")
        .update({ answers: currentAnswers, focus_warnings: currentWarnings })
        .eq("id", submissionIdRef.current);
    }
    await saveAnswersLocally(examId, {
      submissionId: submissionIdRef.current,
      answers: currentAnswers,
      warnings: currentWarnings,
      timestamp: Date.now(),
    });
  }, [examId]);

  const performSubmit = useCallback(
    async (markSuspicious = false) => {
      if (submittedRef.current || !submissionIdRef.current) return;

      const mergedPlain = mergeStarterCodeAnswers(questions, answersRef.current);
      answersRef.current = mergedPlain;
      setAnswers(mergedPlain);

      submittedRef.current = true;
      setSubmitting(true);

      // Merge the latest warning events into answers so we never lose them
      const currentAnswers = {
        ...answersRef.current,
        __warning_events: warningEventsRef.current,
      };
      const currentWarnings = warningsRef.current;

      const updateData = {
        answers: currentAnswers,
        status: markSuspicious ? "sospechoso" : "completado",
        focus_warnings: currentWarnings,
        submitted_at: new Date().toISOString(),
      };

      // Persist locally first as a safety net — never lose answers
      try {
        await saveAnswersLocally(examId, {
          submissionId: submissionIdRef.current,
          answers: currentAnswers,
          warnings: currentWarnings,
          timestamp: Date.now(),
        });
      } catch (e) {
        console.error("local save failed:", e);
      }

      // Siempre intentar persistir en servidor (navigator.onLine puede dar falsos negativos).
      let serverUpdated = false;
      const { error: updateErr } = await supabase
        .from("submissions")
        .update(updateData)
        .eq("id", submissionIdRef.current);
      if (!updateErr) {
        serverUpdated = true;
      } else {
        console.error("submission update failed:", updateErr);
        const { error: retryErr } = await supabase
          .from("submissions")
          .update(updateData)
          .eq("id", submissionIdRef.current);
        if (!retryErr) {
          serverUpdated = true;
        } else {
          console.error("submission update retry failed:", retryErr);
        }
      }

      if (!serverUpdated) {
        submittedRef.current = false;
        setSubmitting(false);
        toast.error(
          i18n.t("toast.routes_app_student_take_examId.submissionServerFailed", {
            defaultValue:
              "No se pudo registrar la entrega en el servidor. Tus respuestas están guardadas localmente; revisa la conexión y vuelve a intentar entregar.",
          }),
        );
        return;
      }

      // Optimización: la UI debe responder rápido (~300ms del update
      // anterior). La notificación al docente y la calificación con IA
      // son tareas de servidor que el alumno no necesita esperar — las
      // disparamos sin await ("fire-and-forget"). El fetch sale del
      // navegador inmediatamente y completa en el servidor incluso si
      // el alumno navega a otra ruta. Antes esto bloqueaba ~5-15s por
      // pregunta abierta esperando a que Gemini calificara una por una.
      if (markSuspicious && exam) {
        void (async () => {
          try {
            const { data: profile } = await supabase
              .from("profiles")
              .select("full_name")
              .eq("id", user!.id)
              .single();
            const studentName =
              profile?.full_name ?? t("hc_routesAppStudentTakeExamId.aStudent");
            // Notificación resumida: un docente con muchos exámenes
            // necesita el qué/quién, no el detalle. El detalle vive en
            // el monitor (la card "Eventos de advertencia" lo muestra).
            const body = t("hc_routesAppStudentTakeExamId.suspiciousExamNotifBody", {
              studentName,
              maxWarnings,
              examTitle: exam.title,
            });

            const { error: rpcErr } = await supabase.rpc("notify_exam_teachers", {
              _exam_id: examId,
              _title: t("hc_routesAppStudentTakeExamId.suspiciousExamNotifTitle"),
              _body: body,
              _link: `/app/teacher/monitor/${examId}`,
            });
            if (rpcErr) console.error("notify_exam_teachers RPC failed:", rpcErr);
          } catch (e) {
            console.error("Error notifying teachers:", e);
          }
        })();
      }

      try {
        if (document.fullscreenElement) await document.exitFullscreen();
      } catch {}
      // Dispara el grading IA respetando el setting global async/sync.
      // - `processing_mode = 'async'` (default): encola en
      //   `ai_grading_queue`; el worker hourly drena la cola.
      // - `processing_mode = 'sync'` o el docente tiene un override
      //   código activo: invoca a `ai-grade-submission` directo.
      //
      // Antes llamábamos siempre directo (`supabase.functions.invoke`)
      // ignorando el toggle del admin — el feature de cola IA no
      // aplicaba a entregas de examen aunque el admin tuviera 'async'
      // activo. Ver `src/modules/ai/ai-grading.ts` para el helper.
      //
      // Fire-and-forget: el alumno no espera ni en sync ni en async.
      // En sync la edge corre en background del Lambda Supabase (~5-15s);
      // en async el worker la procesará en la próxima ventana hourly.
      void aiGradeOrEnqueue({
        kind: "exam_submission",
        body: { submissionId: submissionIdRef.current },
        target: {
          table: "submissions",
          rowId: submissionIdRef.current ?? "",
          // El edge function exam_full escribe submissions internamente
          // (answers JSONB + ai_grade + ai_detected_score) y devuelve
          // `persistedInternally: true`. El worker detecta el flag y NO
          // sobreescribe esas columnas — solo marca el job done.
          fieldGrade: "ai_grade",
          fieldFeedback: "ai_detected_reasons",
          fieldLikelihood: "ai_detected_score",
          // courseId es CLAVE para el RLS del docente. El RLS de
          // ai_grading_queue requiere `course_id IS NOT NULL` para
          // que el docente vea jobs ajenos a sus cursos. Sin esto,
          // el job se encola pero el docente NO lo ve en su
          // dashboard (solo lo vería el admin).
          courseId: exam?.course_id ?? null,
        },
      })
        .then((result) => {
          // Si quedó encolado (modo async sin override del docente),
          // avisar al estudiante. Sin esto, ve la pantalla "examen
          // entregado" sin saber por qué su nota tardará. El toast
          // es global (sonner) — sobrevive a la navegación a otra ruta.
          if (!result.ranSync && !result.error) {
            // Mensaje minimal: solo "Por calificar".
            toast.info(QUEUED_STUDENT_TITLE, { duration: 6000 });
          }
        })
        .catch((e) => console.error("aiGradeOrEnqueue failed:", e));
      void logEvent({
        action: markSuspicious ? "exam_suspended" : "exam_submitted",
        category: "exam",
        severity: markSuspicious ? "warning" : "info",
        entityType: "submission",
        entityId: submissionIdRef.current ?? undefined,
        entityName: exam?.title,
        metadata: {
          examId,
          focusWarnings: warningsRef.current,
          maxWarnings,
        },
      });
      toast.success(
        markSuspicious
          ? i18n.t("toast.routes_app_student_take_examId.examSuspended", {
              defaultValue: "Examen suspendido",
            })
          : i18n.t("toast.routes_app_student_take_examId.examSubmittedSuccess", {
              defaultValue: "Examen entregado correctamente",
            }),
      );
      navigate({ to: "/app/student/exams" });
    },
    [navigate, examId, exam, user, questions, maxWarnings],
  );

  const requestManualSubmit = useCallback(async () => {
    if (submitting || submittedRef.current || !submissionIdRef.current) return;
    await saveAnswersNow();
    const merged = mergeStarterCodeAnswers(questions, answersRef.current);
    answersRef.current = merged;
    setAnswers(merged);
    const unanswered = getUnansweredIndices(questions, merged);
    if (unanswered.length === 0) {
      await performSubmit(false);
      return;
    }
    setSubmitModal({
      open: true,
      unansweredIndices: unanswered,
    });
  }, [submitting, saveAnswersNow, questions, performSubmit]);

  const confirmSubmitFromModal = useCallback(async () => {
    setSubmitModal({ open: false, unansweredIndices: [] });
    await saveAnswersNow();
    await performSubmit(false);
  }, [performSubmit, saveAnswersNow]);

  const cancelManualSubmitModal = useCallback(() => {
    setSubmitModal({ open: false, unansweredIndices: [] });
  }, []);

  /** Tiempo global del examen agotado → guardar y entregar sin modal */
  const handleTimeUp = useCallback(() => {
    if (submittedRef.current) return;
    void (async () => {
      await saveAnswersNow();
      const merged = mergeStarterCodeAnswers(questions, answersRef.current);
      answersRef.current = merged;
      setAnswers(merged);
      await performSubmit(false);
    })();
  }, [saveAnswersNow, questions, performSubmit]);

  const initialSeconds =
    exam?.schedule_type === "relativo"
      ? computeSecondsLeftRelative(
          submissionStartedAt,
          exam?.time_limit_minutes ?? 0,
          exam?.end_time,
        )
      : computeSecondsLeft(exam?.end_time);

  const { isPaused, formattedTime, isLowTime, syncToSeconds } = useRealtimeTimer({
    examId,
    userId: user?.id ?? "",
    initialSeconds,
    onTimeUp: handleTimeUp,
    onPause: () =>
      toast.info(
        i18n.t("toast.routes_app_student_take_examId.timerPausedByTeacher", {
          defaultValue: "⏸ El docente ha pausado el temporizador",
        }),
      ),
    onResume: () =>
      toast.info(
        i18n.t("toast.routes_app_student_take_examId.timerResumed", {
          defaultValue: "▶ El temporizador ha sido reanudado",
        }),
      ),
    onTimeAdded: (secs) =>
      toast.success(
        i18n.t("toast.routes_app_student_take_examId.extraMinutesAdded", {
          defaultValue: "+{{minutes}} minuto(s) extra añadidos",
          minutes: Math.floor(secs / 60),
        }),
      ),
  });

  // Suscripción realtime a cambios en el examen (end_time, time_limit_minutes).
  // Si el docente modifica el horario mientras el examen está en curso,
  // el temporizador del estudiante se sincroniza automáticamente.
  useEffect(() => {
    if (!examId || !started) return;
    const channel = supabase
      .channel(`exam-meta-${examId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "exams", filter: `id=eq.${examId}` },
        (payload) => {
          const updated = payload.new as Partial<Exam>;
          const e = examRef.current;
          if (!e) return;
          const newEndTime = (updated.end_time as string | undefined) ?? e.end_time;
          const newStartTime = (updated.start_time as string | undefined) ?? e.start_time;
          const newLimit =
            (updated.time_limit_minutes as number | undefined) ?? e.time_limit_minutes;
          const newScheduleType = (updated.schedule_type as string | undefined) ?? e.schedule_type;
          const newSeconds =
            newScheduleType === "relativo"
              ? computeSecondsLeftRelative(submissionStartedAtRef.current, newLimit, newEndTime)
              : computeSecondsLeft(newEndTime);
          syncToSeconds(Math.max(0, newSeconds));
          setExam((prev) =>
            prev
              ? {
                  ...prev,
                  end_time: newEndTime,
                  start_time: newStartTime,
                  time_limit_minutes: newLimit,
                  schedule_type: newScheduleType,
                }
              : prev,
          );
          toast.info(
            i18n.t("toast.routes_app_student_take_examId.teacherUpdatedExamTime", {
              defaultValue: "El docente actualizó el tiempo del examen",
            }),
          );
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [examId, started, syncToSeconds]);

  // Auto-save answers (debounced, also runs on warning increments)
  useEffect(() => {
    if (!started || !submissionIdRef.current) return;
    const t = setTimeout(() => {
      saveAnswersNow();
    }, 1500);
    return () => clearTimeout(t);
  }, [answers, warnings, started, saveAnswersNow]);

  // Proctoring: focus tracking, contextmenu/key blocking, fullscreen enforcement
  useEffect(() => {
    if (!started) return;

    // Push an extra history entry so pressing back stays on the exam URL.
    // Register in the CAPTURE phase and call stopImmediatePropagation() so
    // TanStack Router's own popstate listener never fires — without this the
    // router fights with our pushState and causes intermittent UI freezes.
    history.pushState(null, "", window.location.href);
    const onPopstate = (e: PopStateEvent) => {
      if (submittedRef.current) return;
      e.stopImmediatePropagation();
      history.pushState(null, "", window.location.href);
      setManualLeaveOpen(true);
    };
    window.addEventListener("popstate", onPopstate, true);

    let blurLockUntil = 0;
    let lastBlurAt = 0;
    const recordWarning = (type: string) => {
      if (submittedRef.current) return;
      // Grace period de reanudación: si el estudiante todavía no ha
      // entrado a pantalla completa (resume tras eliminación de strike,
      // recarga, etc.), no sumamos strike. El overlay "Reanudar" bloquea
      // la interacción con el examen hasta que entre a FS — cualquier
      // blur/fullscreenchange aquí es parte del flujo de entrada.
      if (!hasEverEnteredFullscreenRef.current) return;
      const now = Date.now();
      if (now < blurLockUntil) return;
      blurLockUntil = now + 500;

      const nw = warningsRef.current + 1;
      warningsRef.current = nw;
      setWarnings(nw);

      const event = {
        type,
        at: new Date(now).toISOString(),
        // currentIdxRef.current (no `currentIdx` del closure): el
        // useEffect que define recordWarning/Copy/Screenshot tiene deps
        // [started, performSubmit, maxWarnings, requireFullscreen] —
        // NO incluye currentIdx, así que al avanzar de pregunta los
        // listeners seguían registrando el índice viejo. El monitor del
        // docente veía strikes anclados a la pregunta equivocada.
        questionIdx:
          exam?.navigation_type === "secuencial" ? currentIdxRef.current : null,
      };
      warningEventsRef.current = [...warningEventsRef.current, event];

      // Persist current answers + warning count + event log in one write
      const updatedAnswers = {
        ...answersRef.current,
        __warning_events: warningEventsRef.current,
      };
      answersRef.current = updatedAnswers;
      setAnswers(updatedAnswers);
      if (submissionIdRef.current && isOnline()) {
        supabase
          .from("submissions")
          .update({ focus_warnings: nw, answers: updatedAnswers })
          .eq("id", submissionIdRef.current)
          .then(({ error }) => {
            if (error) console.error("recordWarning DB save failed:", error);
          });
      }

      if (shouldMarkSuspicious(nw, maxWarnings)) {
        toast.error(
          i18n.t("toast.routes_app_student_take_examId.exitLimitExceeded", {
            defaultValue: "Has superado el límite de salidas. El examen se suspende.",
          }),
        );
        performSubmit(true);
      } else {
        toast.warning(
          i18n.t("toast.routes_app_student_take_examId.warningWithLabel", {
            defaultValue: "Advertencia {{count}}/{{max}}: {{label}}",
            count: nw,
            max: maxWarnings,
            label: warningLabel(type),
          }),
        );
      }
    };

    // Copy/paste/cut: alerta blanda + registro para el monitor del
    // docente, pero NO suma strike. Antes sumaba — varios docentes
    // reportaron que es muy estricto: el alumno copia accidentalmente
    // (Ctrl+C antes de pensar en escribir, navegar con teclado, etc.)
    // y queda con strike sin haber hecho nada malo. Ahora le avisamos
    // que no está permitido pero no penalizamos. El docente sigue
    // viendo el intento en el monitor (warningEvents) para detectar
    // patrones repetidos manualmente.
    let lastClipboardAt = 0;
    const recordCopyAlert = (eventType: "copiar" | "pegar" | "cortar") => {
      if (submittedRef.current) return;
      const now = Date.now();
      if (now - lastClipboardAt < 800) return;
      lastClipboardAt = now;

      const msg =
        eventType === "pegar"
          ? t("hc_routesAppStudentTakeExamId.pasteNotAllowed")
          : eventType === "cortar"
            ? t("hc_routesAppStudentTakeExamId.cutNotAllowed")
            : t("hc_routesAppStudentTakeExamId.copyNotAllowed");
      toast.warning(msg);

      const event = {
        type: eventType,
        at: new Date(now).toISOString(),
        // currentIdxRef.current (no `currentIdx` del closure): el
        // useEffect que define recordWarning/Copy/Screenshot tiene deps
        // [started, performSubmit, maxWarnings, requireFullscreen] —
        // NO incluye currentIdx, así que al avanzar de pregunta los
        // listeners seguían registrando el índice viejo. El monitor del
        // docente veía strikes anclados a la pregunta equivocada.
        questionIdx:
          exam?.navigation_type === "secuencial" ? currentIdxRef.current : null,
      };
      warningEventsRef.current = [...warningEventsRef.current, event];

      const updatedAnswers = {
        ...answersRef.current,
        __warning_events: warningEventsRef.current,
      };
      answersRef.current = updatedAnswers;
      setAnswers(updatedAnswers);
      if (submissionIdRef.current && isOnline()) {
        supabase
          .from("submissions")
          .update({ answers: updatedAnswers })
          .eq("id", submissionIdRef.current)
          .then(({ error }) => {
            if (error) console.error("recordCopyAlert DB save failed:", error);
          });
      }
    };

    // Intento de pantallazo: alerta blanda + se registra para el monitor
    // del docente, pero NO suma strike. La detección es best-effort: el
    // SO suele interceptar PrintScreen, Win+Shift+S y Cmd+Shift+3/4/5
    // antes de que llegue al navegador, así que solo capturamos los
    // casos en que el evento sí se propaga.
    let lastScreenshotAt = 0;
    const recordScreenshotAttempt = () => {
      if (submittedRef.current) return;
      const now = Date.now();
      if (now - lastScreenshotAt < 800) return;
      lastScreenshotAt = now;

      toast.warning(
        i18n.t("toast.routes_app_student_take_examId.screenshotsNotAllowed", {
          defaultValue: "No está permitido tomar pantallazos durante el examen.",
        }),
      );

      const event = {
        type: "screenshot_attempt",
        at: new Date(now).toISOString(),
        // currentIdxRef.current (no `currentIdx` del closure): el
        // useEffect que define recordWarning/Copy/Screenshot tiene deps
        // [started, performSubmit, maxWarnings, requireFullscreen] —
        // NO incluye currentIdx, así que al avanzar de pregunta los
        // listeners seguían registrando el índice viejo. El monitor del
        // docente veía strikes anclados a la pregunta equivocada.
        questionIdx:
          exam?.navigation_type === "secuencial" ? currentIdxRef.current : null,
      };
      warningEventsRef.current = [...warningEventsRef.current, event];

      const updatedAnswers = {
        ...answersRef.current,
        __warning_events: warningEventsRef.current,
      };
      answersRef.current = updatedAnswers;
      setAnswers(updatedAnswers);
      if (submissionIdRef.current && isOnline()) {
        supabase
          .from("submissions")
          .update({ answers: updatedAnswers })
          .eq("id", submissionIdRef.current)
          .then(({ error }) => {
            if (error) console.error("recordScreenshotAttempt DB save failed:", error);
          });
      }
    };

    // Show native "Leave site?" dialog on browser/tab close (full reload/close).
    // SPA navigation is handled by useBlocker above.
    // blur may or may not fire before beforeunload depending on the browser.
    // We use lastBlurAt to know if blur already incremented the count.
    // If not, we increment here before sending the keepalive fetch.
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (submittedRef.current) return;
      e.preventDefault();
      e.returnValue = "";
      if (!submissionIdRef.current || !authTokenRef.current) return;
      // Grace period de reanudación: si el alumno todavía no entró a
      // pantalla completa (resume tras eliminación de strike, recarga,
      // etc.), cerrar la tab NO suma strike — está en la antesala del
      // examen, no abusando. Misma regla que recordWarning.
      if (!hasEverEnteredFullscreenRef.current) {
        // Persistir respuestas sin tocar focus_warnings ni status.
        fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/submissions?id=eq.${submissionIdRef.current}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
              Authorization: `Bearer ${authTokenRef.current}`,
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ answers: answersRef.current }),
            keepalive: true,
          },
        );
        return;
      }
      // If blur fired within the last 200ms it already incremented warningsRef — just persist.
      // Otherwise increment here (browser close on platforms where blur doesn't precede beforeunload).
      const blurJustFired = Date.now() - lastBlurAt < 200;
      const warningsToSend = blurJustFired ? warningsRef.current : warningsRef.current + 1;
      const body: Record<string, unknown> = {
        focus_warnings: warningsToSend,
        answers: answersRef.current,
      };
      if (shouldMarkSuspicious(warningsToSend, maxWarnings)) {
        body.status = "sospechoso";
        body.submitted_at = new Date().toISOString();
        submittedRef.current = true;
      }
      fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/submissions?id=eq.${submissionIdRef.current}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
            Authorization: `Bearer ${authTokenRef.current}`,
            Prefer: "return=minimal",
          },
          body: JSON.stringify(body),
          keepalive: true,
        },
      );
    };

    const onBlur = () => {
      lastBlurAt = Date.now();
      recordWarning("pestaña");
    };
    const onContext = (e: Event) => e.preventDefault();
    // Política de copiar/pegar/cortar:
    //   - PERMITIDO dentro de editores de código (Monaco) → preguntas
    //     `codigo` y `java_gui`. Esto es necesario porque los estudiantes
    //     legítimamente copian fragmentos entre el área de código y
    //     consola, snippets, etc.
    //   - BLOQUEADO en cualquier otro input (textarea de respuesta
    //     abierta, opción múltiple, diagrama). preventDefault evita que
    //     pegar contenido externo (LLM, otro tab) sea trivial; además
    //     suma un strike por intento.
    // Detectamos por DOM: `.monaco-editor` envuelve cualquier instancia
    // del editor. Si el target del evento está dentro de uno, dejamos
    // pasar; si no, lo bloqueamos.
    const isInCodeEditor = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement && target.closest(".monaco-editor") !== null;
    const onClipboard = (e: ClipboardEvent) => {
      if (isInCodeEditor(e.target)) return;
      e.preventDefault();
      // Diferenciamos copy vs paste vs cut para que el monitor docente
      // pueda mostrar la acción exacta. Soft alert (sin strike) —
      // copiar/pegar es bloqueado pero no penalizado.
      const key = e.type === "paste" ? "pegar" : e.type === "cut" ? "cortar" : "copiar";
      recordCopyAlert(key);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "F11") e.preventDefault();
      if (e.altKey && (e.key === "Tab" || e.key === "F4")) e.preventDefault();
      // Pantallazos — alerta blanda, sin strike. preventDefault es
      // best-effort (el SO suele tomar la tecla antes).
      if (e.key === "PrintScreen") {
        e.preventDefault();
        recordScreenshotAttempt();
        return;
      }
      // macOS: Cmd+Shift+3 (pantalla completa), Cmd+Shift+4 (recorte),
      // Cmd+Shift+5 (utilidad de captura).
      if (e.metaKey && e.shiftKey && (e.key === "3" || e.key === "4" || e.key === "5")) {
        e.preventDefault();
        recordScreenshotAttempt();
        return;
      }
      // Windows: Win+Shift+S (Snipping Tool). En la mayoría de navegadores
      // el SO se traga este atajo, pero si llega lo registramos.
      if (e.metaKey && e.shiftKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        recordScreenshotAttempt();
        return;
      }
      // Bloqueo Esc durante el examen: que no cierre dialogs ni
      // cancele autocomplete/selección/etc. del navegador. NOTA: no
      // podemos evitar que el navegador salga de fullscreen al pulsar
      // Esc — esa salida la maneja el SO/browser y nuestro código no
      // la intercepta. Cuando ocurre, fullscreenchange dispara y
      // recordWarning("fullscreen_exit") suma el strike correspondiente.
      // stopPropagation además evita que Radix Dialog reciba el evento
      // y cierre el modal abierto en ese momento.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
      // Bloqueo de zoom del navegador (Ctrl/Cmd + "+" / "-" / "0").
      // En algunos navegadores el zoom hace que el viewport cambie de
      // tamaño y se salga de fullscreen, lo que dispararía
      // recordWarning("fullscreen_exit") sin que el alumno haya hecho
      // nada sospechoso. Interceptando el shortcut el zoom no ocurre
      // y el efecto colateral desaparece. Cubre teclas principales y
      // numpad ("+", "=", "-", "0").
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "+" || e.key === "-" || e.key === "=" || e.key === "0")
      ) {
        e.preventDefault();
        return;
      }
    };
    // Ctrl/Cmd + rueda del mouse también hace zoom. Mismo motivo que
    // arriba — interceptamos para que no dispare fullscreen_exit.
    // Requiere `passive: false` para que preventDefault tenga efecto.
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    };
    const onFsChange = () => {
      if (document.fullscreenElement) {
        // Primer ingreso a FS de esta sesión → activamos el proctoring
        // estricto. A partir de aquí los strikes cuentan.
        hasEverEnteredFullscreenRef.current = true;
        setFsExited(false);
      } else if (started && !submittedRef.current && requireFullscreen) {
        // Solo cuenta strike por salida de FS si la institución exige FS.
        // En modo depuración (toggle off) el FS no aplica.
        recordWarning("fullscreen_exit");
        setFsExited(true);
      }
    };
    // PrintScreen no siempre dispara keydown (algunos navegadores solo
    // emiten keyup tras la captura del SO). Cubrimos ambos.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "PrintScreen") recordScreenshotAttempt();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("blur", onBlur);
    document.addEventListener("contextmenu", onContext);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("copy", onClipboard);
    document.addEventListener("paste", onClipboard);
    document.addEventListener("cut", onClipboard);
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("popstate", onPopstate, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("contextmenu", onContext);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("copy", onClipboard);
      document.removeEventListener("paste", onClipboard);
      document.removeEventListener("cut", onClipboard);
      document.removeEventListener("wheel", onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, performSubmit, maxWarnings, requireFullscreen]);

  /** Cancela un run en curso para `questionId`. No mata el worker remoto
   *  (CheerpJ no expone API; edge function ya está corriendo server-side),
   *  pero libera el botón "Ejecutar" para que el estudiante pueda
   *  cambiar de compilador y reintentar sin esperar. */
  const cancelRun = (questionId: string) => {
    const controller = runAbortersRef.current[questionId];
    if (!controller) return;
    controller.abort();
    delete runAbortersRef.current[questionId];
    setRunningCode((prev) => ({ ...prev, [questionId]: false }));
    toast.info(
      i18n.t("toast.routes_app_student_take_examId.executionCancelled", {
        defaultValue: "Ejecución cancelada. Puedes cambiar de compilador y reintentar.",
      }),
    );
  };

  const runCode = async (questionId: string, language: CodeLanguage) => {
    const code = typeof answers[questionId] === "string" ? (answers[questionId] as string) : "";
    if (!code.trim()) {
      toast.error(
        i18n.t("toast.routes_app_student_take_examId.writeCodeBeforeRunning", {
          defaultValue: "Escribe código antes de ejecutar",
        }),
      );
      return;
    }
    // Provider efectivo = override del estudiante para esta pregunta, o
    // el default global. `cheerp` solo aplica si el lenguaje es Java
    // (corre client-side via WebAssembly). Para otros lenguajes con
    // `cheerp` seleccionado caemos al edge function, que internamente
    // usará onlinecompiler.
    const overrideForQuestion = runnerOverride[questionId];
    const provider = overrideForQuestion ?? codeExecProviderRef.current;

    // Cancela cualquier run previo de esta misma pregunta (defensive —
    // si el alumno clickea Ejecutar dos veces rápido el primero queda
    // huérfano, pero `disabled={isRunning}` previene el doble click en
    // el botón). Igual el cleanup es barato.
    runAbortersRef.current[questionId]?.abort();
    const controller = new AbortController();
    runAbortersRef.current[questionId] = controller;
    const { signal } = controller;

    setRunningCode((prev) => ({ ...prev, [questionId]: true }));
    // Limpia el output ANTES de ejecutar para que el alumno no vea el
    // resultado del run anterior mientras espera el nuevo. Aplica a
    // todos los providers (CheerpJ, Lambda, OnlineCompiler).
    setCodeOutputs((prev) => ({ ...prev, [questionId]: "" }));
    try {
      let stdout = "";
      let stderr = "";

      if (provider === "cheerp" && language === "java") {
        // CheerpJ: ejecuta Java directamente en el navegador (sin API externa ni cuota).
        const result = await runJavaInBrowser(code, signal);
        stdout = result.stdout;
        stderr = result.stderr;
      } else {
        // Para edge functions corremos una carrera entre el invoke y
        // un promise que rechaza cuando el signal aborta. El invoke
        // sigue ejecutando server-side hasta que el provider responda,
        // pero la UI ya quedó libre. Aceptable trade-off.
        const cancelPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error(CANCELLED_SENTINEL));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error(CANCELLED_SENTINEL)), {
            once: true,
          });
        });
        const invokePromise = supabase.functions.invoke("execute-code", {
          body: {
            sourceCode: code,
            language,
            questionId,
            submissionId: submissionIdRef.current,
            // Solo mandamos `provider` cuando el estudiante eligió un
            // override. Sin override, el edge function usa el default
            // del admin (mismo comportamiento que antes).
            ...(overrideForQuestion ? { provider: overrideForQuestion } : {}),
          },
        });
        const { data, error } = await (Promise.race([invokePromise, cancelPromise]) as Promise<
          Awaited<typeof invokePromise>
        >);
        if (error) {
          // Extraemos el mensaje REAL del response body (que tiene
          // `{ error: "detalle..." }`), no el genérico
          // "Edge Function returned a non-2xx status code".
          const real = await extractEdgeError(error, data);
          throw new Error(real || t("hc_routesAppStudentTakeExamId.errorRunningCode"));
        }
        stdout = data?.stdout ?? "";
        stderr = data?.stderr ?? "";
      }

      // Defense-in-depth: si el provider remoto devolvió el mensaje
      // opaco genérico ("Internal error: code execution failed") sin
      // ningún detalle útil, lo reemplazamos por una pista accionable.
      // El edge function ya hace este filtro server-side, pero lo
      // duplicamos aquí para cubrir el caso en que el edge no esté
      // redesplegado todavía con el último fix.
      const opaqueRe = /^\s*(internal\s+)?error:\s*code execution failed\.?\s*$/i;
      const stdoutOpaque = opaqueRe.test(stdout);
      const stderrOpaque = opaqueRe.test(stderr);
      if (stdoutOpaque) stdout = "";
      if (stderrOpaque) stderr = "";
      if (!stdout.trim() && !stderr.trim()) {
        // Nada útil que mostrar: o el API se quedó callado o solo devolvió
        // el mensaje opaco. Inyectamos pista accionable.
        stderr = t("hc_routesAppStudentTakeExamId.remoteCompilerNoDetail");
      }

      // Combinar stdout + stderr en el orden natural de terminal.
      // stderr contiene el traceback completo con números de línea — se muestra tal cual.
      const parts: string[] = [];
      if (stdout.trimEnd()) parts.push(stdout.trimEnd());
      if (stderr.trimEnd()) parts.push(stderr.trimEnd());
      const output = parts.join("\n") || t("hc_routesAppStudentTakeExamId.noOutput");
      setCodeOutputs((prev) => ({ ...prev, [questionId]: output }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t("hc_routesAppStudentTakeExamId.errorRunning");
      // Cancelación por el usuario: NO mostramos error ni loggeamos
      // como error real. La UI ya quedó libre por el cancelRun handler;
      // aquí solo silenciamos el catch para que no aparezca un toast
      // "Error: __examlab_run_cancelled__".
      if (msg === CANCELLED_SENTINEL) {
        return;
      }
      setCodeOutputs((prev) => ({
        ...prev,
        [questionId]: t("hc_routesAppStudentTakeExamId.errorPrefix", { msg }),
      }));
      void logEvent({
        action: "code_execution_error",
        category: "exam",
        severity: "error",
        entityType: "submission",
        entityId: submissionIdRef.current ?? undefined,
        entityName: exam?.title,
        metadata: {
          examId,
          questionId,
          language,
          provider,
          default_provider: codeExecProviderRef.current,
          provider_overridden: !!overrideForQuestion,
          error: msg,
        },
      });
    } finally {
      // Solo limpiamos el aborter si sigue siendo el nuestro. Si el
      // estudiante pulsó Cancelar (cancelRun ya lo borró) o si arrancó
      // otro run en paralelo (sobrescribió el slot), no toquemos lo
      // que ya está en juego.
      if (runAbortersRef.current[questionId] === controller) {
        delete runAbortersRef.current[questionId];
      }
      setRunningCode((prev) => ({ ...prev, [questionId]: false }));
    }
  };

  if (!exam) return <p className="text-muted-foreground p-6">{t("common.loading")}</p>;

  if (blockedBySession) {
    return (
      <div className="max-w-2xl mx-auto py-10">
        <Card>
          <CardContent className="p-6 space-y-4 text-center">
            <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
            <h2 className="text-xl font-semibold">
              {t("hc_routesAppStudentTakeExamId.examOpenOnAnotherDevice")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("hc_routesAppStudentTakeExamId.examOpenOnAnotherDeviceDesc")}
            </p>
            <Button variant="outline" onClick={() => navigate({ to: "/app/student/exams" })}>
              {t("hc_routesAppStudentTakeExamId.backToMyExams")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!started) {
    return (
      <div className="max-w-2xl mx-auto py-10">
        <Card>
          <CardContent className="p-6 space-y-4">
            <h1 className="text-2xl font-semibold">{exam.title}</h1>
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm space-y-2">
              <p className="font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning-foreground" />
                {t("hc_routesAppStudentTakeExamId.beforeYouStart")}
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                <li>
                  {t("hc_routesAppStudentTakeExamId.durationLabel")}{" "}
                  <strong>
                    {t("hc_routesAppStudentTakeExamId.minutesValue", {
                      minutes: exam.time_limit_minutes,
                    })}
                  </strong>
                  .{" "}
                  {exam.schedule_type === "relativo"
                    ? t("hc_routesAppStudentTakeExamId.timerStartsOnStart")
                    : t("hc_routesAppStudentTakeExamId.timeNotPaused")}
                </li>
                <li>
                  {t("hc_routesAppStudentTakeExamId.eachActionWarningPre")}{" "}
                  <strong>{maxWarnings}</strong>{" "}
                  {t("hc_routesAppStudentTakeExamId.eachActionWarningMid")}{" "}
                  <strong>{t("hc_routesAppStudentTakeExamId.suspiciousWord")}</strong>{" "}
                  {t("hc_routesAppStudentTakeExamId.eachActionWarningPost")}
                  <ul className="list-disc list-inside ml-5 mt-1 space-y-0.5">
                    <li>{t("hc_routesAppStudentTakeExamId.switchTabOrWindow")}</li>
                    <li>{t("hc_routesAppStudentTakeExamId.hideTab")}</li>
                    {requireFullscreen && (
                      <li>{t("hc_routesAppStudentTakeExamId.exitFullscreenAction")}</li>
                    )}
                  </ul>
                </li>
                <li>
                  <strong>{t("hc_routesAppStudentTakeExamId.copyPasteCutRightClick")}</strong>{" "}
                  {t("hc_routesAppStudentTakeExamId.copyPasteCutDisabledRest")}
                </li>
                <li>{t("hc_routesAppStudentTakeExamId.answersAutoSaved")}</li>
              </ul>
            </div>
            <Button size="lg" className="w-full" onClick={startExam}>
              <Maximize2 className="h-4 w-4 mr-2" />
              {t("exam.start")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const visible = [questions[currentIdx]].filter(Boolean);

  return (
    <div
      className={`${maximized ? "max-w-none" : "max-w-3xl"} mx-auto py-4 sm:py-6 select-none`}
    >
      {fsExited && started && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-lg border bg-card p-6 space-y-4 text-center">
            <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
            <h2 className="text-lg font-semibold">
              {t("hc_routesAppStudentTakeExamId.youLeftFullscreen")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("hc_routesAppStudentTakeExamId.fullscreenRequiredWarning", { maxWarnings })}
            </p>
            <Button className="w-full" onClick={reenterFullscreen}>
              {t("hc_routesAppStudentTakeExamId.returnToFullscreen")}
            </Button>
          </div>
        </div>
      )}
      {isPaused && started && !fsExited && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-lg border bg-card p-6 space-y-4 text-center">
            <Pause className="h-10 w-10 text-primary mx-auto animate-pulse" />
            <h2 className="text-lg font-semibold">
              {t("hc_routesAppStudentTakeExamId.examPausedByTeacher")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("hc_routesAppStudentTakeExamId.examPausedDesc")}
            </p>
          </div>
        </div>
      )}
      {/* Sticky header with timer — full-bleed on mobile via negative margins matching AppLayout's px-4 */}
      <div className="sticky top-14 md:top-0 z-20 bg-background/95 backdrop-blur border-b -mx-4 md:-mx-8 px-4 md:px-8 py-3 mb-4 sm:mb-5 flex items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate text-sm sm:text-base">{exam.title}</div>
          <div className="text-[11px] sm:text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span>
              {t("exam.question")} {currentIdx + 1} {t("exam.of")} {questions.length}
            </span>
            {attemptInfo && (
              <span className="text-primary font-medium">
                ·{" "}
                {t("hc_routesAppStudentTakeExamId.attemptLabel", {
                  current: attemptInfo.current,
                  total: attemptInfo.total,
                })}{" "}
                ·{" "}
                <span className="text-muted-foreground">
                  {t("hc_routesAppStudentTakeExamId.finalGradeLabel")}{" "}
                  {retryModeLabel((exam.retry_mode ?? "last") as RetryMode)}
                </span>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 sm:gap-2 shrink-0 flex-wrap justify-end">
          {offline && (
            <Badge
              variant="outline"
              className="text-[10px] sm:text-xs text-warning-foreground border-warning/40 bg-warning/10"
            >
              <WifiOff className="h-3 w-3 sm:mr-1" />
              <span className="hidden sm:inline">
                {t("hc_routesAppStudentTakeExamId.offline")}
              </span>
            </Badge>
          )}
          {isPaused && (
            <Badge
              variant="outline"
              className="text-[10px] sm:text-xs text-primary border-primary/40 bg-primary/10 animate-pulse"
            >
              <Pause className="h-3 w-3 sm:mr-1" />
              <span className="hidden sm:inline">
                {t("hc_routesAppStudentTakeExamId.paused")}
              </span>
            </Badge>
          )}
          <Badge
            variant={warnings > 0 ? "destructive" : "outline"}
            className="text-[10px] sm:text-xs"
          >
            <AlertTriangle className="h-3 w-3 mr-0.5 sm:mr-1" />
            {warnings}/{maxWarnings}
          </Badge>
          <Badge
            className={`text-[10px] sm:text-xs ${isLowTime ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}
          >
            <Clock className="h-3 w-3 mr-0.5 sm:mr-1" />
            {formattedTime}
          </Badge>
          {/* Tamaño completo: ensancha el área de resolución. Útil para
              preguntas de código/diagrama donde el max-w-3xl queda chico. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={toggleMaximized}
            title={
              maximized
                ? t("hc_routesAppStudentTakeExamId.restoreSize")
                : t("hc_routesAppStudentTakeExamId.fullSize")
            }
            aria-label={
              maximized
                ? t("hc_routesAppStudentTakeExamId.restoreSize")
                : t("hc_routesAppStudentTakeExamId.fullSize")
            }
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Approved support notes — visible across all questions */}
      {approvedNote && (
        <Card className="mb-4 border-primary/40 bg-primary/5">
          <CardContent className="p-3 space-y-2">
            <button
              type="button"
              onClick={() => setNotesOpen((v) => !v)}
              className="w-full flex items-center justify-between gap-2 text-left"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
                <FileText className="h-3.5 w-3.5" />
                {t("hc_routesAppStudentTakeExamId.yourApprovedNotes")}
              </div>
              {notesOpen ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            {notesOpen && (
              <pre className="whitespace-pre-wrap text-xs bg-background/60 rounded p-2 max-h-48 overflow-y-auto">
                {approvedNote}
              </pre>
            )}
          </CardContent>
        </Card>
      )}

      {/* Questions */}
      <div className="space-y-4">
        {visible.map((q, i) => {
          const idx = exam.navigation_type === "secuencial" ? currentIdx : i;
          const lang = (q.language ?? "java") as CodeLanguage;
          return (
            <Card key={q.id}>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">
                    #{idx + 1}
                  </Badge>
                  <Badge variant="secondary" className="text-[10px]">
                    {q.type}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t("hc_routesAppStudentTakeExamId.pointsAbbr", { points: q.points })}
                  </span>
                </div>
                <MarkdownInline>{q.content}</MarkdownInline>

                {q.type === "cerrada" && q.options?.choices ? (
                  <div className="space-y-1.5">
                    {q.options.choices.map((c: string, ci: number) => (
                      <label
                        key={ci}
                        className="flex items-start gap-2 p-2 rounded border hover:bg-muted/50 cursor-pointer"
                      >
                        <input
                          type="radio"
                          name={`q-${q.id}`}
                          checked={answers[q.id] === ci}
                          onChange={() => {
                            updateAnswer(q.id, ci);
                            saveAnswersNow();
                          }}
                          className="mt-1"
                        />
                        <span className="text-sm">
                          {String.fromCharCode(65 + ci)}. {c}
                        </span>
                      </label>
                    ))}
                  </div>
                ) : q.type === "cerrada_multi" && q.options?.choices ? (
                  <div className="space-y-1.5">
                    {(() => {
                      const sel = Array.isArray(answers[q.id]) ? (answers[q.id] as number[]) : [];
                      const minS = q.options?.min_selections;
                      const maxS = q.options?.max_selections;
                      const hint =
                        typeof minS === "number" && typeof maxS === "number"
                          ? t("hc_routesAppStudentTakeExamId.markBetween", {
                              min: minS,
                              max: maxS,
                            })
                          : typeof minS === "number"
                            ? t("hc_routesAppStudentTakeExamId.markAtLeast", { min: minS })
                            : typeof maxS === "number"
                              ? t("hc_routesAppStudentTakeExamId.markAtMost", { max: maxS })
                              : t("hc_routesAppStudentTakeExamId.markAllCorrect");
                      return (
                        <>
                          <p className="text-xs text-muted-foreground">{hint}</p>
                          {q.options.choices.map((c: string, ci: number) => {
                            const checked = sel.includes(ci);
                            return (
                              <label
                                key={ci}
                                className="flex items-start gap-2 p-2 rounded border hover:bg-muted/50 cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    const next = e.target.checked
                                      ? Array.from(new Set([...sel, ci])).sort((a, b) => a - b)
                                      : sel.filter((x) => x !== ci);
                                    updateAnswer(q.id, next);
                                    saveAnswersNow();
                                  }}
                                  className="mt-1"
                                />
                                <span className="text-sm">
                                  {String.fromCharCode(65 + ci)}. {c}
                                </span>
                              </label>
                            );
                          })}
                          {typeof maxS === "number" && sel.length > maxS && (
                            <p className="text-xs text-destructive">
                              {t("hc_routesAppStudentTakeExamId.tooManyOptions", { max: maxS })}
                            </p>
                          )}
                        </>
                      );
                    })()}
                  </div>
                ) : q.type === "codigo" ? (
                  <div onBlur={saveAnswersNow} className="space-y-2">
                    <div className="flex flex-wrap items-center justify-end">
                      <CodeRunnerPicker
                        language={lang}
                        defaultProvider={defaultCodeProvider}
                        value={runnerOverride[q.id] as CodeRunnerProvider | undefined}
                        disabled={runningCode[q.id] ?? false}
                        onChange={(next) =>
                          setRunnerOverride((prev) => {
                            const copy = { ...prev };
                            if (next === undefined) delete copy[q.id];
                            else copy[q.id] = next;
                            return copy;
                          })
                        }
                      />
                    </div>
                    <CodeEditor
                      value={answers[q.id] ?? q.starter_code ?? getStarterCode(lang)}
                      onChange={(v) => updateAnswer(q.id, v)}
                      language={lang}
                      onRun={() => runCode(q.id, lang)}
                      onCancel={() => cancelRun(q.id)}
                      output={codeOutputs[q.id]}
                      isRunning={runningCode[q.id] ?? false}
                      showLanguageSelector={false}
                      showRunButton={true}
                      height="250px"
                    />
                  </div>
                ) : q.type === "diagrama" ? (
                  <div onBlur={saveAnswersNow}>
                    <DiagramEditor
                      value={answers[q.id] ?? ""}
                      onChange={(code) => updateAnswer(q.id, code)}
                    />
                  </div>
                ) : q.type === "java_gui" ? (
                  <div onBlur={saveAnswersNow}>
                    {(() => {
                      // El default depende del framework — JAVAFX_STARTER
                      // si la pregunta es JavaFX. Sin esto el alumno veía
                      // un JFrame template para una pregunta FX cuando el
                      // docente no había custom-editado el starter.
                      const fw =
                        (q.options as { java_framework?: "swing" | "javafx" } | null)
                          ?.java_framework ?? "swing";
                      const defaultStarter = fw === "javafx" ? JAVAFX_STARTER : JAVA_GUI_STARTER;
                      return (
                        <JavaGuiRunner
                          value={answers[q.id] ?? q.starter_code ?? defaultStarter}
                          onChange={(v) => updateAnswer(q.id, v)}
                          height="280px"
                          framework={fw}
                        />
                      );
                    })()}
                  </div>
                ) : q.type === "python_gui" ? (
                  <div onBlur={saveAnswersNow}>
                    <PythonGuiRunner
                      value={answers[q.id] ?? q.starter_code ?? PYTHON_GUI_STARTER}
                      onChange={(v) => updateAnswer(q.id, v)}
                      height="280px"
                    />
                  </div>
                ) : (
                  (() => {
                    const current = String(answers[q.id] ?? "");
                    const len = current.length;
                    // Umbral ámbar a 90% para que el alumno sepa que se
                    // acerca al tope antes de chocarse con el maxLength
                    // (el browser ignora el input pero sin feedback el
                    // alumno cree que el teclado falló).
                    const warn = len >= Math.floor(maxOpenChars * 0.9);
                    const atMax = len >= maxOpenChars;
                    return (
                      <div className="space-y-1">
                        <Textarea
                          rows={4}
                          placeholder={t("hc_routesAppStudentTakeExamId.yourAnswerPlaceholder")}
                          value={current}
                          maxLength={maxOpenChars}
                          onChange={(e) => updateAnswer(q.id, e.target.value)}
                          onBlur={saveAnswersNow}
                        />
                        <div
                          className={`text-[11px] text-right tabular-nums ${
                            atMax
                              ? "text-destructive"
                              : warn
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-muted-foreground"
                          }`}
                        >
                          {len.toLocaleString("es-CO")} / {maxOpenChars.toLocaleString("es-CO")}
                          {atMax ? t("hc_routesAppStudentTakeExamId.limitReachedSuffix") : ""}
                        </div>
                      </div>
                    );
                  })()
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Navigation sticky bottom.
       *
       * En mobile, al abrir el teclado virtual para responder una
       * pregunta abierta, el iOS/Android browser sube los inputs en
       * foco pero el botón "Siguiente" / "Finalizar" quedaba al final
       * del flow, debajo del teclado. El alumno tenía que cerrar el
       * teclado para ver los botones.
       *
       * Sticky bottom-0 se pega al viewport bottom cuando hay scroll y
       * queda en su posición natural cuando no. Como en examen el
       * bottom-nav del AppLayout NO se renderiza, no hay choque z-index.
       *
       * `-mx-4 px-4 sm:-mx-6 sm:px-6` extiende el bg-background +
       * border-t edge-to-edge en mobile/tablet (compensa el px del
       * AppLayout main); en desktop el max-w-3xl ya constriñe el
       * contenido al mismo ancho que el sticky.
       */}
      <div className="sticky bottom-0 z-20 bg-background border-t mt-6 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] -mx-4 px-4 sm:-mx-6 sm:px-6 flex items-center justify-between gap-2">
        <Button
          variant="outline"
          // En navegación secuencial el alumno NO puede volver atrás
          // una vez que avanza, así que deshabilitamos "Anterior"
          // siempre. En libre solo cuando está en la primera pregunta.
          disabled={exam.navigation_type === "secuencial" || currentIdx === 0}
          onClick={() => {
            setCurrentIdx((i) => i - 1);
            // Push inmediato del nuevo índice al monitor — el autosave
            // de 1.5s también lo haría pero perdemos el "instante" de
            // navegación si el docente está mirando justo ahí.
            void saveAnswersNow();
          }}
        >
          {t("exam.previous")}
        </Button>
        {currentIdx < questions.length - 1 ? (
          <Button
            onClick={() => {
              if (exam.navigation_type === "secuencial") {
                setConfirmNextOpen(true);
              } else {
                setCurrentIdx((i) => i + 1);
                void saveAnswersNow();
              }
            }}
          >
            {t("exam.next")}
          </Button>
        ) : (
          <Button onClick={() => void requestManualSubmit()} disabled={submitting}>
            {submitting ? (
              <Spinner size="md" className="mr-1" />
            ) : (
              <Send className="h-4 w-4 mr-1" />
            )}
            {t("exam.finish")}
          </Button>
        )}
      </div>

      <Dialog open={confirmNextOpen} onOpenChange={setConfirmNextOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
              {t("hc_routesAppStudentTakeExamId.confirmNextTitle")}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-2">
                <p>
                  {t("hc_routesAppStudentTakeExamId.confirmNextDescPre")}{" "}
                  <strong>{t("hc_routesAppStudentTakeExamId.sequentialNavigation")}</strong>
                  {t("hc_routesAppStudentTakeExamId.confirmNextDescPost")}
                </p>
                <p>{t("hc_routesAppStudentTakeExamId.confirmNextDescReminder")}</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setConfirmNextOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirmNextOpen(false);
                setCurrentIdx((i) => i + 1);
                void saveAnswersNow();
              }}
            >
              {t("hc_routesAppStudentTakeExamId.yesAdvance")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={manualLeaveOpen} onOpenChange={(open) => !open && setManualLeaveOpen(false)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
              {t("hc_routesAppStudentTakeExamId.leaveExamTitle")}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-sm text-muted-foreground">
                {t("hc_routesAppStudentTakeExamId.leaveExamDescPre")}{" "}
                <strong>{t("hc_routesAppStudentTakeExamId.strikeWord")}</strong>
                {t("hc_routesAppStudentTakeExamId.leaveExamDescPost", { maxWarnings })}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setManualLeaveOpen(false)}>
              {t("hc_routesAppStudentTakeExamId.stayInExam")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={async () => {
                if (!submittedRef.current && submissionIdRef.current) {
                  const nw = warningsRef.current + 1;
                  warningsRef.current = nw;
                  warningEventsRef.current = [
                    ...warningEventsRef.current,
                    { type: "retroceso", at: new Date().toISOString(), questionIdx: currentIdx },
                  ];
                  const updatedAnswers = {
                    ...answersRef.current,
                    __warning_events: warningEventsRef.current,
                  };
                  answersRef.current = updatedAnswers;
                  setWarnings(nw);
                  setAnswers(updatedAnswers);
                  toast.warning(
                    i18n.t("toast.routes_app_student_take_examId.warningExamExit", {
                      defaultValue: "Advertencia {{count}}/{{max}}: Salida de examen",
                      count: nw,
                      max: maxWarnings,
                    }),
                  );
                  try {
                    await saveAnswersNow();
                  } catch (e) {
                    console.error("[ExamLab] leave strike save failed:", e);
                  }
                  if (shouldMarkSuspicious(nw, maxWarnings)) {
                    toast.error(
                      i18n.t("toast.routes_app_student_take_examId.exitLimitExceeded", {
                        defaultValue: "Has superado el límite de salidas. El examen se suspende.",
                      }),
                    );
                    await performSubmit(true);
                    return;
                  }
                }
                setManualLeaveOpen(false);
                navigate({ to: "/app/student/exams" });
              }}
            >
              {t("hc_routesAppStudentTakeExamId.leaveRegisterStrike")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={submitModal.open} onOpenChange={(open) => !open && cancelManualSubmitModal()}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
              {t("hc_routesAppStudentTakeExamId.unansweredQuestionsRemain")}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-left text-sm text-muted-foreground">
                <p>{t("hc_routesAppStudentTakeExamId.unansweredQuestionsDesc")}</p>
                {submitModal.unansweredIndices.length > 0 && (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                    <p className="text-xs font-medium text-foreground mb-1.5">
                      {t("hc_routesAppStudentTakeExamId.unansweredCountLabel", {
                        count: submitModal.unansweredIndices.length,
                      })}{" "}
                      {submitModal.unansweredIndices.length === 1
                        ? t("hc_routesAppStudentTakeExamId.questionSingular")
                        : t("hc_routesAppStudentTakeExamId.questionPlural")}
                    </p>
                    <ul className="max-h-32 overflow-y-auto text-xs space-y-0.5 list-disc list-inside">
                      {submitModal.unansweredIndices.slice(0, 25).map((idx) => (
                        <li key={idx}>
                          {t("hc_routesAppStudentTakeExamId.questionN", { n: idx + 1 })}
                          {questions[idx]?.type ? (
                            <span className="text-muted-foreground"> ({questions[idx].type})</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {submitModal.unansweredIndices.length > 25 && (
                      <p className="text-[10px] mt-1 text-muted-foreground">
                        {t("hc_routesAppStudentTakeExamId.andNMore", {
                          n: submitModal.unansweredIndices.length - 25,
                        })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={cancelManualSubmitModal}>
              {t("hc_routesAppStudentTakeExamId.keepEditing")}
            </Button>
            <Button
              type="button"
              onClick={() => void confirmSubmitFromModal()}
              disabled={submitting}
            >
              {submitting ? (
                <Spinner size="md" className="mr-1" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              {t("hc_routesAppStudentTakeExamId.submitAnyway")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
