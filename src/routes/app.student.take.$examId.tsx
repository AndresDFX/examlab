import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useRealtimeTimer } from "@/hooks/use-realtime-timer";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
  Send,
  Pause,
  WifiOff,
  FileText,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { CodeEditor, type CodeLanguage, JAVA_STARTER } from "@/components/CodeEditor";
import { DiagramEditor } from "@/components/DiagramEditor";
import { JavaGuiRunner, JAVA_GUI_STARTER } from "@/components/JavaGuiRunner";
import {
  saveAnswersLocally,
  isOnline,
  setupOfflineSync,
  clearLocalAnswers,
} from "@/lib/offline-sync";
import { useTranslation } from "react-i18next";
import { computeSecondsLeft, computeSecondsLeftRelative, isExamOpen } from "@/utils/exam-time";
import { MAX_WARNINGS, shouldMarkSuspicious, warningLabel } from "@/utils/proctoring";
import { useCourseLanguage } from "@/hooks/use-course-language";
import { useApprovedExamNote } from "@/components/ExamNotesManager";
import { logEvent } from "@/lib/audit";
import { MarkdownInline } from "@/components/MarkdownInline";
import { computeExtraSeconds, applyExtraTime, restoreQuestionIndex } from "@/utils/exam-session";
import { runJavaInBrowser } from "@/lib/run-java";
import { extractEdgeError } from "@/lib/edge-error";
import { retryModeLabel, type RetryMode } from "@/utils/exam-attempts";

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
  if (q.type === "codigo" || q.type === "java_gui") {
    // Si no hay starter_code en la BD pero la pregunta es Java codigo,
    // el editor muestra JAVA_STARTER por defecto — eso cuenta como
    // tener contenido visible (se persistirá en mergeStarterCodeAnswers).
    const starter =
      (q.starter_code ?? "").trim() ||
      (q.type === "codigo" && q.language === "java" ? JAVA_STARTER : "");
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
    if (q.type !== "codigo" && q.type !== "java_gui") continue;
    const cur = next[q.id];
    const empty = cur === undefined || cur === null || String(cur).trim() === "";
    if (!empty) continue;
    // Fallback al starter_code de la pregunta. Si no hay y la pregunta
    // es Java codigo, usa JAVA_STARTER (mismo template que ve el alumno
    // por defecto en el editor) para que la entrega no llegue vacía.
    const fallback = (q.starter_code ?? "").trim()
      ? q.starter_code
      : q.type === "codigo" && q.language === "java"
        ? JAVA_STARTER
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
  // Proveedor de ejecución de código activo (leído de code_execution_settings una vez al montar).
  const codeExecProviderRef = useRef<string>("onlinecompiler");

  // Carga el proveedor de ejecución de código una vez al montar (fire-and-forget).
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabase as any)
      .from("code_execution_settings")
      .select("provider")
      .eq("is_active", true)
      .maybeSingle()
      .then(({ data }: { data: { provider: string } | null }) => {
        if (data?.provider) codeExecProviderRef.current = data.provider;
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
          toast.warning("Sin conexión. Reintentando… tus respuestas guardadas siguen seguras.");
          setTimeout(() => window.location.reload(), 2000);
          return;
        }
        toast.error("Examen no encontrado");
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
        toast.error("Este examen no está disponible ahora");
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
        toast.error("No estás asignado a este examen");
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
      const finishedCount = allSubs.filter(
        (s: any) => s.status === "completado" || s.status === "sospechoso",
      ).length;
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

      if (inProgress) {
        // Session lock via answers.__session_id + updated_at (no extra columns needed).
        // The autosave keeps updated_at fresh every 1.5s while a device is active.
        // If another device owns the session and updated_at is <10s old → block.
        const existingAnswers = (inProgress.answers as Record<string, any>) ?? {};
        const storedSession = existingAnswers.__session_id as string | undefined;
        const updatedAt = new Date((inProgress as any).updated_at).getTime();
        const ageMs = Date.now() - updatedAt;

        if (storedSession && storedSession !== localSessionId && ageMs < 10_000) {
          setExam(e);
          setBlockedBySession(true);
          return;
        }

        // Claim the session: inject our session ID into answers (persisted by next autosave)
        const claimedAnswers = { ...existingAnswers, __session_id: localSessionId };
        answersRef.current = claimedAnswers;

        // Reanudar el intento en curso
        setSubmissionId(inProgress.id);
        submissionIdRef.current = inProgress.id;
        setSubmissionStartedAt((inProgress as any).started_at ?? null);
        setAnswers(claimedAnswers);
        const persistedWarnings = inProgress.focus_warnings ?? 0;
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
            ? "Ya completaste este examen"
            : `Ya usaste tus ${maxAttempts} intentos para este examen`,
        );
        navigate({ to: "/app/student/exams" });
        return;
      }

      // Quedan intentos disponibles → mostrar pantalla de inicio
      if (finishedCount > 0) {
        toast.info(
          `Intento ${finishedCount + 1} de ${maxAttempts}. Tu calificación anterior se reemplazará por la de este intento.`,
        );
      }
      setExam(e);
    })();
  }, [examId, user, navigate]);

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
          toast.error(error.message);
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
    try {
      await document.documentElement.requestFullscreen?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(
        "Este examen requiere pantalla completa. Habilítala en tu navegador o usa otro navegador, luego vuelve a presionar Iniciar.",
      );
      void logEvent({
        action: "exam_fullscreen_denied",
        category: "exam",
        severity: "warning",
        entityType: "submission",
        entityId: sid,
        entityName: exam.title,
        metadata: { examId, stage: "start", error: msg },
      });
      return;
    }
    // Verifica que realmente entró (algunos navegadores resuelven la promise sin activar fullscreen)
    if (!document.fullscreenElement) {
      toast.error(
        "No se pudo activar pantalla completa. Verifica tu navegador y vuelve a presionar Iniciar.",
      );
      void logEvent({
        action: "exam_fullscreen_denied",
        category: "exam",
        severity: "warning",
        entityType: "submission",
        entityId: sid,
        entityName: exam.title,
        metadata: { examId, stage: "start", reason: "no_fullscreen_element" },
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
          "No se pudo registrar la entrega en el servidor. Tus respuestas están guardadas localmente; revisa la conexión y vuelve a intentar entregar.",
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
            const studentName = profile?.full_name ?? "Un estudiante";
            // Notificación resumida: un docente con muchos exámenes
            // necesita el qué/quién, no el detalle. El detalle vive en
            // el monitor (la card "Eventos de advertencia" lo muestra).
            const body = `${studentName} superó el límite de ${maxWarnings} advertencias en el examen "${exam.title}" y fue suspendido. Revisa el detalle en el monitor.`;

            const { error: rpcErr } = await supabase.rpc("notify_exam_teachers", {
              _exam_id: examId,
              _title: "Examen sospechoso",
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
      // Disparamos el grading IA sin esperar — corre en background en el
      // edge function. El docente verá la calificación cuando el modelo
      // termine; el alumno no tiene que mirar un spinner mientras tanto.
      void supabase.functions
        .invoke("ai-grade-submission", { body: { submissionId: submissionIdRef.current } })
        .catch((e) => console.error("ai-grade-submission failed:", e));
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
      toast.success(markSuspicious ? "Examen suspendido" : "Examen entregado correctamente");
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

  const { secondsLeft, isPaused, formattedTime, isLowTime, syncToSeconds } = useRealtimeTimer({
    examId,
    userId: user?.id ?? "",
    initialSeconds,
    onTimeUp: handleTimeUp,
    onPause: () => toast.info("⏸ El docente ha pausado el temporizador"),
    onResume: () => toast.info("▶ El temporizador ha sido reanudado"),
    onTimeAdded: (secs) => toast.success(`+${Math.floor(secs / 60)} minuto(s) extra añadidos`),
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
          const newLimit = (updated.time_limit_minutes as number | undefined) ?? e.time_limit_minutes;
          const newScheduleType = (updated.schedule_type as string | undefined) ?? e.schedule_type;
          const newSeconds =
            newScheduleType === "relativo"
              ? computeSecondsLeftRelative(
                  submissionStartedAtRef.current,
                  newLimit,
                  newEndTime,
                )
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
          toast.info("El docente actualizó el tiempo del examen");
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
        questionIdx: exam?.navigation_type === "secuencial" ? currentIdx : null,
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
        toast.error("Has superado el límite de salidas. El examen se suspende.");
        performSubmit(true);
      } else {
        toast.warning(`Advertencia ${nw}/${maxWarnings}: ${warningLabel(type)}`);
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

      toast.warning("No está permitido tomar pantallazos durante el examen.");

      const event = {
        type: "screenshot_attempt",
        at: new Date(now).toISOString(),
        questionIdx: exam?.navigation_type === "secuencial" ? currentIdx : null,
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
      // pueda mostrar la acción exacta. Las claves españolas ya existen
      // en src/utils/proctoring.ts (copiar/pegar/cortar).
      const key = e.type === "paste" ? "pegar" : e.type === "cut" ? "cortar" : "copiar";
      recordWarning(key);
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, performSubmit, maxWarnings, requireFullscreen]);

  const runCode = async (questionId: string, language: CodeLanguage) => {
    const code = typeof answers[questionId] === "string" ? (answers[questionId] as string) : "";
    if (!code.trim()) {
      toast.error("Escribe código antes de ejecutar");
      return;
    }
    setRunningCode((prev) => ({ ...prev, [questionId]: true }));
    // Limpia el output ANTES de ejecutar para que el alumno no vea el
    // resultado del run anterior mientras espera el nuevo. Aplica a
    // todos los providers (CheerpJ, Lambda, OnlineCompiler).
    setCodeOutputs((prev) => ({ ...prev, [questionId]: "" }));
    try {
      let stdout = "";
      let stderr = "";

      if (codeExecProviderRef.current === "cheerp" && language === "java") {
        // CheerpJ: ejecuta Java directamente en el navegador (sin API externa ni cuota).
        const result = await runJavaInBrowser(code);
        stdout = result.stdout;
        stderr = result.stderr;
      } else {
        const { data, error } = await supabase.functions.invoke("execute-code", {
          body: {
            sourceCode: code,
            language,
            questionId,
            submissionId: submissionIdRef.current,
          },
        });
        if (error) {
          // Extraemos el mensaje REAL del response body (que tiene
          // `{ error: "detalle..." }`), no el genérico
          // "Edge Function returned a non-2xx status code".
          const real = await extractEdgeError(error, data);
          throw new Error(real || "Error ejecutando código");
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
        stderr =
          "El compilador remoto no devolvió detalle del error. Suele indicar un error " +
          "de compilación (falta `;`, llaves desbalanceadas, import erróneo, nombre " +
          "de clase incorrecto). Revisa tu código línea por línea y vuelve a intentar.";
      }

      // Combinar stdout + stderr en el orden natural de terminal.
      // stderr contiene el traceback completo con números de línea — se muestra tal cual.
      const parts: string[] = [];
      if (stdout.trimEnd()) parts.push(stdout.trimEnd());
      if (stderr.trimEnd()) parts.push(stderr.trimEnd());
      const output = parts.join("\n") || "(sin salida)";
      setCodeOutputs((prev) => ({ ...prev, [questionId]: output }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Error ejecutando";
      setCodeOutputs((prev) => ({ ...prev, [questionId]: `Error: ${msg}` }));
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
          provider: codeExecProviderRef.current,
          error: msg,
        },
      });
    } finally {
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
            <h2 className="text-xl font-semibold">Examen abierto en otro dispositivo</h2>
            <p className="text-sm text-muted-foreground">
              Este examen ya está siendo presentado desde otro dispositivo o pestaña. Cierra esa
              sesión primero. Si ya la cerraste, espera unos segundos y vuelve a intentar.
            </p>
            <Button variant="outline" onClick={() => navigate({ to: "/app/student/exams" })}>
              Volver a mis exámenes
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
                Antes de comenzar
              </p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                <li>
                  Duración: <strong>{exam.time_limit_minutes} minutos</strong>.{" "}
                  {exam.schedule_type === "relativo"
                    ? "El cronómetro empieza cuando inicies el examen y solo se pausa al cerrar la ventana de disponibilidad."
                    : "El tiempo no se pausa."}
                </li>
                <li>
                  Cada una de estas acciones cuenta como una advertencia, y al llegar a{" "}
                  <strong>{maxWarnings}</strong> el intento se marca como{" "}
                  <strong>sospechoso</strong> y se entrega automáticamente:
                  <ul className="list-disc list-inside ml-5 mt-1 space-y-0.5">
                    <li>Cambiar a otra pestaña o ventana.</li>
                    <li>Ocultar la pestaña (minimizar el navegador).</li>
                    {requireFullscreen && <li>Salir del modo pantalla completa.</li>}
                  </ul>
                </li>
                <li>
                  <strong>Copiar, pegar, cortar y el clic derecho</strong> están deshabilitados. No
                  generan advertencia: simplemente no funcionan.
                </li>
                <li>Las respuestas se guardan automáticamente (incluso sin conexión).</li>
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
    <div className="max-w-3xl mx-auto py-4 sm:py-6 select-none">
      {fsExited && started && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-lg border bg-card p-6 space-y-4 text-center">
            <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
            <h2 className="text-lg font-semibold">Saliste de pantalla completa</h2>
            <p className="text-sm text-muted-foreground">
              Este examen requiere modo pantalla completa. Se registró una advertencia. Vuelve para
              continuar; si superas {maxWarnings} advertencias el examen será marcado como
              sospechoso.
            </p>
            <Button className="w-full" onClick={reenterFullscreen}>
              Volver a pantalla completa
            </Button>
          </div>
        </div>
      )}
      {isPaused && started && !fsExited && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur flex items-center justify-center p-6">
          <div className="max-w-md w-full rounded-lg border bg-card p-6 space-y-4 text-center">
            <Pause className="h-10 w-10 text-primary mx-auto animate-pulse" />
            <h2 className="text-lg font-semibold">Examen pausado por el docente</h2>
            <p className="text-sm text-muted-foreground">
              El tiempo está detenido. Espera a que el docente reanude el examen para continuar
              respondiendo. Tus respuestas están guardadas.
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
                · Intento {attemptInfo.current}/{attemptInfo.total} ·{" "}
                <span className="text-muted-foreground">
                  Nota final: {retryModeLabel((exam.retry_mode ?? "last") as RetryMode)}
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
              <span className="hidden sm:inline">Sin conexión</span>
            </Badge>
          )}
          {isPaused && (
            <Badge
              variant="outline"
              className="text-[10px] sm:text-xs text-primary border-primary/40 bg-primary/10 animate-pulse"
            >
              <Pause className="h-3 w-3 sm:mr-1" />
              <span className="hidden sm:inline">Pausado</span>
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
                Tus notas de apoyo (aprobadas)
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
                  <span className="text-xs text-muted-foreground">{q.points} pt</span>
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
                      const sel = Array.isArray(answers[q.id])
                        ? (answers[q.id] as number[])
                        : [];
                      const minS = q.options?.min_selections;
                      const maxS = q.options?.max_selections;
                      const hint =
                        typeof minS === "number" && typeof maxS === "number"
                          ? `Marca entre ${minS} y ${maxS} opciones`
                          : typeof minS === "number"
                            ? `Marca al menos ${minS}`
                            : typeof maxS === "number"
                              ? `Marca máximo ${maxS}`
                              : "Marca todas las que consideres correctas";
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
                                      ? Array.from(new Set([...sel, ci])).sort(
                                          (a, b) => a - b,
                                        )
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
                              Has marcado más opciones de las permitidas ({maxS}).
                            </p>
                          )}
                        </>
                      );
                    })()}
                  </div>
                ) : q.type === "codigo" ? (
                  <div onBlur={saveAnswersNow}>
                    <CodeEditor
                      value={
                        answers[q.id] ?? q.starter_code ?? (lang === "java" ? JAVA_STARTER : "")
                      }
                      onChange={(v) => updateAnswer(q.id, v)}
                      language={lang}
                      onRun={() => runCode(q.id, lang)}
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
                    <JavaGuiRunner
                      value={answers[q.id] ?? q.starter_code ?? JAVA_GUI_STARTER}
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
                          placeholder="Tu respuesta…"
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
                          {atMax ? " — límite alcanzado" : ""}
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

      {/* Navigation */}
      <div className="flex items-center justify-between gap-2 mt-6">
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
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
              ¿Pasar a la siguiente pregunta?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-sm text-muted-foreground space-y-2">
                <p>
                  Este examen tiene <strong>navegación secuencial</strong>: una vez que avances no
                  podrás regresar a esta pregunta.
                </p>
                <p>Asegúrate de haber respondido lo que querías antes de continuar.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setConfirmNextOpen(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirmNextOpen(false);
                setCurrentIdx((i) => i + 1);
                void saveAnswersNow();
              }}
            >
              Sí, avanzar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={manualLeaveOpen} onOpenChange={(open) => !open && setManualLeaveOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
              ¿Salir del examen?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-sm text-muted-foreground">
                Retroceder cuenta como una salida no permitida y registra un <strong>strike</strong>
                . Si acumulas {maxWarnings} strikes, el examen se marcará como sospechoso. ¿Deseas
                salir de todas formas?
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => setManualLeaveOpen(false)}>
              Seguir en el examen
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
                  toast.warning(`Advertencia ${nw}/${maxWarnings}: Salida de examen`);
                  try {
                    await saveAnswersNow();
                  } catch (e) {
                    console.error("[ExamLab] leave strike save failed:", e);
                  }
                  if (shouldMarkSuspicious(nw, maxWarnings)) {
                    toast.error("Has superado el límite de salidas. El examen se suspende.");
                    await performSubmit(true);
                    return;
                  }
                }
                setManualLeaveOpen(false);
                navigate({ to: "/app/student/exams" });
              }}
            >
              Salir (registrar strike)
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={submitModal.open} onOpenChange={(open) => !open && cancelManualSubmitModal()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
              Quedan preguntas sin responder
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-left text-sm text-muted-foreground">
                <p>
                  Aún no has respondido todas las preguntas. Puedes volver a revisarlas o entregar
                  el examen tal como está; las respuestas que ya guardaste se incluirán.
                </p>
                {submitModal.unansweredIndices.length > 0 && (
                  <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
                    <p className="text-xs font-medium text-foreground mb-1.5">
                      Sin responder: {submitModal.unansweredIndices.length}{" "}
                      {submitModal.unansweredIndices.length === 1 ? "pregunta" : "preguntas"}
                    </p>
                    <ul className="max-h-32 overflow-y-auto text-xs space-y-0.5 list-disc list-inside">
                      {submitModal.unansweredIndices.slice(0, 25).map((idx) => (
                        <li key={idx}>
                          Pregunta {idx + 1}
                          {questions[idx]?.type ? (
                            <span className="text-muted-foreground"> ({questions[idx].type})</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {submitModal.unansweredIndices.length > 25 && (
                      <p className="text-[10px] mt-1 text-muted-foreground">
                        y {submitModal.unansweredIndices.length - 25} más…
                      </p>
                    )}
                  </div>
                )}
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={cancelManualSubmitModal}>
              Seguir editando
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
              Entregar de todas formas
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
