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
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useReloadOnVisible } from "@/shared/hooks/use-reload-on-visible";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { ErrorState } from "@/components/ui/empty-state";
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
import { StudentWorkshopTaker } from "@/modules/workshops/WorkshopQuestions";
import { formatDateTime } from "@/shared/lib/format";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";

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
    group_mode?: "individual" | "teacher_assigned" | "self_signup" | "group_required";
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
  const [search, setSearch] = useState("");
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [questionsWs, setQuestionsWs] = useState<WorkshopRow | null>(null);
  // Estado de error explícito: si la query principal falla, mostramos
  // ErrorState con botón "Reintentar" en vez de una grilla vacía.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

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
      toast.error(friendlyError(error));
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
    const { data: asg, error: asgErr } = await client
      .from("workshop_assignments")
      .select(
        "workshop:workshops(id, title, description, instructions, external_link, due_date, start_date, max_score, status, is_external, group_mode, course:courses(name, grade_scale_min, grade_scale_max, language))",
      )
      .eq("user_id", uid);
    if (asgErr) {
      setLoadError(friendlyError(asgErr, "No pudimos cargar tus talleres."));
      return;
    }
    setLoadError(null);

    // Externos no se listan: solo se registran notas, el estudiante
    // ve la calificación directo en gradebook.
    // Draft tampoco se lista: el docente aún no lo publicó. Closed sí
    // se muestra (con badge "Cerrado") para que el estudiante vea sus
    // entregas/notas previas — coherente con projects.
    const workshops = (asg ?? [])
      .map((a: any) => a.workshop)
      .filter(
        (w: any) =>
          Boolean(w) && !w.is_external && (w.status ?? "published") !== "draft",
      );
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
    // retryNonce: bumpeado por ErrorState "Reintentar". eslint-disable
    // intencional porque `reload` no está memoizada (patrón canonical).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce]);

  // Refetch al volver al tab — si el docente extendió/recortó fechas
  // mientras el alumno tenía la pestaña en background, el `isOverdue`
  // de cada workshop se recalcula al instante con los datos nuevos.
  // Antes el cliente se quedaba con el snapshot del mount inicial y
  // seguía marcando "vencido" aunque el due_date ya hubiera cambiado.
  useReloadOnVisible(() => {
    if (user) void reload(user.id);
  });

  const now = Date.now();
  // Filtra por título del taller + nombre del curso. Case-insensitive,
  // includes. Las descripciones se omiten para que la búsqueda sea
  // rápida en mobile (no abruma con texto secundario).
  const visibleRows = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(
      (r) =>
        r.workshop.title.toLowerCase().includes(q) ||
        (r.workshop.course?.name?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, search]);

  // Si la query principal falló, render explícito con botón Reintentar
  // en vez de una grilla vacía silenciosa.
  if (loadError) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("nav.workshops")}</h1>
        </div>
        <ErrorState
          message="No pudimos cargar tus talleres"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("nav.workshops")}</h1>
        <p className="text-sm text-muted-foreground">
          {visibleRows.length} {t("nav.workshops").toLowerCase()}
        </p>
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Buscar por taller o curso…"
      />

      <div className="grid md:grid-cols-2 gap-3">
        {visibleRows.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {search.trim() && rows.length > 0
              ? "Sin coincidencias. Ajusta el buscador."
              : t("common.empty")}
          </p>
        )}
        {visibleRows.map(({ workshop, submission, groupId }) => {
          const isOverdue = workshop.due_date && new Date(workshop.due_date).getTime() < now;
          const isUpcoming = workshop.start_date && new Date(workshop.start_date).getTime() > now;
          const grade = submission?.final_grade ?? submission?.ai_grade;
          const isGraded = submission?.status === "calificado";
          const isOpen = workshop.status === "published" && !isOverdue && !isUpcoming;
          // Modo mixto (teacher_assigned): coexisten estudiantes con grupo y sin
          // grupo — los segundos entregan individual. Modo grupal estricto
          // (group_required): los estudiantes sin grupo NO pueden entregar.
          const isGroupWorkshop = workshop.group_mode && workshop.group_mode !== "individual";
          const requiresGroup = workshop.group_mode === "group_required";
          const blockedNoGroup = requiresGroup && !groupId;
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

                {/* Modo grupal estricto SIN grupo: no se puede entregar.
                    Mostramos un aviso en lugar del CTA. */}
                {isOpen && blockedNoGroup && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                    <div className="font-medium mb-1">Modo grupal — sin grupo asignado</div>
                    Tu docente configuró este taller como grupal. Aún no perteneces a ningún
                    grupo, así que no puedes entregar. Pídele al docente que te asigne a uno.
                  </div>
                )}

                {/* CTA principal: responder/editar entrega. Mientras esté
                    abierto el plazo, el estudiante puede actualizar su
                    entrega aunque ya haya sido calificada por la IA — al
                    re-entregar se vuelve a calificar. En modo mixto: si
                    el estudiante tiene grupo, la entrega es del grupo;
                    si no, entrega individualmente. */}
                {isOpen && !blockedNoGroup && (
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
