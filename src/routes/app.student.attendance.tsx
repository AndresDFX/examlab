/**
 * Vista del estudiante — Asistencia.
 *
 * Lista las sesiones de asistencia que el docente ha registrado para
 * los cursos del estudiante con el estado puesto por el docente
 * (presente / ausente / sin registro).
 *
 * RLS hace cumplir que cada estudiante solo ve sus propios records:
 *   attendance_records SELECT: auth.uid() = user_id OR docente OR admin.
 * `attendance_sessions` es legible por cualquier authenticated, así que
 * podemos listar todas las sesiones del curso aunque el alumno no
 * tenga record. Si no tiene record para una sesión, la mostramos como
 * "sin registro".
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SectionLoader } from "@/components/ui/loaders";
import { formatDateOnly } from "@/lib/format";
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
import { CalendarCheck, CheckCircle2, X, Loader2 } from "lucide-react";

export const Route = createFileRoute("/app/student/attendance")({
  component: StudentAttendance,
});

type Course = { id: string; name: string; period: string | null };
type Session = {
  id: string;
  course_id: string;
  session_date: string;
  title: string | null;
};
type Record_ = {
  id: string;
  session_id: string;
  status: string;
  note: string | null;
};

function statusMeta(status: string | null | undefined) {
  switch (status) {
    case "presente":
      return {
        label: "Presente",
        icon: CheckCircle2,
        className: "bg-success/10 text-success border-success/30",
      };
    case "ausente":
      return {
        label: "Ausente",
        icon: X,
        className: "bg-destructive/10 text-destructive border-destructive/30",
      };
    case "tardanza":
      return {
        label: "Tardanza",
        icon: CheckCircle2,
        className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
      };
    case "justificado":
      return {
        label: "Justificado",
        icon: CheckCircle2,
        className: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
      };
    default:
      return {
        label: "Sin registro",
        icon: null,
        className: "bg-muted text-muted-foreground",
      };
  }
}

function StudentAttendance() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [records, setRecords] = useState<Record_[]>([]);
  const [loadingCourses, setLoadingCourses] = useState(true);
  const [loadingData, setLoadingData] = useState(false);

  // Cursos donde el alumno está matriculado.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setLoadingCourses(true);
      const { data: enrolls } = await supabase
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", user.id);
      const courseIds = (enrolls ?? []).map((r: { course_id: string }) => r.course_id);
      if (courseIds.length === 0) {
        if (!cancelled) {
          setCourses([]);
          setSelectedCourseId(null);
        }
        if (!cancelled) setLoadingCourses(false);
        return;
      }
      const { data: cs } = await supabase
        .from("courses")
        .select("id, name, period")
        .in("id", courseIds)
        .order("name");
      if (cancelled) return;
      const list = (cs ?? []) as Course[];
      setCourses(list);
      // Default al primero si no había selección o la selección quedó stale.
      setSelectedCourseId((prev) => {
        if (prev && list.find((c) => c.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
      setLoadingCourses(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Sesiones + records del curso seleccionado.
  useEffect(() => {
    if (!user || !selectedCourseId) return;
    let cancelled = false;
    (async () => {
      setLoadingData(true);
      const [{ data: sess }, { data: recs }] = await Promise.all([
        supabase
          .from("attendance_sessions")
          .select("id, course_id, session_date, title")
          .eq("course_id", selectedCourseId)
          .order("session_date", { ascending: false }),
        // RLS limita a auth.uid() = user_id; igual filtramos explícitamente
        // para no traer todo si en el futuro la policy se relaja.
        supabase
          .from("attendance_records")
          .select("id, session_id, status, note")
          .eq("user_id", user.id),
      ]);
      if (cancelled) return;
      setSessions((sess ?? []) as Session[]);
      setRecords((recs ?? []) as Record_[]);
      setLoadingData(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, selectedCourseId]);

  const recordBySession = useMemo(() => {
    const map = new Map<string, Record_>();
    for (const r of records) map.set(r.session_id, r);
    return map;
  }, [records]);

  // Filtramos los records al curso seleccionado para los stats.
  const courseRecords = useMemo(() => {
    const sessionIds = new Set(sessions.map((s) => s.id));
    return records.filter((r) => sessionIds.has(r.session_id));
  }, [records, sessions]);

  const stats = useMemo(() => {
    const total = sessions.length;
    let presente = 0;
    let ausente = 0;
    let otros = 0;
    let registradas = 0;
    for (const s of sessions) {
      const r = recordBySession.get(s.id);
      if (!r) continue;
      registradas++;
      if (r.status === "presente") presente++;
      else if (r.status === "ausente") ausente++;
      else otros++;
    }
    const pct = registradas > 0 ? Math.round((presente / registradas) * 100) : null;
    return { total, presente, ausente, otros, registradas, pct };
  }, [sessions, recordBySession]);

  if (!user) {
    return (
      <p className="text-muted-foreground p-6">
        Inicia sesión para ver tu asistencia.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start gap-3 justify-between">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight flex items-center gap-2">
            <CalendarCheck className="h-5 w-5 text-primary" />
            {t("nav.studentAttendance", { defaultValue: "Asistencia" })}
          </h1>
          <p className="text-sm text-muted-foreground">
            Registro de asistencia que el docente ha cargado para tus cursos.
          </p>
        </div>
        {courses.length > 0 && (
          <div className="min-w-[220px]">
            <Select
              value={selectedCourseId ?? undefined}
              onValueChange={(v) => setSelectedCourseId(v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Selecciona un curso" />
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
          </div>
        )}
      </div>

      {loadingCourses && <SectionLoader />}

      {!loadingCourses && courses.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="p-6 text-sm text-muted-foreground text-center">
            No estás matriculado en ningún curso todavía.
          </CardContent>
        </Card>
      )}

      {!loadingCourses && courses.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Sesiones</div>
                <div className="text-2xl font-semibold tabular-nums">{stats.total}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Presentes</div>
                <div className="text-2xl font-semibold tabular-nums text-success">
                  {stats.presente}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Ausencias</div>
                <div className="text-2xl font-semibold tabular-nums text-destructive">
                  {stats.ausente}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">% asistencia</div>
                <div className="text-2xl font-semibold tabular-nums">
                  {stats.pct == null ? "—" : `${stats.pct}%`}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  sobre {stats.registradas} registradas
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-base">Detalle por sesión</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loadingData && (
                <p className="text-sm text-muted-foreground p-6">
                  <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                  Cargando sesiones…
                </p>
              )}
              {!loadingData && sessions.length === 0 && (
                <p className="text-sm text-muted-foreground p-6 text-center">
                  No hay sesiones de asistencia registradas en este curso.
                </p>
              )}
              {!loadingData && sessions.length > 0 && (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Fecha</TableHead>
                        <TableHead>Sesión</TableHead>
                        <TableHead>Estado</TableHead>
                        <TableHead>Nota del docente</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {sessions.map((s) => {
                        const rec = recordBySession.get(s.id);
                        const meta = statusMeta(rec?.status);
                        const Icon = meta.icon;
                        return (
                          <TableRow key={s.id}>
                            <TableCell className="font-medium tabular-nums">
                              {formatDateOnly(s.session_date)}
                            </TableCell>
                            <TableCell className="text-sm">
                              {s.title ?? <span className="text-muted-foreground">—</span>}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className={`${meta.className} text-xs`}>
                                {Icon && <Icon className="h-3 w-3 mr-1" />}
                                {meta.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {rec?.note ? rec.note : "—"}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {courseRecords.length === 0 && sessions.length > 0 && !loadingData && (
            <p className="text-xs text-muted-foreground text-center">
              El docente aún no ha marcado tu asistencia en ninguna sesión de este curso.
            </p>
          )}
        </>
      )}
    </div>
  );
}
