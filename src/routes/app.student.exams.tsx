import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, Play, CheckCircle2, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/app/student/exams")({ component: StudentExams });

type ExamRow = {
  exam: { id: string; title: string; description: string | null; start_time: string; end_time: string; time_limit_minutes: number; course: { name: string; grade_scale_min: number; grade_scale_max: number } };
  submission?: { id: string; status: string; ai_grade: number | null; final_override_grade: number | null };
};

function StudentExams() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ExamRow[]>([]);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: asg } = await supabase.from("exam_assignments")
        .select("exam:exams(id, title, description, start_time, end_time, time_limit_minutes, course:courses(name, grade_scale_min, grade_scale_max))")
        .eq("user_id", user.id);
      const exams = (asg ?? []).map((a: any) => a.exam).filter(Boolean);
      const ids = exams.map((e: any) => e.id);
      const { data: subs } = ids.length
        ? await supabase.from("submissions").select("id, exam_id, status, ai_grade, final_override_grade").in("exam_id", ids).eq("user_id", user.id)
        : { data: [] as any[] };
      setRows(exams.map((e: any) => ({ exam: e, submission: subs?.find((s: any) => s.exam_id === e.id) })));
    })();
  }, [user]);

  // Only show exams whose start_time has arrived, or that have a submission already
  const visibleRows = rows.filter(({ exam, submission }) => {
    if (submission) return true; // always show if student already interacted
    return new Date(exam.start_time).getTime() <= now;
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Exámenes</h1>
        <p className="text-sm text-muted-foreground">{visibleRows.length} exámenes disponibles</p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {visibleRows.length === 0 && <p className="text-muted-foreground text-sm">No tienes exámenes disponibles en este momento.</p>}
        {visibleRows.map(({ exam, submission }) => {
          const start = new Date(exam.start_time).getTime();
          const end = new Date(exam.end_time).getTime();
          const isOpen = now >= start && now <= end;
          const completed = submission?.status === "completado" || submission?.status === "sospechoso";
          const grade = submission?.final_override_grade ?? submission?.ai_grade;
          return (
            <Card key={exam.id}>
              <CardContent className="p-5 space-y-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{exam.course?.name}</div>
                    <h3 className="font-semibold truncate">{exam.title}</h3>
                  </div>
                  {completed ? (
                    <Badge variant={submission?.status === "sospechoso" ? "destructive" : "default"} className="shrink-0">
                      {submission?.status === "sospechoso" ? <AlertTriangle className="h-3 w-3 mr-1" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
                      {grade != null ? `Nota: ${grade}/${exam.course?.grade_scale_max ?? 5}` : "Enviado"}
                    </Badge>
                  ) : isOpen ? (
                    <Badge className="bg-success text-success-foreground shrink-0">Disponible</Badge>
                  ) : now < start ? (
                    <Badge variant="outline" className="shrink-0">Próximo</Badge>
                  ) : (
                    <Badge variant="secondary" className="shrink-0">Cerrado</Badge>
                  )}
                </div>
                {exam.description && <p className="text-sm text-muted-foreground line-clamp-2">{exam.description}</p>}
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div className="flex items-center gap-1.5"><Clock className="h-3 w-3" />Disponible: {new Date(exam.start_time).toLocaleString()} → {new Date(exam.end_time).toLocaleString()}</div>
                  <div>Duración: {exam.time_limit_minutes} min</div>
                </div>
                {!completed && (
                  <Link to="/app/student/take/$examId" params={{ examId: exam.id }}>
                    <Button size="sm" disabled={!isOpen} className="w-full">
                      <Play className="h-4 w-4 mr-1" />{submission?.status === "en_progreso" ? "Reanudar examen" : "Iniciar examen"}
                    </Button>
                  </Link>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
