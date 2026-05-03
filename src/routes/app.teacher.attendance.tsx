import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Plus, CheckCircle2, X, Eraser } from "lucide-react";
import { toCSV } from "@/lib/csv";
import { useConfirm } from "@/components/ConfirmDialog";
import { ImportExportMenu } from "@/components/ImportExportMenu";
import { DatePicker } from "@/components/ui/date-picker";

const SESSIONS_TEMPLATE = `session_date,title
2025-08-01,Clase introductoria
2025-08-03,Laboratorio 1
2025-08-08,`;

const ATTENDANCE_TEMPLATE = `email,session_date,status,note
estudiante1@uni.edu,2025-08-01,presente,
estudiante2@uni.edu,2025-08-01,ausente,Justificó por correo
estudiante1@uni.edu,2025-08-03,presente,`;

export const Route = createFileRoute("/app/teacher/attendance")({ component: TeacherAttendance });

type Course = { id: string; name: string; period: string | null };
type Session = {
  id: string;
  course_id: string;
  session_date: string;
  title: string | null;
  created_by: string;
};
type Student = { id: string; full_name: string; institutional_email: string };
type Record_ = {
  id: string;
  session_id: string;
  user_id: string;
  status: string;
  note: string | null;
};

const STATUS_OPTIONS = [
  {
    value: "presente",
    short: "P",
    label: "Presente",
    icon: CheckCircle2,
    color: "text-emerald-600 dark:text-emerald-400",
  },
  { value: "ausente", short: "A", label: "Ausente", icon: X, color: "text-destructive" },
];

function TeacherAttendance() {
  const { user, roles } = useAuth();
  const confirm = useConfirm();
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState("");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [records, setRecords] = useState<Record_[]>([]);
  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newDate, setNewDate] = useState(new Date().toISOString().split("T")[0]);
  const [newTitle, setNewTitle] = useState("");

  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  // Load courses
  useEffect(() => {
    supabase
      .from("courses")
      .select("id, name, period")
      .order("name")
      .then(({ data }) => {
        setCourses((data ?? []) as Course[]);
        if (data?.[0]) setCourseId(data[0].id);
      });
  }, []);

  // Load data for selected course
  const loadCourse = useCallback(async () => {
    if (!courseId) return;

    const [{ data: sess }, { data: enr }] = await Promise.all([
      supabase
        .from("attendance_sessions")
        .select("*")
        .eq("course_id", courseId)
        .order("session_date"),
      supabase.from("course_enrollments").select("user_id").eq("course_id", courseId),
    ]);
    setSessions((sess ?? []) as Session[]);

    const userIds = (enr ?? []).map((e: any) => e.user_id);
    if (userIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds)
        .order("full_name");
      setStudents((profs ?? []) as Student[]);
    } else {
      setStudents([]);
    }

    // Load all records for this course's sessions
    const sessionIds = (sess ?? []).map((s: any) => s.id);
    if (sessionIds.length) {
      const { data: recs } = await supabase
        .from("attendance_records")
        .select("*")
        .in("session_id", sessionIds);
      setRecords((recs ?? []) as Record_[]);
    } else {
      setRecords([]);
    }
  }, [courseId]);

  useEffect(() => {
    loadCourse();
  }, [loadCourse]);

  // Create session
  const createSession = async () => {
    if (!courseId || !user || !newDate) {
      toast.error("Fecha requerida");
      return;
    }
    const { error } = await supabase.from("attendance_sessions").insert({
      course_id: courseId,
      session_date: newDate,
      title: newTitle || null,
      created_by: user.id,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Sesión creada correctamente");
    setNewSessionOpen(false);
    setNewTitle("");
    loadCourse();
  };

  // Toggle attendance ("none" = eliminar registro para esa celda)
  const setAttendance = async (sessionId: string, userId: string, status: string) => {
    const existing = records.find((r) => r.session_id === sessionId && r.user_id === userId);
    if (status === "none") {
      if (!existing) return;
      const { error } = await supabase.from("attendance_records").delete().eq("id", existing.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      setRecords((prev) => prev.filter((r) => r.id !== existing.id));
      return;
    }
    if (existing) {
      const { error } = await supabase
        .from("attendance_records")
        .update({ status })
        .eq("id", existing.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      setRecords((prev) => prev.map((r) => (r.id === existing.id ? { ...r, status } : r)));
    } else {
      const { data, error } = await supabase
        .from("attendance_records")
        .insert({
          session_id: sessionId,
          user_id: userId,
          status,
        })
        .select()
        .single();
      if (error) {
        toast.error(error.message);
        return;
      }
      if (data) setRecords((prev) => [...prev, data as Record_]);
    }
  };

  // Get status for a cell
  const getStatus = (sessionId: string, userId: string): string => {
    return records.find((r) => r.session_id === sessionId && r.user_id === userId)?.status ?? "";
  };

  // Marcar todos presentes en la sesión (sobrescribe ausentes / vacíos)
  const markAllPresent = async (sessionId: string) => {
    if (!students.length) return;
    for (const s of students) {
      const existing = records.find((r) => r.session_id === sessionId && r.user_id === s.id);
      if (existing) {
        await supabase
          .from("attendance_records")
          .update({ status: "presente" })
          .eq("id", existing.id);
      } else {
        await supabase.from("attendance_records").insert({
          session_id: sessionId,
          user_id: s.id,
          status: "presente",
        });
      }
    }
    toast.success("Todos los estudiantes marcados como presentes");
    loadCourse();
  };

  // Quitar todo registro de asistencia de la sesión
  const clearSessionAttendance = async (sessionId: string) => {
    const ok = await confirm({
      title: "Reiniciar asistencia",
      description:
        "Se eliminarán los registros de asistencia de todos los estudiantes en esta sesión.",
      confirmLabel: "Reiniciar",
      tone: "warning",
    });
    if (!ok) return;
    const { error } = await supabase
      .from("attendance_records")
      .delete()
      .eq("session_id", sessionId);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Asistencia de la sesión reiniciada");
    loadCourse();
  };

  // Build CSV de exportación de asistencia (matriz)
  const buildAttendanceCsv = (): string => {
    if (!sessions.length || !students.length) return "";
    const csvRows = students.map((s) => {
      const row: any = { nombre: s.full_name, email: s.institutional_email };
      sessions.forEach((sess) => {
        const label = sess.title ? `${sess.session_date} - ${sess.title}` : sess.session_date;
        row[label] = getStatus(sess.id, s.id) || "—";
      });
      const total = sessions.length;
      const present = sessions.filter((sess) => getStatus(sess.id, s.id) === "presente").length;
      row["% Asistencia"] = total > 0 ? `${Math.round((present / total) * 100)}%` : "—";
      return row;
    });
    return toCSV(csvRows);
  };

  // Build CSV de exportación de sesiones/clases
  const buildSessionsCsv = (): string => {
    if (!sessions.length) return "";
    return toCSV(sessions.map((s) => ({ session_date: s.session_date, title: s.title ?? "" })));
  };

  // Importar sesiones desde CSV
  const importSessions = async (rows: Record<string, string>[]) => {
    if (!courseId || !user) throw new Error("Selecciona un curso");
    const valid = rows.filter((r) => r.session_date && /^\d{4}-\d{2}-\d{2}$/.test(r.session_date));
    if (!valid.length) throw new Error("No hay filas con session_date válido (YYYY-MM-DD)");
    const payload = valid.map((r) => ({
      course_id: courseId,
      session_date: r.session_date,
      title: r.title || null,
      created_by: user.id,
    }));
    const { error } = await supabase.from("attendance_sessions").insert(payload);
    if (error) throw new Error(error.message);
    await loadCourse();
    return `${payload.length} clase(s) importada(s) correctamente`;
  };

  // Importar registros de asistencia desde CSV
  const importAttendance = async (rows: Record<string, string>[]) => {
    if (!courseId) throw new Error("Selecciona un curso");
    const sessionByDate = new Map(sessions.map((s) => [s.session_date, s.id]));
    const studentByEmail = new Map(
      students.map((s) => [s.institutional_email.toLowerCase(), s.id]),
    );

    let inserted = 0,
      updated = 0,
      skipped = 0;
    for (const r of rows) {
      const email = (r.email || "").toLowerCase().trim();
      const date = (r.session_date || "").trim();
      const status = (r.status || "").toLowerCase().trim();
      const note = r.note || null;
      const sid = sessionByDate.get(date);
      const uid = studentByEmail.get(email);
      if (!sid || !uid || !["presente", "ausente"].includes(status)) {
        skipped++;
        continue;
      }
      const existing = records.find((rec) => rec.session_id === sid && rec.user_id === uid);
      if (existing) {
        const { error } = await supabase
          .from("attendance_records")
          .update({ status, note })
          .eq("id", existing.id);
        if (!error) updated++;
        else skipped++;
      } else {
        const { error } = await supabase
          .from("attendance_records")
          .insert({ session_id: sid, user_id: uid, status, note });
        if (!error) inserted++;
        else skipped++;
      }
    }
    await loadCourse();
    return `${inserted} insertados · ${updated} actualizados · ${skipped} omitidos`;
  };

  // Delete session
  const deleteSession = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar sesión",
      description: "Se eliminará la sesión y todos sus registros de asistencia.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    await supabase.from("attendance_sessions").delete().eq("id", id);
    toast.success("Sesión eliminada correctamente");
    loadCourse();
  };

  if (!isTeacher) return <p className="text-muted-foreground">Necesitas rol Docente.</p>;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Asistencia</h1>
          <p className="text-sm text-muted-foreground">
            {sessions.length} sesiones · {students.length} estudiantes
          </p>
        </div>
        <div className="flex flex-wrap gap-2 w-full sm:w-auto">
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger className="w-full sm:w-56">
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
          <ImportExportMenu
            label="Clases"
            resourceName="clases"
            templateCsv={SESSIONS_TEMPLATE}
            onImport={importSessions}
            onExport={buildSessionsCsv}
            disabled={!courseId}
          />
          <ImportExportMenu
            label="Asistencia"
            resourceName="asistencia"
            templateCsv={ATTENDANCE_TEMPLATE}
            onImport={importAttendance}
            onExport={buildAttendanceCsv}
            disabled={!courseId}
          />
          <Button size="sm" onClick={() => setNewSessionOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Nueva sesión
          </Button>
        </div>
      </div>

      {/* Legend (above the grid) */}
      <Card className="bg-muted/30 border-dashed">
        <CardContent className="p-3 flex flex-wrap items-center gap-4 text-xs">
          <span className="font-medium text-muted-foreground">Leyenda:</span>
          {STATUS_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <div key={opt.value} className="flex items-center gap-1.5">
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded border text-[11px] font-bold ${opt.color}`}
                >
                  {opt.short}
                </span>
                <span className="text-muted-foreground">
                  <Icon className={`inline h-3 w-3 mr-1 ${opt.color}`} />
                  {opt.short} = {opt.label}
                </span>
              </div>
            );
          })}
          <span className="text-muted-foreground">— = sin registro</span>
        </CardContent>
      </Card>

      {/* Attendance grid */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card min-w-48">Estudiante</TableHead>
                {sessions.map((sess) => (
                  <TableHead key={sess.id} className="text-center min-w-[7.5rem] align-bottom p-2">
                    <div className="flex flex-col items-stretch gap-1.5">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => markAllPresent(sess.id)}
                          title="Marcar a todos como presentes"
                        >
                          <CheckCircle2
                            className="h-4 w-4 text-emerald-600 dark:text-emerald-400"
                            aria-hidden
                          />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => clearSessionAttendance(sess.id)}
                          title="Quitar asistencia de todos (reiniciar sesión)"
                        >
                          <Eraser className="h-4 w-4 text-muted-foreground" aria-hidden />
                        </Button>
                      </div>
                      <div className="flex flex-col items-center gap-0.5 border-t border-border/70 pt-1.5">
                        <span className="text-[10px] font-medium leading-tight">
                          {new Date(sess.session_date + "T12:00:00").toLocaleDateString(undefined, {
                            day: "2-digit",
                            month: "short",
                          })}
                        </span>
                        {sess.title && (
                          <span
                            className="text-[9px] text-muted-foreground truncate max-w-[5.5rem]"
                            title={sess.title ?? undefined}
                          >
                            {sess.title}
                          </span>
                        )}
                      </div>
                    </div>
                  </TableHead>
                ))}
                <TableHead className="text-center min-w-16">%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={sessions.length + 2}
                    className="text-center text-muted-foreground py-8"
                  >
                    No hay estudiantes matriculados.
                  </TableCell>
                </TableRow>
              )}
              {students.map((s) => {
                const total = sessions.length;
                const present = sessions.filter((sess) => {
                  const st = getStatus(sess.id, s.id);
                  return st === "presente";
                }).length;
                const pct = total > 0 ? Math.round((present / total) * 100) : 0;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="sticky left-0 z-10 bg-card">
                      <div className="text-sm font-medium truncate">{s.full_name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {s.institutional_email}
                      </div>
                    </TableCell>
                    {sessions.map((sess) => {
                      const status = getStatus(sess.id, s.id);
                      return (
                        <TableCell key={sess.id} className="text-center p-1">
                          <Select
                            value={status || "none"}
                            onValueChange={(v) => setAttendance(sess.id, s.id, v)}
                          >
                            <SelectTrigger
                              className={`h-8 w-12 mx-auto text-xs font-bold px-1.5 [&>svg]:h-3 [&>svg]:w-3 ${status === "presente" ? "text-emerald-600 dark:text-emerald-400 border-emerald-500/40" : status === "ausente" ? "text-destructive border-destructive/40" : ""}`}
                            >
                              <SelectValue placeholder="—" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">
                                <span className="text-muted-foreground text-xs">—</span>
                              </SelectItem>
                              {STATUS_OPTIONS.map((opt) => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  <span className={`text-xs font-bold ${opt.color}`}>
                                    {opt.short}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-center">
                      <Badge
                        variant={pct >= 80 ? "default" : pct >= 60 ? "secondary" : "destructive"}
                        className="text-[10px]"
                      >
                        {pct}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* New session dialog */}
      <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Nueva sesión de asistencia</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Fecha</Label>
              <DatePicker value={newDate} onChange={setNewDate} />
            </div>
            <div>
              <Label>Título (opcional)</Label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Ej: Clase 5, Laboratorio 2"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewSessionOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={createSession}>Crear</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
