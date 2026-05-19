/**
 * Student-side project detail / review page.
 *
 * Espejo de la página de detalle de talleres pero con archivos en vez de
 * preguntas. Muestra:
 *  - Datos del proyecto (descripción, instrucciones).
 *  - Si la submission está `calificado`: calificación global + cada archivo con
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
import {
  ArrowLeft,
  FileText,
  MessageSquareText,
  Bot,
  ExternalLink,
  Download,
  FileArchive,
} from "lucide-react";
import { toast } from "sonner";
import { FeedbackThread } from "@/modules/grading/FeedbackThread";
import { StatusBadge } from "@/components/ui/status-badge";
import { SectionLoader } from "@/components/ui/loaders";
import { PageHeader } from "@/components/ui/page-header";
import { formatDateTime } from "@/shared/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/student/project/$projectId")({
  component: StudentProjectDetail,
});

type ProjectLoaded = {
  id: string;
  course_id: string | null;
  title: string;
  description: string | null;
  instructions: string | null;
  external_link: string | null;
  due_date: string | null;
  max_files: number;
  max_score: number;
  status: string;
  group_mode?: "individual" | "teacher_assigned" | "self_signup";
  // Cargado en una segunda fase vía project_courses (ya no hay FK directa
  // de projects.course_id a courses, así que el join PostgREST falla con
  // PGRST200; lo resolvemos como "el primer curso vinculado").
  course?: { name: string; grade_scale_min: number; grade_scale_max: number } | null;
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
  points: number;
  /** Tipo de pregunta. Para `codigo_zip` el alumno entrega un archivo
   *  comprimido y la review muestra botón de descarga en vez del
   *  textarea con `content`. */
  type: string | null;
};

type AnswerRow = {
  file_id: string;
  content: string | null;
  ai_grade: number | null;
  ai_feedback: string | null;
  ai_likelihood: number | null;
  ai_reasons: string | null;
  /** Ruta en bucket `project-files` cuando la pregunta es `codigo_zip` y
   *  fue entregada con el flujo viejo (un único ZIP).
   *  Format: `<user_id|group_id>/<submission_id>/<question_id>.zip`. */
  zip_path: string | null;
  /** Rutas en bucket `project-files` cuando la pregunta es `codigo_zip` y
   *  fue entregada con el flujo nuevo (varios archivos sueltos).
   *  Format: `<user_id|group_id>/<submission_id>/<question_id>/<filename>`. */
  code_paths: string[] | null;
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

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        // Lanzamos en paralelo: el query del proyecto y los 3 que validan
        // acceso. Si el proyecto tiene RLS estricto y el usuario aún no
        // resuelve "asignado", el primer query puede devolver pr=null;
        // por eso el access check es autoritativo y no depende de pr.
        const [
          { data: pr, error: prErr },
          { data: fs },
          { data: asg },
          { data: linked },
          { data: ownEnrollments },
          { data: myGroupRows },
        ] = await Promise.all([
          db
            .from("projects")
            .select(
              "id, course_id, title, description, instructions, external_link, due_date, max_files, max_score, status, group_mode",
            )
            .eq("id", projectId)
            .maybeSingle(),
          db
            .from("project_files")
            .select("id, position, title, description, expected_rubric, points, type")
            .eq("project_id", projectId)
            .order("position"),
          db
            .from("project_assignments")
            .select("id")
            .eq("project_id", projectId)
            .eq("user_id", user.id)
            .maybeSingle(),
          db.from("project_courses").select("course_id").eq("project_id", projectId),
          db.from("course_enrollments").select("course_id").eq("user_id", user.id),
          db
            .from("project_group_members")
            .select("group:project_groups!inner(id, project_id)")
            .eq("user_id", user.id),
        ]);

        // Determinar grupo del estudiante para este proyecto (si aplica).
        let myGroupId: string | null = null;
        if (
          pr &&
          (pr as ProjectLoaded).group_mode &&
          (pr as ProjectLoaded).group_mode !== "individual"
        ) {
          const groups = (myGroupRows ?? []) as { group: { id: string; project_id: string } }[];
          myGroupId = groups.find((g) => g.group?.project_id === projectId)?.group?.id ?? null;
        }

        // La submission se busca por group_id si el estudiante tiene grupo
        // (modo grupal); de lo contrario por user_id (incluye modo mixto sin grupo).
        const subQuery = db
          .from("project_submissions")
          .select("id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at")
          .eq("project_id", projectId);
        const { data: sub } = await (myGroupId
          ? subQuery.eq("group_id", myGroupId).maybeSingle()
          : subQuery.eq("user_id", user.id).maybeSingle());

        if (cancelled) return;

        const linkedCourseIds = ((linked ?? []) as { course_id: string }[]).map(
          (row) => row.course_id,
        );
        const enrolledCourseIds = ((ownEnrollments ?? []) as { course_id: string }[]).map(
          (row) => row.course_id,
        );
        const legacyCourseId = pr ? (pr as ProjectLoaded).course_id : null;
        const hasCourseAccess =
          linkedCourseIds.some((c) => enrolledCourseIds.includes(c)) ||
          (!!legacyCourseId && enrolledCourseIds.includes(legacyCourseId));
        const hasAccess = !!asg || hasCourseAccess;

        if (!hasAccess) {
          setError("no_assignment");
          setProject(null);
          setSubmission(null);
          return;
        }

        if (prErr || !pr) {
          console.warn("[student-project] access ok pero project query null", {
            projectId,
            prErr,
            hasAssignment: !!asg,
            hasCourseAccess,
          });
          setError("not_found");
          return;
        }

        // Curso para mostrar el header. Usamos el primer course vinculado
        // (project_courses) o el course_id legacy si está. Query separada
        // porque ya no existe la FK directa projects.course_id→courses.
        const courseIdToShow = linkedCourseIds[0] ?? (pr as ProjectLoaded).course_id ?? null;
        let courseRow: ProjectLoaded["course"] = null;
        if (courseIdToShow) {
          const { data } = await db
            .from("courses")
            .select("name, grade_scale_min, grade_scale_max")
            .eq("id", courseIdToShow)
            .maybeSingle();
          courseRow = data ?? null;
        }

        setProject({ ...(pr as ProjectLoaded), course: courseRow });
        setSubmission(sub as SubmissionRow | null);
        setFiles((fs ?? []) as ProjectFile[]);

        if (sub?.id) {
          const { data: ans } = await db
            .from("project_submission_files")
            .select(
              "file_id, content, ai_grade, ai_feedback, ai_likelihood, ai_reasons, zip_path, code_paths",
            )
            .eq("submission_id", sub.id);
          const map: Record<string, AnswerRow> = {};
          for (const a of (ans ?? []) as AnswerRow[]) map[a.file_id] = a;

          // ── Storage fallback para entregas tipo codigo_zip ──
          // Algunas filas legacy quedaron con `code_paths = NULL` porque
          // se persistieron con el reintento defensivo cuando la columna
          // aún no existía en DB. Los archivos físicos SÍ están en
          // Storage. Acá listamos el prefijo esperado y, si encontramos
          // archivos, los rellenamos al vuelo para que el render muestre
          // los botones de descarga. Solo aplica para filas con `ans`
          // existente pero sin code_paths / zip_path.
          const codigoZipFiles = ((fs ?? []) as ProjectFile[]).filter(
            (f) => f.type === "codigo_zip",
          );
          const root = myGroupId ?? user.id;
          if (codigoZipFiles.length > 0 && root) {
            await Promise.all(
              codigoZipFiles.map(async (f) => {
                const existing = map[f.id];
                if (existing?.code_paths && existing.code_paths.length > 0) return;
                if (existing?.zip_path) return;
                const prefix = `${root}/${sub.id}/${f.id}`;
                const { data: listed } = await supabase.storage
                  .from("project-files")
                  .list(prefix, { limit: 100, sortBy: { column: "name", order: "asc" } });
                if (!listed || listed.length === 0) return;
                const discoveredPaths = listed
                  .filter((entry) => entry.name && !entry.name.endsWith("/"))
                  .map((entry) => `${prefix}/${entry.name}`);
                if (discoveredPaths.length === 0) return;
                // Si la fila no existía aún (entrega anterior incompleta)
                // creamos una virtual solo con code_paths — el render la
                // tratará igual que una persistida.
                if (existing) {
                  map[f.id] = { ...existing, code_paths: discoveredPaths };
                } else {
                  map[f.id] = {
                    file_id: f.id,
                    content: null,
                    ai_grade: null,
                    ai_feedback: null,
                    ai_likelihood: null,
                    ai_reasons: null,
                    zip_path: null,
                    code_paths: discoveredPaths,
                  };
                }
              }),
            );
          }
          if (!cancelled) setAnswersByFid(map);
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
    return <SectionLoader text={t("common.loading")} />;
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
      <PageHeader
        backTo="/app/student/projects"
        backLabel="Proyectos"
        title={project.title}
        subtitle={project.course?.name}
      />

      {!submission && (
        <Card className="border-dashed">
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("project.review.noSubmission")}
          </CardContent>
        </Card>
      )}

      {/* Antes la descripción se renderizaba dos veces — una con
          t("common.description") y otra con "Descripción del proyecto".
          Dejamos solo una para evitar el doble render que reportaron los
          alumnos. */}
      {project.description && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Descripción del proyecto</CardTitle>
          </CardHeader>
          <CardContent className="text-sm whitespace-pre-wrap">{project.description}</CardContent>
        </Card>
      )}

      {project.external_link && (
        <a
          href={project.external_link}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <ExternalLink className="h-4 w-4" /> Abrir recurso del proyecto
        </a>
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
                          when: formatDateTime(submission.submitted_at),
                        })
                      : t("project.review.submittedNoDate")}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-2xl font-semibold tabular-nums">
                  {gradeShow != null ? `${gradeShow} / ${project.max_score}` : "—"}
                </div>
                <StatusBadge status={submission.status} className="mt-1" />
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
                    {f.type === "codigo_zip" ? (
                      // Pregunta de código: la entrega vive en storage.
                      // Dos formas posibles según cuándo se entregó:
                      //   - `code_paths` (flujo nuevo): array de paths a
                      //     archivos individuales. Mostramos un botón de
                      //     descarga por archivo.
                      //   - `zip_path` (flujo viejo): un único path a ZIP.
                      // Si ambos son null, no se entregó nada.
                      (ans?.code_paths && ans.code_paths.length > 0) || ans?.zip_path ? (
                        <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                          {ans?.code_paths && ans.code_paths.length > 0
                            ? ans.code_paths.map((p) => (
                                <div key={p} className="flex items-center gap-3">
                                  <FileArchive className="h-5 w-5 text-primary shrink-0" />
                                  <p className="text-[12px] truncate flex-1">
                                    {p.split("/").pop()}
                                  </p>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={async () => {
                                      const { data, error } = await supabase.storage
                                        .from("project-files")
                                        .createSignedUrl(p, 60);
                                      if (error || !data?.signedUrl) {
                                        toast.error(
                                          error?.message ??
                                            "No se pudo generar enlace de descarga.",
                                        );
                                        return;
                                      }
                                      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
                                    }}
                                  >
                                    <Download className="h-3.5 w-3.5 mr-1" />
                                    Descargar
                                  </Button>
                                </div>
                              ))
                            : ans?.zip_path && (
                                <div className="flex items-center gap-3">
                                  <FileArchive className="h-6 w-6 text-primary shrink-0" />
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium">Código entregado (ZIP)</p>
                                    <p className="text-[11px] text-muted-foreground truncate">
                                      {ans.zip_path.split("/").pop()}
                                    </p>
                                  </div>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={async () => {
                                      if (!ans.zip_path) return;
                                      const { data, error } = await supabase.storage
                                        .from("project-files")
                                        .createSignedUrl(ans.zip_path, 60);
                                      if (error || !data?.signedUrl) {
                                        toast.error(
                                          error?.message ??
                                            "No se pudo generar enlace de descarga.",
                                        );
                                        return;
                                      }
                                      window.open(data.signedUrl, "_blank", "noopener,noreferrer");
                                    }}
                                  >
                                    <Download className="h-3.5 w-3.5 mr-1" />
                                    Descargar
                                  </Button>
                                </div>
                              )}
                        </div>
                      ) : (
                        // Sin archivos en esta pregunta: matiza el mensaje
                        // según el contexto para que el alumno no confunda
                        // "no entregué" con "ya califiqué sin archivos".
                        //
                        //  - Hay `ans` con `ai_feedback` o `ai_grade` → la
                        //    IA ya corrió (probablemente con 0 por entrega
                        //    vacía). El feedback se muestra debajo; aquí
                        //    aclaramos que la entrega no incluyó archivos.
                        //  - No hay `ans` o todo es null → realmente no se
                        //    subió nada todavía.
                        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                          {ans && (ans.ai_feedback || ans.ai_grade != null)
                            ? "Tu entrega no incluyó archivos de código para esta sección. Revisa la retroalimentación abajo."
                            : "Aún no has subido los archivos de código para esta sección."}
                        </div>
                      )
                    ) : (
                      <div className="rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap font-mono max-h-72 overflow-y-auto">
                        {ans?.content && ans.content.trim()
                          ? ans.content
                          : t("project.review.noAnswer")}
                      </div>
                    )}
                    {ans?.ai_feedback && ans.ai_feedback.trim() && (
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
                    {/* Caso intermedio: la entrega ya fue calificada (status
                        calificado/ai_revisado) pero la IA dejó esta pregunta
                        sin `ai_feedback`. Esto pasa cuando hubo timeout o
                        falla silenciosa en el edge function — antes el alumno
                        veía la Card sin ningún texto y creía que faltaba algo.
                        Ahora mostramos una nota explícita. */}
                    {(submission?.status === "calificado" ||
                      submission?.status === "ai_revisado") &&
                      ans &&
                      (!ans.ai_feedback || !ans.ai_feedback.trim()) && (
                        <div className="border-t pt-3 text-[11px] text-amber-700 dark:text-amber-300">
                          La IA no generó retroalimentación para esta sección. Pide a tu docente que
                          recalifique con IA o que revise manualmente.
                        </div>
                      )}
                    {submission && (
                      <FeedbackThread
                        parentKind="project"
                        questionId={f.id}
                        submissionId={submission.id}
                      />
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
