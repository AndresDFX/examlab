import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClipboardList, FileText, Hammer, TrendingUp, CheckCircle2, XCircle, Scale } from "lucide-react";

export const Route = createFileRoute("/app/student/grades")({ component: StudentGrades });

type Course = {
  id: string;
  name: string;
  period: string | null;
  grade_scale_min: number;
  grade_scale_max: number;
  exam_weight: number;
  workshop_weight: number;
  passing_grade: number;
};

type GradeItem = {
  id: string;
  title: string;
  kind: "exam" | "workshop";
  grade: number | null;
  maxScore: number; // for workshops, the configured max; for exams we assume 100
  status: string;
};

function StudentGrades() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [items, setItems] = useState<GradeItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Load enrolled courses
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: enr } = await supabase.from("course_enrollments").select("course_id").eq("user_id", user.id);
      const ids = (enr ?? []).map((e: any) => e.course_id);
      if (!ids.length) { setCourses([]); return; }
      const { data } = await supabase
        .from("courses")
        .select("id, name, period, grade_scale_min, grade_scale_max, exam_weight, workshop_weight, passing_grade")
        .in("id", ids)
        .order("period", { ascending: false, nullsFirst: false })
        .order("name");
      const cs = (data ?? []) as Course[];
      setCourses(cs);
      if (cs[0]) setCourseId(cs[0].id);
    })();
  }, [user]);

  // Load grades for selected course
  useEffect(() => {
    if (!user || !courseId) return;
    (async () => {
      setLoading(true);
      try {
        const [{ data: exams }, { data: workshops }] = await Promise.all([
          supabase.from("exams").select("id, title, parent_exam_id").eq("course_id", courseId),
          supabase.from("workshops").select("id, title, max_score").eq("course_id", courseId),
        ]);

        const examIds = (exams ?? []).map((e: any) => e.id);
        const wsIds = (workshops ?? []).map((w: any) => w.id);

        const [{ data: examSubs }, { data: wsSubs }] = await Promise.all([
          examIds.length
            ? supabase.from("submissions").select("exam_id, ai_grade, final_override_grade, status").in("exam_id", examIds).eq("user_id", user.id)
            : Promise.resolve({ data: [] as any[] }),
          wsIds.length
            ? supabase.from("workshop_submissions").select("workshop_id, ai_grade, final_grade, status").in("workshop_id", wsIds).eq("user_id", user.id)
            : Promise.resolve({ data: [] as any[] }),
        ]);

        // Original exams only (no makeup parents)
        const originalExams = (exams ?? []).filter((e: any) => !e.parent_exam_id);

        const examItems: GradeItem[] = originalExams.map((e: any) => {
          // direct submission
          let sub = (examSubs ?? []).find((s: any) => s.exam_id === e.id);
          if (!sub) {
            // any makeup submission
            const makeupIds = (exams ?? []).filter((x: any) => x.parent_exam_id === e.id).map((x: any) => x.id);
            sub = (examSubs ?? []).find((s: any) => makeupIds.includes(s.exam_id));
          }
          const g = sub ? (sub.final_override_grade ?? sub.ai_grade) : null;
          return { id: e.id, title: e.title, kind: "exam", grade: g, maxScore: 100, status: sub?.status ?? "sin_entrega" };
        });

        const wsItems: GradeItem[] = (workshops ?? []).map((w: any) => {
          const sub = (wsSubs ?? []).find((s: any) => s.workshop_id === w.id);
          const g = sub ? (sub.final_grade ?? sub.ai_grade) : null;
          return { id: w.id, title: w.title, kind: "workshop", grade: g, maxScore: w.max_score ?? 100, status: sub?.status ?? "pendiente" };
        });

        setItems([...examItems, ...wsItems]);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, courseId]);

  const course = courses.find(c => c.id === courseId);

  // Compute averages normalized to course scale
  const computeAverages = () => {
    if (!course) return { exams: null, workshops: null, final: null };

    const scale = (raw: number, max: number) => {
      // Raw is on 0-max → normalize to course scale (min..max)
      const pct = max > 0 ? raw / max : 0;
      return course.grade_scale_min + pct * (course.grade_scale_max - course.grade_scale_min);
    };

    const examsWithGrade = items.filter(i => i.kind === "exam" && i.grade != null);
    const wsWithGrade = items.filter(i => i.kind === "workshop" && i.grade != null);

    const examsAvg = examsWithGrade.length
      ? examsWithGrade.reduce((a, b) => a + scale(b.grade!, b.maxScore), 0) / examsWithGrade.length
      : null;
    const wsAvg = wsWithGrade.length
      ? wsWithGrade.reduce((a, b) => a + scale(b.grade!, b.maxScore), 0) / wsWithGrade.length
      : null;

    let final: number | null = null;
    const ew = course.exam_weight;
    const ww = course.workshop_weight;
    if (examsAvg != null && wsAvg != null) {
      const totalW = ew + ww;
      final = totalW > 0 ? (examsAvg * ew + wsAvg * ww) / totalW : null;
    } else if (examsAvg != null) final = examsAvg;
    else if (wsAvg != null) final = wsAvg;

    return { exams: examsAvg, workshops: wsAvg, final };
  };

  const { exams: examsAvg, workshops: wsAvg, final } = computeAverages();
  const passes = course && final != null ? final >= course.passing_grade : null;

  const fmt = (n: number | null) => n == null ? "—" : n.toFixed(2);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calificaciones</h1>
          <p className="text-sm text-muted-foreground">Consolidado por curso con tu nota actual</p>
        </div>
        {courses.length > 0 && (
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger className="w-64"><SelectValue placeholder="Curso" /></SelectTrigger>
            <SelectContent>
              {courses.map(c => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}{c.period ? ` · ${c.period}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {courses.length === 0 ? (
        <Card><CardContent className="p-10 text-center text-muted-foreground text-sm">
          <ClipboardList className="h-10 w-10 mx-auto text-muted-foreground/60 mb-2" />
          No estás matriculado en ningún curso.
        </CardContent></Card>
      ) : !course ? null : (
        <>
          {/* Summary cards */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <SummaryCard
              icon={<FileText className="h-4 w-4 text-primary" />}
              label="Promedio exámenes"
              value={fmt(examsAvg)}
              hint={`${course.exam_weight}% del total`}
            />
            <SummaryCard
              icon={<Hammer className="h-4 w-4 text-amber-500 dark:text-amber-400" />}
              label="Promedio talleres"
              value={fmt(wsAvg)}
              hint={`${course.workshop_weight}% del total`}
            />
            <SummaryCard
              icon={<Scale className="h-4 w-4 text-muted-foreground" />}
              label="Escala"
              value={`${course.grade_scale_min} – ${course.grade_scale_max}`}
              hint={`Aprobar ≥ ${course.passing_grade}`}
            />
            <Card className={passes === true ? "border-emerald-500/40 bg-emerald-500/5" : passes === false ? "border-destructive/40 bg-destructive/5" : ""}>
              <CardContent className="p-4 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">Nota actual</span>
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="text-2xl font-semibold tabular-nums">{fmt(final)}</div>
                {passes === true && (
                  <div className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="h-3 w-3" /> Aprobando
                  </div>
                )}
                {passes === false && (
                  <div className="flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3" /> Por debajo del mínimo
                  </div>
                )}
                {passes == null && (
                  <div className="text-xs text-muted-foreground">Sin calificaciones aún</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Detail table */}
          <Card>
            <CardContent className="p-0">
              {loading ? (
                <div className="p-6 text-sm text-muted-foreground">Cargando…</div>
              ) : items.length === 0 ? (
                <div className="p-10 text-center text-muted-foreground text-sm">No hay actividades en este curso.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Actividad</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead className="text-right">Nota</TableHead>
                      <TableHead className="text-right">Equiv. ({course.grade_scale_min}–{course.grade_scale_max})</TableHead>
                      <TableHead>Estado</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map(it => {
                      const equiv = it.grade != null
                        ? course.grade_scale_min + (it.grade / it.maxScore) * (course.grade_scale_max - course.grade_scale_min)
                        : null;
                      return (
                        <TableRow key={`${it.kind}-${it.id}`}>
                          <TableCell className="font-medium">{it.title}</TableCell>
                          <TableCell>
                            {it.kind === "exam" ? (
                              <Badge variant="outline" className="text-[10px]"><FileText className="h-3 w-3 mr-1" />Examen</Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px]"><Hammer className="h-3 w-3 mr-1" />Taller</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {it.grade != null ? `${it.grade} / ${it.maxScore}` : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-right tabular-nums font-medium">{fmt(equiv)}</TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="text-[10px] capitalize">{it.status.replace(/_/g, " ")}</Badge>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            La nota actual se calcula como promedio ponderado: exámenes ({course.exam_weight}%) y talleres ({course.workshop_weight}%), normalizado a la escala {course.grade_scale_min}–{course.grade_scale_max} del curso.
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="p-4 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
          {icon}
        </div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}
