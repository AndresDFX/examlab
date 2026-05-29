import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageLoader, SectionLoader } from "@/components/ui/loaders";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { friendlyError } from "@/shared/lib/db-errors";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  course: {
    id: string;
    name: string;
    period: string | null;
    program_id: string | null;
    period_id: string | null;
    subject_id: string | null;
  };
  totalEnrolled: number;
  approvalRate: number;
  attendanceAvg: number;
  aiSuspect: number;
  plagiarismPairs: number;
  totalActivities: number;
};

function AdminStatistics() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const isAdmin = roles.includes("Admin") || roles.includes("SuperAdmin");
  // Filtro cross-tenant solo cuando actúa como SuperAdmin (no por solo
  // tener el rol). Ver comentario en app.admin.users.
  const isSuperAdminCaller = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");
  const [summaries, setSummaries] = useState<CourseSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [drillCourseId, setDrillCourseId] = useState<string | null>(null);
  const [drillDataset, setDrillDataset] = useState<CourseDataset | null>(null);
  const [drillLoading, setDrillLoading] = useState(false);
  // Filtros institucionales — solo aplican a la vista de resumen
  // (no al drill-down de un curso individual).
  const [programFilter, setProgramFilter] = useState<string>("all");
  const [periodFilter, setPeriodFilter] = useState<string>("all");
  // Filtro por asignatura — independiente de programa para combinar
  // libremente. Si el admin elige programa Y asignatura, vale el AND
  // (la asignatura ya pertenece al programa por su schema).
  const [subjectFilter, setSubjectFilter] = useState<string>("all");
  // SuperAdmin: filtro funcional por institución. Aplica `.eq('tenant_id', X)`
  // a la query de courses; el resto del pipeline (summaries por curso)
  // hereda la restricción porque opera sobre los course IDs ya filtrados.
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  const [programs, setPrograms] = useState<Array<{ id: string; name: string }>>([]);
  const [periods, setPeriods] = useState<Array<{ id: string; code: string; status: string }>>([]);
  const [subjects, setSubjects] = useState<
    Array<{ id: string; name: string; code: string | null; program_id: string | null }>
  >([]);

  // Cargar lista de tenants para el Select cuando es SuperAdmin.
  useEffect(() => {
    if (!isSuperAdminCaller) return;
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("tenants")
        .select("id, slug, name")
        .order("name");
      if (cancelled) return;
      setTenants((data ?? []) as Array<{ id: string; slug: string; name: string }>);
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdminCaller]);

  // Cargar resumen agregado por curso (Admin ve todos)
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(null);
      // Cargar lista de cursos + dimensiones institucionales en paralelo.
      // Las dimensiones (programas/periodos) alimentan los Selects de filtro.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let coursesQuery: any = (supabase as any)
        .from("courses")
        .select("id, name, period, program_id, period_id, subject_id")
        .order("name");
      if (isSuperAdminCaller && tenantFilter !== "all") {
        coursesQuery = coursesQuery.eq("tenant_id", tenantFilter);
      }
      const [coursesRes, progsRes, periodsRes, subjectsRes] = await Promise.all([
        coursesQuery,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).from("academic_programs").select("id, name").order("name"),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("academic_periods")
          .select("id, code, status")
          .order("code", { ascending: false }),
        // Asignaturas para el filtro. RLS las acota al tenant del Admin;
        // SuperAdmin las ve cross-tenant.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from("academic_subjects")
          .select("id, name, code, program_id")
          .order("name"),
      ]);
      if (cancelled) return;
      if (coursesRes.error) {
        setLoadError(friendlyError(coursesRes.error, "No pudimos cargar las estadísticas."));
        setLoading(false);
        return;
      }
      setPrograms((progsRes.data ?? []) as Array<{ id: string; name: string }>);
      setPeriods((periodsRes.data ?? []) as Array<{ id: string; code: string; status: string }>);
      setSubjects(
        (subjectsRes.data ?? []) as Array<{
          id: string;
          name: string;
          code: string | null;
          program_id: string | null;
        }>,
      );
      const list = (coursesRes.data ?? []) as Array<{
        id: string;
        name: string;
        period: string | null;
        program_id: string | null;
        period_id: string | null;
        subject_id: string | null;
      }>;
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
  }, [isAdmin, retryNonce, isSuperAdminCaller, tenantFilter]);

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

  // Aplicar filtros institucionales sobre `summaries`. Filtramos
  // post-load (no antes) para que cambiar el filtro no dispare
  // recargas — los datasets ya están en memoria.
  const filteredSummaries = useMemo(() => {
    return summaries.filter((s) => {
      if (programFilter !== "all" && s.course.program_id !== programFilter) return false;
      if (periodFilter !== "all" && s.course.period_id !== periodFilter) return false;
      if (subjectFilter !== "all" && s.course.subject_id !== subjectFilter) return false;
      return true;
    });
  }, [summaries, programFilter, periodFilter, subjectFilter]);

  const totals = useMemo(() => {
    return filteredSummaries.reduce(
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
  }, [filteredSummaries]);

  const globalApproval =
    totals.enrollmentSum === 0 ? 0 : Math.round(totals.weightedApproval / totals.enrollmentSum);
  const globalAttendance =
    totals.enrollmentSum === 0 ? 0 : Math.round(totals.weightedAttendance / totals.enrollmentSum);

  if (!isAdmin) {
    return <p className="text-muted-foreground">Necesitas rol Admin.</p>;
  }

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader icon={<BarChart3 className="h-6 w-6" />} title="Estadísticas" />
        <ErrorState
          message="No pudimos cargar las estadísticas"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  // Vista drill-down: misma UI que docente, embebida con un botón "Volver"
  if (drillCourseId) {
    const summary = summaries.find((s) => s.course.id === drillCourseId);
    return (
      <div className="space-y-5">
        <PageHeader
          onBack={() => setDrillCourseId(null)}
          backLabel="Volver al global"
          title={
            <span>
              {summary?.course.name ?? "Curso"}
              {summary?.course.period && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({summary.course.period})
                </span>
              )}
            </span>
          }
        />
        {drillLoading || !drillDataset ? <PageLoader /> : <CourseDashboard ds={drillDataset} />}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<BarChart3 className="h-6 w-6" />}
        title="Estadísticas globales"
        subtitle="Vista agregada de todos los cursos. Click en una fila para ver el detalle."
      />

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
          {/* Filtros institucionales (programa + periodo + tenant para
              SuperAdmin). Filtran el resumen de cursos. Programa/periodo
              son client-side (datasets ya en memoria). Tenant dispara
              re-load porque la lista de courses sí cambia con tenant. */}
          <Card>
            <CardContent className="p-3 flex flex-col sm:flex-row gap-2">
              {/* Filtro institución — solo SuperAdmin con ≥1 tenant.
                  Aplica `.eq('tenant_id', X)` a la query principal de
                  courses → todo el pipeline de summaries hereda el filtro. */}
              {/* Gate `> 0` (no `> 1`): el filtro queda visible siempre que el
                  SuperAdmin tenga al menos una institución cargada, consistente
                  con Usuarios/Cursos/Certificados/Errores/Cola/Auditoría. */}
              {isSuperAdminCaller && tenants.length > 0 && (
                <div className="flex-1 space-y-1">
                  <label className="text-xs text-muted-foreground">
                    {t("tenant.filterTenantLabel")}
                  </label>
                  <Select value={tenantFilter} onValueChange={setTenantFilter}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t("tenant.filterAllTenants")}</SelectItem>
                      {tenants.map((tn) => (
                        <SelectItem key={tn.id} value={tn.id}>
                          {tn.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="flex-1 space-y-1">
                <label className="text-xs text-muted-foreground">Programa</label>
                <Select value={programFilter} onValueChange={setProgramFilter}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los programas</SelectItem>
                    {programs.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex-1 space-y-1">
                <label className="text-xs text-muted-foreground">Periodo</label>
                <Select value={periodFilter} onValueChange={setPeriodFilter}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los periodos</SelectItem>
                    {periods.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.code} {p.status === "cerrado" ? "(cerrado)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* Asignatura: acota a un curso o set de cursos atado a una
                  asignatura específica del plan. La lista se filtra por
                  programa cuando hay uno elegido (subjects sin programa
                  fijo siempre aparecen — fallback). */}
              {subjects.length > 0 && (
                <div className="flex-1 space-y-1">
                  <label className="text-xs text-muted-foreground">Asignatura</label>
                  <Select value={subjectFilter} onValueChange={setSubjectFilter}>
                    <SelectTrigger className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todas las asignaturas</SelectItem>
                      {subjects
                        .filter(
                          (s) =>
                            programFilter === "all" ||
                            !s.program_id ||
                            s.program_id === programFilter,
                        )
                        .map((s) => (
                          <SelectItem key={s.id} value={s.id}>
                            {s.name}
                            {s.code ? ` (${s.code})` : ""}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {(programFilter !== "all" ||
                periodFilter !== "all" ||
                tenantFilter !== "all" ||
                subjectFilter !== "all") && (
                <div className="flex items-end">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setProgramFilter("all");
                      setPeriodFilter("all");
                      setTenantFilter("all");
                      setSubjectFilter("all");
                    }}
                  >
                    Limpiar filtros
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

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
              <CompareChart summaries={filteredSummaries} />
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
                  {filteredSummaries.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={8}
                        className="text-center text-sm text-muted-foreground py-6"
                      >
                        Sin cursos que coincidan con los filtros.
                      </TableCell>
                    </TableRow>
                  ) : null}
                  {filteredSummaries.map((s) => (
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
