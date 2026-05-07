/**
 * Modal "Notas de examen pendientes" del dashboard del docente.
 *
 * Lista las entregas de examen (`submissions`) cuya nota fue calculada
 * por la IA pero el docente todavía no la aprobó/sobreescribió:
 *   - ai_grade IS NOT NULL
 *   - final_override_grade IS NULL
 *
 * Mismo patrón visual que `OpenFeedbackModal`: filas compactas con
 * estudiante + curso + examen, y dos acciones por fila:
 *   - "Aprobar" → setea `final_override_grade = ai_grade` (1 click).
 *   - "Ir" → abre el monitor del examen con `?student=USER_ID` para
 *     que el docente pueda revisar respuestas o ajustar manualmente.
 *
 * Queries planas + joins en JS (mismo motivo que el modal de
 * conversaciones: embeds anidados de PostgREST son frágiles ante
 * schema cache stale).
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, CheckCircle2, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type SubmissionRow = {
  id: string;
  user_id: string;
  exam_id: string;
  ai_grade: number;
  submitted_at: string | null;
  // resueltos en JS
  examTitle?: string;
  courseName?: string;
  studentName?: string;
  maxScore?: number; // grade_scale_max del curso
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Callback opcional para refrescar el contador en el dashboard. */
  onChange?: () => void;
}

export function PendingExamGradesModal({ open, onOpenChange, onChange }: Props) {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await db
        .from("submissions")
        .select("id, user_id, exam_id, ai_grade, submitted_at")
        .is("final_override_grade", null)
        .not("ai_grade", "is", null)
        .order("submitted_at", { ascending: false })
        .limit(200);
      if (error) {
        console.warn("[PendingExamGradesModal]", error);
        setRows([]);
        return;
      }
      const subs = (data ?? []) as SubmissionRow[];
      if (subs.length === 0) {
        setRows([]);
        return;
      }

      const examIds = Array.from(new Set(subs.map((s) => s.exam_id)));
      const userIds = Array.from(new Set(subs.map((s) => s.user_id)));

      const [examsRes, usersRes] = await Promise.all([
        db.from("exams").select("id, title, course_id").in("id", examIds),
        db.from("profiles").select("id, full_name").in("id", userIds),
      ]);

      const examInfoById = new Map<string, { title: string; course_id: string | null }>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((examsRes.data ?? []) as any[]).forEach((x) =>
        examInfoById.set(x.id, { title: x.title, course_id: x.course_id ?? null }),
      );
      const courseIds = Array.from(
        new Set(
          Array.from(examInfoById.values())
            .map((v) => v.course_id)
            .filter(Boolean) as string[],
        ),
      );
      const courseById = new Map<string, { name: string; grade_scale_max: number }>();
      if (courseIds.length) {
        const { data: courses } = await db
          .from("courses")
          .select("id, name, grade_scale_max")
          .in("id", courseIds);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((courses ?? []) as any[]).forEach((c) =>
          courseById.set(c.id, {
            name: c.name,
            grade_scale_max: Number(c.grade_scale_max ?? 5),
          }),
        );
      }

      const nameById = new Map<string, string>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((usersRes.data ?? []) as any[]).forEach((p) => nameById.set(p.id, p.full_name));

      setRows(
        subs.map((s) => {
          const exam = examInfoById.get(s.exam_id);
          const course = exam?.course_id ? courseById.get(exam.course_id) : undefined;
          return {
            ...s,
            examTitle: exam?.title,
            courseName: course?.name,
            maxScore: course?.grade_scale_max ?? 5,
            studentName: nameById.get(s.user_id),
          };
        }),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  const approve = async (sub: SubmissionRow) => {
    setApprovingId(sub.id);
    const { error } = await db
      .from("submissions")
      .update({ final_override_grade: sub.ai_grade })
      .eq("id", sub.id);
    setApprovingId(null);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(`Nota aprobada: ${formatGrade(sub.ai_grade)} / ${sub.maxScore ?? 5}`);
    setRows((prev) => prev.filter((r) => r.id !== sub.id));
    onChange?.();
  };

  const goTo = (sub: SubmissionRow) => {
    onOpenChange(false);
    navigate({
      to: "/app/teacher/monitor/$examId",
      params: { examId: sub.exam_id },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      search: { student: sub.user_id } as any,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Notas de examen pendientes
            {!loading && (
              <Badge variant="secondary" className="text-[10px]">
                {rows.length}
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No hay notas de examen pendientes 🎉
          </p>
        ) : (
          <div className="space-y-1.5 min-w-0">
            {rows.map((sub) => (
              <PendingRow
                key={sub.id}
                sub={sub}
                approving={approvingId === sub.id}
                onApprove={() => approve(sub)}
                onGo={() => goTo(sub)}
              />
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PendingRow({
  sub,
  approving,
  onApprove,
  onGo,
}: {
  sub: SubmissionRow;
  approving: boolean;
  onApprove: () => void;
  onGo: () => void;
}) {
  const submittedWhen = sub.submitted_at;
  return (
    <div className="flex w-full min-w-0 items-center gap-2 rounded-md border p-2.5">
      <div className="min-w-0 flex-1 space-y-0.5 overflow-hidden">
        <div className="text-sm font-medium truncate">{sub.studentName ?? "Estudiante"}</div>
        <div className="text-xs text-muted-foreground truncate">
          {sub.courseName ? `${sub.courseName} · ` : ""}
          {sub.examTitle ?? "(examen eliminado)"}
        </div>
        <div className="text-[11px] text-muted-foreground/80 truncate tabular-nums">
          IA:{" "}
          <span className="font-medium text-foreground">
            {formatGrade(sub.ai_grade)} / {sub.maxScore ?? 5}
          </span>
          {submittedWhen ? ` · entregado ${formatDateTime(submittedWhen)}` : ""}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-1.5">
        <Button
          size="sm"
          variant="default"
          onClick={onApprove}
          disabled={approving}
          title="Aprobar la nota propuesta por la IA"
        >
          {approving ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <>
              <CheckCircle2 className="h-3 w-3 mr-1" />
              Aprobar
            </>
          )}
        </Button>
        <Button size="sm" variant="outline" onClick={onGo} title="Abrir en el monitor del examen">
          Ir <ArrowRight className="h-3 w-3 ml-1" />
        </Button>
      </div>
    </div>
  );
}

function formatGrade(n: number): string {
  // Formato es-CO con coma; máx 2 decimales sin trailing zeros.
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("es-CO", { maximumFractionDigits: 2 });
}
