/**
 * Vista del estudiante — Calificaciones por cortes.
 *
 * REGLA DE NEGOCIO INMUTABLE (ver EXAMLAB-CONTEXT.md):
 *   Curso → Σ(Cortes × peso)
 *   Corte → Σ([Talleres, Exámenes, Proyectos, Asistencia] × peso)
 *
 * Los pesos globales del curso (`exam_weight`, `workshop_weight`, etc.) son
 * defaults para sembrar cortes nuevos pero NO se usan en el cálculo aquí.
 * La fuente de verdad es `grade_cuts` + sus sub-pesos.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ClipboardList,
  FileText,
  Hammer,
  TrendingUp,
  CheckCircle2,
  XCircle,
  Scale,
  MessageSquareText,
  FolderKanban,
  CalendarCheck,
} from "lucide-react";
import {
  computeCutGrade,
  computeCourseFinalGrade,
  type CutComponentScores,
  type CutWeights,
} from "@/utils/grade";
import { computeAttemptGrade, type RetryMode } from "@/utils/exam-attempts";

// grade_cuts/projects no siempre están en types.ts auto-generados.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/student/grades")({ component: StudentGrades });

type Course = {
  id: string;
  name: string;
  period: string | null;
  grade_scale_min: number;
  grade_scale_max: number;
  passing_grade: number;
};

type Cut = {
  id: string;
  name: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
  weight: number;
  workshop_weight: number;
  exam_weight: number;
  project_weight: number;
  attendance_weight: number;
};

type ItemRow = {
  id: string;
  title: string;
  kind: "exam" | "workshop" | "project" | "attendance";
  cut_id: string | null;
  grade: number | null; // ya normalizado a la escala del curso
  rawGrade: number | null;
  rawMax: number;
  status: string;
  weight?: number; // peso relativo (solo para exámenes por ahora)
  reviewExamId?: string | null;
  reviewWorkshopId?: string | null;
};

type CutBreakdown = {
  cut: Cut;
  items: ItemRow[];
  componentScores: CutComponentScores;
  weights: CutWeights;
  grade: number | null;
};

function StudentGrades() {
  const { user } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [cutsBreakdown, setCutsBreakdown] = useState<CutBreakdown[]>([]);
  const [unassigned, setUnassigned] = useState<ItemRow[]>([]);
  const [loading, setLoading] = useState(false);

  // Carga cursos matriculados
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const { data: enr } = await supabase
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", user.id);
      const ids = (enr ?? []).map((e: { course_id: string }) => e.course_id);
      if (!ids.length) {
        setCourses([]);
        return;
      }
      const { data } = await supabase
        .from("courses")
        .select("id, name, period, grade_scale_min, grade_scale_max, passing_grade")
        .in("id", ids)
        .order("period", { ascending: false, nullsFirst: false })
        .order("name");
      const cs = (data ?? []) as Course[];
      setCourses(cs);
      if (cs[0]) setCourseId(cs[0].id);
    })();
  }, [user]);

  // Carga datos de cortes/items para el curso seleccionado
  useEffect(() => {
    if (!user || !courseId) return;
    const course = courses.find((c) => c.id === courseId);
    if (!course) return;

    void (async () => {
      setLoading(true);
      try {
        const [
          { data: cutsData },
          { data: exams },
          { data: workshops },
          { data: projects },
          { data: sessions },
        ] = await Promise.all([
          db
            .from("grade_cuts")
            .select(
              "id, name, position, start_date, end_date, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
            )
            .eq("course_id", courseId)
            .order("position"),
          (supabase as any)
            .from("exams")
            .select("id, title, parent_exam_id, cut_id, weight, retry_mode")
            .eq("course_id", courseId),
          supabase
            .from("workshops")
            .select("id, title, max_score, cut_id")
            .eq("course_id", courseId),
          db
            .from("projects")
            .select("id, title, max_score, cut_id")
            .eq("course_id", courseId),
          db
            .from("attendance_sessions")
            .select("id, session_date")
            .eq("course_id", courseId),
        ]);

        const cuts = (cutsData ?? []) as Cut[];
        const examIds = (exams ?? []).map((e: { id: string }) => e.id);
        const wsIds = (workshops ?? []).map((w: { id: string }) => w.id);
        const prjIds = ((projects ?? []) as { id: string }[]).map((p) => p.id);
        const sessIds = ((sessions ?? []) as { id: string }[]).map((s) => s.id);

        const [{ data: examSubs }, { data: wsSubs }, { data: prjSubs }, { data: attRecords }] =
          await Promise.all([
            examIds.length
              ? supabase
                  .from("submissions")
                  .select("exam_id, ai_grade, final_override_grade, status")
                  .in("exam_id", examIds)
                  .eq("user_id", user.id)
              : Promise.resolve({ data: [] as any[] }),
            wsIds.length
              ? supabase
                  .from("workshop_submissions")
                  .select("workshop_id, ai_grade, final_grade, status")
                  .in("workshop_id", wsIds)
                  .eq("user_id", user.id)
              : Promise.resolve({ data: [] as any[] }),
            prjIds.length
              ? db
                  .from("project_submissions")
                  .select("project_id, ai_grade, final_grade, status")
                  .in("project_id", prjIds)
                  .eq("user_id", user.id)
              : Promise.resolve({ data: [] as any[] }),
            sessIds.length
              ? supabase
                  .from("attendance_records")
                  .select("session_id, status")
                  .in("session_id", sessIds)
                  .eq("user_id", user.id)
              : Promise.resolve({ data: [] as any[] }),
          ]);

        // Helper: escala una nota raw (0..max) a la escala del curso.
        const toScale = (raw: number, max: number) => {
          const pct = max > 0 ? raw / max : 0;
          return course.grade_scale_min + pct * (course.grade_scale_max - course.grade_scale_min);
        };

        // Construye filas para cada item del curso (ya escaladas).
        const rows: ItemRow[] = [];

        // Exámenes (solo originales, no makeups)
        const originalExams = (exams ?? []).filter((e: any) => !e.parent_exam_id);
        for (const e of originalExams as any[]) {
          let sub = (examSubs ?? []).find((s: any) => s.exam_id === e.id);
          if (!sub) {
            const makeupIds = (exams ?? [])
              .filter((x: any) => x.parent_exam_id === e.id)
              .map((x: any) => x.id);
            sub = (examSubs ?? []).find((s: any) => makeupIds.includes(s.exam_id));
          }
          const raw = sub ? (sub.final_override_grade ?? sub.ai_grade) : null;
          // ai_grade ya está en la escala del curso (post-migración).
          rows.push({
            id: e.id,
            title: e.title,
            kind: "exam",
            cut_id: e.cut_id ?? null,
            rawGrade: raw,
            rawMax: course.grade_scale_max,
            grade: raw != null ? toScale(raw, course.grade_scale_max) : null,
            status: sub?.status ?? "sin_entrega",
            weight: Number(e.weight ?? 1),
            reviewExamId:
              sub && (sub.status === "completado" || sub.status === "sospechoso")
                ? sub.exam_id
                : null,
          });
        }

        // Talleres
        for (const w of (workshops ?? []) as any[]) {
          const sub = (wsSubs ?? []).find((s: any) => s.workshop_id === w.id);
          const raw = sub ? (sub.final_grade ?? sub.ai_grade) : null;
          rows.push({
            id: w.id,
            title: w.title,
            kind: "workshop",
            cut_id: w.cut_id ?? null,
            rawGrade: raw,
            rawMax: w.max_score ?? 100,
            grade: raw != null ? toScale(raw, w.max_score ?? 100) : null,
            status: sub?.status ?? "pendiente",
            reviewWorkshopId: sub ? w.id : null,
          });
        }

        // Proyectos
        for (const p of (projects ?? []) as any[]) {
          const sub = (prjSubs ?? []).find((s: any) => s.project_id === p.id);
          const raw = sub ? (sub.final_grade ?? sub.ai_grade) : null;
          rows.push({
            id: p.id,
            title: p.title,
            kind: "project",
            cut_id: p.cut_id ?? null,
            rawGrade: raw,
            rawMax: p.max_score ?? 100,
            grade: raw != null ? toScale(raw, p.max_score ?? 100) : null,
            status: sub?.status ?? "pendiente",
          });
        }

        // Asistencia: agrupa por corte usando session_date entre fechas del corte.
        // Cuenta sesiones del rango y cuántas registró el estudiante como "presente".
        const allSessions = (sessions ?? []) as { id: string; session_date: string }[];
        const allRecords = (attRecords ?? []) as { session_id: string; status: string }[];
        const recordsBySession = new Map(allRecords.map((r) => [r.session_id, r.status]));

        // Construye el desglose por corte
        const breakdown: CutBreakdown[] = cuts.map((cut) => {
          const cutItems = rows.filter((r) => r.cut_id === cut.id);

          // Promedios por componente (de los items con nota)
          const avg = (items: ItemRow[]): number | null => {
            const withGrade = items.filter((i) => i.grade != null);
            if (!withGrade.length) return null;
            return withGrade.reduce((a, b) => a + (b.grade as number), 0) / withGrade.length;
          };
          // Promedio ponderado por peso relativo (para exámenes)
          const weightedAvg = (items: ItemRow[]): number | null => {
            const withGrade = items.filter((i) => i.grade != null);
            if (!withGrade.length) return null;
            const totalW = withGrade.reduce((a, b) => a + (b.weight ?? 1), 0);
            if (totalW <= 0) return avg(items);
            return (
              withGrade.reduce((a, b) => a + (b.grade as number) * (b.weight ?? 1), 0) / totalW
            );
          };

          const workshopAvg = avg(cutItems.filter((i) => i.kind === "workshop"));
          const examAvg = weightedAvg(cutItems.filter((i) => i.kind === "exam"));
          const projectAvg = avg(cutItems.filter((i) => i.kind === "project"));

          // Asistencia del corte: filtra sesiones por fecha, calcula % presente y escala.
          let attendanceAvg: number | null = null;
          let attItem: ItemRow | null = null;
          if (cut.start_date && cut.end_date) {
            const sessionsInCut = allSessions.filter(
              (s) =>
                s.session_date >= cut.start_date! && s.session_date <= cut.end_date!,
            );
            if (sessionsInCut.length > 0) {
              const present = sessionsInCut.filter(
                (s) => recordsBySession.get(s.id) === "presente",
              ).length;
              const pct = present / sessionsInCut.length;
              attendanceAvg =
                course.grade_scale_min +
                pct * (course.grade_scale_max - course.grade_scale_min);
              attItem = {
                id: `attendance-${cut.id}`,
                title: `Asistencia (${present}/${sessionsInCut.length} sesiones)`,
                kind: "attendance",
                cut_id: cut.id,
                rawGrade: present,
                rawMax: sessionsInCut.length,
                grade: attendanceAvg,
                status: "calculado",
              };
            }
          }

          const componentScores: CutComponentScores = {
            workshop: workshopAvg,
            exam: examAvg,
            project: projectAvg,
            attendance: attendanceAvg,
          };
          const weights: CutWeights = {
            workshop: cut.workshop_weight,
            exam: cut.exam_weight,
            project: cut.project_weight,
            attendance: cut.attendance_weight,
          };
          const grade = computeCutGrade(componentScores, weights);

          return {
            cut,
            items: attItem ? [...cutItems, attItem] : cutItems,
            componentScores,
            weights,
            grade,
          };
        });

        // Items sin corte asignado (informativo)
        setUnassigned(rows.filter((r) => !r.cut_id));
        setCutsBreakdown(breakdown);
      } finally {
        setLoading(false);
      }
    })();
  }, [user, courseId, courses]);

  const course = courses.find((c) => c.id === courseId);

  const finalGrade = useMemo(
    () =>
      computeCourseFinalGrade(
        cutsBreakdown.map((c) => ({ weight: c.cut.weight, grade: c.grade })),
      ),
    [cutsBreakdown],
  );

  const passes = course && finalGrade != null ? finalGrade >= course.passing_grade : null;
  const fmt = (n: number | null) => (n == null ? "—" : n.toFixed(2));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calificaciones</h1>
          <p className="text-sm text-muted-foreground">
            Consolidado por cortes y nota final del curso
          </p>
        </div>
        {courses.length > 0 && (
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Curso" />
            </SelectTrigger>
            <SelectContent>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                  {c.period ? ` · ${c.period}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {courses.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-muted-foreground text-sm">
            <ClipboardList className="h-10 w-10 mx-auto text-muted-foreground/60 mb-2" />
            No estás matriculado en ningún curso.
          </CardContent>
        </Card>
      ) : !course ? null : (
        <>
          {/* Tarjetas resumen: una por corte + final */}
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {cutsBreakdown.map((cb) => (
              <Card key={cb.cut.id}>
                <CardContent className="p-4 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground uppercase tracking-wide">
                      {cb.cut.name}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      {cb.cut.weight}%
                    </Badge>
                  </div>
                  <div className="text-2xl font-semibold tabular-nums">{fmt(cb.grade)}</div>
                  <div className="text-[11px] text-muted-foreground">
                    T:{cb.weights.workshop}% E:{cb.weights.exam}% P:{cb.weights.project}% A:
                    {cb.weights.attendance}%
                  </div>
                </CardContent>
              </Card>
            ))}
            <Card
              className={
                passes === true
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : passes === false
                    ? "border-destructive/40 bg-destructive/5"
                    : ""
              }
            >
              <CardContent className="p-4 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Nota final
                  </span>
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="text-2xl font-semibold tabular-nums">{fmt(finalGrade)}</div>
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

          {/* Escala del curso */}
          <div className="flex flex-wrap items-center gap-4 rounded-md border p-3 bg-muted/30 text-sm">
            <div className="flex items-center gap-1.5">
              <Scale className="h-4 w-4 text-primary" />
              <span className="font-medium">Escala:</span>
              <span className="tabular-nums">
                {course.grade_scale_min} – {course.grade_scale_max}
              </span>
            </div>
            <div className="text-muted-foreground">
              Aprobar ≥{" "}
              <span className="font-medium tabular-nums">{course.passing_grade}</span>
            </div>
          </div>

          {/* Detalle por corte */}
          {loading ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground">Cargando…</CardContent>
            </Card>
          ) : cutsBreakdown.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center text-sm text-muted-foreground">
                Este curso aún no tiene cortes evaluativos configurados.
              </CardContent>
            </Card>
          ) : (
            cutsBreakdown.map((cb) => (
              <Card key={cb.cut.id}>
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
                  <div>
                    <CardTitle className="text-base">{cb.cut.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">
                      Peso: {cb.cut.weight}% del total · Nota:{" "}
                      <span className="font-medium tabular-nums">{fmt(cb.grade)}</span>
                    </p>
                  </div>
                  {cb.cut.start_date && cb.cut.end_date && (
                    <Badge variant="outline" className="text-[10px]">
                      {cb.cut.start_date} → {cb.cut.end_date}
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="p-0 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Actividad</TableHead>
                        <TableHead className="hidden sm:table-cell">Tipo</TableHead>
                        <TableHead className="text-right">Bruto</TableHead>
                        <TableHead className="text-right">
                          Equiv ({course.grade_scale_min}–{course.grade_scale_max})
                        </TableHead>
                        <TableHead className="hidden md:table-cell">Estado</TableHead>
                        <TableHead className="text-right w-[1%]">Detalle</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {cb.items.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={6} className="text-center text-muted-foreground py-6">
                            Sin actividades en este corte.
                          </TableCell>
                        </TableRow>
                      ) : (
                        cb.items.map((it) => (
                          <TableRow key={`${it.kind}-${it.id}`}>
                            <TableCell className="font-medium">{it.title}</TableCell>
                            <TableCell className="hidden sm:table-cell">
                              <KindBadge kind={it.kind} />
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {it.rawGrade != null ? `${it.rawGrade} / ${it.rawMax}` : "—"}
                            </TableCell>
                            <TableCell className="text-right tabular-nums font-medium">
                              {fmt(it.grade)}
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                              <Badge variant="secondary" className="text-[10px] capitalize">
                                {it.status.replace(/_/g, " ")}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              {it.kind === "exam" && it.reviewExamId ? (
                                <Link
                                  to="/app/student/review/$examId"
                                  params={{ examId: it.reviewExamId }}
                                >
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1 text-xs"
                                  >
                                    <MessageSquareText className="h-3.5 w-3.5" />
                                    Detalle
                                  </Button>
                                </Link>
                              ) : it.kind === "workshop" && it.reviewWorkshopId ? (
                                <Link
                                  to="/app/student/workshop/$workshopId"
                                  params={{ workshopId: it.reviewWorkshopId }}
                                >
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1 text-xs"
                                  >
                                    <MessageSquareText className="h-3.5 w-3.5" />
                                    Detalle
                                  </Button>
                                </Link>
                              ) : (
                                <span className="text-muted-foreground text-xs">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))
          )}

          {/* Items sin corte asignado */}
          {unassigned.length > 0 && (
            <Card className="border-dashed">
              <CardHeader>
                <CardTitle className="text-base">Sin corte asignado</CardTitle>
                <p className="text-xs text-muted-foreground">
                  Estas actividades aún no están asociadas a un corte y no afectan tu nota final.
                </p>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Actividad</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead className="text-right">Bruto</TableHead>
                      <TableHead className="text-right">
                        Equiv ({course.grade_scale_min}–{course.grade_scale_max})
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {unassigned.map((it) => (
                      <TableRow key={`${it.kind}-${it.id}`}>
                        <TableCell>{it.title}</TableCell>
                        <TableCell>
                          <KindBadge kind={it.kind} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {it.rawGrade != null ? `${it.rawGrade} / ${it.rawMax}` : "—"}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{fmt(it.grade)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <p className="text-xs text-muted-foreground">
            La nota del curso se calcula sumando el promedio ponderado de cada corte. Cada corte
            promedia talleres, exámenes, proyectos y asistencia con los pesos definidos por el
            docente. Componentes sin datos no penalizan: sus pesos se reparten entre los demás.
          </p>
        </>
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: ItemRow["kind"] }) {
  switch (kind) {
    case "exam":
      return (
        <Badge variant="outline" className="text-[10px]">
          <FileText className="h-3 w-3 mr-1" />
          Examen
        </Badge>
      );
    case "workshop":
      return (
        <Badge variant="outline" className="text-[10px]">
          <Hammer className="h-3 w-3 mr-1" />
          Taller
        </Badge>
      );
    case "project":
      return (
        <Badge variant="outline" className="text-[10px]">
          <FolderKanban className="h-3 w-3 mr-1" />
          Proyecto
        </Badge>
      );
    case "attendance":
      return (
        <Badge variant="outline" className="text-[10px]">
          <CalendarCheck className="h-3 w-3 mr-1" />
          Asistencia
        </Badge>
      );
  }
}
