/**
 * Modal "Por calificar" del dashboard del docente.
 *
 * Lista las submissions completadas que aún no tienen nota final manual:
 *   - Exámenes: submissions.status='completado' AND final_override_grade IS NULL
 *   - Talleres: workshop_submissions.status IN ('entregado','calificado')
 *               AND final_grade IS NULL
 *   - Proyectos: project_submissions.status='entregado' AND final_grade IS NULL
 *
 * Cada item navega a la vista de calificación correspondiente.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FileText, Hammer, FolderKanban, ArrowRight, Loader2 } from "lucide-react";
import { formatDateTime } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type ExamPending = {
  id: string;
  exam_id: string;
  user_id: string;
  submitted_at: string | null;
  exam: { id: string; title: string; course?: { name: string } | null } | null;
  studentName?: string;
};

type WorkshopPending = {
  id: string;
  workshop_id: string;
  user_id: string;
  submitted_at: string | null;
  workshop: { id: string; title: string; course?: { name: string } | null } | null;
  studentName?: string;
};

type ProjectPending = {
  id: string;
  project_id: string;
  user_id: string;
  submitted_at: string | null;
  project: { id: string; title: string; course?: { name: string } | null } | null;
  studentName?: string;
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PendingGradingModal({ open, onOpenChange }: Props) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [exams, setExams] = useState<ExamPending[]>([]);
  const [workshops, setWorkshops] = useState<WorkshopPending[]>([]);
  const [projects, setProjects] = useState<ProjectPending[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      // submissions.user_id → auth.users (no FK directa a profiles), así que
      // traemos profiles aparte y mappeamos por user_id en JS.
      // Hacemos la query plana (sin embeds anidados) y luego juntamos los
      // datos de exam/workshop/project + course en JS. Antes usábamos
      // `exam:exams!inner(id,title,course:courses(name))` pero PostgREST a
      // veces resolvía 0 filas dependiendo del estado del schema cache,
      // dejando el modal vacío aunque el conteo del dashboard mostrara N.
      const [eRes, wRes, pRes] = await Promise.all([
        db
          .from("submissions")
          .select("id, exam_id, user_id, submitted_at")
          .eq("status", "completado")
          .is("final_override_grade", null)
          .order("submitted_at", { ascending: false })
          .limit(50),
        db
          .from("workshop_submissions")
          .select("id, workshop_id, user_id, submitted_at")
          .in("status", ["entregado", "calificado"])
          .is("final_grade", null)
          .order("submitted_at", { ascending: false })
          .limit(50),
        db
          .from("project_submissions")
          .select("id, project_id, user_id, submitted_at")
          .eq("status", "entregado")
          .is("final_grade", null)
          .order("submitted_at", { ascending: false })
          .limit(50),
      ]);
      if (cancelled) return;
      if (eRes.error) console.warn("[PendingGradingModal] exams", eRes.error);
      if (wRes.error) console.warn("[PendingGradingModal] workshops", wRes.error);
      if (pRes.error) console.warn("[PendingGradingModal] projects", pRes.error);

      const eRowsRaw = (eRes.data ?? []) as Array<{
        id: string;
        exam_id: string;
        user_id: string;
        submitted_at: string | null;
      }>;
      const wRowsRaw = (wRes.data ?? []) as Array<{
        id: string;
        workshop_id: string;
        user_id: string;
        submitted_at: string | null;
      }>;
      const pRowsRaw = (pRes.data ?? []) as Array<{
        id: string;
        project_id: string;
        user_id: string;
        submitted_at: string | null;
      }>;

      const examIds = Array.from(new Set(eRowsRaw.map((r) => r.exam_id).filter(Boolean)));
      const workshopIds = Array.from(
        new Set(wRowsRaw.map((r) => r.workshop_id).filter(Boolean)),
      );
      const projectIds = Array.from(new Set(pRowsRaw.map((r) => r.project_id).filter(Boolean)));

      const [examsRes, workshopsRes, projectsRes] = await Promise.all([
        examIds.length
          ? db.from("exams").select("id, title, course_id").in("id", examIds)
          : Promise.resolve({ data: [] }),
        workshopIds.length
          ? db.from("workshops").select("id, title, course_id").in("id", workshopIds)
          : Promise.resolve({ data: [] }),
        projectIds.length
          ? db.from("projects").select("id, title, course_id").in("id", projectIds)
          : Promise.resolve({ data: [] }),
      ]);

      const examMap = new Map<string, { id: string; title: string; course_id: string }>();
      ((examsRes.data ?? []) as any[]).forEach((x) => examMap.set(x.id, x));
      const workshopMap = new Map<string, { id: string; title: string; course_id: string }>();
      ((workshopsRes.data ?? []) as any[]).forEach((x) => workshopMap.set(x.id, x));
      const projectMap = new Map<string, { id: string; title: string; course_id: string }>();
      ((projectsRes.data ?? []) as any[]).forEach((x) => projectMap.set(x.id, x));

      const courseIds = Array.from(
        new Set(
          [
            ...Array.from(examMap.values()),
            ...Array.from(workshopMap.values()),
            ...Array.from(projectMap.values()),
          ]
            .map((x) => x.course_id)
            .filter(Boolean),
        ),
      );
      const courseNameById = new Map<string, string>();
      if (courseIds.length) {
        const { data: cs } = await db.from("courses").select("id, name").in("id", courseIds);
        ((cs ?? []) as any[]).forEach((c) => courseNameById.set(c.id, c.name));
      }

      const eRows: ExamPending[] = eRowsRaw
        .filter((r) => examMap.has(r.exam_id))
        .map((r) => {
          const ex = examMap.get(r.exam_id)!;
          return {
            ...r,
            exam: {
              id: ex.id,
              title: ex.title,
              course: ex.course_id ? { name: courseNameById.get(ex.course_id) ?? "" } : null,
            },
          };
        });
      const wRows: WorkshopPending[] = wRowsRaw
        .filter((r) => workshopMap.has(r.workshop_id))
        .map((r) => {
          const w = workshopMap.get(r.workshop_id)!;
          return {
            ...r,
            workshop: {
              id: w.id,
              title: w.title,
              course: w.course_id ? { name: courseNameById.get(w.course_id) ?? "" } : null,
            },
          };
        });
      const pRows: ProjectPending[] = pRowsRaw
        .filter((r) => projectMap.has(r.project_id))
        .map((r) => {
          const p = projectMap.get(r.project_id)!;
          return {
            ...r,
            project: {
              id: p.id,
              title: p.title,
              course: p.course_id ? { name: courseNameById.get(p.course_id) ?? "" } : null,
            },
          };
        });

      // Recolecta todos los user_ids y trae profiles en un solo query.
      const userIds = Array.from(
        new Set([
          ...eRows.map((r) => r.user_id),
          ...wRows.map((r) => r.user_id),
          ...pRows.map((r) => r.user_id),
        ]),
      );
      const nameById = new Map<string, string>();
      if (userIds.length > 0) {
        const { data: profs } = await db.from("profiles").select("id, full_name").in("id", userIds);
        for (const p of (profs ?? []) as { id: string; full_name: string }[]) {
          nameById.set(p.id, p.full_name);
        }
      }
      const attach = <T extends { user_id: string; studentName?: string }>(rows: T[]) =>
        rows.map((r) => ({ ...r, studentName: nameById.get(r.user_id) ?? "Estudiante" }));

      setExams(attach(eRows));
      setWorkshops(attach(wRows));
      setProjects(attach(pRows));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const goToExam = (examId: string) => {
    onOpenChange(false);
    navigate({ to: "/app/teacher/monitor/$examId", params: { examId } });
  };
  const goToWorkshops = () => {
    onOpenChange(false);
    navigate({ to: "/app/teacher/workshops" });
  };
  const goToProjects = () => {
    onOpenChange(false);
    navigate({ to: "/app/teacher/projects" });
  };

  const total = exams.length + workshops.length + projects.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Por calificar
            {!loading && (
              <Badge variant="secondary" className="text-[10px]">
                {total}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : total === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No tienes entregas pendientes por calificar 🎉
          </p>
        ) : (
          <div className="space-y-4">
            {exams.length > 0 && (
              <Section
                icon={FileText}
                title="Exámenes"
                color="text-violet-500 dark:text-violet-400"
                count={exams.length}
              >
                {exams.map((s) => (
                  <PendingRow
                    key={s.id}
                    title={s.exam?.title ?? "(examen eliminado)"}
                    subtitle={`${s.studentName ?? "Estudiante"} · ${s.exam?.course?.name ?? ""}`}
                    when={s.submitted_at}
                    onGo={() => goToExam(s.exam_id)}
                  />
                ))}
              </Section>
            )}

            {workshops.length > 0 && (
              <Section
                icon={Hammer}
                title="Talleres"
                color="text-amber-500 dark:text-amber-400"
                count={workshops.length}
              >
                {workshops.map((s) => (
                  <PendingRow
                    key={s.id}
                    title={s.workshop?.title ?? "(taller eliminado)"}
                    subtitle={`${s.studentName ?? "Estudiante"} · ${s.workshop?.course?.name ?? ""}`}
                    when={s.submitted_at}
                    onGo={goToWorkshops}
                  />
                ))}
              </Section>
            )}

            {projects.length > 0 && (
              <Section
                icon={FolderKanban}
                title="Proyectos"
                color="text-rose-500 dark:text-rose-400"
                count={projects.length}
              >
                {projects.map((s) => (
                  <PendingRow
                    key={s.id}
                    title={s.project?.title ?? "(proyecto eliminado)"}
                    subtitle={`${s.studentName ?? "Estudiante"} · ${s.project?.course?.name ?? ""}`}
                    when={s.submitted_at}
                    onGo={goToProjects}
                  />
                ))}
              </Section>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Section({
  icon: Icon,
  title,
  color,
  count,
  children,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon: any;
  title: string;
  color: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${color}`} />
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant="outline" className="text-[10px]">
          {count}
        </Badge>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function PendingRow({
  title,
  subtitle,
  when,
  onGo,
}: {
  title: string;
  subtitle: string;
  when: string | null;
  onGo: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border p-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{title}</div>
        <div className="text-xs text-muted-foreground truncate">{subtitle}</div>
        {when && (
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Entregado: {formatDateTime(when)}
          </div>
        )}
      </div>
      <Button size="sm" variant="outline" onClick={onGo}>
        Calificar <ArrowRight className="h-3 w-3 ml-1" />
      </Button>
    </div>
  );
}
