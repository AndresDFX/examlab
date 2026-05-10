/**
 * Student-side workshop list.
 *
 * UX (vigente desde el refactor de talleres):
 *  - El estudiante NO sube archivos ni envía links. El único flujo de entrega
 *    es responder cada pregunta del taller.
 *  - "Responder y enviar" abre el `StudentWorkshopTaker`, que muestra las
 *    preguntas (abierta / cerrada / código / diagrama) y, al enviar, llama al
 *    edge function `ai-grade-submission` por cada pregunta y consolida la
 *    calificación final automáticamente.
 *  - El idioma del curso se pasa al Taker para que la IA responda en el
 *    idioma configurado (default español).
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
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  MessageSquareText,
  ListChecks,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { StudentWorkshopTaker } from "@/components/WorkshopQuestions";
import { formatDateTime } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";

export const Route = createFileRoute("/app/student/workshops")({ component: StudentWorkshops });

type WorkshopRow = {
  workshop: {
    id: string;
    title: string;
    description: string | null;
    instructions: string | null;
    external_link: string | null;
    due_date: string | null;
    start_date: string | null;
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
  /** Si el taller es grupal y el estudiante tiene grupo, ID del grupo. */
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

function StudentWorkshops() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [rows, setRows] = useState<WorkshopRow[]>([]);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [questionsWs, setQuestionsWs] = useState<WorkshopRow | null>(null);

  /** Borra la entrega del estudiante (RLS restringe a dentro del plazo).
   *  Las respuestas asociadas caen por CASCADE (FK añadida en
   *  20260508140000). En modo grupal afecta a la entrega del grupo. */
  const deleteSubmission = async (
    workshopTitle: string,
    submissionId: string,
    isGroup: boolean,
  ) => {
    const ok = await confirm({
      title: t("workshop.deleteMySubmissionTitle"),
      description: isGroup
        ? t("workshop.deleteMySubmissionBodyGroup", { title: workshopTitle })
        : t("workshop.deleteMySubmissionBodyIndividual", { title: workshopTitle }),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("workshop_submissions").delete().eq("id", submissionId);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Entrega eliminada");
    if (user) await reload(user.id);
  };

  const reload = async (uid: string) => {
    // courses.language se introdujo en migraciones recientes; cast hasta que se
    // refresque la tipificación generada de Supabase.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = supabase as any;
    const { data: asg } = await client
      .from("workshop_assignments")
      .select(
        "workshop:workshops(id, title, description, instructions, external_link, due_date, start_date, max_score, status, is_external, group_mode, course:courses(name, grade_scale_min, grade_scale_max, language))",
      )
      .eq("user_id", uid);

    // Externos no se listan: solo se registran notas, el estudiante
    // ve la calificación directo en gradebook.
    const workshops = (asg ?? [])
      .map((a: any) => a.workshop)
      .filter((w: any) => Boolean(w) && !w.is_external);
    const ids = workshops.map((w: any) => w.id);

    // Para talleres grupales: el estudiante puede tener un grupo, y la
    // submission pertenece al grupo (no al user). Mapeamos workshop_id
    // → group_id y la query de submission cambia entre user_id y group_id
    // según el caso.
    const groupWorkshopIds = workshops
      .filter((w: any) => w.group_mode && w.group_mode !== "individual")
      .map((w: any) => w.id as string);
    const groupIdByWorkshop = new Map<string, string>();
    if (groupWorkshopIds.length > 0) {
      const { data: myGroups } = await client
        .from("workshop_group_members")
        .select("group:workshop_groups!inner(id, workshop_id)")
        .eq("user_id", uid);
      for (const m of (myGroups ?? []) as {
        group: { id: string; workshop_id: string };
      }[]) {
        if (m.group && groupWorkshopIds.includes(m.group.workshop_id)) {
          groupIdByWorkshop.set(m.group.workshop_id, m.group.id);
        }
      }
    }

    // Splitting de IDs: los individuales se buscan por user_id; los
    // grupales por group_id de mi grupo (si lo tengo).
    const indivIds = ids.filter((id: string) => !groupIdByWorkshop.has(id));
    const myGroupIds = Array.from(groupIdByWorkshop.values());

    const [{ data: indivSubs }, { data: groupSubs }] = await Promise.all([
      indivIds.length > 0
        ? supabase
            .from("workshop_submissions")
            .select(
              "id, workshop_id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at, group_id",
            )
            .in("workshop_id", indivIds)
            .eq("user_id", uid)
        : Promise.resolve({ data: [] as any[] }),
      myGroupIds.length > 0
        ? supabase
            .from("workshop_submissions")
            .select(
              "id, workshop_id, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at, group_id",
            )
            .in("group_id", myGroupIds)
        : Promise.resolve({ data: [] as any[] }),
    ]);
    const subs = [...(indivSubs ?? []), ...(groupSubs ?? [])];

    setRows(
      workshops.map((w: any) => ({
        workshop: w,
        submission: subs?.find((s: any) => s.workshop_id === w.id),
        groupId: groupIdByWorkshop.get(w.id) ?? null,
      })),
    );
  };

  useEffect(() => {
    if (!user) return;
    void reload(user.id);
  }, [user]);

  const now = Date.now();
  const visibleRows = rows;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("nav.workshops")}</h1>
        <p className="text-sm text-muted-foreground">
          {visibleRows.length} {t("nav.workshops").toLowerCase()}
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {visibleRows.length === 0 && (
          <p className="text-muted-foreground text-sm">{t("common.empty")}</p>
        )}
        {visibleRows.map(({ workshop, submission, groupId }) => {
          const isOverdue = workshop.due_date && new Date(workshop.due_date).getTime() < now;
          const isUpcoming = workshop.start_date && new Date(workshop.start_date).getTime() > now;
          const grade = submission?.final_grade ?? submission?.ai_grade;
          const isGraded = submission?.status === "calificado";
          const isOpen = workshop.status === "published" && !isOverdue && !isUpcoming;
          // Modo mixto: en un taller con group_mode != 'individual',
          // pueden coexistir estudiantes con grupo (entregan en grupo) y
          // sin grupo (entregan individual). NO bloqueamos al estudiante
          // sin grupo — simplemente entrega individualmente.
          const isGroupWorkshop = workshop.group_mode && workshop.group_mode !== "individual";
          void isGroupWorkshop;
          return (
            <Card key={workshop.id}>
              <CardContent className="p-5 space-y-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{workshop.course?.name}</div>
                    <h3 className="font-semibold truncate">{workshop.title}</h3>
                  </div>
                  {isGraded ? (
                    <Badge className="shrink-0">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      {grade != null
                        ? `${workshop.is_external ? grade : +(workshop.course.grade_scale_min + (grade / (workshop.max_score || 100)) * (workshop.course.grade_scale_max - workshop.course.grade_scale_min)).toFixed(2)}/${workshop.course.grade_scale_max}`
                        : t("exam.submitted")}
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

                {workshop.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {workshop.description}
                  </p>
                )}

                <div className="text-xs text-muted-foreground space-y-0.5">
                  {workshop.start_date && isUpcoming && (
                    <div className="flex items-center gap-1.5 tabular-nums">
                      <Clock className="h-3 w-3" />
                      Disponible desde: {formatDateTime(workshop.start_date)}
                    </div>
                  )}
                  {workshop.due_date && (
                    <div className="flex items-center gap-1.5 tabular-nums">
                      <Clock className="h-3 w-3" />
                      {t("dashboard.dueLabel")}: {formatDateTime(workshop.due_date)}
                    </div>
                  )}
                </div>

                {workshop.external_link && (
                  <a
                    href={workshop.external_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary flex items-center gap-1 hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" /> {t("dashboard.cards.workshopsStudent")}
                  </a>
                )}

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

                {/* CTA principal: responder/editar entrega. Mientras esté
                    abierto el plazo, el estudiante puede actualizar su
                    entrega aunque ya haya sido calificada por la IA — al
                    re-entregar se vuelve a calificar. En modo mixto: si
                    el estudiante tiene grupo, la entrega es del grupo;
                    si no, entrega individualmente. */}
                {isOpen && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setQuestionsWs({ workshop, submission, groupId });
                      setQuestionsOpen(true);
                    }}
                  >
                    <ListChecks className="h-4 w-4 mr-1" />
                    {submission ? t("common.update") : t("workshop.startSubmission")}
                  </Button>
                )}

                {submission && (
                  <Link to="/app/student/workshop/$workshopId" params={{ workshopId: workshop.id }}>
                    <Button variant="secondary" size="sm" className="w-full">
                      <MessageSquareText className="h-4 w-4 mr-1" />
                      {t("exam.viewDetail")}
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
                    onClick={() => deleteSubmission(workshop.title, submission.id, !!groupId)}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Eliminar mi entrega
                  </Button>
                )}

                {workshop.status === "published" && isOverdue && !submission && (
                  <p className="text-xs text-destructive text-center">
                    {t("exam.windowClosedHelp")}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Workshop Questions Dialog — single entry-point for student delivery.
          On submit the Taker runs AI grading per question and writes the final
          grade back to workshop_submissions; we reload to reflect the new state. */}
      <Dialog
        open={questionsOpen}
        onOpenChange={(open) => {
          setQuestionsOpen(open);
          if (!open && user) void reload(user.id);
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{questionsWs?.workshop.title}</DialogTitle>
          </DialogHeader>
          {questionsWs && (
            <StudentWorkshopTaker
              workshopId={questionsWs.workshop.id}
              workshopTitle={questionsWs.workshop.title}
              maxScore={questionsWs.workshop.max_score}
              courseLanguage={questionsWs.workshop.course?.language === "en" ? "en" : "es"}
              groupId={questionsWs.groupId ?? null}
              onGraded={() => {
                if (user) void reload(user.id);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
