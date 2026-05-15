import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { Clock, Play, CheckCircle2, AlertTriangle, MessageSquareText, ShieldAlert } from "lucide-react";
import { StudentExamNotes } from "@/components/ExamNotesManager";
import { MAX_WARNINGS } from "@/utils/proctoring";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/app/student/exams")({ component: StudentExams });

type ExamRow = {
  exam: {
    id: string;
    title: string;
    description: string | null;
    start_time: string;
    end_time: string;
    time_limit_minutes: number;
    parent_exam_id?: string | null;
    max_attempts?: number | null;
    course: {
      name: string;
      grade_scale_min: number;
      grade_scale_max: number;
      max_exam_attempts?: number;
    };
  };
  submission?: {
    id: string;
    exam_id: string;
    status: string;
    ai_grade: number | null;
    final_override_grade: number | null;
    focus_warnings: number | null;
  };
  attemptsUsed: number;
  maxAttempts: number;
};

function StudentExams() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [rows, setRows] = useState<ExamRow[]>([]);
  const [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState("");

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: asg } = await supabase
        .from("exam_assignments")
        .select(
          "exam:exams(id, title, description, start_time, end_time, time_limit_minutes, parent_exam_id, max_attempts, max_warnings, is_external, allow_exam_notes, course:courses(name, grade_scale_min, grade_scale_max, max_exam_attempts))",
        )
        .eq("user_id", user.id);
      // Filtramos los externos: el estudiante no debería verlos en
      // su lista de exámenes — la nota llega por gradebook directamente.
      const exams = (asg ?? [])
        .map((a: any) => a.exam)
        .filter((e: any) => Boolean(e) && !e.is_external);
      const assignedIds = exams.map((e: any) => e.id);
      let makeupRows: { id: string; parent_exam_id: string | null }[] = [];
      if (assignedIds.length) {
        const { data: mr } = await supabase
          .from("exams")
          .select("id, parent_exam_id")
          .in("parent_exam_id", assignedIds);
        makeupRows = mr ?? [];
      }
      const submissionExamIds = [...new Set([...assignedIds, ...makeupRows.map((m) => m.id)])];
      type SubRow = {
        id: string;
        exam_id: string;
        status: string;
        ai_grade: number | null;
        final_override_grade: number | null;
        focus_warnings: number | null;
      };
      const { data: subs } = submissionExamIds.length
        ? await supabase
            .from("submissions")
            .select("id, exam_id, status, ai_grade, final_override_grade, focus_warnings")
            .in("exam_id", submissionExamIds)
            .eq("user_id", user.id)
        : { data: [] as SubRow[] };

      const findSubmission = (examId: string): SubRow | undefined => {
        const list = subs as SubRow[] | undefined;
        let sub = list?.find((s) => s.exam_id === examId);
        if (sub) return sub;
        const makeupIds = makeupRows.filter((m) => m.parent_exam_id === examId).map((m) => m.id);
        return list?.find((s) => makeupIds.includes(s.exam_id));
      };

      const countAttempts = (examId: string): number => {
        const list = (subs ?? []) as SubRow[];
        return list.filter(
          (s) => s.exam_id === examId && (s.status === "completado" || s.status === "sospechoso"),
        ).length;
      };

      setRows(
        exams.map((e: any) => {
          const courseMax = Number(e.course?.max_exam_attempts ?? 1) || 1;
          const examMax = e.max_attempts != null ? Number(e.max_attempts) : courseMax;
          return {
            exam: e,
            submission: findSubmission(e.id),
            attemptsUsed: countAttempts(e.id),
            maxAttempts: Math.max(1, examMax),
          };
        }),
      );
    })();
  }, [user]);

  // Filtramos por título del examen + nombre del curso. Case-insensitive,
  // includes. La búsqueda es local al cliente — la lista del estudiante
  // raramente supera unos pocos exámenes activos.
  const visibleRows = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter(
      (r) =>
        r.exam.title.toLowerCase().includes(q) ||
        r.exam.course?.name?.toLowerCase().includes(q),
    );
  }, [rows, search]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("exam.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("exam.availableSubtitle", { count: visibleRows.length })}
        </p>
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Buscar por examen o curso…"
      />

      <div className="grid md:grid-cols-2 gap-3">
        {visibleRows.length === 0 && (
          <p className="text-muted-foreground text-sm">
            {search.trim() && rows.length > 0
              ? "Sin coincidencias. Ajusta el buscador."
              : t("exam.noExamsAvailable")}
          </p>
        )}
        {visibleRows.map(({ exam, submission, attemptsUsed, maxAttempts }) => {
          const start = new Date(exam.start_time).getTime();
          const end = new Date(exam.end_time).getTime();
          const isOpen = now >= start && now <= end;
          const completed =
            submission?.status === "completado" || submission?.status === "sospechoso";
          const grade = submission?.final_override_grade ?? submission?.ai_grade;
          const reviewExamId = completed && submission?.exam_id ? submission.exam_id : exam.id;
          const noAttemptsLeft = attemptsUsed >= maxAttempts;
          return (
            <Card key={exam.id}>
              <CardContent className="p-5 space-y-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{exam.course?.name}</div>
                    <h3 className="font-semibold truncate">{exam.title}</h3>
                  </div>
                  {completed ? (
                    <Badge
                      variant={submission?.status === "sospechoso" ? "destructive" : "default"}
                      className="shrink-0"
                    >
                      {submission?.status === "sospechoso" ? (
                        <AlertTriangle className="h-3 w-3 mr-1" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                      )}
                      {grade != null
                        ? t("exam.gradeLabel", { grade, max: exam.course?.grade_scale_max ?? 5 })
                        : t("exam.submitted")}
                    </Badge>
                  ) : isOpen ? (
                    <Badge className="bg-success text-success-foreground shrink-0">
                      {t("exam.available")}
                    </Badge>
                  ) : now < start ? (
                    <Badge variant="outline" className="shrink-0">
                      {t("exam.upcoming")}
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="shrink-0">
                      {t("exam.closed")}
                    </Badge>
                  )}
                </div>
                {exam.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">{exam.description}</p>
                )}
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <Clock className="h-3 w-3" />
                    {t("exam.availability", {
                      start: formatDateTime(exam.start_time),
                      end: formatDateTime(exam.end_time),
                    })}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>{t("exam.duration", { min: exam.time_limit_minutes })}</span>
                    {maxAttempts > 1 && (
                      <Badge variant="outline" className="text-[10px] py-0 px-1.5">
                        Intento {Math.min(attemptsUsed + (completed ? 0 : 1), maxAttempts)} de{" "}
                        {maxAttempts}
                      </Badge>
                    )}
                  </div>
                  {submission?.status === "en_progreso" &&
                    (submission.focus_warnings ?? 0) > 0 && (
                      <div className="flex items-center gap-1 mt-0.5">
                        <ShieldAlert className="h-3 w-3 text-destructive" />
                        <span className="text-destructive font-medium">
                          {submission.focus_warnings}/
                          {(exam as any).max_warnings ?? MAX_WARNINGS} strikes registrados
                        </span>
                      </div>
                    )}
                </div>
                {/* Solo mostramos el componente de notas de apoyo si
                    el docente las habilitó para este examen. Default
                    true para mantener compat con exámenes pre-toggle. */}
                {!completed &&
                  user &&
                  now < end &&
                  ((exam as { allow_exam_notes?: boolean }).allow_exam_notes ?? true) && (
                    <StudentExamNotes examId={exam.id} userId={user.id} />
                  )}
                {completed && !noAttemptsLeft && isOpen ? (
                  <div className="space-y-2">
                    <Link to="/app/student/take/$examId" params={{ examId: exam.id }}>
                      <Button size="sm" className="w-full">
                        <Play className="h-4 w-4 mr-1" />
                        Reintentar examen
                      </Button>
                    </Link>
                    <Link to="/app/student/review/$examId" params={{ examId: reviewExamId }}>
                      <Button variant="ghost" size="sm" className="w-full">
                        <MessageSquareText className="h-4 w-4 mr-1" />
                        {t("exam.viewDetail")}
                      </Button>
                    </Link>
                  </div>
                ) : completed ? (
                  <Link to="/app/student/review/$examId" params={{ examId: reviewExamId }}>
                    <Button variant="secondary" size="sm" className="w-full">
                      <MessageSquareText className="h-4 w-4 mr-1" />
                      {t("exam.viewDetail")}
                    </Button>
                  </Link>
                ) : submission?.status === "en_progreso" && !isOpen && now > end ? (
                  <div className="space-y-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled
                      className="w-full cursor-not-allowed"
                    >
                      {t("exam.windowClosed")}
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground leading-snug">
                      {t("exam.windowClosedHelp")}
                    </p>
                  </div>
                ) : noAttemptsLeft ? (
                  <div className="space-y-2">
                    <Button size="sm" disabled variant="outline" className="w-full">
                      <Play className="h-4 w-4 mr-1" />
                      Sin intentos disponibles
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground leading-snug">
                      Has agotado los {maxAttempts} intento(s) permitidos para este examen.
                    </p>
                  </div>
                ) : isOpen &&
                  submission?.status === "en_progreso" &&
                  (submission.focus_warnings ?? 0) >=
                    ((exam as any).max_warnings ?? MAX_WARNINGS) ? (
                  <div className="space-y-2">
                    <Button size="sm" disabled variant="outline" className="w-full">
                      <ShieldAlert className="h-4 w-4 mr-1" />
                      Examen suspendido
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground leading-snug">
                      Alcanzaste el máximo de advertencias. El docente puede revisar tu caso.
                    </p>
                  </div>
                ) : isOpen ? (
                  <Link to="/app/student/take/$examId" params={{ examId: exam.id }}>
                    <Button size="sm" className="w-full">
                      <Play className="h-4 w-4 mr-1" />
                      {submission?.status === "en_progreso" ? t("exam.resume") : t("exam.start")}
                    </Button>
                  </Link>
                ) : now < start ? (
                  <div className="space-y-2">
                    <Button size="sm" disabled variant="outline" className="w-full">
                      <Play className="h-4 w-4 mr-1" />
                      Aún no disponible
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground leading-snug">
                      Este examen está próximo a empezar. Podrás acceder cuando abra la ventana.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Button size="sm" disabled variant="outline" className="w-full">
                      <Play className="h-4 w-4 mr-1" />
                      Examen cerrado
                    </Button>
                    <p className="text-[11px] text-center text-muted-foreground leading-snug">
                      El periodo de este examen ya finalizó.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
