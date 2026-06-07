import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { isStaffRole } from "@/shared/lib/roles";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { PageLoader } from "@/components/ui/loaders";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { friendlyError } from "@/shared/lib/db-errors";
import { toast } from "sonner";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import {
  BarChart3,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Bot,
  Users,
  CalendarCheck,
  TrendingUp,
} from "lucide-react";
import {
  loadCourseDataset,
  computeApproval,
  computeApprovalByKind,
  computeAttendanceBySession,
  computeCutTrend,
  computeFraudStats,
  computeGradeDistribution,
  type CourseDataset,
  type SubmissionLike,
} from "@/shared/lib/statistics";
import { formatDateShort } from "@/shared/lib/format";

export const Route = createFileRoute("/app/teacher/statistics")({
  component: TeacherStatistics,
});

type CourseOpt = { id: string; name: string; period: string | null };

function TeacherStatistics() {
  const { roles, user } = useAuth();
  // SA accede a pantallas Docente para soporte / diagnóstico — sin SA
  // en el set, recibía "Necesitas rol Docente" silencioso al entrar.
  const isTeacher = isStaffRole(roles);
  const [courses, setCourses] = useState<CourseOpt[]>([]);
  const [courseId, setCourseId] = useState("");
  const [dataset, setDataset] = useState<CourseDataset | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  // Cargar cursos del docente. Admin ve todos.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoadError(null);
      let q = supabase.from("courses").select("id, name, period").order("name");
      if (!roles.includes("Admin")) {
        const { data: ct } = await supabase
          .from("course_teachers")
          .select("course_id")
          .eq("user_id", user.id);
        const ids = (ct ?? []).map((r: { course_id: string }) => r.course_id);
        if (cancelled) return;
        if (ids.length === 0) {
          setCourses([]);
          return;
        }
        q = q.in("id", ids);
      }
      const { data, error } = await q;
      if (cancelled) return;
      if (error) {
        setLoadError(friendlyError(error, "No pudimos cargar tus cursos."));
        return;
      }
      const list = (data ?? []) as CourseOpt[];
      setCourses(list);
      if (list[0] && !courseId) setCourseId(list[0].id);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, roles.join(","), retryNonce]);

  // Cargar dataset del curso seleccionado.
  // Guard `cancelled` evita race condition cuando el docente cambia
  // de curso rápido (Select): la query del curso A puede resolver
  // DESPUÉS de B y sobrescribir el dataset. Además, .catch() asegura
  // que un fallo (RLS, red) no deje el spinner colgado.
  useEffect(() => {
    if (!courseId) {
      setDataset(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadCourseDataset(courseId)
      .then((data) => {
        if (!cancelled) setDataset(data);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("loadCourseDataset failed:", e);
        toast.error(friendlyError(e, "No pudimos cargar los datos del curso"));
        setDataset(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  if (!isTeacher) {
    return <p className="text-muted-foreground">Necesitas rol Docente.</p>;
  }

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<BarChart3 className="h-6 w-6" />} title="Estadísticas" />
        <ErrorState
          message="No pudimos cargar tus cursos"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<BarChart3 className="h-6 w-6" />}
        title="Estadísticas"
        subtitle="Aprobación, fraude, asistencia y tendencia por corte del curso seleccionado."
        actions={
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger className="w-full sm:w-72">
              <SelectValue placeholder="Curso" />
            </SelectTrigger>
            <SelectContent>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                  {c.period ? ` (${c.period})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {courses.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          text="Sin cursos asignados"
          hint="No tienes cursos asociados como docente. Pide a un administrador que te asigne uno."
        />
      ) : loading || !dataset ? (
        <PageLoader />
      ) : (
        <CourseDashboard ds={dataset} />
      )}
    </div>
  );
}

// ─── Dashboard de un curso ───────────────────────────────────────────

export function CourseDashboard({ ds }: { ds: CourseDataset }) {
  const enrolledIds = useMemo(
    () => new Set(ds.enrollments.map((e) => e.user_id)),
    [ds.enrollments],
  );
  const totalEnrolled = enrolledIds.size;

  // KPIs globales
  const allSubs = useMemo(() => [...ds.examSubs, ...ds.workshopSubs, ...ds.projectSubs], [ds]);
  const overallApproval = useMemo(
    () => computeApproval(allSubs, enrolledIds, ds.course),
    [allSubs, enrolledIds, ds.course],
  );
  const fraud = useMemo(
    () => computeFraudStats(allSubs, ds.similarityPairs),
    [allSubs, ds.similarityPairs],
  );
  const attendance = useMemo(
    () => computeAttendanceBySession(ds.attendanceSessions, ds.attendanceRecords, totalEnrolled),
    [ds.attendanceSessions, ds.attendanceRecords, totalEnrolled],
  );
  const avgAttendance =
    attendance.length === 0
      ? 0
      : Math.round(attendance.reduce((a, s) => a + s.presentPct, 0) / attendance.length);
  const approvalRate =
    overallApproval.total === 0
      ? 0
      : Math.round((overallApproval.approved / overallApproval.total) * 100);

  return (
    <div className="space-y-5">
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard icon={Users} label="Estudiantes" value={totalEnrolled} accent="text-sky-500" />
        <KpiCard
          icon={CheckCircle2}
          label="% Aprobación"
          value={`${approvalRate}%`}
          subline={`${overallApproval.approved}/${overallApproval.total}`}
          accent="text-emerald-500"
        />
        <KpiCard
          icon={CalendarCheck}
          label="Asistencia promedio"
          value={`${avgAttendance}%`}
          subline={`${attendance.length} sesión${attendance.length === 1 ? "" : "es"}`}
          accent="text-cyan-500"
        />
        <KpiCard
          icon={Bot}
          label="Alertas fraude IA"
          value={fraud.aiSuspect}
          subline={`${fraud.plagiarismPairs} par${fraud.plagiarismPairs === 1 ? "" : "es"} de copia`}
          accent="text-amber-500"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ApprovalDonutCard approval={overallApproval} />
        <GradeDistributionCard ds={ds} subs={allSubs} />
        <ApprovalByKindCard ds={ds} />
        <CutTrendCard ds={ds} />
        <AttendanceCard sessions={attendance} />
        <FraudCard ds={ds} fraud={fraud} />
      </div>
    </div>
  );
}

function KpiCard({
  icon: Icon,
  label,
  value,
  subline,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  subline?: string;
  accent: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <div className={`rounded-md bg-muted/40 p-2 ${accent}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground truncate">{label}</div>
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
          {subline && (
            <div className="text-[11px] text-muted-foreground truncate tabular-nums">{subline}</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Charts ──────────────────────────────────────────────────────────

function ApprovalDonutCard({
  approval,
}: {
  approval: { approved: number; failed: number; pending: number; total: number };
}) {
  const data = [
    { name: "Aprobados", value: approval.approved, fill: "hsl(142 71% 45%)" },
    { name: "Reprobados", value: approval.failed, fill: "hsl(0 84% 60%)" },
    { name: "Pendientes", value: approval.pending, fill: "hsl(45 93% 58%)" },
  ];
  const config: ChartConfig = {
    Aprobados: { label: "Aprobados", color: "hsl(142 71% 45%)" },
    Reprobados: { label: "Reprobados", color: "hsl(0 84% 60%)" },
    Pendientes: { label: "Pendientes", color: "hsl(45 93% 58%)" },
  };
  const empty = approval.total === 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          Aprobación global del curso
        </CardTitle>
        <CardDescription>
          Conteo (matriculado × actividad). Pendientes = sin entrega o sin nota.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <EmptyChart text="Aún no hay actividades calificadas." />
        ) : (
          <ChartContainer config={config} className="h-[260px] w-full">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Pie
                data={data}
                dataKey="value"
                nameKey="name"
                innerRadius={50}
                outerRadius={90}
                strokeWidth={2}
              >
                {data.map((entry, idx) => (
                  <Cell key={idx} fill={entry.fill} />
                ))}
              </Pie>
              <ChartLegend content={<ChartLegendContent nameKey="name" />} />
            </PieChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function GradeDistributionCard({ ds, subs }: { ds: CourseDataset; subs: SubmissionLike[] }) {
  const data = useMemo(() => computeGradeDistribution(subs, ds.course), [subs, ds.course]);
  const total = data.reduce((a, b) => a + b.count, 0);
  const min = ds.course.grade_scale_min ?? 0;
  const max = ds.course.grade_scale_max ?? 5;
  // Buckets que están al o por encima del passing_grade se pintan
  // verdes; los reprobatorios rojos. Más claro que una línea vertical
  // que Recharts no renderiza bien con eje X categórico.
  const passingIdx = Math.min(
    4,
    Math.max(0, Math.floor(((ds.course.passing_grade - min) / (max - min || 1)) * 5)),
  );
  const config: ChartConfig = {
    count: { label: "Entregas", color: "hsl(217 91% 60%)" },
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-blue-500" />
          Distribución de notas
        </CardTitle>
        <CardDescription>
          Reescalada a {min}–{max}. Verde = bucket aprobatorio (≥ {ds.course.passing_grade}), rojo =
          reprobatorio.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <EmptyChart text="Aún no hay entregas calificadas." />
        ) : (
          <ChartContainer config={config} className="h-[260px] w-full">
            <BarChart data={data}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="range" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" radius={4}>
                {data.map((_, i) => (
                  <Cell key={i} fill={i >= passingIdx ? "hsl(142 71% 45%)" : "hsl(0 84% 60%)"} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function ApprovalByKindCard({ ds }: { ds: CourseDataset }) {
  const data = useMemo(() => computeApprovalByKind(ds), [ds]);
  const empty = data.every((d) => d.approved + d.failed + d.pending === 0);
  const config: ChartConfig = {
    approved: { label: "Aprobados", color: "hsl(142 71% 45%)" },
    failed: { label: "Reprobados", color: "hsl(0 84% 60%)" },
    pending: { label: "Pendientes", color: "hsl(45 93% 58%)" },
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-orange-500" />
          Aprobación por tipo de actividad
        </CardTitle>
        <CardDescription>Conteo apilado de matriculado × actividad por tipo.</CardDescription>
      </CardHeader>
      <CardContent>
        {empty ? (
          <EmptyChart text="Aún no hay actividades en el curso." />
        ) : (
          <ChartContainer config={config} className="h-[260px] w-full">
            <BarChart data={data}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="kind" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                dataKey="approved"
                stackId="a"
                fill="var(--color-approved)"
                radius={[0, 0, 0, 0]}
              />
              <Bar dataKey="failed" stackId="a" fill="var(--color-failed)" />
              <Bar
                dataKey="pending"
                stackId="a"
                fill="var(--color-pending)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function CutTrendCard({ ds }: { ds: CourseDataset }) {
  const data = useMemo(
    () => computeCutTrend(ds.examSubs, ds.workshopSubs, ds.projectSubs, ds.cuts, ds.course),
    [ds],
  );
  const empty = data.every((d) => d.avg == null);
  const config: ChartConfig = {
    avg: { label: "Nota promedio", color: "hsl(262 83% 58%)" },
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-violet-500" />
          Tendencia por corte
        </CardTitle>
        <CardDescription>
          Nota promedio (escala {ds.course.grade_scale_min}–{ds.course.grade_scale_max}) combinando
          exámenes, talleres y proyectos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {ds.cuts.length === 0 ? (
          <EmptyChart text="Este curso aún no tiene cortes definidos." />
        ) : empty ? (
          <EmptyChart text="Aún no hay actividades calificadas en ningún corte." />
        ) : (
          <ChartContainer config={config} className="h-[260px] w-full">
            <LineChart data={data}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="cut" tickLine={false} axisLine={false} />
              <YAxis
                domain={[ds.course.grade_scale_min, ds.course.grade_scale_max]}
                tickLine={false}
                axisLine={false}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ReferenceLine
                y={ds.course.passing_grade}
                stroke="hsl(0 84% 60%)"
                strokeDasharray="4 4"
                label={{ value: `≥${ds.course.passing_grade}`, position: "right", fontSize: 10 }}
              />
              <Line
                type="monotone"
                dataKey="avg"
                stroke="var(--color-avg)"
                strokeWidth={2.5}
                dot={{ r: 4 }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function AttendanceCard({ sessions }: { sessions: ReturnType<typeof computeAttendanceBySession> }) {
  const data = sessions.map((s) => ({
    label: formatDateShort(`${s.date}T12:00:00`),
    presentPct: s.presentPct,
    presentCount: s.presentCount,
    total: s.total,
  }));
  const config: ChartConfig = {
    presentPct: { label: "% Presentes", color: "hsl(189 94% 43%)" },
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarCheck className="h-4 w-4 text-cyan-500" />
          Asistencia por sesión
        </CardTitle>
        <CardDescription>
          % de matriculados que se marcaron presentes en cada sesión, en orden cronológico.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <EmptyChart text="Aún no hay sesiones de asistencia registradas." />
        ) : (
          <ChartContainer config={config} className="h-[260px] w-full">
            <BarChart data={data}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={10} />
              <YAxis tickLine={false} axisLine={false} domain={[0, 100]} unit="%" />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value, _name, item) => {
                      const p = item.payload as { presentCount: number; total: number };
                      return (
                        <div className="flex flex-col">
                          <span className="font-medium">{value}%</span>
                          <span className="text-[10px] text-muted-foreground">
                            {p.presentCount}/{p.total}
                          </span>
                        </div>
                      );
                    }}
                  />
                }
              />
              <Bar dataKey="presentPct" fill="var(--color-presentPct)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function FraudCard({
  ds,
  fraud,
}: {
  ds: CourseDataset;
  fraud: {
    aiSuspect: number;
    totalGraded: number;
    plagiarismPairs: number;
    plagiarismStudents: number;
  };
}) {
  // Distribución de fraude por tipo de actividad
  const data = useMemo(() => {
    const rows = [
      { kind: "Exámenes", subs: ds.examSubs },
      { kind: "Talleres", subs: ds.workshopSubs },
      { kind: "Proyectos", subs: ds.projectSubs },
    ];
    return rows.map(({ kind, subs }) => {
      const aiSuspect = subs.filter((s) => (s.ai_detected_score ?? 0) >= 0.6).length;
      const plagiarismPairs = ds.similarityPairs.filter(
        (p) => p.score >= 0.6 && subs.some((s) => s.ref_id === p.ref_id),
      ).length;
      return { kind, aiSuspect, plagiarismPairs };
    });
  }, [ds]);
  const empty = fraud.aiSuspect === 0 && fraud.plagiarismPairs === 0 && fraud.totalGraded === 0;
  const config: ChartConfig = {
    aiSuspect: { label: "Sospecha IA", color: "hsl(45 93% 58%)" },
    plagiarismPairs: { label: "Pares plagio", color: "hsl(0 84% 60%)" },
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Integridad académica
        </CardTitle>
        <CardDescription>
          Entregas con probabilidad de IA ≥ 60% y pares de copia detectados (similitud ≥ 60%).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className="text-xs">
            <Bot className="h-3 w-3 mr-1 text-amber-500" />
            {fraud.aiSuspect}/{fraud.totalGraded} con sospecha IA
          </Badge>
          <Badge variant="outline" className="text-xs">
            <XCircle className="h-3 w-3 mr-1 text-rose-500" />
            {fraud.plagiarismPairs} pares · {fraud.plagiarismStudents} estudiantes
          </Badge>
        </div>
        {empty ? (
          <EmptyChart text="Sin alertas de integridad. Ejecuta 'Detectar copias' por actividad para poblar pares." />
        ) : (
          <ChartContainer config={config} className="h-[200px] w-full">
            <BarChart data={data}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="kind" tickLine={false} axisLine={false} />
              <YAxis tickLine={false} axisLine={false} allowDecimals={false} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar dataKey="aiSuspect" fill="var(--color-aiSuspect)" radius={4} />
              <Bar dataKey="plagiarismPairs" fill="var(--color-plagiarismPairs)" radius={4} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground text-center px-4">
      {text}
    </div>
  );
}
