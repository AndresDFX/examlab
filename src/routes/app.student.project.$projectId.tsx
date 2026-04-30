/**
 * Student-side project detail / review page.
 *
 * Espejo de la página de detalle de talleres pero con archivos en vez de
 * preguntas. Muestra:
 *  - Datos del proyecto (descripción, instrucciones).
 *  - Si la submission está `calificado`: nota global + cada archivo con
 *    el contenido entregado, puntaje obtenido y feedback IA.
 *  - Si la submission existe pero está `entregado` (sin calificación
 *    todavía): estado pendiente.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, FileText, Loader2, MessageSquareText, Bot } from "lucide-react";
import { SlotDeliverableView } from "@/components/SlotDeliverableView";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/student/project/$projectId")({
  component: StudentProjectDetail,
});

type ProjectLoaded = {
  id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  due_date: string | null;
  max_files: number;
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

type ProjectFile = {
  id: string;
  position: number;
  title: string;
  description: string | null;
  expected_rubric: string | null;
  language: string | null;
  points: number;
};

type AnswerRow = {
  id: string;
  file_id: string;
  content: string | null;
  ai_grade: number | null;
  ai_feedback: string | null;
  ai_likelihood: number | null;
  ai_reasons: string | null;
};

type AttachmentRow = {
  id: string;
  project_submission_file_id: string;
  file_name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number;
};

function StudentProjectDetail() {
  const { projectId } = Route.useParams();
  const { user } = useAuth();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectLoaded | null>(null);
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [answersByFid, setAnswersByFid] = useState<Record<string, AnswerRow>>({});
  // Attachments grouped by file slot id (not by psf id) for easy lookup at
  // render time. Empty array means the slot was not submitted with files.
  const [attachmentsByFid, setAttachmentsByFid] = useState<Record<string, AttachmentRow[]>>({});

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Access check: a student can see a project if either
        //   (a) it was assigned directly via `project_assignments`, or
        //   (b) the project is linked to a course where the student is enrolled
        //       (via `project_courses` ⨝ `course_enrollments`).
        // Without (b) the listing page would show the project but this detail
        // view would 403 — that mismatch was the bug being fixed.
        const [{ data: asg }, { data: links }, { data: enrolls }] = await Promise.all([
          db
            .from("project_assignments")
            .select("id")
            .eq("project_id", projectId)
            .eq("user_id", user.id)
            .maybeSingle(),
          db.from("project_courses").select("course_id").eq("project_id", projectId),
          db.from("course_enrollments").select("course_id").eq("user_id", user.id),
        ]);

        if (cancelled) return;
        const enrolledCourseIds = new Set(
          ((enrolls ?? []) as { course_id: string }[]).map((e) => e.course_id),
        );
        const projectCourseIds = ((links ?? []) as { course_id: string }[]).map(
          (l) => l.course_id,
        );
        const enrolledViaCourse = projectCourseIds.some((cid) => enrolledCourseIds.has(cid));

        if (!asg && !enrolledViaCourse) {
          setError("no_assignment");
          setProject(null);
          setSubmission(null);
          return;
        }

        const [{ data: pr, error: prErr }, { data: sub }, { data: fs }] = await Promise.all([
          db
            .from("projects")
            .select(
              "id, title, description, instructions, due_date, max_files, max_score, status, course:courses(name, grade_scale_min, grade_scale_max)",
            )
            .eq("id", projectId)
            .single(),
          db
            .from("project_submissions")
            .select(
              "id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at",
            )
            .eq("project_id", projectId)
            .eq("user_id", user.id)
            .maybeSingle(),
          db
            .from("project_files")
            .select("id, position, title, description, expected_rubric, language, points")
            .eq("project_id", projectId)
            .order("position"),
        ]);

        if (cancelled) return;
        if (prErr || !pr) {
          setError("not_found");
          return;
        }

        setProject(pr as ProjectLoaded);
        setSubmission(sub as SubmissionRow | null);
        setFiles((fs ?? []) as ProjectFile[]);

        if (sub?.id) {
          const { data: ans } = await db
            .from("project_submission_files")
            .select("id, file_id, content, ai_grade, ai_feedback, ai_likelihood, ai_reasons")
            .eq("submission_id", sub.id);
          const answers = (ans ?? []) as AnswerRow[];
          const map: Record<string, AnswerRow> = {};
          for (const a of answers) map[a.file_id] = a;
          if (!cancelled) setAnswersByFid(map);

          // Load attachments referenced by these submission_file rows.
          if (answers.length) {
            const psfIds = answers.map((a) => a.id);
            const { data: atts } = await db
              .from("project_submission_attachments")
              .select(
                "id, project_submission_file_id, file_name, storage_path, mime_type, size_bytes",
              )
              .in("project_submission_file_id", psfIds);
            const psfToSlot = Object.fromEntries(answers.map((a) => [a.id, a.file_id]));
            const grouped: Record<string, AttachmentRow[]> = {};
            for (const a of (atts ?? []) as AttachmentRow[]) {
              const slot = psfToSlot[a.project_submission_file_id];
              if (!slot) continue;
              (grouped[slot] ||= []).push(a);
            }
            if (!cancelled) setAttachmentsByFid(grouped);
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, projectId]);

  if (!user) {
    return <p className="text-muted-foreground p-6">{t("project.review.mustSignIn")}</p>;
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground p-6">
        <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
      </div>
    );
  }

  if (error === "no_assignment") {
    return (
      <div className="space-y-4 p-2">
        <Link to="/app/student/projects">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Proyectos
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("project.review.noAccess")}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error === "not_found" || !project) {
    return (
      <div className="space-y-4 p-2">
        <Link to="/app/student/projects">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Proyectos
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("project.review.notFound")}
          </CardContent>
        </Card>
      </div>
    );
  }

  const gradeShow = submission?.final_grade ?? submission?.ai_grade;

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <div className="flex flex-wrap items-start gap-3">
        <Link to="/app/student/projects">
          <Button variant="ghost" size="sm" className="shrink-0">
            <ArrowLeft className="h-4 w-4 mr-1" /> Proyectos
          </Button>
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">{project.title}</h1>
          <p className="text-sm text-muted-foreground">{project.course?.name}</p>
        </div>
      </div>

      {!submission && (
        <Card className="border-dashed">
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("project.review.noSubmission")}
          </CardContent>
        </Card>
      )}

      {project.description && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{t("common.description")}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground whitespace-pre-wrap">
            {project.description}
          </CardContent>
        </Card>
      )}

      {project.instructions && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Instrucciones</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap">{project.instructions}</CardContent>
        </Card>
      )}

      {submission && (
        <>
          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MessageSquareText className="h-5 w-5 text-primary shrink-0" />
                <div>
                  <div className="font-medium">{t("project.review.globalResult")}</div>
                  <div className="text-xs text-muted-foreground">
                    {submission.submitted_at
                      ? t("project.review.submittedAt", {
                          when: new Date(submission.submitted_at).toLocaleString(),
                        })
                      : t("project.review.submittedNoDate")}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-semibold tabular-nums">
                  {gradeShow != null ? `${gradeShow} / ${project.max_score}` : "—"}
                </div>
                <Badge variant="outline" className="text-[10px] capitalize mt-1">
                  {submission.status.replace(/_/g, " ")}
                </Badge>
              </div>
            </CardContent>
          </Card>

          {(submission.teacher_feedback || submission.ai_feedback) && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t("project.review.feedback")}</CardTitle>
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

          <div className="space-y-4">
            <h2 className="text-lg font-semibold tracking-tight">Archivos entregados</h2>
            {files.length === 0 && (
              <p className="text-sm text-muted-foreground">No hay archivos definidos.</p>
            )}
            {files.map((f, idx) => {
              const ans = answersByFid[f.id];
              const earned = ans?.ai_grade;
              const aiFlag = ans?.ai_likelihood != null && ans.ai_likelihood >= 0.6;
              return (
                <Card key={f.id}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {idx + 1}
                      </Badge>
                      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>{f.title}</span>
                      {aiFlag && (
                        <Badge variant="destructive" className="text-[10px]">
                          <Bot className="h-3 w-3 mr-1" />
                          Posible IA
                        </Badge>
                      )}
                      <span className="text-sm font-normal text-muted-foreground ml-auto tabular-nums">
                        {earned != null ? earned : "—"} / {f.points} pts
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    {f.description && (
                      <div className="text-muted-foreground whitespace-pre-wrap">
                        {f.description}
                      </div>
                    )}
                    <SlotDeliverableView slot={f} attachments={attachmentsByFid[f.id] ?? []} />
                    {!attachmentsByFid[f.id]?.length && ans?.content && ans.content.trim() && (
                      // Legacy text-only submission (pre-attachments). Kept so old
                      // submissions remain readable after the file-upload migration.
                      <div className="rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap font-mono max-h-72 overflow-y-auto">
                        {ans.content}
                      </div>
                    )}
                    {ans?.ai_feedback && (
                      <div className="border-t pt-3">
                        <div className="text-xs rounded-md border-l-2 border-primary/50 bg-muted/40 pl-3 py-2">
                          <span className="font-medium text-foreground block mb-1">
                            {t("project.review.feedback")}
                          </span>
                          <span className="text-muted-foreground whitespace-pre-wrap">
                            {ans.ai_feedback}
                          </span>
                        </div>
                      </div>
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
