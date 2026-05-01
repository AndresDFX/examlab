import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
  ArrowLeft,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Sparkles,
  Trash2,
  Eye,
  Save,
  TimerReset,
} from "lucide-react";
import { warningLabel, warningEventTimestamp, type WarningEvent } from "@/utils/proctoring";
import {
  computeFinalGrade,
  type BreakdownItem as GradeBreakdown,
  type ManualOverride as GradeManual,
} from "@/utils/grade";
import {
  computeAttemptGrade,
  retryModeLabel,
  type RetryMode,
} from "@/utils/exam-attempts";
import { useConfirm } from "@/components/ConfirmDialog";

export const Route = createFileRoute("/app/teacher/monitor/$examId")({ component: ExamMonitor });

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
  const [overrideValue, setOverrideValue] = useState<string>("");
  const [savingOverride, setSavingOverride] = useState(false);
  const [qOverrides, setQOverrides] = useState<Record<string, { score: string; feedback: string }>>(
    {},
  );
  const [savingQid, setSavingQid] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: e } = await (supabase as any)
      .from("exams")
      .select(
        "*, course:courses(name, grade_scale_max, max_exam_attempts)",
      )
      .eq("id", examId)
      .single();
    setExam(e);

    const { data: subs } = await supabase
      .from("submissions")
      .select(
        "id, user_id, status, focus_warnings, answers, ai_grade, final_override_grade, created_at, started_at, submitted_at",
      )
      .eq("exam_id", examId)
      .order("created_at", { ascending: true });

    if (subs?.length) {
      const userIds = Array.from(new Set(subs.map((s) => s.user_id)));
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds);

      const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      setSubmissions(
        subs.map((s) => ({ ...s, profile: profileMap.get(s.user_id) })) as Submission[],
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
    setLoading(null);
    if (error) return toast.error(error.message);

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

  const deleteSubmission = async (sub: Submission) => {
    const name = sub.profile?.full_name ?? "este estudiante";
    const ok = await confirm({
      title: `Eliminar entrega de ${name}`,
      description: "Se eliminará la entrega del estudiante de forma permanente.",
      confirmLabel: "Eliminar entrega",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("submissions").delete().eq("id", sub.id);
    if (error) return toast.error(error.message);
    setSubmissions((prev) => prev.filter((s) => s.id !== sub.id));
    toast.success("Entrega eliminada correctamente");
  };

  const openView = (sub: Submission) => {
    setViewingId(sub.id);
    const cur = sub.final_override_grade ?? sub.ai_grade;
    setOverrideValue(cur != null ? String(cur) : "");
    const manual: Record<string, ManualOverride> = sub.answers?.__manual_overrides ?? {};
    const next: Record<string, { score: string; feedback: string }> = {};
    for (const [qid, v] of Object.entries(manual)) {
      next[qid] = { score: v.score != null ? String(v.score) : "", feedback: v.feedback ?? "" };
    }
    setQOverrides(next);
  };

  const saveOverride = async (sub: Submission) => {
    const trimmed = overrideValue.trim();
    const numValue = trimmed === "" ? null : Number(trimmed);
    if (numValue != null && (Number.isNaN(numValue) || numValue < 0 || numValue > 5)) {
      toast.error("La nota debe ser un número entre 0 y 5");
      return;
    }
    setSavingOverride(true);
    const { error } = await supabase
      .from("submissions")
      .update({ final_override_grade: numValue })
      .eq("id", sub.id);
    setSavingOverride(false);
    if (error) return toast.error(error.message);
    toast.success(numValue == null ? "Nota manual eliminada" : "Nota guardada correctamente");
    setSubmissions((prev) =>
      prev.map((s) => (s.id === sub.id ? { ...s, final_override_grade: numValue } : s)),
    );
  };

  const saveQuestionOverride = async (sub: Submission, q: Question) => {
    const entry = qOverrides[q.id] ?? { score: "", feedback: "" };
    const trimmed = entry.score.trim();
    let numScore: number | null = null;
    if (trimmed !== "") {
      numScore = Number(trimmed);
      if (Number.isNaN(numScore) || numScore < 0 || numScore > q.points) {
        toast.error(`La nota debe estar entre 0 y ${q.points}`);
        return;
      }
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
    toast.success(numScore == null ? "Nota por pregunta eliminada" : "Nota por pregunta guardada");

    setSubmissions((prev) =>
      prev.map((s) =>
        s.id === sub.id ? { ...s, answers: nextAnswers, final_override_grade: recomputed } : s,
      ),
    );
    setOverrideValue(recomputed != null ? String(recomputed) : "");
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
      title: `Eliminar intento del ${new Date(sub.created_at).toLocaleString()}`,
      description:
        "Se eliminará este intento de forma permanente. La nota efectiva del examen se recalculará según el modo de reintento.",
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
    ? studentRows.find((r) => r.userId === attemptsForUser) ?? null
    : null;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Link to="/app/teacher/exams">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            {t("common.back")}
          </Button>
        </Link>
        <div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
            {t("monitor.title")}: {exam.title}
          </h1>
          <p className="text-sm text-muted-foreground">
            {exam.course?.name} · Modo de reintento:{" "}
            <span className="font-medium">{retryModeLabel(retryMode)}</span> · Máx. intentos:{" "}
            {maxAttempts}
          </p>
        </div>
      </div>

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
                <TableHead>Intentos</TableHead>
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>Nota efectiva</TableHead>
                <TableHead>{t("monitor.warnings")}</TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {studentRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    Ningún estudiante ha iniciado el examen aún.
                  </TableCell>
                </TableRow>
              )}
              {studentRows.map((row) => {
                const latest = row.latest;
                const inProg = !!row.inProgress;
                return (
                  <TableRow key={row.userId}>
                    <TableCell>
                      <div className="font-medium">{row.profile?.full_name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.profile?.institutional_email}
                      </div>
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="text-sm font-medium underline-offset-2 hover:underline"
                        onClick={() => setAttemptsForUser(row.userId)}
                        title="Ver y gestionar intentos"
                      >
                        {row.currentNumber} de {maxAttempts}
                      </button>
                    </TableCell>
                    <TableCell>
                      {inProg ? (
                        <Badge className="bg-success text-success-foreground text-[10px]">
                          En progreso
                        </Badge>
                      ) : latest.status === "sospechoso" ? (
                        <Badge variant="destructive" className="text-[10px]">
                          <AlertTriangle className="h-3 w-3 mr-0.5" /> Sospechoso
                        </Badge>
                      ) : isFinalStatus(latest.status) ? (
                        <Badge variant="secondary" className="text-[10px]">
                          <CheckCircle2 className="h-3 w-3 mr-0.5" /> Completado
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          {latest.status}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {row.effectiveGrade == null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-col items-start">
                          <span className="font-medium">{row.effectiveGrade}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {retryModeLabel(retryMode)}
                          </span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={latest.focus_warnings > 0 ? "destructive" : "outline"}
                        className="text-[10px]"
                      >
                        {latest.focus_warnings}/3
                      </Badge>
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
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <TimerReset className="h-3.5 w-3.5" />
                            )}
                            <span className="ml-1 text-[11px]">+5m</span>
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setAttemptsForUser(row.userId)}
                          title="Ver intentos"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </Button>
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
      <Dialog
        open={attemptsForUser != null}
        onOpenChange={(o) => !o && setAttemptsForUser(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              Intentos de {attemptsRow?.profile?.full_name ?? "—"}
            </DialogTitle>
            <DialogDescription>
              {attemptsRow?.profile?.institutional_email} ·{" "}
              {attemptsRow?.attemptsUsed ?? 0} finalizado(s) ·{" "}
              {attemptsRow?.currentNumber ?? 0} de {maxAttempts} usados ·{" "}
              Modo: {retryModeLabel(retryMode)}
            </DialogDescription>
          </DialogHeader>
          {attemptsRow && (
            <div className="space-y-3">
              <div className="rounded-md border p-3 flex items-center justify-between">
                <div className="text-sm">
                  Nota efectiva:{" "}
                  <span className="font-semibold">
                    {attemptsRow.effectiveGrade ?? "—"}
                  </span>
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
                    return (
                      <div
                        key={a.id}
                        className="rounded-md border p-3 flex items-center justify-between gap-3"
                      >
                        <div className="space-y-1">
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <span>Intento {idx + 1}</span>
                            {a.status === "en_progreso" ? (
                              <Badge className="bg-success text-success-foreground text-[10px]">
                                En progreso
                              </Badge>
                            ) : a.status === "sospechoso" ? (
                              <Badge variant="destructive" className="text-[10px]">
                                Sospechoso
                              </Badge>
                            ) : (
                              <Badge variant="secondary" className="text-[10px]">
                                {a.status}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            Iniciado: {new Date(a.started_at ?? a.created_at).toLocaleString()}
                            {a.submitted_at && (
                              <> · Entregado: {new Date(a.submitted_at).toLocaleString()}</>
                            )}
                          </div>
                          <div className="text-xs">
                            Nota:{" "}
                            <span className="font-medium tabular-nums">
                              {grade != null ? grade : "—"}
                            </span>{" "}
                            · Advertencias: {a.focus_warnings}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          {isFinal && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                openView(a);
                              }}
                              title="Ver respuestas y calificar"
                            >
                              <Eye className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => deleteOneAttempt(a)}
                            title="Eliminar este intento"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
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
              {viewingSub?.profile?.institutional_email} · Estado: {viewingSub?.status}
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
                        <CardTitle className="text-sm flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-destructive" />
                          Eventos de advertencia ({events.length})
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="text-xs space-y-1">
                        {events.map((ev, i) => {
                          const ts = warningEventTimestamp(ev);
                          return (
                            <div key={i} className="flex items-center gap-2">
                              <span className="text-muted-foreground tabular-nums">
                                {ts ? new Date(ts).toLocaleString() : "—"}
                              </span>
                              <span className="font-medium">{warningLabel(ev.type)}</span>
                              {typeof ev.questionIdx === "number" && (
                                <span className="text-muted-foreground">
                                  · pregunta {ev.questionIdx + 1}
                                </span>
                              )}
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
                    const qEntry = qOverrides[q.id] ?? { score: "", feedback: "" };
                    return (
                      <Card key={q.id}>
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

                          {q.type !== "cerrada" && (
                            <div className="rounded border bg-muted/30 p-2 text-xs whitespace-pre-wrap font-mono min-h-[40px]">
                              {ans == null || ans === "" ? (
                                <span className="text-muted-foreground italic">Sin responder</span>
                              ) : typeof ans === "string" ? (
                                ans
                              ) : (
                                JSON.stringify(ans, null, 2)
                              )}
                            </div>
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
                              <Input
                                type="number"
                                min={0}
                                max={q.points}
                                step={0.1}
                                placeholder={`Nota manual 0-${q.points}`}
                                value={qEntry.score}
                                onChange={(e) =>
                                  setQOverrides((prev) => ({
                                    ...prev,
                                    [q.id]: {
                                      ...(prev[q.id] ?? { score: "", feedback: "" }),
                                      score: e.target.value,
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
                                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
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
                                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
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
                                    ...(prev[q.id] ?? { score: "", feedback: "" }),
                                    feedback: e.target.value,
                                  },
                                }))
                              }
                              className="text-xs min-h-[50px]"
                            />
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
                    <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5 mr-1" />
                  )}
                  Recalificar todo con IA
                </Button>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={5}
                    step={0.1}
                    placeholder="Nota 0-5"
                    value={overrideValue}
                    onChange={(e) => setOverrideValue(e.target.value)}
                    className="w-24 h-8 text-sm"
                  />
                  <Button
                    size="sm"
                    onClick={() => saveOverride(viewingSub)}
                    disabled={savingOverride}
                  >
                    {savingOverride ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5 mr-1" />
                    )}
                    Guardar nota
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
