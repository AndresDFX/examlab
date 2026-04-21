import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ExternalLink, FileIcon, Loader2, MessageSquareText } from "lucide-react";

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
  content: string | null;
  external_link: string | null;
  file_url: string | null;
  ai_grade: number | null;
  ai_feedback: string | null;
  final_grade: number | null;
  teacher_feedback: string | null;
  status: string;
  submitted_at: string | null;
};

function StudentWorkshopDetail() {
  const { workshopId } = Route.useParams();
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [workshop, setWorkshop] = useState<WorkshopLoaded | null>(null);
  const [submission, setSubmission] = useState<SubmissionRow | null>(null);

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

        const [{ data: ws, error: wsErr }, { data: sub }] = await Promise.all([
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
              "content, external_link, file_url, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at",
            )
            .eq("workshop_id", workshopId)
            .eq("user_id", user.id)
            .maybeSingle(),
        ]);

        if (cancelled) return;
        if (wsErr || !ws) {
          setError("not_found");
          return;
        }

        setWorkshop(ws as WorkshopLoaded);
        setSubmission(sub as SubmissionRow | null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, workshopId]);

  const downloadFile = async (path: string) => {
    const { data, error } = await supabase.storage
      .from("workshop-files")
      .createSignedUrl(path, 3600);
    if (error || !data?.signedUrl) return;
    window.open(data.signedUrl, "_blank");
  };

  const fileLabel = (path: string) => path.split("/").pop() ?? path;

  if (!user) {
    return <p className="text-muted-foreground p-6">Inicia sesión para ver esta página.</p>;
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground p-6">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando taller…
      </div>
    );
  }

  if (error === "no_assignment") {
    return (
      <div className="space-y-4 p-2">
        <Link to="/app/student/workshops">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Talleres
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No tienes acceso a este taller.
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
            <ArrowLeft className="h-4 w-4 mr-1" /> Talleres
          </Button>
        </Link>
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No se encontró el taller.
          </CardContent>
        </Card>
      </div>
    );
  }

  const gradeShow = submission?.final_grade ?? submission?.ai_grade;

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <div className="flex flex-wrap items-start gap-3">
        <Link to="/app/student/workshops">
          <Button variant="ghost" size="sm" className="shrink-0">
            <ArrowLeft className="h-4 w-4 mr-1" /> Talleres
          </Button>
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">{workshop.title}</h1>
          <p className="text-sm text-muted-foreground">{workshop.course?.name}</p>
        </div>
      </div>

      {!submission && (
        <Card className="border-dashed">
          <CardContent className="p-6 text-sm text-muted-foreground">
            Aún no has entregado este taller. Desde la lista de talleres puedes enviar tu trabajo
            cuando el curso lo permita.
          </CardContent>
        </Card>
      )}

      {workshop.description && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Descripción</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground whitespace-pre-wrap">
            {workshop.description}
          </CardContent>
        </Card>
      )}

      {workshop.instructions && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Instrucciones</CardTitle>
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
          <ExternalLink className="h-4 w-4" /> Material o enlace del docente
        </a>
      )}

      {submission && (
        <>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex flex-wrap items-center gap-2">
                Tu entrega
                <Badge variant="outline" className="text-[10px] capitalize">
                  {submission.status.replace(/_/g, " ")}
                </Badge>
              </CardTitle>
              {submission.submitted_at && (
                <p className="text-xs text-muted-foreground">
                  Enviado: {new Date(submission.submitted_at).toLocaleString()}
                </p>
              )}
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {submission.content && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Contenido</div>
                  <div className="rounded-md border bg-muted/30 p-3 whitespace-pre-wrap">
                    {submission.content}
                  </div>
                </div>
              )}
              {submission.external_link && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Enlace entregado
                  </div>
                  <a
                    href={submission.external_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary break-all hover:underline"
                  >
                    {submission.external_link}
                  </a>
                </div>
              )}
              {submission.file_url && (
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">Archivo</div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => downloadFile(submission.file_url!)}
                  >
                    <FileIcon className="h-4 w-4" />
                    {fileLabel(submission.file_url)}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-primary/20 bg-primary/5">
            <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <MessageSquareText className="h-5 w-5 text-primary shrink-0" />
                <div>
                  <div className="font-medium">Calificación</div>
                  <div className="text-xs text-muted-foreground">
                    Escala del curso {workshop.course?.grade_scale_min}–
                    {workshop.course?.grade_scale_max} · Máx. taller {workshop.max_score}
                  </div>
                </div>
              </div>
              <div className="text-2xl font-semibold tabular-nums">
                {gradeShow != null ? `${gradeShow} / ${workshop.max_score}` : "—"}
              </div>
            </CardContent>
          </Card>

          {(submission.ai_feedback || submission.teacher_feedback) && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Retroalimentación</CardTitle>
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
        </>
      )}
    </div>
  );
}
