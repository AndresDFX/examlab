/**
 * Resumen integral por programa académico (Admin).
 *
 * Vista de "salud institucional" — para cada programa muestra:
 *   - Asignaturas activas en el plan
 *   - Cursos (instancias) totales y del periodo actual
 *   - Estudiantes matriculados (distintos, suma a través de los cursos)
 *   - Docentes asignados (distintos)
 *
 * Filtrable por periodo. Sin filtro = todos los periodos (vista
 * histórica acumulada). Con periodo = solo lo activo en ese periodo.
 *
 * Las queries traen todo el material y agregan client-side. Para una
 * institución pequeña/mediana (~30 programas, ~500 asignaturas,
 * ~5000 estudiantes) esto es ~200ms — aceptable para una vista
 * administrativa que no se carga cada 30s.
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { ErrorState, TableEmpty } from "@/components/ui/empty-state";
import { HelpHint } from "@/components/ui/help-hint";
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
import { BarChart3 } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { StatTile } from "@/components/ui/stat-tile";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Program {
  id: string;
  name: string;
  code: string | null;
  faculty: string | null;
  active: boolean;
}

interface Period {
  id: string;
  code: string;
  status: string;
}

interface ProgramStats {
  programId: string;
  subjectsActive: number;
  coursesTotal: number;
  coursesInPeriod: number;
  studentsDistinct: number;
  teachersDistinct: number;
}

/** Convierte filas en un mapa programId → ProgramStats con todos los
 *  conteos. Es defensivo con FKs null (los ignora). */
function computeStats({
  programs,
  subjects,
  courses,
  enrollments,
  teachers,
  filterPeriodId,
}: {
  programs: Program[];
  subjects: Array<{ program_id: string | null; active: boolean }>;
  courses: Array<{ id: string; program_id: string | null; period_id: string | null }>;
  enrollments: Array<{ user_id: string; course: { program_id: string | null } | null }>;
  teachers: Array<{ user_id: string; course: { program_id: string | null } | null }>;
  filterPeriodId: string | null;
}): ProgramStats[] {
  const byProgram = new Map<string, ProgramStats>();
  for (const p of programs) {
    byProgram.set(p.id, {
      programId: p.id,
      subjectsActive: 0,
      coursesTotal: 0,
      coursesInPeriod: 0,
      studentsDistinct: 0,
      teachersDistinct: 0,
    });
  }
  // Asignaturas activas por programa.
  for (const s of subjects) {
    if (!s.program_id || !s.active) continue;
    const st = byProgram.get(s.program_id);
    if (st) st.subjectsActive += 1;
  }
  // Cursos por programa — totales + filtrados por periodo.
  for (const c of courses) {
    if (!c.program_id) continue;
    const st = byProgram.get(c.program_id);
    if (!st) continue;
    st.coursesTotal += 1;
    if (filterPeriodId && c.period_id === filterPeriodId) {
      st.coursesInPeriod += 1;
    }
  }
  // Estudiantes DISTINTOS por programa (un alumno en 2 cursos del
  // mismo programa cuenta una vez).
  const studentsByProgram = new Map<string, Set<string>>();
  for (const e of enrollments) {
    const pid = e.course?.program_id;
    if (!pid) continue;
    let set = studentsByProgram.get(pid);
    if (!set) {
      set = new Set();
      studentsByProgram.set(pid, set);
    }
    set.add(e.user_id);
  }
  for (const [pid, set] of studentsByProgram.entries()) {
    const st = byProgram.get(pid);
    if (st) st.studentsDistinct = set.size;
  }
  // Docentes DISTINTOS por programa (mismo principio).
  const teachersByProgram = new Map<string, Set<string>>();
  for (const t of teachers) {
    const pid = t.course?.program_id;
    if (!pid) continue;
    let set = teachersByProgram.get(pid);
    if (!set) {
      set = new Set();
      teachersByProgram.set(pid, set);
    }
    set.add(t.user_id);
  }
  for (const [pid, set] of teachersByProgram.entries()) {
    const st = byProgram.get(pid);
    if (st) st.teachersDistinct = set.size;
  }
  return Array.from(byProgram.values());
}

export function AdminProgramOverviewPanel() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [stats, setStats] = useState<ProgramStats[]>([]);
  const [periodFilter, setPeriodFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      const [progRes, periodRes, subjRes, coursesRes, enrRes, teachRes] = await Promise.all([
        db
          .from("academic_programs")
          .select("id, name, code, faculty, active")
          .order("name"),
        db
          .from("academic_periods")
          .select("id, code, status")
          .order("code", { ascending: false }),
        db.from("academic_subjects").select("program_id, active"),
        db.from("courses").select("id, program_id, period_id"),
        // Enrollment → course (program_id via embed). El embed sigue
        // funcionando aunque el curso no tenga program_id (queda null).
        db.from("course_enrollments").select("user_id, course:courses(program_id)"),
        db.from("course_teachers").select("user_id, course:courses(program_id)"),
      ]);
      if (cancelled) return;
      const firstErr =
        progRes.error ||
        periodRes.error ||
        subjRes.error ||
        coursesRes.error ||
        enrRes.error ||
        teachRes.error;
      if (firstErr) {
        setLoadError(friendlyError(firstErr, "No pudimos cargar los datos del resumen."));
        setLoading(false);
        return;
      }
      setPrograms((progRes.data ?? []) as Program[]);
      setPeriods((periodRes.data ?? []) as Period[]);
      const computed = computeStats({
        programs: (progRes.data ?? []) as Program[],
        subjects: (subjRes.data ?? []) as Array<{ program_id: string | null; active: boolean }>,
        courses: (coursesRes.data ?? []) as Array<{
          id: string;
          program_id: string | null;
          period_id: string | null;
        }>,
        enrollments: (enrRes.data ?? []) as Array<{
          user_id: string;
          course: { program_id: string | null } | null;
        }>,
        teachers: (teachRes.data ?? []) as Array<{
          user_id: string;
          course: { program_id: string | null } | null;
        }>,
        filterPeriodId: periodFilter === "all" ? null : periodFilter,
      });
      setStats(computed);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce, periodFilter]);

  const totals = useMemo(() => {
    // Agregado total del cuadro de arriba.
    return stats.reduce(
      (acc, s) => {
        acc.subjects += s.subjectsActive;
        acc.courses += s.coursesTotal;
        acc.coursesInPeriod += s.coursesInPeriod;
        acc.students += s.studentsDistinct;
        acc.teachers += s.teachersDistinct;
        return acc;
      },
      { subjects: 0, courses: 0, coursesInPeriod: 0, students: 0, teachers: 0 },
    );
  }, [stats]);

  const showInPeriodColumn = periodFilter !== "all";

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-indigo-500" />
          Resumen institucional
          <HelpHint>
            KPIs agregados por programa/nivel — asignaturas activas, cursos totales
            (instancias), estudiantes y docentes únicos. Filtra por periodo para ver solo lo
            activo en ese ciclo.
          </HelpHint>
        </CardTitle>
        <div className="w-44">
          <Select value={periodFilter} onValueChange={setPeriodFilter}>
            <SelectTrigger className="h-8 text-xs">
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
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> Cargando…
          </div>
        ) : loadError ? (
          <ErrorState
            message="No pudimos cargar"
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : (
          <>
            {/* Fila de totales arriba — visión rápida de la institución
                completa. Usa <StatTile> del design system para mantener
                consistencia con los headers de stats de student/teacher
                dashboards. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatTile
                label="Programas / Niveles"
                value={programs.filter((p) => p.active).length}
                color="text-indigo-600 dark:text-indigo-400"
                bg="bg-indigo-500/10"
              />
              <StatTile
                label="Asignaturas"
                value={totals.subjects}
                color="text-cyan-600 dark:text-cyan-400"
                bg="bg-cyan-500/10"
              />
              <StatTile
                label={showInPeriodColumn ? "Cursos · periodo" : "Cursos · histórico"}
                value={showInPeriodColumn ? totals.coursesInPeriod : totals.courses}
                color="text-violet-600 dark:text-violet-400"
                bg="bg-violet-500/10"
              />
              <StatTile
                label="Estudiantes únicos"
                value={totals.students}
                color="text-emerald-600 dark:text-emerald-400"
                bg="bg-emerald-500/10"
              />
            </div>

            <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="max-w-[260px]">Programa / Nivel</TableHead>
                    <TableHead className="hidden md:table-cell">Área / Departamento</TableHead>
                    <TableHead className="text-center w-24">Asignaturas</TableHead>
                    <TableHead className="text-center w-24">
                      {showInPeriodColumn ? "Cursos · periodo" : "Cursos"}
                    </TableHead>
                    <TableHead className="text-center w-24">Estudiantes</TableHead>
                    <TableHead className="text-center w-24 hidden sm:table-cell">
                      Docentes
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {programs.length === 0 ? (
                    <TableEmpty
                      colSpan={6}
                      text="Sin programas registrados"
                      hint="Crea programas desde la card de arriba."
                    />
                  ) : (
                    programs.map((p) => {
                      const s = stats.find((x) => x.programId === p.id);
                      return (
                        <TableRow key={p.id}>
                          <TableCell className="font-medium">
                            <div className="truncate" title={p.name}>
                              {p.name}
                              {!p.active && (
                                <Badge variant="outline" className="ml-2 text-[10px]">
                                  inactivo
                                </Badge>
                              )}
                            </div>
                            {p.code && (
                              <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                                {p.code}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                            {p.faculty ?? "—"}
                          </TableCell>
                          <TableCell className="text-center tabular-nums">
                            {s?.subjectsActive ?? 0}
                          </TableCell>
                          <TableCell className="text-center tabular-nums">
                            {showInPeriodColumn ? (s?.coursesInPeriod ?? 0) : (s?.coursesTotal ?? 0)}
                          </TableCell>
                          <TableCell className="text-center tabular-nums">
                            {s?.studentsDistinct ?? 0}
                          </TableCell>
                          <TableCell className="text-center tabular-nums hidden sm:table-cell">
                            {s?.teachersDistinct ?? 0}
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
