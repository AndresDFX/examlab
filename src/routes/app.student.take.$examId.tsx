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
import { AlertTriangle, Clock, Maximize2, Send, Loader2, Pause, WifiOff, FileText, ChevronDown, ChevronUp } from "lucide-react";
import { CodeEditor, type CodeLanguage } from "@/components/CodeEditor";
import { DiagramEditor } from "@/components/DiagramEditor";
import { saveAnswersLocally, isOnline, setupOfflineSync } from "@/lib/offline-sync";
import { useTranslation } from "react-i18next";
import { computeSecondsLeft, isExamOpen } from "@/utils/exam-time";
import { MAX_WARNINGS, shouldMarkSuspicious, warningLabel } from "@/utils/proctoring";
import { useCourseLanguage } from "@/hooks/use-course-language";
import { useApprovedExamNote } from "@/components/ExamNotesManager";

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
  /** Populated via join `course:courses(language)` when available. */
  course?: { language?: string | null } | null;
};

/** Considera contestada la celda según tipo (incluye plantilla de código si no hubo edición). */
function isQuestionAnswered(q: Question, answers: Record<string, unknown>): boolean {
  const v = answers[q.id];
  if (q.type === "cerrada") {
    return typeof v === "number" && v >= 0;
  }
  if (q.type === "codigo") {
    const code = (typeof v === "string" ? v : "").trim() || (q.starter_code ?? "").trim();
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
    if (q.type !== "codigo") continue;
    const cur = next[q.id];
    const empty = cur === undefined || cur === null || String(cur).trim() === "";
    if (empty && (q.starter_code ?? "").trim()) next[q.id] = q.starter_code;
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
  const [questions, setQuestions] = useState<Question[]>([]);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [started, setStarted] = useState(false);
  const [warnings, setWarnings] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [codeOutputs, setCodeOutputs] = useState<Record<string, string>>({});
  const [runningCode, setRunningCode] = useState<Record<string, boolean>>({});
  const [offline, setOffline] = useState(!isOnline());
  const [submitModal, setSubmitModal] = useState<{
    open: boolean;
    unansweredIndices: number[];
  }>({ open: false, unansweredIndices: [] });
  const submittedRef = useRef(false);
  const submissionIdRef = useRef<string | null>(null);
  const warningsRef = useRef(0);
  const answersRef = useRef<Record<string, any>>({});
  const warningEventsRef = useRef<Array<{ type: string; at: string; questionIdx: number | null }>>(
    [],
  );

  // Keep refs in sync with state for synchronous reads in event handlers
  useEffect(() => {
    warningsRef.current = warnings;
  }, [warnings]);
  useEffect(() => {
    answersRef.current = answers;
  }, [answers]);

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

    const cleanup = setupOfflineSync((count) => {
      toast.success(`${count} respuesta(s) sincronizada(s) automáticamente`);
    });

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: e } = await (supabase as any)
        .from("exams")
        .select("*, course:courses(language, max_exam_attempts)")
        .eq("id", examId)
        .single();
      if (!e) {
        toast.error("Examen no encontrado");
        navigate({ to: "/app/student/exams" });
        return;
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

      if (inProgress) {
        // Reanudar el intento en curso
        setSubmissionId(inProgress.id);
        submissionIdRef.current = inProgress.id;
        const existingAnswers = (inProgress.answers as Record<string, any>) ?? {};
        setAnswers(existingAnswers);
        answersRef.current = existingAnswers;
        const persistedWarnings = inProgress.focus_warnings ?? 0;
        setWarnings(persistedWarnings);
        warningsRef.current = persistedWarnings;
        const persistedEvents = Array.isArray(existingAnswers.__warning_events)
          ? existingAnswers.__warning_events
          : [];
        warningEventsRef.current = persistedEvents;
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
          `Intento ${finishedCount + 1} de ${maxAttempts}. Tu nota anterior se reemplazará por la de este intento.`,
        );
      }
      setExam(e);
    })();
  }, [examId, user, navigate]);

  const startExam = async () => {
    if (!user || !exam) return;
    let sid = submissionId;
    if (!sid) {
      const { data, error } = await supabase
        .from("submissions")
        .insert({
          exam_id: examId,
          user_id: user.id,
          answers: {},
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
    }
    // TODO: Re-enable fullscreen when ready
    // try { await document.documentElement.requestFullscreen(); } catch { }
    setStarted(true);
  };

  // Persistir respuestas inmediatamente (autosave, entrega, tiempo agotado)
  const saveAnswersNow = useCallback(async () => {
    if (!submissionIdRef.current) return;
    const currentAnswers = answersRef.current;
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

      // Notify course teachers via RPC (students cannot INSERT into
      // notifications directly under current RLS; the function runs with
      // SECURITY DEFINER and authorizes by the caller's submission)
      if (markSuspicious && exam) {
        try {
          const { data: profile } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("id", user!.id)
            .single();
          const studentName = profile?.full_name ?? "Un estudiante";

          const events = warningEventsRef.current.slice(-MAX_WARNINGS);
          const eventLines = events
            .map((ev, i) => {
              const when = new Date(ev.at).toLocaleTimeString("es-CO", {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });
              const where = ev.questionIdx != null ? ` (pregunta ${ev.questionIdx + 1})` : "";
              return `${i + 1}. ${warningLabel(ev.type)} — ${when}${where}`;
            })
            .join("\n");
          const body = `${studentName} fue suspendido del examen "${exam.title}" por superar el límite de ${MAX_WARNINGS} advertencias.\n\nAcciones detectadas:\n${eventLines || "(sin detalle)"}`;

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
      }

      try {
        if (document.fullscreenElement) await document.exitFullscreen();
      } catch {}
      try {
        await supabase.functions.invoke("ai-grade-submission", {
          body: { submissionId: submissionIdRef.current },
        });
      } catch (e) {
        console.error(e);
      }
      toast.success(markSuspicious ? "Examen suspendido" : "Examen entregado correctamente");
      navigate({ to: "/app/student/exams" });
    },
    [navigate, examId, exam, user, questions],
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

  const initialSeconds = computeSecondsLeft(exam?.end_time);

  const { secondsLeft, isPaused, formattedTime, isLowTime } = useRealtimeTimer({
    examId,
    userId: user?.id ?? "",
    initialSeconds,
    onTimeUp: handleTimeUp,
    onPause: () => toast.info("⏸ El docente ha pausado el temporizador"),
    onResume: () => toast.info("▶ El temporizador ha sido reanudado"),
    onTimeAdded: (secs) => toast.success(`+${Math.floor(secs / 60)} minuto(s) extra añadidos`),
  });

  // Auto-save answers (debounced, also runs on warning increments)
  useEffect(() => {
    if (!started || !submissionIdRef.current) return;
    const t = setTimeout(() => {
      saveAnswersNow();
    }, 1500);
    return () => clearTimeout(t);
  }, [answers, warnings, started, saveAnswersNow]);

  // Proctoring: focus tracking, copy/paste blocking, fullscreen enforcement
  useEffect(() => {
    if (!started) return;
    let blurLockUntil = 0;
    const recordWarning = (type: string) => {
      if (submittedRef.current) return;
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
          .then(() => {});
      }

      if (shouldMarkSuspicious(nw, MAX_WARNINGS)) {
        toast.error("Has superado el límite de salidas. El examen se suspende.");
        performSubmit(true);
      } else {
        toast.warning(`Advertencia ${nw}/${MAX_WARNINGS}: ${warningLabel(type)}`);
      }
    };
    const onBlur = () => recordWarning("pestaña");
    const onContext = (e: Event) => e.preventDefault();
    const onCopy = (e: Event) => {
      e.preventDefault();
      toast.warning("Copiar/pegar deshabilitado");
    };
    const onSelect = (e: Event) => e.preventDefault();
    // TODO: Re-enable fullscreen enforcement when ready
    // const onKeyDown = (e: KeyboardEvent) => {
    //   if (e.key === "Escape") {
    //     e.preventDefault();
    //     e.stopPropagation();
    //   }
    //   if (e.key === "F11") {
    //     e.preventDefault();
    //   }
    //   if (e.altKey && (e.key === "Tab" || e.key === "F4")) {
    //     e.preventDefault();
    //   }
    // };
    // const onFsChange = () => {
    //   if (!document.fullscreenElement && started && !submittedRef.current) {
    //     toast.warning("Debes permanecer en pantalla completa");
    //     setTimeout(() => {
    //       if (!document.fullscreenElement && !submittedRef.current) {
    //         document.documentElement.requestFullscreen().catch(() => {});
    //       }
    //     }, 300);
    //   }
    // };
    window.addEventListener("blur", onBlur);
    document.addEventListener("contextmenu", onContext);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onCopy);
    document.addEventListener("selectstart", onSelect);
    // TODO: Re-enable fullscreen enforcement
    // document.addEventListener("keydown", onKeyDown, true);
    // document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("contextmenu", onContext);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onCopy);
      document.removeEventListener("selectstart", onSelect);
      // document.removeEventListener("keydown", onKeyDown, true);
      // document.removeEventListener("fullscreenchange", onFsChange);
    };
  }, [started, performSubmit]);

  // Run code for a question
  const runCode = async (questionId: string, language: CodeLanguage) => {
    const code = answers[questionId];
    if (!code?.trim()) {
      toast.error("Escribe código antes de ejecutar");
      return;
    }
    setRunningCode((prev) => ({ ...prev, [questionId]: true }));
    try {
      const { data, error } = await supabase.functions.invoke("execute-code", {
        body: {
          sourceCode: code,
          language,
          questionId,
          submissionId: submissionIdRef.current,
        },
      });
      if (error) throw error;
      const output = data.stderr ? `${data.stdout}\n--- ERRORES ---\n${data.stderr}` : data.stdout;
      setCodeOutputs((prev) => ({ ...prev, [questionId]: output }));
    } catch (e: any) {
      setCodeOutputs((prev) => ({ ...prev, [questionId]: `Error: ${e.message}` }));
    } finally {
      setRunningCode((prev) => ({ ...prev, [questionId]: false }));
    }
  };

  if (!exam) return <p className="text-muted-foreground p-6">{t("common.loading")}</p>;

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
                  Duración: <strong>{exam.time_limit_minutes} minutos</strong>. El tiempo no se
                  pausa.
                </li>
                {/* <li>El examen se ejecuta en <strong>pantalla completa</strong>.</li> */}
                <li>No puedes copiar, pegar ni hacer clic derecho.</li>
                <li>
                  Si sales de la pestaña <strong>{MAX_WARNINGS} veces</strong>, el examen se
                  suspende.
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

  const visible =
    exam.navigation_type === "secuencial" ? [questions[currentIdx]].filter(Boolean) : questions;

  return (
    <div className="max-w-3xl mx-auto py-4 sm:py-6 select-none">
      {/* Sticky header with timer — full-bleed on mobile via negative margins matching AppLayout's px-4 */}
      <div className="sticky top-14 md:top-0 z-20 bg-background/95 backdrop-blur border-b -mx-4 md:-mx-8 px-4 md:px-8 py-3 mb-4 sm:mb-5 flex items-center justify-between gap-2 sm:gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate text-sm sm:text-base">{exam.title}</div>
          <div className="text-[11px] sm:text-xs text-muted-foreground">
            {t("exam.question")} {exam.navigation_type === "secuencial" ? currentIdx + 1 : "—"}{" "}
            {t("exam.of")} {questions.length}
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
          <Badge variant={warnings > 0 ? "destructive" : "outline"} className="text-[10px] sm:text-xs">
            <AlertTriangle className="h-3 w-3 mr-0.5 sm:mr-1" />
            {warnings}/{MAX_WARNINGS}
          </Badge>
          <Badge
            className={`text-[10px] sm:text-xs ${isLowTime ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}
          >
            <Clock className="h-3 w-3 mr-0.5 sm:mr-1" />
            {formattedTime}
          </Badge>
        </div>
      </div>

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
                <p className="text-sm whitespace-pre-wrap">{q.content}</p>

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
                ) : q.type === "codigo" ? (
                  <div onBlur={saveAnswersNow}>
                    <CodeEditor
                      value={answers[q.id] ?? q.starter_code ?? ""}
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
                ) : (
                  <Textarea
                    rows={4}
                    placeholder="Tu respuesta…"
                    value={answers[q.id] ?? ""}
                    onChange={(e) => updateAnswer(q.id, e.target.value)}
                    onBlur={saveAnswersNow}
                  />
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between gap-2 mt-6">
        {exam.navigation_type === "secuencial" ? (
          <>
            <Button
              variant="outline"
              disabled={currentIdx === 0}
              onClick={() => setCurrentIdx((i) => i - 1)}
            >
              {t("exam.previous")}
            </Button>
            {currentIdx < questions.length - 1 ? (
              <Button onClick={() => setCurrentIdx((i) => i + 1)}>{t("exam.next")}</Button>
            ) : (
              <Button onClick={() => void requestManualSubmit()} disabled={submitting}>
                {submitting ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-1" />
                )}
                {t("exam.finish")}
              </Button>
            )}
          </>
        ) : (
          <Button
            className="w-full"
            onClick={() => void requestManualSubmit()}
            disabled={submitting}
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-1" />
            )}
            {t("exam.submit")}
          </Button>
        )}
      </div>

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
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
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
