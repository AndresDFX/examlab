/**
 * Student Projects — list assigned projects, deliver via per-file text boxes.
 *
 * Refactor del flujo ZIP previo: ahora cada proyecto muestra N cajas de
 * texto (una por `project_files` row); el estudiante pega el contenido de
 * cada archivo y al enviar la IA califica caja por caja. La calificación final se
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
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { StudentProjectTaker } from "@/components/ProjectFiles";
import { formatDateTime } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";

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
    is_external?: boolean | null;
    status: string;
    group_mode?: "individual" | "teacher_assigned" | "self_signup";
    course: {
      name: string;
      grade_scale_min: number;
      grade_scale_max: number;
      language?: string | null;
    };
  };
  /** Si el proyecto es grupal y el estudiante tiene grupo, ID del grupo. */
  groupId?: string | null;
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
  const confirm = useConfirm();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<ProjectRow | null>(null);

  /** Borra la entrega del estudiante (RLS restringe a dentro del plazo).
   *  Los archivos asociados caen por CASCADE (FK en project_submission_files).
   *  En modo grupal afecta a la entrega del grupo. */
  const deleteSubmission = async (projectTitle: string, submissionId: string, isGroup: boolean) => {
    const ok = await confirm({
      title: t("project.deleteMySubmissionTitle"),
      description: isGroup
        ? t("project.deleteMySubmissionBodyGroup", { title: projectTitle })
        : t("project.deleteMySubmissionBodyIndividual", { title: projectTitle }),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("project_submissions").delete().eq("id", submissionId);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Entrega eliminada");
    if (user) await reload(user.id);
  };

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
          "id, title, description, instructions, start_date, due_date, max_files, max_score, is_external, status, group_mode, course:courses(name, grade_scale_min, grade_scale_max, language)",
        )
        .in("id", allIds)
        .neq("status", "draft");
      if (res.error) {
        console.warn("[student-projects] projects+join failed, retrying without join", res.error);
        res = await db
          .from("projects")
          .select(
            "id, title, description, instructions, start_date, due_date, max_files, max_score, status, group_mode, course_id",
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

    // Para proyectos grupales: el estudiante puede tener un grupo, y la
    // submission pertenece al grupo (no al user). Mapeamos project_id
    // → group_id y la query de submissions cambia entre user_id y group_id
    // según el caso.
    const groupProjectIds = projects
      .filter((p) => p.group_mode && p.group_mode !== "individual")
      .map((p) => p.id);
    const groupIdByProject = new Map<string, string>();
    if (groupProjectIds.length > 0) {
      const { data: myGroups } = await db
        .from("project_group_members")
        .select("group:project_groups!inner(id, project_id)")
        .eq("user_id", uid);
      for (const m of (myGroups ?? []) as {
        group: { id: string; project_id: string };
      }[]) {
        if (m.group && groupProjectIds.includes(m.group.project_id)) {
          groupIdByProject.set(m.group.project_id, m.group.id);
        }
      }
    }

    // Splitting: individuales (incluye grupales sin grupo asignado, modo mixto)
    // se buscan por user_id; los grupales con grupo asignado por group_id.
    const indivIds = ids.filter((id) => !groupIdByProject.has(id));
    const myGroupIds = Array.from(groupIdByProject.values());

    let subs: Array<ProjectRow["submission"] & { project_id: string }> = [];
    if (indivIds.length || myGroupIds.length) {
      try {
        const [{ data: indivSubs }, { data: groupSubs }] = await Promise.all([
          indivIds.length
            ? db
                .from("project_submissions")
                .select(
                  "id, project_id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at, group_id",
                )
                .in("project_id", indivIds)
                .eq("user_id", uid)
            : Promise.resolve({ data: [] as any[] }),
          myGroupIds.length
            ? db
                .from("project_submissions")
                .select(
                  "id, project_id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at, group_id",
                )
                .in("group_id", myGroupIds)
            : Promise.resolve({ data: [] as any[] }),
        ]);
        subs = [...((indivSubs ?? []) as typeof subs), ...((groupSubs ?? []) as typeof subs)];
      } catch (e) {
        console.error("[student-projects] project_submissions load failed", e);
      }
    }

    setRows(
      projects.map((p) => ({
        project: p,
        submission: subs.find((s) => s.project_id === p.id) as ProjectRow["submission"],
        groupId: groupIdByProject.get(p.id) ?? null,
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
        <p className="text-sm text-muted-foreground">{rows.length} proyectos asignados</p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {rows.length === 0 && <p className="text-muted-foreground text-sm">{t("common.empty")}</p>}
        {rows.map(({ project, submission, groupId }) => {
          const isOverdue = project.due_date && new Date(project.due_date).getTime() < now;
          const isUpcoming = project.start_date && new Date(project.start_date).getTime() > now;
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
                      {grade != null
                        ? `${project.is_external ? grade : +(project.course.grade_scale_min + (grade / (project.max_score || 100)) * (project.course.grade_scale_max - project.course.grade_scale_min)).toFixed(2)}/${project.course.grade_scale_max}`
                        : t("project.submitted")}
                    </Badge>
                  ) : submission?.status === "entregado" ? (
                    <Badge variant="secondary" className="shrink-0">
                      {t("project.submitted")}
                    </Badge>
                  ) : isOverdue ? (
                    <Badge variant="destructive" className="shrink-0">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      {t("dashboard.overdue")}
                    </Badge>
                  ) : isOpen ? (
                    <Badge className="bg-success text-success-foreground shrink-0">
                      {t("project.available")}
                    </Badge>
                  ) : isUpcoming ? (
                    <Badge variant="outline" className="shrink-0">
                      {t("project.upcoming")}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">
                      {t("project.closed")}
                    </Badge>
                  )}
                </div>

                {project.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {project.description}
                  </p>
                )}

                <div className="text-xs text-muted-foreground space-y-0.5">
                  {project.start_date && isUpcoming && (
                    <div className="flex items-center gap-1.5 tabular-nums">
                      <Clock className="h-3 w-3" />
                      Disponible desde: {formatDateTime(project.start_date)}
                    </div>
                  )}
                  {project.due_date && (
                    <div className="flex items-center gap-1.5 tabular-nums">
                      <Clock className="h-3 w-3" />
                      {t("dashboard.dueLabel")}: {formatDateTime(project.due_date)}
                    </div>
                  )}
                </div>

                {(submission?.teacher_feedback || submission?.ai_feedback) && (
                  <div className="bg-muted/50 p-2 rounded text-sm">
                    <div className="text-xs font-medium flex items-center gap-1 mb-1">
                      <MessageSquare className="h-3 w-3" />
                      {t("project.review.feedback")}
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

                {/* Mientras esté abierto el plazo, el estudiante puede
                    actualizar su entrega aunque ya tenga calificación de
                    IA — al re-entregar se vuelve a calificar. */}
                {isOpen && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setActive({ project, submission, groupId });
                      setOpen(true);
                    }}
                  >
                    <ListChecks className="h-4 w-4 mr-1" />
                    {submission ? t("project.update") : t("project.start")}
                  </Button>
                )}

                {submission && (
                  <Link to="/app/student/project/$projectId" params={{ projectId: project.id }}>
                    <Button variant="secondary" size="sm" className="w-full">
                      <MessageSquareText className="h-4 w-4 mr-1" />
                      {t("project.viewDetail")}
                    </Button>
                  </Link>
                )}

                {/* Eliminar mi entrega — solo dentro del plazo. RLS lo
                    valida también en BD (migración 20260508140000). */}
                {isOpen && submission && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="w-full text-destructive hover:text-destructive"
                    onClick={() => deleteSubmission(project.title, submission.id, !!groupId)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Eliminar mi entrega
                  </Button>
                )}

                {project.status === "published" && isOverdue && !submission && (
                  <p className="text-xs text-destructive text-center">
                    {t("project.windowClosedHelp")}
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
              {active.project.description && (
                <div className="rounded-md bg-muted/40 p-3 text-sm whitespace-pre-wrap">
                  {active.project.description}
                </div>
              )}
              <StudentProjectTaker
                projectId={active.project.id}
                projectTitle={active.project.title}
                maxScore={active.project.max_score}
                courseLanguage={active.project.course?.language === "en" ? "en" : "es"}
                groupId={active.groupId ?? null}
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
