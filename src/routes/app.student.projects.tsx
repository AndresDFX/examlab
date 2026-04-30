/**
 * Student Projects — list assigned projects, deliver via per-file text boxes.
 *
 * Refactor del flujo ZIP previo: ahora cada proyecto muestra N cajas de
 * texto (una por `project_files` row); el estudiante pega el contenido de
 * cada archivo y al enviar la IA califica caja por caja. La nota final se
 * calcula sobre `max_score` del proyecto.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Clock,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  MessageSquareText,
  ListChecks,
  FileText,
} from "lucide-react";
import { StudentProjectTaker } from "@/components/ProjectFiles";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/student/projects")({ component: StudentProjects });

type ProjectRow = {
  project: {
    id: string;
    title: string;
    description: string | null;
    instructions: string | null;
    start_date: string | null;
    due_date: string | null;
    max_files: number;
    max_score: number;
    status: string;
    course: {
      name: string;
      grade_scale_min: number;
      grade_scale_max: number;
      language?: string | null;
    };
  };
  submission?: {
    id: string;
    ai_grade: number | null;
    ai_feedback: string | null;
    final_grade: number | null;
    teacher_feedback: string | null;
    status: string;
    submitted_at: string | null;
  };
};

function StudentProjects() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ProjectRow | null>(null);

  const reload = async (uid: string) => {
    // Cada paso loguea su error a consola para que el diagnóstico sea
    // posible cuando "no aparece nada". No usamos Promise.all porque la
    // fase 2/3 dependen de la 1.
    let enrolledCourseIds: string[] = [];
    try {
      const { data, error } = await db
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", uid);
      if (error) throw new Error(`course_enrollments: ${error.message}`);
      enrolledCourseIds = ((data ?? []) as { course_id: string }[]).map((e) => e.course_id);
    } catch (e) {
      console.error("[student-projects] enrollments load failed", e);
    }

    let linkedProjectIds: string[] = [];
    if (enrolledCourseIds.length) {
      try {
        const { data, error } = await db
          .from("project_courses")
          .select("project_id")
          .in("course_id", enrolledCourseIds);
        if (error) throw new Error(`project_courses: ${error.message}`);
        linkedProjectIds = ((data ?? []) as { project_id: string }[]).map((r) => r.project_id);
      } catch (e) {
        console.error("[student-projects] project_courses load failed", e);
      }
    }

    let assignedProjectIds: string[] = [];
    try {
      const { data, error } = await db
        .from("project_assignments")
        .select("project_id")
        .eq("user_id", uid);
      if (error) throw new Error(`project_assignments: ${error.message}`);
      assignedProjectIds = ((data ?? []) as { project_id: string }[]).map((r) => r.project_id);
    } catch (e) {
      console.error("[student-projects] project_assignments load failed", e);
    }

    const allIds = Array.from(new Set([...linkedProjectIds, ...assignedProjectIds]));
    console.info(
      `[student-projects] enrolled=${enrolledCourseIds.length} linked=${linkedProjectIds.length} assigned=${assignedProjectIds.length} → ${allIds.length} project(s)`,
    );
    if (!allIds.length) {
      setRows([]);
      return;
    }

    let projects: ProjectRow["project"][] = [];
    try {
      // Reintenta sin el JOIN si la columna `language` no existe en la BD.
      let res = await db
        .from("projects")
        .select(
          "id, title, description, instructions, start_date, due_date, max_files, max_score, status, course:courses(name, grade_scale_min, grade_scale_max, language)",
        )
        .in("id", allIds)
        .neq("status", "draft");
      if (res.error) {
        console.warn("[student-projects] projects+join failed, retrying without join", res.error);
        res = await db
          .from("projects")
          .select(
            "id, title, description, instructions, start_date, due_date, max_files, max_score, status, course_id",
          )
          .in("id", allIds)
          .neq("status", "draft");
      }
      if (res.error) throw new Error(`projects: ${res.error.message}`);
      projects = (res.data ?? []) as ProjectRow["project"][];
    } catch (e) {
      console.error("[student-projects] projects load failed", e);
    }

    const ids = projects.map((p) => p.id);
    let subs: Array<ProjectRow["submission"] & { project_id: string }> = [];
    if (ids.length) {
      try {
        const { data, error } = await db
          .from("project_submissions")
          .select(
            "id, project_id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at",
          )
          .in("project_id", ids)
          .eq("user_id", uid);
        if (error) throw new Error(`project_submissions: ${error.message}`);
        subs = (data ?? []) as typeof subs;
      } catch (e) {
        console.error("[student-projects] project_submissions load failed", e);
      }
    }

    setRows(
      projects.map((p) => ({
        project: p,
        submission: subs.find((s) => s.project_id === p.id) as ProjectRow["submission"],
      })),
    );
  };

  useEffect(() => {
    if (!user) return;
    void reload(user.id);
  }, [user]);

  const now = Date.now();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Proyectos</h1>
        <p className="text-sm text-muted-foreground">
          {rows.length} proyectos asignados
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {rows.length === 0 && (
          <p className="text-muted-foreground text-sm">{t("common.empty")}</p>
        )}
        {rows.map(({ project, submission }) => {
          const isOverdue = project.due_date && new Date(project.due_date).getTime() < now;
          const isUpcoming =
            project.start_date && new Date(project.start_date).getTime() > now;
          const grade = submission?.final_grade ?? submission?.ai_grade;
          const isGraded = submission?.status === "calificado";
          const isOpen = project.status === "published" && !isOverdue && !isUpcoming;

          return (
            <Card key={project.id}>
              <CardContent className="p-5 space-y-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{project.course?.name}</div>
                    <h3 className="font-semibold truncate">{project.title}</h3>
                  </div>
                  {isGraded ? (
                    <Badge className="shrink-0">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      {grade != null ? `${grade}/${project.max_score}` : t("exam.submitted")}
                    </Badge>
                  ) : submission?.status === "entregado" ? (
                    <Badge variant="secondary" className="shrink-0">
                      {t("exam.submitted")}
                    </Badge>
                  ) : isOverdue ? (
                    <Badge variant="destructive" className="shrink-0">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {t("dashboard.overdue")}
                    </Badge>
                  ) : isOpen ? (
                    <Badge className="bg-success text-success-foreground shrink-0">
                      {t("exam.available")}
                    </Badge>
                  ) : isUpcoming ? (
                    <Badge variant="outline" className="shrink-0">
                      {t("exam.upcoming")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">
                      {t("exam.closed")}
                    </Badge>
                  )}
                </div>

                {project.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {project.description}
                  </p>
                )}

                <div className="text-xs text-muted-foreground space-y-0.5">
                  {project.due_date && (
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-3 w-3" />
                      {t("dashboard.dueLabel")}: {new Date(project.due_date).toLocaleString()}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <FileText className="h-3 w-3" />
                    {project.max_files} archivos esperados
                  </div>
                </div>

                {(submission?.teacher_feedback || submission?.ai_feedback) && (
                  <div className="bg-muted/50 p-2 rounded text-sm">
                    <div className="text-xs font-medium flex items-center gap-1 mb-1">
                      <MessageSquare className="h-3 w-3" />
                      {t("exam.review.feedback")}
                    </div>
                    <div className="whitespace-pre-wrap">
                      {[
                        ...new Set(
                          [submission?.teacher_feedback, submission?.ai_feedback].filter(
                            Boolean,
                          ) as string[],
                        ),
                      ].join("\n\n")}
                    </div>
                  </div>
                )}

                {isOpen && !isGraded && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setActive({ project, submission });
                      setOpen(true);
                    }}
                  >
                    <ListChecks className="h-4 w-4 mr-1" />
                    {submission ? t("common.update") : t("exam.start")}
                  </Button>
                )}

                {submission && (
                  <Link to="/app/student/project/$projectId" params={{ projectId: project.id }}>
                    <Button variant="secondary" size="sm" className="w-full">
                      <MessageSquareText className="h-4 w-4 mr-1" />
                      {t("exam.viewDetail")}
                    </Button>
                  </Link>
                )}

                {project.status === "published" && isOverdue && !submission && (
                  <p className="text-xs text-destructive text-center">
                    {t("exam.windowClosedHelp")}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o && user) void reload(user.id);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{active?.project.title}</DialogTitle>
          </DialogHeader>
          {active && (
            <>
              {active.project.instructions && (
                <div className="rounded-md bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                  {active.project.instructions}
                </div>
              )}
              <StudentProjectTaker
                projectId={active.project.id}
                projectTitle={active.project.title}
                maxScore={active.project.max_score}
                courseLanguage={active.project.course?.language === "en" ? "en" : "es"}
                onGraded={() => {
                  if (user) void reload(user.id);
                }}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
