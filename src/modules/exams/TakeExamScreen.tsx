/**
 * Pantalla de TOMA de examen del estudiante.
 *
 * ── Por qué vive acá y no dentro del archivo de ruta ──────────────────
 * Porque la usan DOS rutas: la del estudiante (`/app/student/take/$examId`) y
 * el simulacro del docente (`/app/teacher/exams/$examId/simulacro`).
 *
 * Y no alcanza con exportarla desde el archivo de ruta: el plugin de TanStack
 * separa en un chunk aparte el componente de una ruta SOLO si ese archivo no
 * exporta nada más. Al agregarle un segundo export, el archivo entero pasa a
 * importarse de forma ESTÁTICA desde `routeTree.gen.ts` — y con él
 * `run-java.ts`, que evalúa `window` al cargarse. Resultado medido: el
 * prerenderizado del cascarón revienta con `ReferenceError: window is not
 * defined` y la app entera devuelve 500, no solo esta pantalla. Con el
 * componente en un módulo propio, cada archivo de ruta vuelve a exportar solo
 * su `Route` y el chunk se separa como siempre.
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { clienteDeSimulacro } from "@/modules/exams/cliente-simulacro";
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
import {
  currentFullscreenElement,
  exitFullscreen,
  onFullscreenChange,
  requestFullscreen,
  requestFullscreenGate,
  currentProctoringGate,
} from "@/shared/lib/fullscreen";
import { toast } from "sonner";
import { getUnansweredIndices } from "@/modules/exams/answered";
import {
  AlertTriangle,
  Clock,
  FlaskConical,
  RotateCcw,
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
import { PageLoader } from "@/components/ui/loaders";
import { ErrorState } from "@/components/ui/empty-state";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { CodeEditor, type CodeLanguage, getStarterCode } from "@/modules/code/CodeEditor";
import { NetworkConsole } from "@/modules/network/NetworkConsole";
import { NetworkTopologyEditor } from "@/modules/network/NetworkTopologyEditor";
import { SqlRunner } from "@/modules/database/SqlRunner";
import { type NetworkScenario, parseScenario } from "@/modules/network/scenario";
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
import { OpenAnswerTextarea } from "@/components/ui/open-answer-textarea";
import { DEFAULT_MAX_OPEN_ANSWER_CHARS } from "@/hooks/use-max-open-answer-chars";
import {
  computeSecondsLeft,
  computeSecondsLeftRelative,
  isExamOpen,
} from "@/modules/exams/exam-time";
import {
  MAX_WARNINGS,
  blurCuentaComoStrike,
  salidaDePantallaCompletaCuentaComoStrike,
  ocultarCuentaComoStrike,
  GRACIA_OCULTO_MOVIL_MS,
  creaVentanasDeProctoring,
  entornoDePuntero,
  shouldMarkSuspicious,
  warningLabel,
  permiteMenuContextual,
} from "@/modules/exams/proctoring";
import { seededShuffle, examShuffleSeed } from "@/modules/exams/shuffle";
import { useCourseLanguage } from "@/hooks/use-course-language";
import { useApprovedExamNote } from "@/modules/exams/ExamNotesManager";
import { logEvent } from "@/shared/lib/audit";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import {
  computeExtraSeconds,
  applyExtraTime,
  restoreQuestionIndex,
  latidoEsRedundante,
  MS_BLOQUEO_SESION,
  MS_ENTRE_LATIDOS,
} from "@/modules/exams/exam-session";
import { runJavaInBrowser, CANCELLED_SENTINEL } from "@/modules/code/run-java";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { necesitaRefresco } from "@/modules/exams/sesion-fresca";
import {
  efectoDeRestablecer,
  hayAlgoQueRestablecer,
  respuestaRestablecida,
} from "@/modules/exams/restablecer-respuesta";
import {
  clasificarFalloDeEjecucion,
  esReintentable,
  esperaAntesDeReintentar,
} from "@/modules/code/fallo-de-ejecucion";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { retryModeLabel, type RetryMode } from "@/modules/exams/exam-attempts";
import { aiGradeOrEnqueue } from "@/modules/ai/ai-grading";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

/** Mapa tipo-de-pregunta → clave i18n de su etiqueta legible. Espeja el
 *  `TYPE_LABEL_KEY` del banco de preguntas — el alumno NO debe ver el código
 *  interno crudo (`cerrada`, `codigo`, `java_gui`…) en la pantalla de toma.
 *  Fallback al valor crudo si aparece un tipo fuera del mapa (defensivo). */
const QUESTION_TYPE_LABEL_KEY: Record<string, string> = {
  cerrada: "questionBank.type.cerrada",
  cerrada_multi: "questionBank.type.cerradaMulti",
  codigo: "questionBank.type.codigo",
  codigo_zip: "questionBank.type.codigoZip",
  abierta: "questionBank.type.abierta",
  diagrama: "questionBank.type.diagrama",
  java_gui: "questionBank.type.javaGui",
  python_gui: "questionBank.type.pythonGui",
  red_consola: "questionBank.type.redConsola",
  red_gui: "questionBank.type.redGui",
  bd_sql: "bdSql.typeLabel",
};

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

// El predicado vive en `@/modules/exams/answered` — antes estaba acá Y en
// `WorkshopQuestions.tsx`, con reglas OPUESTAS para una pregunta de código sin
// tocar (acá contaba como respondida; allá, como en blanco). El módulo unificado
// se queda con la regla del taller, así que ahora el examen SÍ avisa cuando el
// alumno entrega con el editor intacto.


// ── Por qué la plantilla ya NO se guarda como respuesta ───────────────
// Acá vivía `mergeStarterCodeAnswers`, que rellenaba toda pregunta de código
// vacía con la plantilla del editor «para que se detecte como respondida». Esa
// regla dejó de existir cuando el predicado se unificó en `@/modules/exams/
// answered`: desde entonces la plantilla intacta es lo contrario de una
// respuesta, así que el relleno no lograba nada y sí hacía daño.
//
//  · Corría al ABRIR el diálogo de entrega, no al entregar. El alumno que lo
//    abría y cancelaba quedaba con la plantilla persistida por el autoguardado
//    sin haber escrito una letra — en producción le pasó a tres alumnos de un
//    mismo parcial que ni siquiera entregaron.
//  · La plantilla llegaba a la IA como si fuera el código del alumno.
//
// Una pregunta sin tocar ahora llega SIN valor, que es lo que de verdad pasó.

export interface TakeExamProps {
  examId: string;
  /**
   * SIMULACRO: el docente prueba el examen como lo ve el estudiante y **nada
   * se guarda ni se califica**. No es un `if` repartido por la pantalla: lo
   * garantiza `clienteDeSimulacro`, que no sabe escribir — ver ese módulo.
   */
  simulacro?: boolean;
}

export function TakeExam({ examId, simulacro = false }: TakeExamProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  // TODA la pantalla habla con la base por acá. En simulacro es un cliente que
  // lee igual y no escribe: el punto de decisión es UNO, no los once sitios
  // donde esta pantalla escribe.
  const db = useMemo(() => (simulacro ? clienteDeSimulacro(supabase) : supabase), [simulacro]);
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
  // Tiempo extra concedido por el docente (segundos), acumulado de
  // exam_timer_controls. En exámenes RELATIVOS extiende la deadline personal
  // (started+límite), no solo end_time — ver computeSecondsLeftRelative.
  const [examExtraSeconds, setExamExtraSeconds] = useState(0);
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
  const [maxOpenChars, setMaxOpenChars] = useState(DEFAULT_MAX_OPEN_ANSWER_CHARS);
  const [warnings, setWarnings] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  // `preparingSubmit`: cubre la ventana entre el click en "Finalizar" y el
  // arranque real de performSubmit (guardado previo + cálculo de vacías).
  // Sin esto el botón quedaba habilitado durante ese await y un doble click
  // disparaba dos entregas.
  const [preparingSubmit, setPreparingSubmit] = useState(false);
  const submitBusyRef = useRef(false);
  const busySubmit = submitting || preparingSubmit;
  // Inicio del examen (crea/reclama la submission). Necesita su propio busy:
  // un doble click podía crear DOS submissions `en_progreso`.
  const [startingExam, setStartingExam] = useState(false);
  const startBusyRef = useRef(false);
  const [reenteringFs, setReenteringFs] = useState(false);
  const [leavingExam, setLeavingExam] = useState(false);
  // Falla del último autosave contra el servidor. Se muestra como badge en
  // el header para que el alumno NO crea que sus respuestas están a salvo
  // cuando el guardado está fallando (el respaldo local sigue activo).
  const [saveFailed, setSaveFailed] = useState(false);
  // Error de la carga inicial (examen/preguntas/intento). Sin esto la
  // pantalla se quedaba en <PageLoader/> para siempre.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
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
  // activa la primera vez que el modo de proctoring deja de ser "ventana"
  // —fullscreen real o app instalada— (sea por startExam o por click en el
  // overlay de Reanudar).
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
  // Cuándo escribió por última vez el autoguardado. Lo lee el latido para no
  // duplicar una escritura que ya se hizo.
  const ultimoGuardadoRef = useRef(0);
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

  // Carga el proveedor de ejecución de código una vez al montar.
  // Si falla, se conserva el default local ("onlinecompiler") — no es
  // bloqueante, pero NO lo dejamos silencioso en consola.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data } = await (db as any)
          .from("code_execution_settings")
          .select("provider")
          .eq("is_active", true)
          .maybeSingle();
        if (cancelled) return;
        const provider = (data as { provider?: string } | null)?.provider;
        if (provider) {
          codeExecProviderRef.current = provider;
          setDefaultCodeProvider(provider);
        }
      } catch (e) {
        if (cancelled) return;
        console.error("[ExamLab] code_execution_settings load failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
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
    db.auth.getSession().then(({ data }) => {
      authTokenRef.current = data.session?.access_token ?? null;
    });
    const {
      data: { subscription },
    } = db.auth.onAuthStateChange((_, session) => {
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
  const examExtraSecondsRef = useRef(0);
  useEffect(() => {
    examExtraSecondsRef.current = examExtraSeconds;
  }, [examExtraSeconds]);

  // Update state AND ref synchronously so blur/suspend handlers never read
  // stale answers between a keystroke and the next render commit.
  const confirm = useConfirm();
  /**
   * Renueva la sesión ANTES de que haga falta. La librería de auth solo
   * refresca con la pestaña en primer plano y dentro de los últimos 90 s de
   * vida del token; en un examen de dos horas con un token de una, un alumno
   * que estuvo fuera de la app justo en esa ventana vuelve con el token
   * vencido y pierde la ejecución de su código. Ver `sesion-fresca.ts`.
   */
  const asegurarSesionFresca = useCallback(async () => {
    if (simulacro) return;
    try {
      const { data } = await db.auth.getSession();
      if (necesitaRefresco(data.session?.expires_at, Date.now())) {
        await db.auth.refreshSession();
      }
    } catch {
      // Si falla, el reintento de `runCode` sigue siendo la red de seguridad.
    }
  }, [db, simulacro]);

  const updateAnswer = useCallback((questionId: string, value: any) => {
    const next = { ...answersRef.current, [questionId]: value };
    answersRef.current = next;
    setAnswers(next);
  }, []);

  /**
   * Devuelve una pregunta a como estaba al empezar.
   *
   * Confirma SIEMPRE y con tono destructivo: lo que el estudiante escribió no
   * se puede recuperar después, y el botón vive al lado del enunciado en una
   * pantalla contrarreloj. El texto dice qué va a pasar en ESTA pregunta,
   * porque no es lo mismo en todas: una de código vuelve a la plantilla del
   * docente —vaciarla lo dejaría sin el andamiaje que el enunciado le dio— y
   * el resto queda sin responder.
   */
  const restablecerPregunta = useCallback(
    async (q: Question) => {
      const efecto = efectoDeRestablecer(q);
      const ok = await confirm({
        title: t("hc_routesAppStudentTakeExamId.resetTitle"),
        description:
          efecto === "plantilla"
            ? t("hc_routesAppStudentTakeExamId.resetBodyTemplate")
            : t("hc_routesAppStudentTakeExamId.resetBodyEmpty"),
        confirmLabel: t("hc_routesAppStudentTakeExamId.resetConfirm"),
        tone: "destructive",
      });
      if (!ok) return;
      updateAnswer(q.id, respuestaRestablecida(q));
      // El editor de código se redibuja por `value`, pero la salida de la
      // ejecución anterior quedaría en pantalla contradiciendo al código que
      // ahora se ve.
      setCodeOutputs((prev) => {
        const next = { ...prev };
        delete next[q.id];
        return next;
      });
      toast.success(t("hc_routesAppStudentTakeExamId.resetDone"));
    },
    [confirm, t, updateAnswer],
  );

  // Escenarios de red parseados y ESTABLES (memoizados por questions) — pasar
  // un objeto nuevo por render reiniciaría la NetworkConsole (init keyed por
  // identidad del scenario).
  const networkScenarios = useMemo(() => {
    const map: Record<string, NetworkScenario> = {};
    for (const q of questions) {
      if (q.type === "red_consola" || q.type === "red_gui") {
        const s = parseScenario(q.options);
        if (s) map[q.id] = s;
      }
    }
    return map;
  }, [questions]);

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
    // En simulacro no se monta: escribiría en IndexedDB y la cola de respuestas
    // pendientes es del ALUMNO, no de un ensayo del docente.
    const cleanup = simulacro ? () => {} : setupOfflineSync();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      cleanup();
    };
  }, [simulacro]);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    setLoadError(null);
    // Body en una función nombrada para poder colgarle un `.catch` que
    // SIEMPRE deje el fallo visible: antes cualquier throw (red, RLS,
    // parseo) dejaba la pantalla en <PageLoader/> indefinidamente y el
    // alumno no sabía si su examen existía o la app estaba rota.
    const runLoad = async () => {
      // `courses.language` se introduce en migraciones recientes; cast hasta refrescar tipos.
      // Setting global de pantalla completa. Lo leemos en paralelo al
      // fetch del examen — si falla, asumimos true (más seguro).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const settingsPromise = (db as any)
        .from("app_settings")
        .select("require_exam_fullscreen, max_open_answer_chars")
        .maybeSingle();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: examData, error: eErr } = await (db as any)
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
      const { data: timerCtrls } = await db
        .from("exam_timer_controls")
        .select("action, extra_seconds, target_user_id")
        .eq("exam_id", examId)
        .or(`target_user_id.is.null,target_user_id.eq.${user.id}`);
      const extraSeconds = computeExtraSeconds(timerCtrls ?? []);
      if (extraSeconds > 0) {
        e = { ...e, end_time: applyExtraTime(e.end_time, extraSeconds) };
      }
      // Guardar el extra para el cálculo del timer relativo (extiende la
      // deadline personal, no solo la ventana end_time ya extendida arriba).
      setExamExtraSeconds(extraSeconds);
      examExtraSecondsRef.current = extraSeconds;

      // En SIMULACRO no se miran la ventana, el estado ni la asignación: el
      // docente prueba justamente lo que todavía es borrador, o lo que ya cerró.
      if (!simulacro && !isExamOpen({ start_time: e.start_time, end_time: e.end_time })) {
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
      if (!simulacro && examStatus !== "published") {
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
      const { data: asg } = simulacro
        ? { data: true }
        : await db
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
      let { data: qs } = await db
        .from("questions")
        .select("*")
        .eq("exam_id", examId)
        .order("position");
      // Mezcla DETERMINÍSTICA por (examen, alumno): estable entre recargas
      // (antes un sort+random re-ordenaba en cada carga y rompía la
      // navegación al reanudar) y distinta por alumno (anti-copia).
      if (e.shuffle_enabled && qs) qs = seededShuffle(qs, examShuffleSeed(examId, user.id));
      if (cancelled) return;
      setQuestions(qs ?? []);

      // SIMULACRO: acá se corta. Lo que sigue lee la ENTREGA del usuario, cuenta
      // sus intentos y reclama el bloqueo de sesión — y el docente de este curso
      // puede estar matriculado y tener una entrega REAL (en UNIAJ el dueño se
      // matricula en todos sus cursos a propósito). Cargarla mostraría sus
      // respuestas de verdad dentro de un ensayo, y el bloqueo de sesión le
      // quitaría el examen a sí mismo si lo estuviera rindiendo en otro
      // dispositivo. El ensayo arranca siempre en blanco.
      if (cancelled) return;
      if (simulacro) {
        setExam(e);
        return;
      }

      // Reintentos: contar todas las submissions del estudiante para este examen
      const { data: subs } = await db
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
          // Cerrado (por advertencias, por el docente o por vencimiento): el
          // intento se gastó aunque todavía no tenga nota. Antes esto lo cubría
          // el estado `sospechoso`; desde que una suspensión se guarda como
          // `completado`, lo que la distingue es `closed_at`.
          s.closed_at != null ||
          (s.status === "completado" && (s.ai_grade != null || s.final_override_grade != null)),
      ).length;
      // Solo `completado` SIN calificación es reanudable. `sospechoso`
      // queda bloqueado para revisión del docente — el alumno no puede
      // re-editar para "limpiar" su entrega marcada por proctoring.
      // `closed_at` distingue lo que HOY es la misma fila byte a byte: "entregué
      // limpio y todavía no hay nota" (reanudable, es el caso legítimo de abajo)
      // vs "el docente lo dio por terminado, o se venció el plazo" (NO
      // reanudable). Sin esa condición el estudiante deshace el cierre y además
      // cancela la calificación que el cierre existía para habilitar. El bloqueo
      // de verdad vive en un trigger de la base — esto es para que la pantalla no
      // ofrezca algo que el servidor va a rechazar.
      const resumableUngraded = allSubs.find(
        (s: any) =>
          s.status === "completado" &&
          s.closed_at == null &&
          s.ai_grade == null &&
          s.final_override_grade == null,
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
          await db
            .from("submissions")
            .update({ status: "en_progreso", submitted_at: null })
            .eq("id", resumeTarget.id);
          // Best-effort: si la RPC falla, igual seguimos — el peor caso
          // es que el grader IA produzca una nota desfasada que el
          // alumno verá al re-entregar (la nueva entrega re-encolará).
          await (db as any).rpc("cancel_pending_ai_jobs_for_submission", {
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
        // `updated_at` lo mantiene fresco el latido de cada 5 s (y el autosave,
        // cuando el alumno escribe). El latido manda SOLO esa columna: ver el
        // efecto del heartbeat más abajo.
        // If another device owns the session and updated_at is <10s old → block.
        const existingAnswers = (resumeTarget.answers as Record<string, any>) ?? {};
        const storedSession = existingAnswers.__session_id as string | undefined;
        const updatedAt = new Date((resumeTarget as any).updated_at).getTime();
        const ageMs = Date.now() - updatedAt;

        if (storedSession && storedSession !== localSessionId && ageMs < MS_BLOQUEO_SESION) {
          setExam(e);
          setBlockedBySession(true);
          return;
        }

        // Claim the session: inject our session ID into answers (persisted by next autosave)
        const claimedAnswers = { ...existingAnswers, __session_id: localSessionId };
        answersRef.current = claimedAnswers;

        // Reanudar el intento en curso (o re-abrir la entrega sin calificar)
        if (cancelled) return;
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
        // Restaurar la pregunta donde el estudiante se quedó, acotada al total
        // actual de preguntas (el docente pudo eliminar preguntas entre sesiones
        // → un índice fuera de rango dejaría la pantalla en blanco sin navegación).
        const persistedIdx = restoreQuestionIndex(existingAnswers, qs?.length);
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
      if (cancelled) return;
      setExam(e);
    };
    void runLoad().catch((e: unknown) => {
      if (cancelled) return;
      const msg = friendlyError(
        e,
        i18n.t("toast.routes_app_student_take_examId.examLoadFailed", {
          defaultValue: "No se pudo cargar el examen.",
        }),
      );
      setLoadError(msg);
      toast.error(msg);
    });
    return () => {
      cancelled = true;
    };
    // Dep en `user?.id` y no `user` — useAuth emite un objeto nuevo en
    // varios eventos (rehidratación de sesión, refresh de token, etc.)
    // aunque el usuario sea el mismo. Con `user` como dep el toast de
    // "Intento X de Y" se mostraba 2-3 veces seguidas al cargar la
    // pantalla. Con `user?.id` solo se reevalúa cuando cambia el
    // usuario real. `navigate` se quita de deps porque es estable
    // referencialmente en TanStack Router y no aporta nada.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId, user?.id, retryNonce]);

  const startExam = async () => {
    if (!user || !exam) return;
    // Anti doble-click: sin este guard dos clicks seguidos podían crear
    // DOS submissions `en_progreso` para el mismo alumno.
    if (startBusyRef.current) return;
    startBusyRef.current = true;
    setStartingExam(true);
    try {
      await startExamInner();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      startBusyRef.current = false;
      setStartingExam(false);
    }
  };

  const startExamInner = async () => {
    if (!user || !exam) return;
    let sid = submissionId;
    // SIMULACRO: no se crea ninguna entrega, y `submissionIdRef` se queda en
    // NULL a propósito — es el SEGUNDO cinturón. Las tres escrituras de
    // proctoring y el latido del bloqueo de sesión ya están condicionadas a que
    // tenga valor, así que con el cliente que no escribe y este null hacen
    // falta dos olvidos, no uno, para que un ensayo toque la base.
    if (!simulacro && !sid) {
      // Guard against race condition: both devices on the start screen simultaneously.
      const { data: existing } = await db
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

        if (storedSession && storedSession !== sessionIdRef.current && ageMs < MS_BLOQUEO_SESION) {
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
        const { data, error } = await db
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

    // `requestFullscreen` del helper devuelve el MODO que quedó vigente, no un
    // booleano, y ahí está el arreglo: en iPhone no existe pantalla completa
    // para elementos (medido: ni con prefijo `webkit` ni sin él), así que antes
    // esto era un callejón sin salida. El modo `standalone` —app instalada,
    // ventana sin cromo del navegador— se acepta como equivalente: es lo que el
    // propio mensaje de ayuda le pide al alumno, y hasta ahora seguir esa
    // instrucción no servía de nada porque el código nunca lo miraba.
    //
    // (El helper prueba también la API prefijada. Eso NO era la causa —en el
    // WebKit de escritorio actual existen las dos— pero sigue siendo el único
    // camino en Safari anterior a 16.4.)
    const gate = await requestFullscreenGate();
    if (!gate.permitir) {
      // Sí se puede y no se activó: rechazo del usuario, iframe sin permiso,
      // gesto perdido. Acá bloquear ES la función — el alumno puede cumplir.
      toast.error(
        i18n.t("toast.routes_app_student_take_examId.couldNotActivateFullscreen", {
          defaultValue: "No se pudo activar pantalla completa. {{help}}",
          help: fullscreenHelpText,
        }),
        {
          duration: 10000,
        },
      );
      // `logEvent` trae su PROPIO cliente, así que el guardián de `db` no lo
      // frena: en un ensayo dejaría una fila en la auditoría con categoría
      // `exam` y tipo `submission`, indistinguible de un evento real.
      if (!simulacro)
        void logEvent({
          action: "exam_fullscreen_denied",
        category: "exam",
        severity: "warning",
        entityType: "submission",
        entityId: sid ?? undefined,
        entityName: exam.title,
        metadata: { examId, stage: "start", reason: gate.motivo, isIOS, modo: gate.modo },
      });
      return;
    }
    if (gate.motivo === "sin_soporte") {
      // La plataforma NO tiene la API (iPhone). Bloquear acá dejaba el examen
      // inalcanzable: no hay nada que el alumno pueda hacer, ni instalando la
      // app. Se permite y se AVISA —no es un error suyo—, y queda auditado para
      // que el docente sepa que esta entrega corrió sin pantalla completa. El
      // resto del proctoring (cambio de app, pestaña oculta, foco, copiar) sigue
      // activo, y es el que de verdad detecta que se fue a otra parte.
      toast.info(
        i18n.t("toast.routes_app_student_take_examId.fullscreenUnsupportedStart", {
          defaultValue:
            "Tu navegador no permite pantalla completa, así que el examen abre en ventana normal. Se sigue registrando si cambias de app o de pestaña.",
        }),
        { duration: 9000 },
      );
      if (!simulacro)
        void logEvent({
          action: "exam_started_without_fullscreen",
        category: "exam",
        severity: "info",
        entityType: "submission",
        entityId: sid ?? undefined,
        entityName: exam.title,
        metadata: { examId, stage: "start", reason: "sin_soporte", isIOS },
      });
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
    if (!requireFullscreen) {
      // Reanudar/recargar entra a started=true SIN pasar por startExam, así que
      // hasEverEnteredFullscreenRef quedaba en false y el proctoring (blur/
      // beforeunload) se auto-suprimía toda la sesión cuando el FS obligatorio
      // está desactivado. Con FS off no hay overlay de re-entrada que lo active,
      // así que lo marcamos acá. Este effect re-corre cuando requireFullscreen
      // resuelve desde app_settings; no-op en arranque fresco (startExam ya lo puso).
      hasEverEnteredFullscreenRef.current = true;
      return;
    }
    // Solo si el alumno PUEDE volver. En una plataforma sin la API (iPhone) el
    // overlay era una trampa: el botón "Reanudar" llamaba a una API inexistente,
    // no lanzaba nada y no pasaba nada — el alumno quedaba mirando un botón
    // muerto sobre su examen ya empezado, sin mensaje ni salida.
    if (!currentProctoringGate().permitir) {
      setFsExited(true);
    }
  }, [started, requireFullscreen]);

  // Estado del overlay de re-entrada a pantalla completa
  const [fsExited, setFsExited] = useState(false);
  const reenterFullscreen = async () => {
    if (reenteringFs) return;
    setReenteringFs(true);
    try {
      const gate = await requestFullscreenGate();
      // El click en "Reanudar" del overlay cuenta como entrada válida —
      // activamos el proctoring estricto. Si el alumno sale luego, sí
      // cuenta como strike normal.
      hasEverEnteredFullscreenRef.current = true;
      if (gate.motivo === "sin_soporte") {
        // Cinturón y tirantes: si igual se llegó acá en una plataforma sin la
        // API, se cierra el overlay en vez de dejarlo encerrado.
        toast.info(
          i18n.t("toast.routes_app_student_take_examId.fullscreenUnsupportedResume", {
            defaultValue:
              "Tu navegador no permite pantalla completa. Continúas en ventana normal; el examen sigue registrando los cambios de app o pestaña.",
          }),
          { duration: 9000 },
        );
      }
      setFsExited(false);
    } catch (e) {
      // Sin toast el alumno quedaba atrapado en el overlay sin saber por
      // qué el botón "no hace nada" (navegador que niega fullscreen).
      toast.error(
        friendlyError(
          e,
          i18n.t("toast.routes_app_student_take_examId.couldNotReenterFullscreen", {
            defaultValue:
              "No se pudo volver a pantalla completa. Intenta de nuevo o usa la tecla F11.",
          }),
        ),
      );
    } finally {
      setReenteringFs(false);
    }
  };

  // Persistir respuestas inmediatamente (autosave, entrega, tiempo agotado)
  const saveAnswersNow = useCallback(async () => {
    if (!submissionIdRef.current) return;
    // __saved_at: marca de versión del CONTENIDO de las respuestas. Se escribe
    // IDÉNTICA en el server y en el snapshot local, así el sync offline puede
    // descartar un pending rezagado cuando el server tiene answers más nuevas de
    // la MISMA sesión (student siguió trabajando online). Es inmune a extra_seconds
    // (que bumpea updated_at pero NO answers.__saved_at).
    const savedAt = Date.now();
    const currentAnswers = {
      ...answersRef.current,
      // Persistimos el índice de la pregunta visible para que el
      // monitor del docente pueda mostrar "Pregunta X de Y" en tiempo
      // real para los intentos en curso (vía postgres_changes).
      __current_idx: currentIdxRef.current,
      __saved_at: savedAt,
    };
    answersRef.current = currentAnswers;
    // LIMITACIÓN CONOCIDA (docs/HALLAZGOS-BUGS-2026-07-15-ronda2.md #N11): este
    // UPDATE reescribe focus_warnings + answers.__warning_events con el valor LOCAL.
    // warningsRef.current solo se sincroniza desde el server en el load/resume, así
    // que si el docente PERDONA una advertencia desde el monitor a un alumno aún en
    // curso, el próximo heartbeat la pisa. Fix pendiente: suscribir a
    // postgres_changes de esta fila de submissions y hacer merge hacia abajo cuando
    // el server trae focus_warnings menor (requiere prueba multi-cliente).
    const currentWarnings = warningsRef.current;
    if (isOnline()) {
      // El error del UPDATE se ignoraba por completo: si el guardado
      // fallaba (RLS, red, 5xx) el alumno seguía viendo "respuestas
      // guardadas automáticamente" sin ninguna señal. Ahora lo reflejamos
      // en un badge del header (`saveFailed`). NO tiramos el error: este
      // helper lo llaman los flujos de ENTREGA y un throw acá abortaba la
      // entrega entera (el respaldo local + el update de performSubmit son
      // los que realmente cuentan).
      try {
        const { error } = await db
          .from("submissions")
          .update({ answers: currentAnswers, focus_warnings: currentWarnings })
          .eq("id", submissionIdRef.current);
        setSaveFailed(!!error);
        // El latido mira esta marca para no repetir una escritura que el
        // autoguardado ya hizo (ver `latidoEsRedundante`). Solo cuenta si de
        // verdad se guardó: si falló, `updated_at` no se movió y el latido
        // TIENE que correr.
        if (!error) ultimoGuardadoRef.current = Date.now();
        if (error) console.error("[ExamLab] autosave failed:", error);
      } catch (e) {
        setSaveFailed(true);
        console.error("[ExamLab] autosave threw:", e);
      }
    }
    try {
      await saveAnswersLocally(examId, {
        submissionId: submissionIdRef.current,
        answers: currentAnswers,
        warnings: currentWarnings,
        timestamp: savedAt,
      });
    } catch (e) {
      // IndexedDB puede fallar (modo privado, cuota). No es motivo para
      // abortar una entrega en curso.
      console.error("[ExamLab] local answers save failed:", e);
    }
  }, [examId]);

  const performSubmit = useCallback(
    async (markSuspicious = false) => {
      // SIMULACRO: corta ACÁ, y no por prolijidad. Lo que sigue llama a
      // `aiGradeOrEnqueue` y a `logEvent`, que traen su PROPIO cliente y por lo
      // tanto NO pasan por el guardián de `db`: sin este corte, terminar un
      // ensayo encolaría un trabajo de calificación con IA contra una entrega
      // que no existe. También escribe en IndexedDB y avisa al docente.
      if (simulacro) {
        if (submittedRef.current) return;
        submittedRef.current = true;
        setSubmitting(true);
        try {
          await exitFullscreen();
        } catch {}
        toast.success(
          markSuspicious
            ? t("simulacroExamen.terminadoPorAdvertencias")
            : t("simulacroExamen.terminado"),
          { duration: 8000 },
        );
        navigate({ to: "/app/teacher/exams" });
        return;
      }
      if (submittedRef.current || !submissionIdRef.current) return;

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
        // SIEMPRE «completado», aunque el examen se haya suspendido por
        // advertencias. `sospechoso` quedó reservado para el fraude que la
        // plataforma DETECTA —IA o copia entre entregas—; haberse salido de
        // la pantalla tres veces no es eso. Marcarlo así ponía a media clase
        // bajo una etiqueta acusatoria por algo que muchas veces es el
        // teclado del teléfono, una notificación o el navegador. El dato NO
        // se pierde: `focus_warnings` guarda cuántas fueron y los eventos
        // quedan en `__warning_events`, que es lo que el monitor muestra.
        status: "completado",
        focus_warnings: currentWarnings,
        submitted_at: new Date().toISOString(),
        // Suspender por advertencias CIERRA el intento, y eso hay que marcarlo.
        // El estado ya no alcanza para distinguirlo: desde que dejó de ser
        // `sospechoso`, una suspensión y una entrega limpia sin nota son la
        // MISMA fila, y `resumableUngraded` de más abajo daba la segunda por
        // reanudable — o sea que el alumno deshacía su propia suspensión con
        // solo recargar. El bloqueo de verdad lo aplica el trigger
        // `tg_block_reopen_closed_attempt` en la base; esto es lo que se lo da.
        ...(markSuspicious
          ? {
              closed_at: new Date().toISOString(),
              close_reason: "advertencias",
              closed_by: user?.id ?? null,
            }
          : {}),
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
      // Dos intentos. El `try/catch` importa: si el fetch REVIENTA (red caída
      // a mitad, CORS, abort) el await tiraba y performSubmit quedaba a medias
      // con `submittedRef=true` + spinner infinito → el alumno creía haber
      // entregado y no podía reintentar.
      let serverUpdated = false;
      let lastSubmitError: unknown = null;
      for (let attempt = 0; attempt < 2 && !serverUpdated; attempt++) {
        try {
          const { error: updateErr } = await db
            .from("submissions")
            .update(updateData)
            .eq("id", submissionIdRef.current);
          if (!updateErr) {
            serverUpdated = true;
          } else {
            lastSubmitError = updateErr;
            console.error("submission update failed:", updateErr);
          }
        } catch (e) {
          lastSubmitError = e;
          console.error("submission update threw:", e);
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
          {
            description: lastSubmitError ? friendlyError(lastSubmitError) : undefined,
            duration: 12000,
          },
        );
        return;
      }

      // Entrega confirmada en el servidor → el respaldo local (línea ~865) ya
      // no hace falta. Sin esto quedaba un pending que syncPendingAnswers
      // intentaría re-aplicar (hoy inofensivo por el guard `status='en_progreso'`,
      // pero mejor no dejar estado obsoleto que dispare un sync sin efecto).
      // En try/catch: un fallo de IndexedDB acá NO puede impedir el toast de
      // confirmación ni la navegación — la entrega YA está registrada.
      try {
        await clearLocalAnswers(examId);
      } catch (e) {
        console.error("clearLocalAnswers failed:", e);
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
            const { data: profile } = await db
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

            const { error: rpcErr } = await db.rpc("notify_exam_teachers", {
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
        await exitFullscreen();
      } catch {}
      // Dispara el grading IA respetando el setting global async/sync.
      // - `processing_mode = 'async'` (default): encola en
      //   `ai_grading_queue`; el worker hourly drena la cola.
      // - `processing_mode = 'sync'` o el docente tiene un override
      //   código activo: invoca a `ai-grade-submission` directo.
      //
      // Antes llamábamos siempre directo (`db.functions.invoke`)
      // ignorando el toggle del admin — el feature de cola IA no
      // aplicaba a entregas de examen aunque el admin tuviera 'async'
      // activo. Ver `src/modules/ai/ai-grading.ts` para el helper.
      //
      // Fire-and-forget Y SIEMPRE A LA COLA (`soloEncolar`), incluso con el
      // modo en `sync`. Un alumno no puede usar el camino inmediato: el worker
      // le responde 401 por permisos, el código cae al edge directo y, si ese
      // contesta bien, CANCELA el job encolado — retirando la única red de
      // contención en el momento en que ya no se puede verificar nada. Con eso,
      // un 429 por cuota o una pestaña que se cierra dejaba la entrega sin nota
      // y sin nada pendiente que la recuperara. Encolando, el resultado es
      // determinista: el trabajo queda, el cron lo drena con reintentos y abajo
      // se le avisa al alumno que su nota llega después.
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
      }, { soloEncolar: true })
        .then((result) => {
          // Avisar al estudiante cuando la nota NO va a estar ya. Sin esto ve
          // la pantalla "examen entregado" sin saber por qué su nota tarda. El
          // toast es global (sonner), así que sobrevive a la navegación.
          //
          // La condición cubre DOS casos, y antes solo cubría el primero:
          //   · encolado por el modo (async, sin código del docente);
          //   · **modo sincrónico que no pudo calificar** — el caso de quedarse
          //     sin cuota (429 del nivel gratuito de Gemini). Ahí
          //     `aiGradeOrEnqueue` devuelve `ranSync: true` CON error, así que
          //     la condición vieja lo dejaba pasar en silencio: el alumno leía
          //     "Examen entregado correctamente" y nunca se enteraba de que la
          //     nota había quedado en espera. El trabajo durable ya estaba
          //     encolado; lo único que faltaba era decírselo.
          const quedoPendiente = result.jobId && (!result.ranSync || !!result.error);
          if (quedoPendiente) {
            toast.info(t("hc_routesAppStudentTakeExamId.gradePendingLater"), { duration: 9000 });
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
    [navigate, examId, exam, user, questions, maxWarnings, simulacro, t],
  );

  const requestManualSubmit = useCallback(async () => {
    // En simulacro no hay entrega, así que no se exige `submissionIdRef`: sin
    // esto el botón «Finalizar» no haría nada y el docente no podría ver el
    // aviso de preguntas en blanco ni el cierre, que es parte de lo que viene
    // a probar.
    if (submitting || submittedRef.current) return;
    if (!simulacro && !submissionIdRef.current) return;
    // Guard por ref: `submitting` recién se activa dentro de performSubmit,
    // así que entre el click y ese punto el botón seguía clickeable.
    if (submitBusyRef.current) return;
    submitBusyRef.current = true;
    setPreparingSubmit(true);
    try {
      await saveAnswersNow();
      const unanswered = getUnansweredIndices(questions, answersRef.current);
      // El modal se abre SIEMPRE, también con todo respondido. Antes, un examen
      // completo se entregaba en el mismo clic: la acción menos reversible del
      // producto no tenía ningún paso intermedio, y un clic accidental en
      // "Finalizar" cerraba el examen sin vuelta. La lista de vacías sigue
      // apareciendo solo cuando hay alguna; lo que cambia es que ahora hay
      // confirmación aunque no haya ninguna.
      //
      // Ojo: esto es SOLO el camino manual. `handleTimeUp` y el corte por
      // proctoring llaman a `performSubmit` derecho y NO deben pasar por acá —
      // no hay nadie a quien preguntarle y un modal abierto perdería la entrega.
      setSubmitModal({
        open: true,
        unansweredIndices: unanswered,
      });
    } catch (e) {
      // Antes cualquier throw acá (guardado previo, IndexedDB) abortaba la
      // entrega en silencio: el alumno pulsaba "Finalizar" y no pasaba nada.
      toast.error(friendlyError(e));
    } finally {
      submitBusyRef.current = false;
      setPreparingSubmit(false);
    }
  }, [submitting, saveAnswersNow, questions, performSubmit]);

  const confirmSubmitFromModal = useCallback(async () => {
    if (submitBusyRef.current || submittedRef.current) return;
    submitBusyRef.current = true;
    setPreparingSubmit(true);
    setSubmitModal({ open: false, unansweredIndices: [] });
    try {
      await saveAnswersNow();
      await performSubmit(false);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      submitBusyRef.current = false;
      setPreparingSubmit(false);
    }
  }, [performSubmit, saveAnswersNow]);

  const cancelManualSubmitModal = useCallback(() => {
    setSubmitModal({ open: false, unansweredIndices: [] });
  }, []);

  /** Tiempo global del examen agotado → guardar y entregar sin modal */
  const handleTimeUp = useCallback(() => {
    if (submittedRef.current) return;
    void (async () => {
      // El guardado previo va en su propio try: si falla, la ENTREGA debe
      // ocurrir igual (antes un throw acá dejaba el examen sin entregar al
      // vencerse el tiempo — el peor fallo silencioso posible).
      try {
        await saveAnswersNow();
      } catch (e) {
        console.error("[ExamLab] save before auto-submit failed:", e);
      }
      try {
        await performSubmit(false);
      } catch (e) {
        toast.error(friendlyError(e));
      }
    })();
  }, [saveAnswersNow, questions, performSubmit]);

  const initialSeconds =
    exam?.schedule_type === "relativo"
      ? computeSecondsLeftRelative(
          submissionStartedAt,
          exam?.time_limit_minutes ?? 0,
          exam?.end_time,
          Date.now(),
          examExtraSeconds,
        )
      : computeSecondsLeft(exam?.end_time);

  const { isPaused, mensajeDePausa, formattedTime, isLowTime, syncToSeconds } = useRealtimeTimer({
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
    // El docente perdonó advertencias desde el monitor. Adoptar el estado que
    // viene en la orden es lo que hace que el borrado SIRVA: sin esto el
    // contador local seguía igual y la suspensión automática se disparaba
    // igual al siguiente strike, aunque en la base el contador fuera 0. Y el
    // siguiente autoguardado escribe estos mismos valores, así que la fila
    // converge sola en vez de que el alumno restaure lo viejo.
    onWarningsCleared: ({ focusWarnings, events }) => {
      warningsRef.current = focusWarnings;
      setWarnings(focusWarnings);
      warningEventsRef.current = events as typeof warningEventsRef.current;
      answersRef.current = { ...answersRef.current, __warning_events: events };
      toast.info(
        i18n.t("toast.routes_app_student_take_examId.warningsClearedByTeacher", {
          defaultValue:
            "El docente revisó tus advertencias. Ahora tienes {{count}}.",
          count: focusWarnings,
        }),
      );
    },
  });

  // Suscripción realtime a cambios en el examen (end_time, time_limit_minutes).
  // Si el docente modifica el horario mientras el examen está en curso,
  // el temporizador del estudiante se sincroniza automáticamente.
  useEffect(() => {
    if (!examId || !started) return;
    const channel = db
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
          // payload.new.end_time es el valor CRUDO de la DB (nunca contiene el
          // tiempo extra por-alumno de exam_timer_controls). Extendemos con el
          // extra acumulado — igual que el load effect (líneas 433-439) — para no
          // encoger el timer y forzar una auto-entrega prematura.
          const effEnd = applyExtraTime(newEndTime, examExtraSecondsRef.current);
          const newSeconds =
            newScheduleType === "relativo"
              ? computeSecondsLeftRelative(
                  submissionStartedAtRef.current,
                  newLimit,
                  effEnd,
                  Date.now(),
                  examExtraSecondsRef.current,
                )
              : computeSecondsLeft(effEnd);
          syncToSeconds(Math.max(0, newSeconds));
          setExam((prev) =>
            prev
              ? {
                  ...prev,
                  end_time: effEnd,
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
      void db.removeChannel(channel);
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

  // Heartbeat del session-lock. El autosave de arriba es un DEBOUNCE: solo se
  // re-arma cuando cambian `answers`/`warnings`, así que un alumno INACTIVO
  // (leyendo una pregunta larga, pensando, una pregunta de código sin tocar)
  // dejaría de refrescar `submissions.updated_at`. El lock usa una ventana de
  // 10s sobre updated_at, así que sin un heartbeat periódico otro dispositivo
  // podría "robar" el intento tras >10s de inactividad.
  //
  // ── Por qué NO llama a `saveAnswersNow` ────────────────────────────────
  // Lo único que el lock necesita es que `updated_at` esté fresco, y eso lo
  // pone el trigger `submissions_updated` ante CUALQUIER update. Guardar las
  // respuestas enteras cada 5 s reescribía la columna `answers` completa
  // —medida en producción: 6 KB de mediana— aunque el alumno no hubiera tocado
  // nada. Con 32 exámenes a la vez, que es el pico real de hoy, son unas 6
  // escrituras por segundo de 6 KB cada una, sostenidas durante las dos horas
  // del examen: unas 52.000 reescrituras de fila sobre una base que pesa
  // 197 MB. Esa carga de WAL y de vacío es justo la que la instancia no
  // aguanta cuando su E/S está estrangulada (los `57014` y el checkpoint de
  // 56 s del 22-09).
  //
  // Mandar solo `updated_at` deja el mismo efecto sobre el lock y saca la
  // columna pesada del camino. Lo que el alumno escribe lo sigue guardando el
  // debounce de arriba, que corre 1,5 s después de cada cambio real.
  useEffect(() => {
    if (!started) return;
    const id = setInterval(() => {
      if (submittedRef.current || isPaused || !submissionIdRef.current) return;
      // Un alumno que está respondiendo ya refresca `updated_at` con cada
      // autoguardado; latir encima no aporta nada y duplica la escritura sobre
      // la tabla más caliente. El latido queda para el alumno QUIETO, que es
      // para quien se hizo.
      if (latidoEsRedundante(Date.now() - ultimoGuardadoRef.current)) return;
      void db
        .from("submissions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", submissionIdRef.current)
        .then(({ error }) => {
          // Silencioso a propósito: el latido no es la entrega. Un fallo acá
          // solo arriesga que otro dispositivo reclame el intento, y el
          // siguiente latido lo recupera. El badge de "no se pudo guardar" lo
          // gobierna el autosave, que es el que sí tiene respuestas en juego.
          if (error) console.error("[ExamLab] heartbeat failed:", error);
        });
    }, MS_ENTRE_LATIDOS);
    return () => clearInterval(id);
  }, [started, isPaused]);

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

    // Ventanas SEPARADAS: si la señal blanda compartiera la del strike, el
    // `blur` de un cambio de app en móvil se tragaría el `visibility_hidden`
    // que viene detrás y el cambio quedaría sin registrar. Ver
    // `creaVentanasDeProctoring`.
    const ventanas = creaVentanasDeProctoring(500);
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
      if (!ventanas.permiteStrike(now)) return;

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
        // Avanza la marca de versión de answers (ver saveAnswersNow) para que un
        // sync offline rezagado no pise esta escritura del server.
        __saved_at: Date.now(),
      };
      answersRef.current = updatedAnswers;
      setAnswers(updatedAnswers);
      if (submissionIdRef.current && isOnline()) {
        db
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
        // Avanza la marca de versión de answers (ver saveAnswersNow) para que un
        // sync offline rezagado no pise esta escritura del server.
        __saved_at: Date.now(),
      };
      answersRef.current = updatedAnswers;
      setAnswers(updatedAnswers);
      if (submissionIdRef.current && isOnline()) {
        db
          .from("submissions")
          .update({ answers: updatedAnswers })
          .eq("id", submissionIdRef.current)
          .then(({ error }) => {
            if (error) console.error("recordCopyAlert DB save failed:", error);
          });
      }
    };

    // Pantallazo: SUMA strike. Nadie pulsa Impr Pant ni Cmd+Shift+4 sin querer
    // en mitad de un examen — es deliberado y unívoco, al revés que copiar o
    // pegar, que en una pregunta de código son parte de responderla.
    //
    // ── Lo que esto NO alcanza, y conviene tenerlo escrito ──────────────
    // En un TELÉFONO el pantallazo es Power+Volumen: lo resuelve el sistema
    // operativo y no genera NINGÚN evento web — ni tecla, ni blur, ni cambio de
    // visibilidad. No hay API que lo detecte y tampoco forma de impedirlo desde
    // la web. Así que esto cubre computador, donde el atajo a veces llega; en
    // móvil no hay nada que contar, y conviene no prometerlo.
    //
    // Incluso en computador el SO suele interceptar el atajo antes que el
    // navegador, así que la detección es best-effort: se capturan los casos en
    // que el evento sí se propaga.
    let lastScreenshotAt = 0;
    const recordScreenshotAttempt = () => {
      if (submittedRef.current) return;
      const now = Date.now();
      // El SO puede repetir la tecla: sin esto, un pantallazo sostenido sumaba
      // varios strikes de golpe.
      if (now - lastScreenshotAt < 800) return;
      lastScreenshotAt = now;

      // Se delega en `recordWarning`, que es quien sabe contar: incrementa
      // `focus_warnings`, persiste las dos cosas en UNA escritura, respeta la
      // gracia de reanudación y marca la entrega como sospechosa al llegar al
      // tope. Duplicar eso acá fue justamente lo que dejó el pantallazo sin
      // contar: esta función escribía `answers` y nunca el contador.
      //
      // Y el aviso lo da ÉL, no esta función: antes había uno propio («No está
      // permitido tomar pantallazos»), que ahora sería el SEGUNDO mensaje por
      // un mismo gesto — y al tercer strike quedaría debajo de «el examen se
      // suspende», diciendo que algo no se puede hacer cuando el examen ya
      // terminó. El genérico nombra la acción: «Advertencia 1/3: Pantallazo».
      recordWarning("pantallazo");
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
        // Se cierra la entrega, pero como «completado»: ver el comentario del
        // estado en `performSubmit`. Y se marca el cierre por el mismo motivo
        // que allá — sin esto el alumno reabre su propia suspensión.
        body.status = "completado";
        body.submitted_at = new Date().toISOString();
        body.closed_at = new Date().toISOString();
        body.close_reason = "advertencias";
        body.closed_by = user?.id ?? null;
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

    /**
     * Deja constancia de algo que el docente debería ver pero que NO suma
     * strike. Mismo camino de persistencia que `recordScreenshotAttempt`.
     */
    const registrarSenalBlanda = (type: string) => {
      if (submittedRef.current) return;
      if (!hasEverEnteredFullscreenRef.current) return;
      const now = Date.now();
      // Ventana propia: deduplica el ruido de un foco que parpadea sin poder
      // silenciar un strike real que llegue en los mismos milisegundos.
      if (!ventanas.permiteBlanda(now)) return;

      warningEventsRef.current = [
        ...warningEventsRef.current,
        {
          type,
          at: new Date(now).toISOString(),
          questionIdx:
            exam?.navigation_type === "secuencial" ? currentIdxRef.current : null,
        },
      ];
      const updatedAnswers = {
        ...answersRef.current,
        __warning_events: warningEventsRef.current,
        __saved_at: Date.now(),
      };
      answersRef.current = updatedAnswers;
      setAnswers(updatedAnswers);
      if (submissionIdRef.current && isOnline()) {
        db
          .from("submissions")
          .update({ answers: updatedAnswers })
          .eq("id", submissionIdRef.current)
          .then(({ error }) => {
            if (error) console.error("registrarSenalBlanda DB save failed:", error);
          });
      }
    };

    // En un teléfono el corrector ortográfico abre su burbuja nativa y eso
    // quita el foco de la ventana sin que el estudiante salga a ningún lado:
    // ver `blurCuentaComoStrike`. Se evalúa una sola vez por intento.
    const entornoPuntero = entornoDePuntero();
    const blurSuma = blurCuentaComoStrike(entornoPuntero);

    // Última corrección registrada en móvil, para no anotar DOS señales blandas
    // por el mismo gesto (ver `resolverOculto`).
    let ultimoBlurMovil = 0;
    const onBlur = () => {
      if (!blurSuma) {
        // No suma, pero no se pierde: el docente lo ve en el monitor. Salir de
        // la app DE VERDAD sigue sumando por `visibilitychange`, que en móvil
        // es la señal confiable.
        ultimoBlurMovil = Date.now();
        registrarSenalBlanda("blur_movil");
        return;
      }
      // Solo se marca cuando el blur SUMÓ: `onBeforeUnload` usa esta marca para
      // no contar dos veces el cierre de la ventana, y si la pusiéramos igual
      // en móvil dejaría de contar ese cierre.
      lastBlurAt = Date.now();
      recordWarning("pestaña");
    };
    // El menú contextual sigue bloqueado en la página, PERO no sobre los
    // campos de respuesta: ahí es donde viven las sugerencias del corrector
    // ortográfico, y bloquearlas dejaba al estudiante viendo la palabra
    // subrayada en rojo sin forma de corregirla salvo reescribirla. No abre
    // la mano con el portapapeles: elegir «Pegar» en el menú dispara el mismo
    // evento que `onClipboard` intercepta. Ver `permiteMenuContextual`.
    const onContext = (e: Event) => {
      if (permiteMenuContextual(e.target)) return;
      e.preventDefault();
    };
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
      if (currentFullscreenElement()) {
        // Primer ingreso a FS de esta sesión → activamos el proctoring
        // estricto. A partir de aquí los strikes cuentan.
        hasEverEnteredFullscreenRef.current = true;
        setFsExited(false);
      } else if (started && !submittedRef.current && requireFullscreen) {
        // Solo cuenta strike por salida de FS si la institución exige FS.
        // En modo depuración (toggle off) el FS no aplica.
        //
        // En un teléfono la pantalla completa la suelta el SISTEMA al abrir sus
        // superficies (teclado, burbuja del corrector), no el estudiante: ahí
        // queda como señal blanda. El overlay de «volvé a pantalla completa» se
        // muestra igual, porque el examen sí necesita volver.
        if (salidaDePantallaCompletaCuentaComoStrike(entornoPuntero)) {
          recordWarning("fullscreen_exit");
        } else {
          registrarSenalBlanda("fullscreen_exit_movil");
        }
        setFsExited(true);
      }
    };
    // PrintScreen no siempre dispara keydown (algunos navegadores solo
    // emiten keyup tras la captura del SO). Cubrimos ambos.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "PrintScreen") recordScreenshotAttempt();
    };
    // Cambio de pestaña / cambio de app: algunos navegadores (sobre todo mobile)
    // disparan visibilitychange pero NO window blur → sin este listener el alumno
    // escapaba el proctoring. recordWarning ya deduplica con su propia ventana de 500 ms
    // cuando desktop dispara ambos, y usa el tipo dedicado visibility_hidden.
    // Momento en que el documento se ocultó, para medir cuánto estuvo así.
    // Solo se usa en móvil: en computador el strike sigue siendo inmediato.
    let ocultoDesde: number | null = null;
    const resolverOculto = (ms: number) => {
      if (ocultarCuentaComoStrike(entornoPuntero, ms)) {
        recordWarning("visibility_hidden");
        return;
      }
      // El ocultamiento breve que viene pegado a una corrección es el MISMO
      // gesto que ya quedó anotado como `blur_movil`. Sin esto el docente ve
      // dos renglones por cada palabra corregida y el listado deja de servir.
      if (Date.now() - ultimoBlurMovil <= GRACIA_OCULTO_MOVIL_MS + 1000) return;
      registrarSenalBlanda("oculto_breve_movil");
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (salidaDePantallaCompletaCuentaComoStrike(entornoPuntero)) {
          // Computador: ocultarse ES cambiar de pestaña. Sin espera.
          recordWarning("visibility_hidden");
          return;
        }
        // Móvil: la decisión se toma al volver. Lo que distingue «se fue» de
        // «el sistema abrió una burbuja» no es el evento, es cuánto duró —
        // los datos de producción muestran la corrección disparando `blur` y
        // el ocultamiento con 0 a 2 segundos de diferencia, o sea el mismo
        // gesto. El temporizador cubre el caso de que no vuelva nunca; si el
        // navegador lo congela, la vuelta lo resuelve igual.
        ocultoDesde = Date.now();
        const marca = ocultoDesde;
        window.setTimeout(() => {
          if (ocultoDesde !== marca || document.visibilityState !== "hidden") return;
          ocultoDesde = null;
          resolverOculto(Date.now() - marca);
        }, GRACIA_OCULTO_MOVIL_MS + 200);
        return;
      }
      // VUELVE a primer plano. Mientras estuvo fuera, la librería de auth tuvo
      // su renovación DETENIDA (solo refresca con la pestaña visible), así que
      // este es el momento exacto en que el token puede haber vencido sin que
      // nadie lo notara. Se renueva acá, antes de que el alumno pulse nada.
      void asegurarSesionFresca();
      if (ocultoDesde != null) {
        const ms = Date.now() - ocultoDesde;
        ocultoDesde = null;
        resolverOculto(ms);
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("contextmenu", onContext);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    // Los DOS eventos: sin `webkitfullscreenchange` el strike por salir de
    // pantalla completa nunca se registraba en Safari.
    const desuscribirFs = onFullscreenChange(onFsChange);
    document.addEventListener("copy", onClipboard);
    document.addEventListener("paste", onClipboard);
    document.addEventListener("cut", onClipboard);
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      window.removeEventListener("popstate", onPopstate, true);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("contextmenu", onContext);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      desuscribirFs();
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
        // El camino crítico del examen: si el token está por vencer, se
        // renueva ANTES de salir, en vez de descubrirlo por un «No autenticado».
        await asegurarSesionFresca();
        const invokePromise = db.functions.invoke("execute-code", {
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
          const mensaje = real || t("hc_routesAppStudentTakeExamId.errorRunningCode");
          // UN reintento, y solo para los dos fallos de CARGA que aparecieron
          // en el parcial del 2026-09-23 (ver `fallo-de-ejecucion.ts`): la
          // sesión que no se pudo validar y el proveedor sin capacidad. Los
          // dos se arreglan solos; lo que no se arregla —un error de
          // compilación, un bucle infinito— no se repite, porque daría lo
          // mismo y quemaría capacidad que otro alumno necesita.
          const tipo = clasificarFalloDeEjecucion(mensaje);
          if (!esReintentable(tipo) || signal.aborted) throw new Error(mensaje);

          if (tipo === "sesion") await db.auth.refreshSession();
          const espera = esperaAntesDeReintentar(tipo);
          if (espera > 0) await new Promise((r) => setTimeout(r, espera));
          if (signal.aborted) throw new Error(CANCELLED_SENTINEL);

          const reintento = await (Promise.race([
            db.functions.invoke("execute-code", {
              body: {
                sourceCode: code,
                language,
                questionId,
                submissionId: submissionIdRef.current,
                ...(overrideForQuestion ? { provider: overrideForQuestion } : {}),
              },
            }),
            cancelPromise,
          ]) as Promise<Awaited<typeof invokePromise>>);
          if (reintento.error) {
            const realReintento = await extractEdgeError(reintento.error, reintento.data);
            // Si insiste, se nombra la salida que el alumno tiene y no
            // descubre solo en mitad de un parcial: cambiar de compilador.
            throw new Error(
              `${realReintento || mensaje}

${t("hc_routesAppStudentTakeExamId.tryAnotherRunner")}`,
            );
          }
          stdout = reintento.data?.stdout ?? "";
          stderr = reintento.data?.stderr ?? "";
        } else {
          stdout = data?.stdout ?? "";
          stderr = data?.stderr ?? "";
        }
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
      // Además del panel de salida (que puede quedar fuera de vista si el
      // alumno hizo scroll) mostramos toast: el fallo de ejecución nunca
      // debe pasar desapercibido durante un examen.
      toast.error(friendlyError(msg), { duration: 8000 });
      // Ídem: en un ensayo el aviso al docente sí va (está probando el
      // compilador y necesita ver el fallo), pero la fila de auditoría no.
      if (!simulacro)
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

  if (loadError && !exam) {
    return (
      <div className="max-w-2xl mx-auto">
        <ErrorState
          message={t("hc_routesAppStudentTakeExamId.examLoadErrorTitle", {
            defaultValue: "No pudimos cargar tu examen",
          })}
          hint={loadError}
          onRetry={() => {
            setLoadError(null);
            setRetryNonce((n) => n + 1);
          }}
        />
      </div>
    );
  }

  if (!exam) return <PageLoader />;

  if (blockedBySession) {
    return (
      <div className="max-w-2xl mx-auto">
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
      <div className="max-w-2xl mx-auto">
        <Card>
          <CardContent className="p-6 space-y-4">
            <h1 className="text-2xl font-semibold">{exam.title}</h1>
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm space-y-2">
              <p className="font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning-on-subtle" />
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
                {/* El corrector ortográfico se nombra EXPLÍCITAMENTE: es la
                    duda que más aparece («si corrijo, ¿me cuenta?») y la
                    respuesta no es evidente mirando la pantalla, porque el
                    examen sí bloquea otras cosas. Va en todos los exámenes,
                    sin depender de que el docente lo configure. */}
                <li>{t("hc_routesAppStudentTakeExamId.spellcheckAllowed")}</li>
                <li>{t("hc_routesAppStudentTakeExamId.answersAutoSaved")}</li>
              </ul>
            </div>
            {/* El aviso de ENTREGAR va en su propio recuadro y no como un punto
                más de la lista: es la causa de que un intento quede "en
                progreso" y sin nota, y el punto de arriba —"tus respuestas se
                guardan solas"— invita justo a la conclusión contraria. Por eso
                lo dice explícitamente: guardado no es entregado. */}
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm space-y-1">
              <p className="font-semibold flex items-center gap-2">
                <Send className="h-4 w-4 shrink-0" />
                {t("exam.mustSubmitTitle")}
              </p>
              <p>{t("exam.mustSubmitBody")}</p>
            </div>
            <Button
              size="lg"
              className="w-full"
              onClick={() => void startExam()}
              disabled={startingExam}
            >
              {startingExam ? (
                <Spinner size="md" className="mr-2" />
              ) : (
                <Maximize2 className="h-4 w-4 mr-2" />
              )}
              {startingExam
                ? t("hc_routesAppStudentTakeExamId.startingExam", {
                    defaultValue: "Iniciando…",
                  })
                : t("exam.start")}
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
      {/* El aviso va SIEMPRE visible mientras dure el ensayo, y arriba del todo.
          Toda esta pantalla está hecha para que no se distinga de un examen de
          verdad; si el aviso se pudiera cerrar o quedara fuera de vista, el
          docente podría dictar un parcial creyendo que está probando, o al
          revés, probar creyendo que su respuesta contó. */}
      {simulacro && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
          <FlaskConical className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold">{t("simulacroExamen.banner")}</p>
            <p className="text-2xs opacity-90">{t("simulacroExamen.bannerDetalle")}</p>
          </div>
        </div>
      )}
      {/* Entrega en curso: bloqueo visual explícito. El botón deshabilitado
          solo no alcanzaba — el alumno no sabía si su click "tomó" y podía
          cerrar la pestaña justo mientras se registraba la entrega. */}
      {busySubmit && (
        <LoadingOverlay
          title={t("hc_routesAppStudentTakeExamId.submittingOverlayTitle", {
            defaultValue: "Entregando tu examen…",
          })}
          subtitle={t("hc_routesAppStudentTakeExamId.submittingOverlaySubtitle", {
            defaultValue: "No cierres esta ventana ni cambies de pestaña.",
          })}
        />
      )}
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
            <Button
              className="w-full"
              onClick={() => void reenterFullscreen()}
              disabled={reenteringFs}
            >
              {reenteringFs ? <Spinner size="md" className="mr-2" /> : null}
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
            {/* El motivo que escribió el docente. Sin esto, el cartel de pausa
                es indistinguible de una falla: el estudiante no sabe si es
                algo suyo, si es general ni cuánto va a durar, y no puede
                preguntar porque salir del examen le cuesta una advertencia.
                Va en su propio recuadro y con el rótulo de quién lo escribe,
                para que no se lea como un texto más de la plataforma. */}
            {mensajeDePausa && (
              <div className="rounded-md border bg-muted/50 p-3 text-left space-y-1">
                <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("hc_routesAppStudentTakeExamId.pauseReasonFromTeacher")}
                </p>
                <p className="text-sm whitespace-pre-wrap break-words">{mensajeDePausa}</p>
              </div>
            )}
          </div>
        </div>
      )}
      {/* Sticky header with timer — full-bleed on mobile via negative margins matching AppLayout's px-4 */}
      <div className="sticky top-14 md:top-0 z-20 bg-background/95 backdrop-blur border-b -mx-4 md:-mx-8 px-4 md:px-8 py-3 mb-4 sm:mb-5 flex items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate text-sm sm:text-base">{exam.title}</div>
          <div className="text-2xs sm:text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5">
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
              className="text-3xs sm:text-xs text-warning-on-subtle border-warning/40 bg-warning/10"
            >
              <WifiOff className="h-3 w-3 sm:mr-1" />
              <span className="hidden sm:inline">
                {t("hc_routesAppStudentTakeExamId.offline")}
              </span>
            </Badge>
          )}
          {saveFailed && (
            <Badge
              variant="destructive"
              className="text-3xs sm:text-xs"
              title={t("hc_routesAppStudentTakeExamId.saveFailedHint", {
                defaultValue:
                  "El último guardado automático falló. Tus respuestas siguen en este dispositivo; revisa tu conexión.",
              })}
            >
              <AlertTriangle className="h-3 w-3 sm:mr-1" />
              <span className="hidden sm:inline">
                {t("hc_routesAppStudentTakeExamId.saveFailedBadge", {
                  defaultValue: "Sin guardar",
                })}
              </span>
            </Badge>
          )}
          {isPaused && (
            <Badge
              variant="outline"
              className="text-3xs sm:text-xs text-primary border-primary/40 bg-primary/10 animate-pulse"
            >
              <Pause className="h-3 w-3 sm:mr-1" />
              <span className="hidden sm:inline">
                {t("hc_routesAppStudentTakeExamId.paused")}
              </span>
            </Badge>
          )}
          <Badge
            variant={warnings > 0 ? "destructive" : "outline"}
            className="text-3xs sm:text-xs"
          >
            <AlertTriangle className="h-3 w-3 mr-0.5 sm:mr-1" />
            {warnings}/{maxWarnings}
          </Badge>
          <Badge
            className={`text-3xs sm:text-xs ${isLowTime ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}
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
              {/* `p-3` en móvil: con `p-5` fijo, el relleno se llevaba 40 px de
                  los 390 de un teléfono y el código quedaba en ~30 caracteres
                  por renglón. En `sm` en adelante se conserva el de siempre. */}
              <CardContent className="p-3 sm:p-5 space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-3xs">
                    #{idx + 1}
                  </Badge>
                  <Badge variant="secondary" className="text-3xs">
                    {QUESTION_TYPE_LABEL_KEY[q.type]
                      ? t(QUESTION_TYPE_LABEL_KEY[q.type])
                      : q.type}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {t("hc_routesAppStudentTakeExamId.pointsAbbr", { points: q.points })}
                  </span>
                  {/* Solo aparece cuando hay algo que restablecer: con la
                      pregunta intacta no haría nada, y un botón que no hace
                      nada enseña que la pantalla está muerta. */}
                  {hayAlgoQueRestablecer(q, answers[q.id]) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto h-8 px-2 text-muted-foreground hover:text-foreground"
                      onClick={() => void restablecerPregunta(q)}
                      title={t("hc_routesAppStudentTakeExamId.resetTitle")}
                    >
                      <RotateCcw className="h-3.5 w-3.5 sm:mr-1" />
                      <span className="hidden sm:inline">
                        {t("hc_routesAppStudentTakeExamId.resetAction")}
                      </span>
                    </Button>
                  )}
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
                      zoomScopeKey={q.id}
                      // El editor ampliado es `fixed inset-0` y tapa el
                      // encabezado del examen, donde vive el reloj. Un alumno
                      // que amplía para escribir y deja de ver cuánto le queda
                      // está peor que antes de ampliar.
                      barraSuperior={
                        <>
                          <Badge
                            variant={warnings > 0 ? "destructive" : "outline"}
                            className="text-3xs sm:text-xs"
                          >
                            <AlertTriangle className="h-3 w-3 mr-0.5 sm:mr-1" />
                            {warnings}/{maxWarnings}
                          </Badge>
                          <Badge
                            className={`text-3xs sm:text-xs ${isLowTime ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}
                          >
                            <Clock className="h-3 w-3 mr-0.5 sm:mr-1" />
                            {formattedTime}
                          </Badge>
                        </>
                      }
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
                          zoomScopeKey={q.id}
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
                      zoomScopeKey={q.id}
                    />
                  </div>
                ) : q.type === "red_consola" ? (
                  networkScenarios[q.id] ? (
                    <div onBlur={saveAnswersNow}>
                      <NetworkConsole
                        scenario={networkScenarios[q.id]}
                        value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : null}
                        onChange={(v) => updateAnswer(q.id, v)}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-destructive">
                      {t("hc_routesAppStudentTakeExamId.networkScenarioMissing", {
                        defaultValue: "Esta pregunta de red no tiene un escenario válido configurado.",
                      })}
                    </p>
                  )
                ) : q.type === "bd_sql" ? (
                  <div onBlur={saveAnswersNow}>
                    <SqlRunner
                      value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : null}
                      onChange={(v) => updateAnswer(q.id, v)}
                      setupSql={(q.options as { db?: { setupSql?: string } } | null)?.db?.setupSql ?? null}
                      starterSql={q.starter_code}
                      zoomScopeKey={q.id}
                    />
                  </div>
                ) : q.type === "red_gui" ? (
                  networkScenarios[q.id] ? (
                    <div onBlur={saveAnswersNow}>
                      <NetworkTopologyEditor
                        scenario={networkScenarios[q.id]}
                        value={typeof answers[q.id] === "string" ? (answers[q.id] as string) : null}
                        onChange={(v) => updateAnswer(q.id, v)}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-destructive">
                      {t("hc_routesAppStudentTakeExamId.networkScenarioMissing", {
                        defaultValue: "Esta pregunta de red no tiene un escenario válido configurado.",
                      })}
                    </p>
                  )
                ) : (
                  <OpenAnswerTextarea
                    value={String(answers[q.id] ?? "")}
                    onChange={(v) => updateAnswer(q.id, v)}
                    onBlur={saveAnswersNow}
                    placeholder={t("hc_routesAppStudentTakeExamId.yourAnswerPlaceholder")}
                    max={maxOpenChars}
                  />
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
      {/* Última pregunta: el aviso va PEGADO al botón que hay que pulsar, no en
          la cabecera. Quien llega acá ya no va a scrollear hacia arriba, y este
          es el punto exacto donde un intento queda "en progreso" para siempre si
          la persona cierra la pestaña creyendo que terminó. */}
      {currentIdx === questions.length - 1 && (
        <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm space-y-1">
          <p className="font-semibold flex items-center gap-2">
            <Send className="h-4 w-4 shrink-0" />
            {t("exam.lastQuestionTitle")}
          </p>
          <p className="text-muted-foreground">{t("exam.lastQuestionBody")}</p>
        </div>
      )}

      <div className="sticky bottom-0 z-20 bg-background border-t mt-6 pt-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] -mx-4 px-4 sm:-mx-6 sm:px-6 flex items-center justify-between gap-2">
        <Button
          variant="outline"
          // En navegación secuencial el alumno NO puede volver atrás
          // una vez que avanza, así que deshabilitamos "Anterior"
          // siempre. En libre solo cuando está en la primera pregunta.
          disabled={exam.navigation_type === "secuencial" || currentIdx === 0}
          onClick={() => {
            const next = currentIdx - 1;
            // Sincronizar el ref ANTES del save: saveAnswersNow lee
            // currentIdxRef.current de forma síncrona y el effect que
            // sincroniza el ref corre DESPUÉS del commit del render, así que
            // sin esto persistiríamos el índice ANTERIOR (mismo patrón que
            // answersRef en updateAnswer).
            currentIdxRef.current = next;
            setCurrentIdx(next);
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
                const next = currentIdx + 1;
                currentIdxRef.current = next; // sincronizar ref antes del save síncrono
                setCurrentIdx(next);
                void saveAnswersNow();
              }
            }}
          >
            {t("exam.next")}
          </Button>
        ) : (
          <Button onClick={() => void requestManualSubmit()} disabled={busySubmit}>
            {busySubmit ? (
              <Spinner size="md" className="mr-1" />
            ) : (
              <Send className="h-4 w-4 mr-1" />
            )}
            {busySubmit
              ? t("hc_routesAppStudentTakeExamId.submittingLabel", {
                  defaultValue: "Entregando…",
                })
              : t("exam.finish")}
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
                const next = currentIdx + 1;
                currentIdxRef.current = next; // sincronizar ref antes del save síncrono
                setCurrentIdx(next);
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
              disabled={leavingExam || busySubmit}
              onClick={async () => {
                // Anti doble-click: sin guard, dos clicks sumaban DOS strikes.
                if (leavingExam) return;
                setLeavingExam(true);
                try {
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
                      // El strike y la salida siguen adelante, pero el alumno
                      // debe saber que el guardado no llegó al servidor.
                      console.error("[ExamLab] leave strike save failed:", e);
                      toast.error(friendlyError(e));
                    }
                    if (shouldMarkSuspicious(nw, maxWarnings)) {
                      toast.error(
                        i18n.t("toast.routes_app_student_take_examId.exitLimitExceeded", {
                          defaultValue:
                            "Has superado el límite de salidas. El examen se suspende.",
                        }),
                      );
                      await performSubmit(true);
                      return;
                    }
                  }
                  setManualLeaveOpen(false);
                  navigate({ to: "/app/student/exams" });
                } catch (e) {
                  toast.error(friendlyError(e));
                } finally {
                  setLeavingExam(false);
                }
              }}
            >
              {leavingExam ? <Spinner size="md" className="mr-1" /> : null}
              {t("hc_routesAppStudentTakeExamId.leaveRegisterStrike")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={submitModal.open} onOpenChange={(open) => !open && cancelManualSubmitModal()}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {/* El ícono ámbar de advertencia es para las vacías. Con todo
                  respondido esto NO es una advertencia —es una confirmación—, y
                  pintarlo igual entrenaría a ignorar el amarillo. */}
              {submitModal.unansweredIndices.length > 0 ? (
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500" />
              ) : (
                <Send className="h-5 w-5 shrink-0 text-primary" />
              )}
              {submitModal.unansweredIndices.length > 0
                ? t("hc_routesAppStudentTakeExamId.unansweredQuestionsRemain")
                : t("hc_routesAppStudentTakeExamId.confirmSubmitTitle")}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 text-left text-sm text-muted-foreground">
                <p>
                  {submitModal.unansweredIndices.length > 0
                    ? t("hc_routesAppStudentTakeExamId.unansweredQuestionsDesc")
                    : t("hc_routesAppStudentTakeExamId.confirmSubmitDesc")}
                </p>
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
                      <p className="text-3xs mt-1 text-muted-foreground">
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
              disabled={busySubmit}
            >
              {busySubmit ? (
                <Spinner size="md" className="mr-1" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              {submitModal.unansweredIndices.length > 0
                ? t("hc_routesAppStudentTakeExamId.submitAnyway")
                : t("hc_routesAppStudentTakeExamId.confirmSubmitConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
