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
  submitted_at: string | null;
  exam: { id: string; title: string; course?: { name: string } | null };
  student: { full_name: string } | null;
};

type WorkshopPending = {
  id: string;
  workshop_id: string;
  submitted_at: string | null;
  workshop: { id: string; title: string; course?: { name: string } | null };
  student: { full_name: string } | null;
};

type ProjectPending = {
  id: string;
  project_id: string;
  submitted_at: string | null;
  project: { id: string; title: string; course?: { name: string } | null };
  student: { full_name: string } | null;
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
      const [eRes, wRes, pRes] = await Promise.all([
        db
          .from("submissions")
          .select(
            "id, exam_id, submitted_at, exam:exams(id, title, course:courses(name)), student:profiles!submissions_user_id_fkey(full_name)",
          )
          .eq("status", "completado")
          .is("final_override_grade", null)
          .order("submitted_at", { ascending: false })
          .limit(50),
        db
          .from("workshop_submissions")
          .select(
            "id, workshop_id, submitted_at, workshop:workshops(id, title, course:courses(name)), student:profiles!workshop_submissions_user_id_fkey(full_name)",
          )
          .in("status", ["entregado", "calificado"])
          .is("final_grade", null)
          .order("submitted_at", { ascending: false })
          .limit(50),
        db
          .from("project_submissions")
          .select(
            "id, project_id, submitted_at, project:projects(id, title, course:courses(name)), student:profiles!project_submissions_user_id_fkey(full_name)",
          )
          .eq("status", "entregado")
          .is("final_grade", null)
          .order("submitted_at", { ascending: false })
          .limit(50),
      ]);
      if (cancelled) return;
      setExams(((eRes.data ?? []) as ExamPending[]).filter((r) => r.exam));
      setWorkshops(((wRes.data ?? []) as WorkshopPending[]).filter((r) => r.workshop));
      setProjects(((pRes.data ?? []) as ProjectPending[]).filter((r) => r.project));
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
                    title={s.exam.title}
                    subtitle={`${s.student?.full_name ?? "Estudiante"} · ${s.exam.course?.name ?? ""}`}
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
                    title={s.workshop.title}
                    subtitle={`${s.student?.full_name ?? "Estudiante"} · ${s.workshop.course?.name ?? ""}`}
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
                    title={s.project.title}
                    subtitle={`${s.student?.full_name ?? "Estudiante"} · ${s.project.course?.name ?? ""}`}
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
