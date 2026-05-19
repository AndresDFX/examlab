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
import { RowAction } from "@/components/ui/row-action";
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
import { computeWeightedGrade } from "@/modules/grading/grade";
import { computeAttemptGrade, type RetryMode } from "@/modules/exams/exam-attempts";
import { StatusBadge } from "@/components/ui/status-badge";
import { TableEmpty } from "@/components/ui/empty-state";

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
            .select("id, title, max_score, cut_id, weight, is_external")
            .eq("course_id", courseId),
          // Proyectos via project_courses para incluir secundarios y usar
          // cut_id/weight por curso.
          db
            .from("project_courses")
            .select("cut_id, weight, project:projects(id, title, max_score, is_external)")
            .eq("course_id", courseId),
          db
            .from("attendance_sessions")
            .select("id, session_date, cut_id")
            .eq("course_id", courseId),
        ]);

        const cuts = (cutsData ?? []) as Cut[];
        const examIds = (exams ?? []).map((e: { id: string }) => e.id);
        const wsIds = (workshops ?? []).map((w: { id: string }) => w.id);
        // Flatten project_courses rows → per-course cut_id/weight override
        const flatProjects = (projects ?? []).map((pc: any) => ({
          ...(pc.project ?? pc),
          cut_id: pc.cut_id ?? null,
          weight: pc.weight ?? 1,
        }));
        const prjIds = flatProjects.map((p: { id: string }) => p.id);
        const sessIds = ((sessions ?? []) as { id: string }[]).map((s) => s.id);

        const [{ data: examSubs }, { data: wsSubs }, { data: prjSubs }, { data: attRecords }] =
          await Promise.all([
            examIds.length
              ? supabase
                  .from("submissions")
                  .select("exam_id, ai_grade, final_override_grade, status, created_at")
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

        // Helper: escala una calificación raw (0..max) a la escala del curso.
        const toScale = (raw: number, max: number) => {
          const pct = max > 0 ? raw / max : 0;
          return course.grade_scale_min + pct * (course.grade_scale_max - course.grade_scale_min);
        };

        // Construye filas para cada item del curso (ya escaladas).
        const rows: ItemRow[] = [];

        // Exámenes (solo originales, no makeups)
        const originalExams = (exams ?? []).filter((e: any) => !e.parent_exam_id);
        for (const e of originalExams as any[]) {
          const mode = (e.retry_mode as RetryMode) ?? "last";
          let attempts = (examSubs ?? []).filter((s: any) => s.exam_id === e.id);
          let usedFromMakeup = false;
          if (!attempts.length) {
            const makeupIds = (exams ?? [])
              .filter((x: any) => x.parent_exam_id === e.id)
              .map((x: any) => x.id);
            attempts = (examSubs ?? []).filter((s: any) => makeupIds.includes(s.exam_id));
            usedFromMakeup = attempts.length > 0;
          }
          const raw = computeAttemptGrade(attempts as any, mode);
          // Para "review" link: el intento más reciente finalizado
          const sortedFinished = [...attempts]
            .filter((s: any) => s.status === "completado" || s.status === "sospechoso")
            .sort(
              (a: any, b: any) =>
                new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
            );
          const latest = sortedFinished[0];
          rows.push({
            id: e.id,
            title: e.title,
            kind: "exam",
            cut_id: e.cut_id ?? null,
            rawGrade: raw,
            rawMax: course.grade_scale_max,
            grade: raw != null ? toScale(raw, course.grade_scale_max) : null,
            status: latest?.status ?? (attempts.length ? "en_progreso" : "sin_entrega"),
            weight: Number(e.weight ?? 1),
            reviewExamId: latest ? (usedFromMakeup ? latest.exam_id : e.id) : null,
          });
        }

        // Talleres — para is_external la nota ya está en la escala del
        // curso (la ingresa el docente en ExternalGradesEditor con cap =
        // course.grade_scale_max). Para AI, w.max_score es la escala 0..100
        // del prompt y hay que reescalar.
        for (const w of (workshops ?? []) as any[]) {
          const sub = (wsSubs ?? []).find((s: any) => s.workshop_id === w.id);
          const raw = sub ? (sub.final_grade ?? sub.ai_grade) : null;
          const wMax = w.is_external ? course.grade_scale_max : (w.max_score ?? 100);
          rows.push({
            id: w.id,
            title: w.title,
            kind: "workshop",
            cut_id: w.cut_id ?? null,
            rawGrade: raw,
            rawMax: wMax,
            grade: raw != null ? toScale(raw, wMax) : null,
            status: sub?.status ?? "pendiente",
            weight: Number(w.weight ?? 1),
            reviewWorkshopId: sub ? w.id : null,
          });
        }

        // Proyectos — misma regla: external = ya en escala del curso.
        for (const p of flatProjects as any[]) {
          const sub = (prjSubs ?? []).find((s: any) => s.project_id === p.id);
          const raw = sub ? (sub.final_grade ?? sub.ai_grade) : null;
          const pMax = p.is_external ? course.grade_scale_max : (p.max_score ?? 100);
          rows.push({
            id: p.id,
            title: p.title,
            kind: "project",
            cut_id: p.cut_id ?? null,
            rawGrade: raw,
            rawMax: pMax,
            grade: raw != null ? toScale(raw, pMax) : null,
            status: sub?.status ?? "pendiente",
            weight: Number(p.weight ?? 1),
          });
        }

        // Asistencia: agrupa por corte usando el FK explícito
        // attendance_sessions.cut_id (migración 20260509020000). Antes
        // se inferiía por rango de fechas. Cuenta sesiones del corte y
        // cuántas registró el estudiante como "presente".
        const allSessions = (sessions ?? []) as {
          id: string;
          session_date: string;
          cut_id?: string | null;
        }[];
        const allRecords = (attRecords ?? []) as { session_id: string; status: string }[];
        const recordsBySession = new Map(allRecords.map((r) => [r.session_id, r.status]));

        // Construye el desglose por corte usando el modelo nuevo:
        // cada item aporta su weight (% del total) y la asistencia del
        // corte aporta cut.attendance_weight (también % del total).
        const breakdown: CutBreakdown[] = cuts.map((cut) => {
          const cutItems = rows.filter((r) => r.cut_id === cut.id);

          // Asistencia del corte: filtra sesiones por fecha, calcula %
          // presente y escala. Se modela como un ItemRow más con peso =
          // cut.attendance_weight para entrar al weighted avg uniforme.
          //
          // Renderizamos SIEMPRE la fila de asistencia cuando el bucket
          // attendance_weight > 0, aunque no haya sesiones registradas o
          // el corte no tenga fechas. Así el estudiante ve "0/0 sesiones"
          // o "sin sesiones registradas" en lugar de que la asistencia
          // simplemente desaparezca y dé la sensación de que su nota
          // final ignora ese componente.
          let attItem: ItemRow | null = null;
          const attWeight = Number(cut.attendance_weight ?? 0);
          if (attWeight > 0) {
            // Filtro por cut_id explícito (migración 20260509020000):
            // el docente asigna el corte al crear la sesión.
            const sessionsInCut = allSessions.filter((s) => s.cut_id === cut.id);
            if (sessionsInCut.length > 0) {
              const present = sessionsInCut.filter(
                (s) => recordsBySession.get(s.id) === "presente",
              ).length;
              const pct = present / sessionsInCut.length;
              const attendanceAvg =
                course.grade_scale_min + pct * (course.grade_scale_max - course.grade_scale_min);
              attItem = {
                id: `attendance-${cut.id}`,
                title: `Asistencia (${present}/${sessionsInCut.length} sesiones)`,
                kind: "attendance",
                cut_id: cut.id,
                rawGrade: present,
                rawMax: sessionsInCut.length,
                grade: attendanceAvg,
                status: "calculado",
                weight: attWeight,
              };
            } else {
              // Bucket de asistencia con peso > 0 pero sin sesiones
              // asignadas a este corte: grade=null. computeWeightedGrade
              // ignora null sin reescalar pesos vecinos.
              attItem = {
                id: `attendance-${cut.id}`,
                title: "Asistencia (sin sesiones asignadas a este corte)",
                kind: "attendance",
                cut_id: cut.id,
                rawGrade: null,
                rawMax: 0,
                grade: null,
                status: "pendiente",
                weight: attWeight,
              };
            }
          }

          const allCutItems = attItem ? [...cutItems, attItem] : cutItems;
          const grade = computeWeightedGrade(
            allCutItems.map((i) => ({ score: i.grade, weight: i.weight ?? 1 })),
          );

          return {
            cut,
            items: allCutItems,
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

  // La nota final ahora es el weighted avg de TODOS los items del curso
  // (de todos los cortes) + asistencias por corte. Cada item ya tiene su
  // weight expresado en % del total, así que pasamos todos directos al
  // helper. Esto evita doble re-escala / pérdida de precisión que tendría
  // promediar primero por corte y luego entre cortes.
  const finalGrade = useMemo(() => {
    const items: { score: number | null; weight: number }[] = [];
    for (const cb of cutsBreakdown) {
      for (const it of cb.items) {
        items.push({ score: it.grade, weight: it.weight ?? 1 });
      }
    }
    return computeWeightedGrade(items);
  }, [cutsBreakdown]);

  const passes = course && finalGrade != null ? finalGrade >= course.passing_grade : null;
  const fmt = (n: number | null) => (n == null ? "—" : n.toFixed(2));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Calificaciones</h1>
          <p className="text-sm text-muted-foreground">
            Consolidado por cortes y calificación final del curso
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
                    {cb.items.filter((i) => i.grade != null).length}/{cb.items.length} item(s)
                    calificado(s)
                  </div>
                </CardContent>
              </Card>
            ))}
            <Card
              className={
                passes === true
                  ? "border-success/40 bg-success/5"
                  : passes === false
                    ? "border-destructive/40 bg-destructive/5"
                    : ""
              }
            >
              <CardContent className="p-4 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground uppercase tracking-wide">
                    Calificación final
                  </span>
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="text-2xl font-semibold tabular-nums">{fmt(finalGrade)}</div>
                {passes === true && (
                  <div className="flex items-center gap-1 text-xs text-success">
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
              Aprobar ≥ <span className="font-medium tabular-nums">{course.passing_grade}</span>
            </div>
            <div className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">Puntaje</span> = lo que sacaste sobre el
              total de la actividad · <span className="font-medium text-foreground">Nota</span> =
              ese puntaje convertido a la escala del curso, que es la que cuenta para tu
              calificación final.
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
                      Peso: {cb.cut.weight}% del total · Calificación:{" "}
                      <span className="font-medium tabular-nums">{fmt(cb.grade)}</span>
                    </p>
                  </div>
                  {cb.cut.start_date && cb.cut.end_date && (
                    <Badge variant="outline" className="text-[10px]">
                      {cb.cut.start_date} → {cb.cut.end_date}
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="p-3 space-y-3">
                  {cb.items.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      Sin actividades en este corte.
                    </p>
                  ) : (
                    (["workshop", "exam", "project", "attendance"] as const).map((kind) => {
                      const items = cb.items.filter((i) => i.kind === kind);
                      if (items.length === 0) return null;
                      // Subtotal = nota ponderada SOLO de los items de este
                      // tipo dentro del corte. Útil para que el alumno
                      // entienda "cuánto va aportando talleres" antes de
                      // ver la nota global del corte.
                      const subtotal = computeWeightedGrade(
                        items.map((i) => ({ score: i.grade, weight: i.weight ?? 1 })),
                      );
                      const bucketWeight = items.reduce((s, i) => s + (i.weight ?? 0), 0);
                      const graded = items.filter((i) => i.grade != null).length;
                      return (
                        <KindGroup
                          key={kind}
                          kind={kind}
                          items={items}
                          subtotal={subtotal}
                          bucketWeight={bucketWeight}
                          gradedCount={graded}
                          totalCount={items.length}
                          fmt={fmt}
                          gradeScaleMin={course.grade_scale_min}
                          gradeScaleMax={course.grade_scale_max}
                        />
                      );
                    })
                  )}
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
                  Estas actividades aún no están asociadas a un corte y no afectan tu calificación
                  final.
                </p>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Actividad</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead className="text-right">Puntaje</TableHead>
                      <TableHead className="text-right">
                        Nota ({course.grade_scale_min}–{course.grade_scale_max})
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
            La calificación del curso se calcula sumando el promedio ponderado de cada corte. Cada
            corte promedia talleres, exámenes, proyectos y asistencia con los pesos definidos por el
            docente. Componentes sin datos no penalizan: sus pesos se reparten entre los demás.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Sub-sección por tipo dentro del detalle de un corte. Renderiza el
 * encabezado del bucket (Talleres / Exámenes / etc) con el subtotal
 * y peso, seguido de una mini-tabla con cada item.
 *
 * Diseño consciente: subtotal y peso son por tipo dentro del corte —
 * NO la nota acumulada del corte (que vive en el header de la card).
 * Sirve para que el alumno entienda "cuánto va aportando cada bucket".
 */
function KindGroup({
  kind,
  items,
  subtotal,
  bucketWeight,
  gradedCount,
  totalCount,
  fmt,
  gradeScaleMin,
  gradeScaleMax,
}: {
  kind: ItemRow["kind"];
  items: ItemRow[];
  subtotal: number | null;
  bucketWeight: number;
  gradedCount: number;
  totalCount: number;
  fmt: (n: number | null) => string;
  gradeScaleMin: number;
  gradeScaleMax: number;
}) {
  const label =
    kind === "workshop"
      ? "Talleres"
      : kind === "exam"
        ? "Exámenes"
        : kind === "project"
          ? "Proyectos"
          : "Asistencia";
  return (
    <div className="rounded-md border overflow-hidden">
      <div className="flex items-center justify-between gap-2 bg-muted/40 px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <KindBadge kind={kind} />
          <span className="text-sm font-medium">{label}</span>
          <span className="text-[11px] text-muted-foreground">
            {gradedCount}/{totalCount} con nota
          </span>
        </div>
        <div className="text-xs text-muted-foreground inline-flex items-center gap-2 tabular-nums">
          <span>Peso bucket: {bucketWeight.toFixed(1)}%</span>
          <span>·</span>
          <span>
            Subtotal:{" "}
            <span className="font-semibold text-foreground tabular-nums">{fmt(subtotal)}</span>
          </span>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Actividad</TableHead>
            <TableHead className="text-right w-32">Peso</TableHead>
            <TableHead className="text-right">Puntaje</TableHead>
            <TableHead className="text-right">
              Nota ({gradeScaleMin}–{gradeScaleMax})
            </TableHead>
            <TableHead className="hidden md:table-cell">Estado</TableHead>
            <TableHead className="text-right w-[1%]">Detalle</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((it) => (
            <TableRow key={`${it.kind}-${it.id}`}>
              <TableCell className="font-medium">{it.title}</TableCell>
              <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                {it.weight != null ? `${Number(it.weight).toFixed(1)}%` : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {it.rawGrade != null ? `${it.rawGrade} / ${it.rawMax}` : "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums font-medium">{fmt(it.grade)}</TableCell>
              <TableCell className="hidden md:table-cell">
                <StatusBadge status={it.status} />
              </TableCell>
              <TableCell className="text-right">
                {it.kind === "exam" && it.reviewExamId ? (
                  <RowAction asChild label="Ver detalle" icon={MessageSquareText}>
                    <Link to="/app/student/review/$examId" params={{ examId: it.reviewExamId }} />
                  </RowAction>
                ) : it.kind === "workshop" && it.reviewWorkshopId ? (
                  <RowAction asChild label="Ver detalle" icon={MessageSquareText}>
                    <Link
                      to="/app/student/workshop/$workshopId"
                      params={{ workshopId: it.reviewWorkshopId }}
                    />
                  </RowAction>
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
