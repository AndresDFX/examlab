import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageLoader, SectionLoader } from "@/components/ui/loaders";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  BarChart3,
  CheckCircle2,
  Bot,
  Users,
  CalendarCheck,
  AlertTriangle,
  ArrowLeft,
} from "lucide-react";
import {
  loadCourseDataset,
  computeApproval,
  computeAttendanceBySession,
  computeFraudStats,
  type CourseDataset,
} from "@/shared/lib/statistics";
import { CourseDashboard } from "./app.teacher.statistics";

export const Route = createFileRoute("/app/admin/statistics")({
  component: AdminStatistics,
});

type CourseSummary = {
  course: { id: string; name: string; period: string | null };
  totalEnrolled: number;
  approvalRate: number;
  attendanceAvg: number;
  aiSuspect: number;
  plagiarismPairs: number;
  totalActivities: number;
};

function AdminStatistics() {
  const { roles } = useAuth();
  const isAdmin = roles.includes("Admin");
  const [summaries, setSummaries] = useState<CourseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [drillCourseId, setDrillCourseId] = useState<string | null>(null);
  const [drillDataset, setDrillDataset] = useState<CourseDataset | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);

  // Cargar resumen agregado por curso (Admin ve todos)
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: courses } = await supabase
        .from("courses")
        .select("id, name, period")
        .order("name");
      if (cancelled) return;
      const list = (courses ?? []) as Array<{ id: string; name: string; period: string | null }>;
      // Cargamos en paralelo todos los datasets — ojo: si hay 50+ cursos
      // esto puede ser pesado. Para V1 nos sirve; si crece, mover a una
      // RPC server-side `admin_course_stats_summary()`.
      const results = await Promise.all(
        list.map(async (course): Promise<CourseSummary> => {
          try {
            const ds = await loadCourseDataset(course.id);
            const enrolledIds = new Set(ds.enrollments.map((e) => e.user_id));
            const totalEnrolled = enrolledIds.size;
            const allSubs = [...ds.examSubs, ...ds.workshopSubs, ...ds.projectSubs];
            const apr = computeApproval(allSubs, enrolledIds, ds.course);
            const att = computeAttendanceBySession(
              ds.attendanceSessions,
              ds.attendanceRecords,
              totalEnrolled,
            );
            const fraud = computeFraudStats(allSubs, ds.similarityPairs);
            const totalActivities =
              new Set(ds.examSubs.map((s) => s.ref_id)).size +
              new Set(ds.workshopSubs.map((s) => s.ref_id)).size +
              new Set(ds.projectSubs.map((s) => s.ref_id)).size;
            return {
              course,
              totalEnrolled,
              approvalRate: apr.total === 0 ? 0 : Math.round((apr.approved / apr.total) * 100),
              attendanceAvg:
                att.length === 0
                  ? 0
                  : Math.round(att.reduce((a, s) => a + s.presentPct, 0) / att.length),
              aiSuspect: fraud.aiSuspect,
              plagiarismPairs: fraud.plagiarismPairs,
              totalActivities,
            };
          } catch {
            return {
              course,
              totalEnrolled: 0,
              approvalRate: 0,
              attendanceAvg: 0,
              aiSuspect: 0,
              plagiarismPairs: 0,
              totalActivities: 0,
            };
          }
        }),
      );
      if (!cancelled) {
        setSummaries(results);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  // Drill-down: carga el dataset completo del curso seleccionado
  useEffect(() => {
    if (!drillCourseId) {
      setDrillDataset(null);
      return;
    }
    setDrillLoading(true);
    loadCourseDataset(drillCourseId)
      .then(setDrillDataset)
      .finally(() => setDrillLoading(false));
  }, [drillCourseId]);

  const totals = useMemo(() => {
    return summaries.reduce(
      (acc, s) => ({
        students: acc.students + s.totalEnrolled,
        courses: acc.courses + 1,
        aiSuspect: acc.aiSuspect + s.aiSuspect,
        plagiarismPairs: acc.plagiarismPairs + s.plagiarismPairs,
        weightedApproval: acc.weightedApproval + s.approvalRate * s.totalEnrolled,
        weightedAttendance: acc.weightedAttendance + s.attendanceAvg * s.totalEnrolled,
        enrollmentSum: acc.enrollmentSum + s.totalEnrolled,
      }),
      {
        students: 0,
        courses: 0,
        aiSuspect: 0,
        plagiarismPairs: 0,
        weightedApproval: 0,
        weightedAttendance: 0,
        enrollmentSum: 0,
      },
    );
  }, [summaries]);

  const globalApproval =
    totals.enrollmentSum === 0 ? 0 : Math.round(totals.weightedApproval / totals.enrollmentSum);
  const globalAttendance =
    totals.enrollmentSum === 0 ? 0 : Math.round(totals.weightedAttendance / totals.enrollmentSum);

  if (!isAdmin) {
    return <p className="text-muted-foreground">Necesitas rol Admin.</p>;
  }

  // Vista drill-down: misma UI que docente, embebida con un botón "Volver"
  if (drillCourseId) {
    const summary = summaries.find((s) => s.course.id === drillCourseId);
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDrillCourseId(null)}
              className="-ml-2"
            >
              <ArrowLeft className="h-4 w-4 mr-1" />
              Volver al global
            </Button>
            <h1 className="text-2xl font-semibold tracking-tight mt-1">
              {summary?.course.name ?? "Curso"}
              {summary?.course.period && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({summary.course.period})
                </span>
              )}
            </h1>
          </div>
        </div>
        {drillLoading || !drillDataset ? <PageLoader /> : <CourseDashboard ds={drillDataset} />}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-primary" />
          Estadísticas globales
        </h1>
        <p className="text-sm text-muted-foreground">
          Vista agregada de todos los cursos. Click en una fila para ver el detalle.
        </p>
      </div>

      {loading ? (
        <SectionLoader text="Calculando estadísticas de todos los cursos…" />
      ) : summaries.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          text="Aún no hay cursos creados"
          hint="Crea cursos desde la sección de gestión para que aparezcan estadísticas aquí."
        />
      ) : (
        <>
          {/* KPIs globales */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <KpiCard
              icon={BookOpenLikeIcon}
              label="Cursos"
              value={totals.courses}
              accent="text-fuchsia-500"
            />
            <KpiCard
              icon={Users}
              label="Estudiantes"
              value={totals.students}
              accent="text-sky-500"
            />
            <KpiCard
              icon={CheckCircle2}
              label="% Aprobación global"
              value={`${globalApproval}%`}
              subline="Ponderado por matrícula"
              accent="text-emerald-500"
            />
            <KpiCard
              icon={CalendarCheck}
              label="Asistencia promedio"
              value={`${globalAttendance}%`}
              accent="text-cyan-500"
            />
            <KpiCard
              icon={AlertTriangle}
              label="Alertas integridad"
              value={totals.aiSuspect + totals.plagiarismPairs}
              subline={`${totals.aiSuspect} IA · ${totals.plagiarismPairs} copia`}
              accent="text-amber-500"
            />
          </div>

          {/* Comparativa entre cursos */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-primary" />
                Comparativa entre cursos
              </CardTitle>
              <CardDescription>
                % de aprobación, asistencia promedio y alertas de integridad por curso.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CompareChart summaries={summaries} />
            </CardContent>
          </Card>

          {/* Tabla con drill-down */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Detalle por curso</CardTitle>
              <CardDescription>Click en un curso para ver su dashboard completo.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Curso</TableHead>
                    <TableHead className="hidden sm:table-cell">Periodo</TableHead>
                    <TableHead className="text-right">Estudiantes</TableHead>
                    <TableHead className="text-right">Actividades</TableHead>
                    <TableHead className="text-right">% Aprobación</TableHead>
                    <TableHead className="text-right hidden md:table-cell">Asistencia</TableHead>
                    <TableHead className="text-right hidden md:table-cell">Alertas IA</TableHead>
                    <TableHead className="text-right hidden lg:table-cell">Pares copia</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summaries.map((s) => (
                    <TableRow
                      key={s.course.id}
                      className="cursor-pointer hover:bg-muted/40"
                      onClick={() => setDrillCourseId(s.course.id)}
                    >
                      <TableCell className="font-medium">{s.course.name}</TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {s.course.period ? (
                          <Badge variant="outline" className="text-xs">
                            {s.course.period}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{s.totalEnrolled}</TableCell>
                      <TableCell className="text-right tabular-nums">{s.totalActivities}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <Badge
                          variant={
                            s.approvalRate >= 70
                              ? "default"
                              : s.approvalRate >= 50
                                ? "secondary"
                                : "destructive"
                          }
                          className="text-xs"
                        >
                          {s.approvalRate}%
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums hidden md:table-cell">
                        {s.attendanceAvg}%
                      </TableCell>
                      <TableCell className="text-right tabular-nums hidden md:table-cell">
                        {s.aiSuspect > 0 ? (
                          <Badge variant="outline" className="text-xs">
                            <Bot className="h-3 w-3 mr-1 text-amber-500" />
                            {s.aiSuspect}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">0</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums hidden lg:table-cell">
                        {s.plagiarismPairs}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
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

function BookOpenLikeIcon({ className }: { className?: string }) {
  // Reutiliza el icono fuchsia que el resto de la app asocia a Cursos
  // sin importarlo desde lucide en este archivo (reutiliza el barrel
  // ya importado). Esto es un alias visual, no un componente nuevo.
  return <BarChart3 className={className} />;
}

function CompareChart({ summaries }: { summaries: CourseSummary[] }) {
  const data = summaries.map((s) => ({
    course: s.course.name.length > 18 ? s.course.name.slice(0, 16) + "…" : s.course.name,
    fullName: s.course.name,
    approval: s.approvalRate,
    attendance: s.attendanceAvg,
    alerts: s.aiSuspect + s.plagiarismPairs,
  }));
  const config: ChartConfig = {
    approval: { label: "% Aprobación", color: "hsl(142 71% 45%)" },
    attendance: { label: "% Asistencia", color: "hsl(189 94% 43%)" },
    alerts: { label: "Alertas integridad", color: "hsl(45 93% 58%)" },
  };

  return (
    <ChartContainer config={config} className="h-[320px] w-full">
      <BarChart data={data}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="course"
          tickLine={false}
          axisLine={false}
          fontSize={11}
          interval={0}
          angle={-15}
          dy={8}
          height={50}
        />
        <YAxis tickLine={false} axisLine={false} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              labelFormatter={(_, payload) =>
                (payload?.[0]?.payload as { fullName?: string })?.fullName ?? ""
              }
            />
          }
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="approval" fill="var(--color-approval)" radius={4} />
        <Bar dataKey="attendance" fill="var(--color-attendance)" radius={4} />
        <Bar dataKey="alerts" fill="var(--color-alerts)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}
