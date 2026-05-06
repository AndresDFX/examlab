/**
 * Student-side workshop detail / review page.
 *
 * Refactor de talleres: la entrega ya no es archivo + link, sino respuestas
 * por pregunta calificadas con IA al enviar. Esta página muestra:
 *  - Datos del taller (descripción, instrucciones).
 *  - Si hay submission `calificado`: calificación global + cada pregunta con la
 *    respuesta del estudiante, puntaje obtenido y feedback IA.
 *  - Si la submission existe pero está `entregado` (no calificada todavía,
 *    p.ej. caso edge si el estudiante recargó antes del grading), muestra
 *    estado pendiente.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ExternalLink, MessageSquareText } from "lucide-react";
import { FeedbackThread } from "@/components/FeedbackThread";
import { StatusBadge } from "@/components/ui/status-badge";
import { SectionLoader } from "@/components/ui/loaders";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/app/student/workshop/$workshopId")({
  component: StudentWorkshopDetail,
});

type WorkshopLoaded = {
  id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  external_link: string | null;
  due_date: string | null;
  max_score: number;
  status: string;
  course: { name: string; grade_scale_min: number; grade_scale_max: number };
};

type SubmissionRow = {
  id: string;
  ai_grade: number | null;
  ai_feedback: string | null;
  final_grade: number | null;
  teacher_feedback: string | null;
  status: string;
  submitted_at: string | null;
};

type WorkshopQuestion = {
  id: string;
  type: "abierta" | "cerrada" | "codigo" | "diagrama";
  content: string;
  options: { choices?: string[]; correct_index?: number } | null;
  position: number;
  points: number;
  expected_rubric: string | null;
  language: string | null;
};

type AnswerRow = {
  question_id: string;
  answer_text: string | null;
  selected_option: string | null;
  code_content: string | null;
  diagram_code: string | null;
  ai_grade: number | null;
  ai_feedback: string | null;
};

function StudentWorkshopDetail() {
  const { workshopId } = Route.useParams();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<WorkshopLoaded | null>(null);
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);
  const [questions, setQuestions] = useState<WorkshopQuestion[]>([]);
  const [answersByQid, setAnswersByQid] = useState<Record<string, AnswerRow>>({});

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data: asg } = await supabase
          .from("workshop_assignments")
          .select("id")
          .eq("workshop_id", workshopId)
          .eq("user_id", user.id)
          .maybeSingle();

        if (cancelled) return;
        if (!asg) {
          setError("no_assignment");
          setWorkshop(null);
          setSubmission(null);
          return;
        }

        const [{ data: ws, error: wsErr }, { data: sub }, { data: qs }] = await Promise.all([
          supabase
            .from("workshops")
            .select(
              "id, title, description, instructions, external_link, due_date, max_score, status, course:courses(name, grade_scale_min, grade_scale_max)",
            )
            .eq("id", workshopId)
            .single(),
          supabase
            .from("workshop_submissions")
            .select(
              "id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at",
            )
            .eq("workshop_id", workshopId)
            .eq("user_id", user.id)
            .maybeSingle(),
          supabase
            .from("workshop_questions")
            .select("id, type, content, options, position, points, expected_rubric, language")
            .eq("workshop_id", workshopId)
            .order("position"),
        ]);

        if (cancelled) return;
        if (wsErr || !ws) {
          setError("not_found");
          return;
        }

        setWorkshop(ws as WorkshopLoaded);
        setSubmission(sub as SubmissionRow | null);
        setQuestions((qs ?? []) as WorkshopQuestion[]);

        if (sub?.id) {
          const { data: ans } = await supabase
            .from("workshop_submission_answers")
            .select(
              "question_id, answer_text, selected_option, code_content, diagram_code, ai_grade, ai_feedback",
            )
            .eq("submission_id", sub.id);
          const map: Record<string, AnswerRow> = {};
          for (const a of (ans ?? []) as AnswerRow[]) map[a.question_id] = a;
          if (!cancelled) setAnswersByQid(map);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, workshopId]);

  if (!user) {
    return <p className="text-muted-foreground p-6">{t("exam.review.mustSignIn")}</p>;
  }

  if (loading) {
    return (
      <SectionLoader text={t("common.loading")} />
    );
  }

  if (error === "no_assignment") {
    return (
      <div className="space-y-4 p-2">
        <Link to="/app/student/workshops">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> {t("nav.workshops")}
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

  if (error === "not_found" || !workshop) {
    return (
      <div className="space-y-4 p-2">
        <Link to="/app/student/workshops">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> {t("nav.workshops")}
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

  const gradeShow = submission?.final_grade ?? submission?.ai_grade;

  // Helper: extract the actual answer string for a question.
  const renderAnswer = (q: WorkshopQuestion, ans: AnswerRow | undefined) => {
    if (!ans)
      return <span className="text-muted-foreground italic">{t("exam.review.noAnswer")}</span>;
    if (q.type === "cerrada") {
      const idx = ans.selected_option != null ? Number(ans.selected_option) : -1;
      const choice = q.options?.choices?.[idx];
      return (
        <div className="space-y-1.5">
          {(q.options?.choices ?? []).map((c, i) => {
            const isStudent = i === idx;
            const isCorrect = q.options?.correct_index === i;
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
          {choice == null && (
            <span className="text-muted-foreground italic">{t("exam.review.noAnswer")}</span>
          )}
        </div>
      );
    }
    const raw = ans.code_content ?? ans.diagram_code ?? ans.answer_text ?? "";
    if (!raw.trim())
      return <span className="text-muted-foreground italic">{t("exam.review.noAnswer")}</span>;
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap font-mono">
        {raw}
      </div>
    );
  };

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <PageHeader
        backTo="/app/student/workshops"
        backLabel={t("nav.workshops")}
        title={workshop.title}
        subtitle={workshop.course?.name}
      />

      {!submission && (
        <Card className="border-dashed">
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("exam.review.noSubmission")}
          </CardContent>
        </Card>
      )}

      {workshop.description && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("common.description")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground whitespace-pre-wrap">
            {workshop.description}
          </CardContent>
        </Card>
      )}

      {workshop.instructions && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("dashboard.cards.workshopsStudent")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap">{workshop.instructions}</CardContent>
        </Card>
      )}

      {workshop.external_link && (
        <a
          href={workshop.external_link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <ExternalLink className="h-4 w-4" /> {t("dashboard.cards.workshopsStudent")}
        </a>
      )}

      {submission && (
        <>
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
                  {gradeShow != null ? `${gradeShow} / ${workshop.max_score}` : "—"}
                </div>
                <StatusBadge status={submission.status} className="mt-1" />
              </div>
            </CardContent>
          </Card>

          {(submission.teacher_feedback || submission.ai_feedback) && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t("exam.review.feedback")}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-muted-foreground whitespace-pre-wrap">
                {[
                  ...new Set(
                    [submission.teacher_feedback, submission.ai_feedback].filter(
                      Boolean,
                    ) as string[],
                  ),
                ].join("\n\n")}
              </CardContent>
            </Card>
          )}

          {/* Per-question review (mirrors the exam review UX) */}
          <div className="space-y-4">
            <h2 className="text-lg font-semibold tracking-tight">{t("exam.review.title")}</h2>
            {questions.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("exam.review.noQuestions")}</p>
            )}
            {questions.map((q, idx) => {
              const ans = answersByQid[q.id];
              const earned = ans?.ai_grade;
              return (
                <Card key={q.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex flex-wrap items-center gap-2">
                      <span>
                        {t("exam.question")} {idx + 1}
                      </span>
                      <Badge variant="outline" className="text-[10px] capitalize">
                        {q.type}
                      </Badge>
                      {q.language && (
                        <Badge variant="secondary" className="text-[10px]">
                          {q.language}
                        </Badge>
                      )}
                      <span className="text-sm font-normal text-muted-foreground ml-auto tabular-nums">
                        {earned != null ? earned : "—"} / {q.points} pts
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <div className="text-foreground whitespace-pre-wrap">{q.content}</div>
                    {renderAnswer(q, ans)}
                    {ans?.ai_feedback && (
                      <div className="border-t pt-3">
                        <div className="text-xs rounded-md border-l-2 border-primary/50 bg-muted/40 pl-3 py-2">
                          <span className="font-medium text-foreground block mb-1">
                            {t("exam.review.feedback")}
                          </span>
                          <span className="text-muted-foreground whitespace-pre-wrap">
                            {ans.ai_feedback}
                          </span>
                        </div>
                      </div>
                    )}
                    {submission && (
                      <FeedbackThread
                        parentKind="workshop"
                        questionId={q.id}
                        submissionId={submission.id}
                      />
                    )}
                    {q.expected_rubric && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer hover:text-foreground">
                          {t("exam.review.rubric")}
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
        </>
      )}
    </div>
  );
}
