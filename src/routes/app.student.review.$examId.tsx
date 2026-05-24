import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ArrowLeft, AlertTriangle, MessageSquareText } from "lucide-react";
import { FeedbackThread } from "@/modules/grading/FeedbackThread";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/empty-state";
import { formatDateTime } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";
import { CodeRunOutput } from "@/modules/code/CodeRunOutput";
import { CodeEditor, type CodeLanguage } from "@/modules/code/CodeEditor";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { SectionLoader } from "@/components/ui/loaders";
import { isAiGradePending } from "@/modules/ai/ai-grading";
import { PendingAiGradeBanner } from "@/modules/ai/PendingAiGradeBanner";

export const Route = createFileRoute("/app/student/review/$examId")({
  component: StudentExamReview,
});

type QuestionRow = {
  id: string;
  type: string;
  content: string;
  options: {
    choices?: string[];
    correct_index?: number;
    correct_indices?: number[];
    min_selections?: number;
    max_selections?: number;
  } | null;
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

type ExamLoaded = {
  id: string;
  title: string;
  description: string | null;
  course: { name: string; grade_scale_min: number; grade_scale_max: number } | null;
};

function isFinalStatus(s: string) {
  return s === "completado" || s === "sospechoso";
}

function StudentExamReview() {
  const { examId } = Route.useParams();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [exam, setExam] = useState<ExamLoaded | null>(null);
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [submission, setSubmission] = useState<{
    id: string;
    status: string;
    answers: Record<string, unknown> | null;
    ai_grade: number | null;
    ai_feedback: string | null;
    final_override_grade: number | null;
    submitted_at: string | null;
    teacher_feedback?: string | null;
  } | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setLoadError(null);
      try {
        const { data: asg } = await supabase
          .from("exam_assignments")
          .select("id")
          .eq("exam_id", examId)
          .eq("user_id", user.id)
          .maybeSingle();

        // Resolución del set de exam_ids a buscar: la URL trae UN id,
        // pero un examen puede tener un padre (cuando este es un makeup)
        // O hijos makeup. La entrega del alumno puede estar en cualquiera
        // de esos tres puntos del árbol — antes la query se hacía solo
        // contra el id de la URL y devolvía null cuando el alumno había
        // tomado un makeup pero el link traía el padre (o viceversa).
        // Resultado visible: "No hay una entrega registrada" aunque sí
        // existiera, simplemente bajo otro exam_id.
        const { data: examRow } = await supabase
          .from("exams")
          .select("id, parent_exam_id")
          .eq("id", examId)
          .maybeSingle();
        const { data: makeupRows } = await supabase
          .from("exams")
          .select("id")
          .eq("parent_exam_id", examId);
        const relatedExamIds = Array.from(
          new Set<string>([
            examId,
            ...((examRow as { parent_exam_id?: string | null } | null)?.parent_exam_id
              ? [(examRow as { parent_exam_id: string }).parent_exam_id]
              : []),
            ...((makeupRows ?? []) as { id: string }[]).map((m) => m.id),
          ]),
        );

        // limit(1): un examen con varios intentos tiene VARIAS filas en
        // `submissions` para el mismo (exam_id, user_id). Sin el limit,
        // `.maybeSingle()` lanza error ante >1 fila y la revisión queda
        // vacía aunque el alumno sí tenga entregas.
        const { data: subGate } = await supabase
          .from("submissions")
          .select("id")
          .in("exam_id", relatedExamIds)
          .eq("user_id", user.id)
          .limit(1)
          .maybeSingle();

        if (cancelled) return;
        if (!asg && !subGate) {
          setError("no_assignment");
          setExam(null);
          setSubmission(null);
          setQuestions([]);
          return;
        }

        const [{ data: ex, error: exErr }, { data: sub }, { data: qs }] = await Promise.all([
          supabase
            .from("exams")
            .select(
              "id, title, description, course:courses(name, grade_scale_min, grade_scale_max)",
            )
            .eq("id", examId)
            .single(),
          // Último intento del alumno en CUALQUIERA de los exam_ids
          // relacionados (la URL, su padre, o un makeup hijo). Si el
          // alumno solo tomó el makeup pero el link trae el padre, esta
          // query sigue trayendo la entrega correcta.
          supabase
            .from("submissions")
            .select(
              "id, exam_id, status, answers, ai_grade, ai_feedback, final_override_grade, submitted_at, teacher_feedback",
            )
            .in("exam_id", relatedExamIds)
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle(),
          // Para las preguntas: si la entrega vino de un exam_id distinto
          // al de la URL, las preguntas deben corresponder al exam_id REAL
          // de la entrega — si no, el render del breakdown queda vacío
          // porque los question_ids no matchean. Lo resolvemos abajo tras
          // saber qué entrega ganó.
          supabase
            .from("questions")
            .select("id, type, content, options, points, position, expected_rubric, language")
            .eq("exam_id", examId)
            .order("position", { ascending: true }),
        ]);

        // Si la submission ganadora pertenece a OTRO exam_id (makeup vs
        // padre), recargamos las questions desde ESE exam para que el
        // render del breakdown matche los question_ids.
        let qsForSub = qs;
        const subExamId = (sub as { exam_id?: string } | null)?.exam_id;
        if (subExamId && subExamId !== examId) {
          const { data: qsAlt } = await supabase
            .from("questions")
            .select("id, type, content, options, points, position, expected_rubric, language")
            .eq("exam_id", subExamId)
            .order("position", { ascending: true });
          if (qsAlt) qsForSub = qsAlt;
        }

        if (cancelled) return;
        if (exErr || !ex) {
          setError("not_found");
          return;
        }

        setExam(ex as ExamLoaded);
        setSubmission(
          sub as {
            id: string;
            status: string;
            answers: Record<string, unknown> | null;
            ai_grade: number | null;
            ai_feedback: string | null;
            final_override_grade: number | null;
            submitted_at: string | null;
            teacher_feedback?: string | null;
          } | null,
        );
        setQuestions((qs ?? []) as QuestionRow[]);
      } catch (e) {
        if (!cancelled) setLoadError(friendlyError(e, "No pudimos cargar los datos del examen."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, examId, retryNonce]);

  if (!user) {
    return <p className="text-muted-foreground p-6">{t("exam.review.mustSignIn")}</p>;
  }

  if (loading) {
    return <SectionLoader text={t("common.loading")} />;
  }

  if (loadError) {
    return (
      <div className="space-y-4 p-2">
        <Link to="/app/student/exams">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            {t("exam.review.backToExams")}
          </Button>
        </Link>
        <ErrorState
          message="No pudimos cargar los datos del examen"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  if (error === "no_assignment") {
    return (
      <div className="space-y-4 p-2">
        <Link to="/app/student/exams">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            {t("exam.review.backToExams")}
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("exam.review.noAccess")}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error === "not_found" || !exam) {
    return (
      <div className="space-y-4 p-2">
        <Link to="/app/student/exams">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            {t("exam.review.backToExams")}
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("exam.review.notFound")}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!submission) {
    return (
      <div className="space-y-4">
        <BackHeader title={exam.title} courseName={exam.course?.name} />
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("exam.review.noSubmission")}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!isFinalStatus(submission.status)) {
    return (
      <div className="space-y-4">
        <BackHeader title={exam.title} courseName={exam.course?.name} />
        <Card>
          <CardContent className="p-6 space-y-3">
            <p className="text-sm text-muted-foreground">{t("exam.review.pendingFinish")}</p>
            <Link to="/app/student/take/$examId" params={{ examId }}>
              <Button size="sm">{t("exam.review.goToExam")}</Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  const answers = (submission.answers ?? {}) as Record<string, unknown>;
  const breakdown: BreakdownItem[] = Array.isArray(answers.__breakdown)
    ? (answers.__breakdown as BreakdownItem[])
    : [];
  const byBreakdownId = new Map(breakdown.map((b) => [b.qid, b]));
  const manual = (answers.__manual_overrides ?? {}) as Record<string, ManualOverride>;

  const finalGrade = submission.final_override_grade ?? submission.ai_grade;
  const gradeMax = exam.course?.grade_scale_max ?? 5;

  return (
    <div className="space-y-5">
      <BackHeader title={exam.title} courseName={exam.course?.name} />

      {/* Banner "calificación en cola". Solo mostrar cuando: el docente
          NO override-eó (final_override_grade es null) Y la IA no
          escribió la nota todavía. Si el docente ya calificó manual, la
          nota visible es la suya — no tiene sentido confundir con el
          banner de "pendiente IA". */}
      {submission.final_override_grade == null &&
        isAiGradePending({
          ai_grade: submission.ai_grade,
          ai_feedback: submission.ai_feedback,
        }) && <PendingAiGradeBanner />}

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MessageSquareText className="h-5 w-5 text-primary shrink-0" />
            <div>
              <div className="font-medium">{t("exam.review.globalResult")}</div>
              <div className="text-xs text-muted-foreground">
                {submission.submitted_at
                  ? t("exam.review.submittedAt", {
                      when: formatDateTime(submission.submitted_at),
                    })
                  : t("exam.review.submittedNoDate")}
              </div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">
              {finalGrade != null ? `${finalGrade} / ${gradeMax}` : "—"}
            </div>
            {submission.final_override_grade != null &&
              submission.ai_grade != null &&
              submission.final_override_grade !== submission.ai_grade && (
                <div className="text-[10px] text-muted-foreground">
                  {t("exam.review.priorValue", { value: submission.ai_grade })}
                </div>
              )}
          </div>
        </CardContent>
      </Card>

      {submission.teacher_feedback && submission.teacher_feedback.trim() && (
        <Card className="border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <MessageSquareText className="h-4 w-4 text-primary" />
              Retroalimentación del docente
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm"><MarkdownInline>{submission.teacher_feedback!}</MarkdownInline></div>
          </CardContent>
        </Card>
      )}

      {submission.status === "sospechoso" && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>{t("exam.review.flagged")}</AlertTitle>
          <AlertDescription>{t("exam.review.flaggedBody")}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">{t("exam.review.title")}</h2>
        {questions.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("exam.review.noQuestions")}</p>
        )}
        {questions.map((q, idx) => {
          const ans = answers[q.id];
          const bd = byBreakdownId.get(q.id);
          const override = manual[q.id];
          const earned = override != null ? override.score : bd?.earned;
          const choices = q.options?.choices as string[] | undefined;
          const correctIdx = q.options?.correct_index;
          const correctIndices = Array.isArray(q.options?.correct_indices)
            ? q.options!.correct_indices!
            : [];
          const studentMulti = Array.isArray(ans) ? (ans as number[]) : [];

          const iaFeedback = bd?.feedback && String(bd.feedback).trim() ? bd.feedback : null;
          const teacherFeedback =
            override?.feedback && String(override.feedback).trim() ? override.feedback : null;

          return (
            <Card key={q.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex flex-wrap items-center gap-2">
                  <span>
                    {t("exam.question")} {idx + 1}
                  </span>
                  <Badge variant="outline" className="text-[10px] capitalize">
                    {q.type.replace(/_/g, " ")}
                  </Badge>
                  {q.language && (
                    <Badge variant="secondary" className="text-[10px]">
                      {q.language}
                    </Badge>
                  )}
                  <span className="text-sm font-normal text-muted-foreground ml-auto tabular-nums">
                    {earned != null ? `${earned}` : "—"} / {q.points} pts
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <MarkdownInline>{q.content}</MarkdownInline>

                {q.type === "cerrada" && choices && (
                  <div className="space-y-1.5">
                    {choices.map((c, i) => {
                      const isStudent = ans === i;
                      const isCorrect = correctIdx === i;
                      return (
                        <div
                          key={i}
                          className={`text-xs p-2 rounded-md border ${
                            isCorrect ? "border-success bg-success/10" : "border-border"
                          } ${isStudent ? "ring-1 ring-primary" : ""}`}
                        >
                          <span className="font-mono mr-2">{String.fromCharCode(65 + i)}.</span>
                          {c}
                          {isStudent && (
                            <Badge variant="outline" className="ml-2 text-[9px]">
                              {t("exam.review.yourAnswer")}
                            </Badge>
                          )}
                          {isCorrect && (
                            <Badge className="ml-1 text-[9px] bg-success text-success-foreground">
                              {t("exam.review.correct")}
                            </Badge>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {q.type === "cerrada_multi" && choices && (
                  <div className="space-y-1.5">
                    {choices.map((c, i) => {
                      const isStudent = studentMulti.includes(i);
                      const isCorrect = correctIndices.includes(i);
                      return (
                        <div
                          key={i}
                          className={`text-xs p-2 rounded-md border ${
                            isCorrect ? "border-success bg-success/10" : "border-border"
                          } ${isStudent ? "ring-1 ring-primary" : ""}`}
                        >
                          <span className="font-mono mr-2">{String.fromCharCode(65 + i)}.</span>
                          {c}
                          {isStudent && (
                            <Badge variant="outline" className="ml-2 text-[9px]">
                              {t("exam.review.yourAnswer")}
                            </Badge>
                          )}
                          {isCorrect && (
                            <Badge className="ml-1 text-[9px] bg-success text-success-foreground">
                              {t("exam.review.correct")}
                            </Badge>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

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
                  q.type !== "cerrada" && q.type !== "cerrada_multi" && (
                    <div className="rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap font-mono min-h-[44px]">
                      {ans == null || ans === "" ? (
                        <span className="text-muted-foreground italic font-sans">
                          {t("exam.review.noAnswer")}
                        </span>
                      ) : typeof ans === "string" ? (
                        ans
                      ) : (
                        JSON.stringify(ans, null, 2)
                      )}
                    </div>
                  )
                )}

                {/* Líneas del compilador / consola: la última ejecución
                    registrada por el estudiante en `code_executions`
                    durante la toma del examen. */}
                {(q.type === "codigo" || q.type === "java_gui") && submission && user && (
                  <CodeRunOutput submissionId={submission.id} questionId={q.id} userId={user.id} />
                )}

                {(iaFeedback || teacherFeedback) && (
                  <div className="border-t pt-3">
                    <div className="text-xs rounded-md border-l-2 border-primary/50 bg-muted/40 pl-3 py-2">
                      <span className="font-medium text-foreground block mb-1">
                        {t("exam.review.feedback")}
                      </span>
                      <div className="text-muted-foreground">
                        <MarkdownInline>
                          {[
                            ...new Set([teacherFeedback, iaFeedback].filter(Boolean) as string[]),
                          ].join("\n\n")}
                        </MarkdownInline>
                      </div>
                    </div>
                  </div>
                )}

                {!iaFeedback && !teacherFeedback && q.type !== "cerrada" && q.type !== "cerrada_multi" && (
                  <p className="text-xs text-muted-foreground italic">
                    {t("exam.review.noFeedback")}
                  </p>
                )}

                {submission && (
                  <FeedbackThread
                    parentKind="exam"
                    questionId={q.id}
                    submissionId={submission.id}
                  />
                )}

                {q.expected_rubric && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer hover:text-foreground">
                      {t("exam.review.rubric")}
                    </summary>
                    <div className="mt-2 border rounded-md p-2 bg-muted/20">
                      <MarkdownInline>{q.expected_rubric}</MarkdownInline>
                    </div>
                  </details>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function BackHeader({ title, courseName }: { title: string; courseName?: string | null }) {
  const { t } = useTranslation();
  return (
    <PageHeader
      backTo="/app/student/exams"
      backLabel={t("exam.review.backToExams")}
      title={title}
      subtitle={courseName ?? undefined}
    />
  );
}
