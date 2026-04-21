import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ArrowLeft, AlertTriangle, MessageSquareText } from "lucide-react";

export const Route = createFileRoute("/app/student/review/$examId")({
  component: StudentExamReview,
});

type QuestionRow = {
  id: string;
  type: string;
  content: string;
  options: { choices?: string[]; correct_index?: number } | null;
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exam, setExam] = useState<ExamLoaded | null>(null);
  const [questions, setQuestions] = useState<QuestionRow[]>([]);
  const [submission, setSubmission] = useState<{
    status: string;
    answers: Record<string, unknown> | null;
    ai_grade: number | null;
    final_override_grade: number | null;
    submitted_at: string | null;
  } | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: asg } = await supabase
          .from("exam_assignments")
          .select("id")
          .eq("exam_id", examId)
          .eq("user_id", user.id)
          .maybeSingle();

        const { data: subGate } = await supabase
          .from("submissions")
          .select("id")
          .eq("exam_id", examId)
          .eq("user_id", user.id)
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
          supabase
            .from("submissions")
            .select("status, answers, ai_grade, final_override_grade, submitted_at")
            .eq("exam_id", examId)
            .eq("user_id", user.id)
            .maybeSingle(),
          supabase
            .from("questions")
            .select("id, type, content, options, points, position, expected_rubric, language")
            .eq("exam_id", examId)
            .order("position", { ascending: true }),
        ]);

        if (cancelled) return;
        if (exErr || !ex) {
          setError("not_found");
          return;
        }

        setExam(ex as ExamLoaded);
        setSubmission(
          sub as {
            status: string;
            answers: Record<string, unknown> | null;
            ai_grade: number | null;
            final_override_grade: number | null;
            submitted_at: string | null;
          } | null,
        );
        setQuestions((qs ?? []) as QuestionRow[]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, examId]);

  if (!user) {
    return <p className="text-muted-foreground p-6">Inicia sesión para ver tus resultados.</p>;
  }

  if (loading) {
    return <p className="text-muted-foreground p-6">Cargando resultado del examen…</p>;
  }

  if (error === "no_assignment") {
    return (
      <div className="space-y-4 p-2">
        <Link to="/app/student/exams">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" />
            Volver a exámenes
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No tienes acceso a este examen o no está asignado a tu cuenta.
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
            Volver a exámenes
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No se encontró el examen.
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
            No hay una entrega registrada para este examen.
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
            <p className="text-sm text-muted-foreground">
              Cuando completes y entregues el examen, aquí podrás ver tus respuestas y la
              retroalimentación por pregunta (después de la calificación).
            </p>
            <Link to="/app/student/take/$examId" params={{ examId }}>
              <Button size="sm">Ir al examen</Button>
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

      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <MessageSquareText className="h-5 w-5 text-primary shrink-0" />
            <div>
              <div className="font-medium">Resultado global</div>
              <div className="text-xs text-muted-foreground">
                {submission.submitted_at
                  ? `Entregado: ${new Date(submission.submitted_at).toLocaleString()}`
                  : "Entregado"}
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
                  Valor de referencia anterior: {submission.ai_grade}
                </div>
              )}
          </div>
        </CardContent>
      </Card>

      {submission.status === "sospechoso" && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Intento marcado por alertas</AlertTitle>
          <AlertDescription>
            Esta entrega fue registrada con advertencias de integridad (foco, pantalla completa u
            otros eventos). La nota se muestra igualmente a efectos informativos.
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight">Retroalimentación por pregunta</h2>
        {questions.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Este examen no tiene preguntas registradas.
          </p>
        )}
        {questions.map((q, idx) => {
          const ans = answers[q.id];
          const bd = byBreakdownId.get(q.id);
          const override = manual[q.id];
          const earned = override != null ? override.score : bd?.earned;
          const choices = q.options?.choices as string[] | undefined;
          const correctIdx = q.options?.correct_index;

          const iaFeedback = bd?.feedback && String(bd.feedback).trim() ? bd.feedback : null;
          const teacherFeedback =
            override?.feedback && String(override.feedback).trim() ? override.feedback : null;

          return (
            <Card key={q.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex flex-wrap items-center gap-2">
                  <span>Pregunta {idx + 1}</span>
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
                <div className="text-foreground whitespace-pre-wrap">{q.content}</div>

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
                              tu respuesta
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
                  <div className="rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap font-mono min-h-[44px]">
                    {ans == null || ans === "" ? (
                      <span className="text-muted-foreground italic font-sans">Sin respuesta</span>
                    ) : typeof ans === "string" ? (
                      ans
                    ) : (
                      JSON.stringify(ans, null, 2)
                    )}
                  </div>
                )}

                {(iaFeedback || teacherFeedback) && (
                  <div className="border-t pt-3">
                    <div className="text-xs rounded-md border-l-2 border-primary/50 bg-muted/40 pl-3 py-2">
                      <span className="font-medium text-foreground block mb-1">
                        Retroalimentación
                      </span>
                      <span className="text-muted-foreground whitespace-pre-wrap">
                        {[
                          ...new Set([teacherFeedback, iaFeedback].filter(Boolean) as string[]),
                        ].join("\n\n")}
                      </span>
                    </div>
                  </div>
                )}

                {!iaFeedback && !teacherFeedback && q.type !== "cerrada" && (
                  <p className="text-xs text-muted-foreground italic">
                    No hay retroalimentación escrita para esta pregunta.
                  </p>
                )}

                {q.expected_rubric && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer hover:text-foreground">
                      Criterios de evaluación (referencia)
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap border rounded-md p-2 bg-muted/20">
                      {q.expected_rubric}
                    </p>
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
  return (
    <div className="flex flex-wrap items-start gap-3">
      <Link to="/app/student/exams">
        <Button variant="ghost" size="sm" className="shrink-0">
          <ArrowLeft className="h-4 w-4 mr-1" />
          Exámenes
        </Button>
      </Link>
      <div className="min-w-0">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight truncate">{title}</h1>
        {courseName && <p className="text-sm text-muted-foreground">{courseName}</p>}
      </div>
    </div>
  );
}
