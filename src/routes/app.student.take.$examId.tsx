import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useRealtimeTimer } from "@/hooks/use-realtime-timer";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { AlertTriangle, Clock, Maximize2, Send, Loader2, Pause, WifiOff } from "lucide-react";
import { CodeEditor, type CodeLanguage } from "@/components/CodeEditor";
import { saveAnswersLocally, isOnline, setupOfflineSync } from "@/lib/offline-sync";

export const Route = createFileRoute("/app/student/take/$examId")({ component: TakeExam });

type Question = { id: string; type: string; content: string; options: any; points: number; position: number; language?: string | null; starter_code?: string | null };
type Exam = { id: string; title: string; time_limit_minutes: number; navigation_type: string; shuffle_enabled: boolean; start_time: string; end_time: string };

const MAX_WARNINGS = 3;

function TakeExam() {
  const { examId } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [exam, setExam] = useState<Exam | null>(null);
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
  const submittedRef = useRef(false);
  const submissionIdRef = useRef<string | null>(null);

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
      const { data: e } = await supabase.from("exams").select("*").eq("id", examId).single();
      if (!e) { toast.error("Examen no encontrado"); navigate({ to: "/app/student/exams" }); return; }
      const now = Date.now();
      if (now < new Date(e.start_time).getTime() || now > new Date(e.end_time).getTime()) {
        toast.error("Este examen no está disponible ahora"); navigate({ to: "/app/student/exams" }); return;
      }
      const { data: asg } = await supabase.from("exam_assignments").select("id").eq("exam_id", examId).eq("user_id", user.id).maybeSingle();
      if (!asg) { toast.error("No estás asignado a este examen"); navigate({ to: "/app/student/exams" }); return; }
      setExam(e);
      let { data: qs } = await supabase.from("questions").select("*").eq("exam_id", examId).order("position");
      if (e.shuffle_enabled && qs) qs = [...qs].sort(() => Math.random() - 0.5);
      setQuestions(qs ?? []);

      const { data: sub } = await supabase.from("submissions").select("*").eq("exam_id", examId).eq("user_id", user.id).maybeSingle();
      if (sub) {
        if (sub.status === "completado" || sub.status === "sospechoso") {
          toast.info("Ya completaste este examen"); navigate({ to: "/app/student/exams" }); return;
        }
        setSubmissionId(sub.id);
        submissionIdRef.current = sub.id;
        setAnswers((sub.answers as Record<string, any>) ?? {});
        setWarnings(sub.focus_warnings ?? 0);
      }
    })();
  }, [examId, user, navigate]);

  const startExam = async () => {
    if (!user || !exam) return;
    let sid = submissionId;
    if (!sid) {
      const { data, error } = await supabase.from("submissions").insert({
        exam_id: examId, user_id: user.id, answers: {}, status: "en_progreso",
      }).select().single();
      if (error) { toast.error(error.message); return; }
      sid = data.id;
      setSubmissionId(sid);
      submissionIdRef.current = sid;
    }
    try { await document.documentElement.requestFullscreen(); } catch { }
    setStarted(true);
  };

  const submitExam = useCallback(async (markSuspicious = false) => {
    if (submittedRef.current || !submissionIdRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);

    const updateData = {
      answers,
      status: markSuspicious ? "sospechoso" : "completado",
      focus_warnings: warnings,
      submitted_at: new Date().toISOString(),
    };

    if (isOnline()) {
      await supabase.from("submissions").update(updateData).eq("id", submissionIdRef.current);
    } else {
      await saveAnswersLocally(examId, {
        submissionId: submissionIdRef.current,
        answers,
        warnings,
        timestamp: Date.now(),
      });
    }

    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { }
    try {
      if (isOnline()) {
        await supabase.functions.invoke("ai-grade-submission", { body: { submissionId: submissionIdRef.current } });
      }
    } catch (e) { console.error(e); }
    toast.success("Examen entregado");
    navigate({ to: "/app/student/exams" });
  }, [answers, warnings, navigate, examId]);

  // Realtime timer
  const handleTimeUp = useCallback(() => {
    if (!submittedRef.current) submitExam(false);
  }, [submitExam]);

  const { secondsLeft, isPaused, formattedTime, isLowTime } = useRealtimeTimer({
    examId,
    userId: user?.id ?? "",
    initialSeconds: exam?.time_limit_minutes ? exam.time_limit_minutes * 60 : 0,
    onTimeUp: handleTimeUp,
    onPause: () => toast.info("⏸ El docente ha pausado el temporizador"),
    onResume: () => toast.info("▶ El temporizador ha sido reanudado"),
    onTimeAdded: (secs) => toast.success(`+${Math.floor(secs / 60)} minuto(s) extra añadidos`),
  });

  // Auto-save answers (with offline support)
  useEffect(() => {
    if (!started || !submissionIdRef.current) return;
    const t = setTimeout(async () => {
      if (isOnline()) {
        supabase.from("submissions").update({ answers, focus_warnings: warnings }).eq("id", submissionIdRef.current!);
      }
      // Always save locally as backup
      await saveAnswersLocally(examId, {
        submissionId: submissionIdRef.current!,
        answers,
        warnings,
        timestamp: Date.now(),
      });
    }, 1500);
    return () => clearTimeout(t);
  }, [answers, warnings, started, examId]);

  // Proctoring: focus tracking, copy/paste blocking
  useEffect(() => {
    if (!started) return;
    const onBlur = () => {
      setWarnings(w => {
        const nw = w + 1;
        if (nw >= MAX_WARNINGS) {
          toast.error("Has superado el límite de salidas. El examen se marca como sospechoso.");
          submitExam(true);
        } else {
          toast.warning(`Advertencia ${nw}/${MAX_WARNINGS}: no salgas de la pestaña`);
        }
        return nw;
      });
    };
    const onContext = (e: Event) => e.preventDefault();
    const onCopy = (e: Event) => { e.preventDefault(); toast.warning("Copiar/pegar deshabilitado"); };
    const onSelect = (e: Event) => e.preventDefault();
    const onFsChange = () => {
      if (!document.fullscreenElement && started && !submittedRef.current) {
        toast.warning("Mantén la pantalla completa");
      }
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("contextmenu", onContext);
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onCopy);
    document.addEventListener("selectstart", onSelect);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("contextmenu", onContext);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onCopy);
      document.removeEventListener("selectstart", onSelect);
      document.removeEventListener("fullscreenchange", onFsChange);
    };
  }, [started, submitExam]);

  // Run code for a question
  const runCode = async (questionId: string, language: CodeLanguage) => {
    const code = answers[questionId];
    if (!code?.trim()) { toast.error("Escribe código antes de ejecutar"); return; }
    setRunningCode(prev => ({ ...prev, [questionId]: true }));
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
      setCodeOutputs(prev => ({ ...prev, [questionId]: output }));
    } catch (e: any) {
      setCodeOutputs(prev => ({ ...prev, [questionId]: `Error: ${e.message}` }));
    } finally {
      setRunningCode(prev => ({ ...prev, [questionId]: false }));
    }
  };

  if (!exam) return <p className="text-muted-foreground p-6">Cargando…</p>;

  if (!started) {
    return (
      <div className="max-w-2xl mx-auto py-10">
        <Card>
          <CardContent className="p-6 space-y-4">
            <h1 className="text-2xl font-semibold">{exam.title}</h1>
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm space-y-2">
              <p className="font-semibold flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warning-foreground" />Antes de comenzar</p>
              <ul className="list-disc list-inside text-muted-foreground space-y-1">
                <li>Duración: <strong>{exam.time_limit_minutes} minutos</strong>. El tiempo no se pausa.</li>
                <li>El examen se ejecuta en <strong>pantalla completa</strong>.</li>
                <li>No puedes copiar, pegar ni hacer clic derecho.</li>
                <li>Si sales de la pestaña <strong>{MAX_WARNINGS} veces</strong>, el examen se marca como sospechoso.</li>
                <li>Las respuestas se guardan automáticamente (incluso sin conexión).</li>
              </ul>
            </div>
            <Button size="lg" className="w-full" onClick={startExam}>
              <Maximize2 className="h-4 w-4 mr-2" />Aceptar y comenzar
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const visible = exam.navigation_type === "secuencial" ? [questions[currentIdx]].filter(Boolean) : questions;

  return (
    <div className="max-w-3xl mx-auto py-6 select-none">
      {/* Sticky header with timer */}
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b -mx-4 px-4 py-3 mb-5 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold truncate">{exam.title}</div>
          <div className="text-xs text-muted-foreground">Pregunta {exam.navigation_type === "secuencial" ? currentIdx + 1 : "—"} de {questions.length}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {offline && (
            <Badge variant="outline" className="text-xs text-warning-foreground border-warning/40 bg-warning/10">
              <WifiOff className="h-3 w-3 mr-1" />Sin conexión
            </Badge>
          )}
          {isPaused && (
            <Badge variant="outline" className="text-xs text-primary border-primary/40 bg-primary/10 animate-pulse">
              <Pause className="h-3 w-3 mr-1" />Pausado
            </Badge>
          )}
          <Badge variant={warnings > 0 ? "destructive" : "outline"} className="text-xs">
            <AlertTriangle className="h-3 w-3 mr-1" />{warnings}/{MAX_WARNINGS}
          </Badge>
          <Badge className={`text-xs ${isLowTime ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}>
            <Clock className="h-3 w-3 mr-1" />{formattedTime}
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
                  <Badge variant="outline" className="text-[10px]">#{idx + 1}</Badge>
                  <Badge variant="secondary" className="text-[10px]">{q.type}</Badge>
                  <span className="text-xs text-muted-foreground">{q.points} pt</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{q.content}</p>

                {q.type === "cerrada" && q.options?.choices ? (
                  <div className="space-y-1.5">
                    {q.options.choices.map((c: string, ci: number) => (
                      <label key={ci} className="flex items-start gap-2 p-2 rounded border hover:bg-muted/50 cursor-pointer">
                        <input
                          type="radio"
                          name={`q-${q.id}`}
                          checked={answers[q.id] === ci}
                          onChange={() => setAnswers({ ...answers, [q.id]: ci })}
                          className="mt-1"
                        />
                        <span className="text-sm">{String.fromCharCode(65 + ci)}. {c}</span>
                      </label>
                    ))}
                  </div>
                ) : q.type === "codigo" ? (
                  <CodeEditor
                    value={answers[q.id] ?? q.starter_code ?? ""}
                    onChange={(v) => setAnswers({ ...answers, [q.id]: v })}
                    language={lang}
                    onRun={() => runCode(q.id, lang)}
                    output={codeOutputs[q.id]}
                    isRunning={runningCode[q.id] ?? false}
                    showLanguageSelector={false}
                    showRunButton={true}
                    height="250px"
                  />
                ) : (
                  <Textarea
                    rows={4}
                    placeholder="Tu respuesta…"
                    value={answers[q.id] ?? ""}
                    onChange={e => setAnswers({ ...answers, [q.id]: e.target.value })}
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
            <Button variant="outline" disabled={currentIdx === 0} onClick={() => setCurrentIdx(i => i - 1)}>Anterior</Button>
            {currentIdx < questions.length - 1 ? (
              <Button onClick={() => setCurrentIdx(i => i + 1)}>Siguiente</Button>
            ) : (
              <Button onClick={() => submitExam(false)} disabled={submitting}>
                {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
                Entregar
              </Button>
            )}
          </>
        ) : (
          <Button className="w-full" onClick={() => submitExam(false)} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Send className="h-4 w-4 mr-1" />}
            Entregar examen
          </Button>
        )}
      </div>
    </div>
  );
}
