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
  const [overrideValue, setOverrideValue] = useState<string>("");
  const [savingOverride, setSavingOverride] = useState(false);
  const [qOverrides, setQOverrides] = useState<Record<string, { score: string; feedback: string }>>(
    {},
  );
  const [savingQid, setSavingQid] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: e } = await supabase
      .from("exams")
      .select("*, course:courses(name, grade_scale_max)")
      .eq("id", examId)
      .single();
    setExam(e);

    const { data: subs } = await supabase
      .from("submissions")
      .select("id, user_id, status, focus_warnings, answers, ai_grade, final_override_grade")
      .eq("exam_id", examId);

    if (subs?.length) {
      const userIds = subs.map((s) => s.user_id);
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

  const inProgress = submissions.filter((s) => s.status === "en_progreso");
  const completed = submissions.filter((s) => isFinalStatus(s.status));

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
          <p className="text-sm text-muted-foreground">{exam.course?.name}</p>
        </div>
      </div>

      {/* Live submissions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              En progreso ({inProgress.length}) · Completados ({completed.length})
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
                <TableHead>{t("common.status")}</TableHead>
                <TableHead>{t("dashboard.cards.grades")}</TableHead>
                <TableHead>{t("monitor.warnings")}</TableHead>
                <TableHead>{t("monitor.viewAnswers")}</TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submissions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    Ningún estudiante ha iniciado el examen aún.
                  </TableCell>
                </TableRow>
              )}
              {submissions.map((sub) => {
                const answeredCount = Object.keys(sub.answers ?? {}).filter(
                  (k) => !k.startsWith("__"),
                ).length;
                const finalState = isFinalStatus(sub.status);
                return (
                  <TableRow key={sub.id}>
                    <TableCell>
                      <div className="font-medium">{sub.profile?.full_name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">
                        {sub.profile?.institutional_email}
                      </div>
                    </TableCell>
                    <TableCell>
                      {sub.status === "en_progreso" ? (
                        <Badge className="bg-success text-success-foreground text-[10px]">
                          En progreso
                        </Badge>
                      ) : sub.status === "sospechoso" ? (
                        <Badge variant="destructive" className="text-[10px]">
                          <AlertTriangle className="h-3 w-3 mr-0.5" /> Sospechoso
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          <CheckCircle2 className="h-3 w-3 mr-0.5" /> Completado
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {(() => {
                        const grade = sub.final_override_grade ?? sub.ai_grade;
                        if (grade == null) return <span className="text-muted-foreground">—</span>;
                        return (
                          <div className="flex flex-col items-start">
                            <span className="font-medium">{grade}</span>
                            {sub.final_override_grade != null &&
                              sub.ai_grade != null &&
                              sub.final_override_grade !== sub.ai_grade && (
                                <span className="text-[10px] text-muted-foreground">
                                  IA: {sub.ai_grade}
                                </span>
                              )}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={sub.focus_warnings > 0 ? "destructive" : "outline"}
                        className="text-[10px]"
                      >
                        {sub.focus_warnings}/3
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{answeredCount}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {sub.status === "en_progreso" && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => sendTimerControl("add_time", sub.user_id, 5 * 60)}
                              disabled={loading === `add_time-${sub.user_id}`}
                              title="Agregar 5 minutos a este estudiante"
                            >
                              {loading === `add_time-${sub.user_id}` ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <TimerReset className="h-3.5 w-3.5" />
                              )}
                              <span className="ml-1 text-[11px]">+5m</span>
                            </Button>
                          </>
                        )}
                        {finalState && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openView(sub)}
                            title="Ver respuestas y calificar"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => deleteSubmission(sub)}
                          title="Eliminar entrega"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
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
