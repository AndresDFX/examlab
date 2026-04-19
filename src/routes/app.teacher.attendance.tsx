import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Plus, Download, Calendar, CheckCircle2, X } from "lucide-react";
import { downloadCSV, toCSV } from "@/lib/csv";

export const Route = createFileRoute("/app/teacher/attendance")({ component: TeacherAttendance });

type Course = { id: string; name: string; period: string | null };
type Session = { id: string; course_id: string; session_date: string; title: string | null; created_by: string };
type Student = { id: string; full_name: string; institutional_email: string };
type Record_ = { id: string; session_id: string; user_id: string; status: string; note: string | null };

const STATUS_OPTIONS = [
  { value: "presente", label: "Presente", icon: CheckCircle2, color: "text-emerald-600 dark:text-emerald-400" },
  { value: "ausente", label: "Ausente", icon: X, color: "text-destructive" },
];

function TeacherAttendance() {
  const { user, roles } = useAuth();
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
    supabase.from("courses").select("id, name, period").order("name").then(({ data }) => {
      setCourses((data ?? []) as Course[]);
      if (data?.[0]) setCourseId(data[0].id);
    });
  }, []);

  // Load data for selected course
  const loadCourse = useCallback(async () => {
    if (!courseId) return;

    const [{ data: sess }, { data: enr }] = await Promise.all([
      supabase.from("attendance_sessions").select("*").eq("course_id", courseId).order("session_date"),
      supabase.from("course_enrollments").select("user_id").eq("course_id", courseId),
    ]);
    setSessions((sess ?? []) as Session[]);

    const userIds = (enr ?? []).map((e: any) => e.user_id);
    if (userIds.length) {
      const { data: profs } = await supabase.from("profiles").select("id, full_name, institutional_email").in("id", userIds).order("full_name");
      setStudents((profs ?? []) as Student[]);
    } else {
      setStudents([]);
    }

    // Load all records for this course's sessions
    const sessionIds = (sess ?? []).map((s: any) => s.id);
    if (sessionIds.length) {
      const { data: recs } = await supabase.from("attendance_records").select("*").in("session_id", sessionIds);
      setRecords((recs ?? []) as Record_[]);
    } else {
      setRecords([]);
    }
  }, [courseId]);

  useEffect(() => { loadCourse(); }, [loadCourse]);

  // Create session
  const createSession = async () => {
    if (!courseId || !user || !newDate) { toast.error("Fecha requerida"); return; }
    const { error } = await supabase.from("attendance_sessions").insert({
      course_id: courseId,
      session_date: newDate,
      title: newTitle || null,
      created_by: user.id,
    });
    if (error) { toast.error(error.message); return; }
    toast.success("Sesión creada correctamente");
    setNewSessionOpen(false);
    setNewTitle("");
    loadCourse();
  };

  // Toggle attendance
  const setAttendance = async (sessionId: string, userId: string, status: string) => {
    const existing = records.find(r => r.session_id === sessionId && r.user_id === userId);
    if (existing) {
      await supabase.from("attendance_records").update({ status }).eq("id", existing.id);
      setRecords(prev => prev.map(r => r.id === existing.id ? { ...r, status } : r));
    } else {
      const { data } = await supabase.from("attendance_records").insert({
        session_id: sessionId,
        user_id: userId,
        status,
      }).select().single();
      if (data) setRecords(prev => [...prev, data as Record_]);
    }
  };

  // Get status for a cell
  const getStatus = (sessionId: string, userId: string): string => {
    return records.find(r => r.session_id === sessionId && r.user_id === userId)?.status ?? "";
  };

  // Mark all present for a session
  const markAllPresent = async (sessionId: string) => {
    for (const s of students) {
      if (!getStatus(sessionId, s.id)) {
        await setAttendance(sessionId, s.id, "presente");
      }
    }
    toast.success("Todos marcados como presentes");
    loadCourse();
  };

  // Export CSV
  const exportAttendance = () => {
    if (!sessions.length || !students.length) { toast.info("No hay datos para exportar"); return; }
    const csvRows = students.map(s => {
      const row: any = { nombre: s.full_name, email: s.institutional_email };
      sessions.forEach(sess => {
        const label = sess.title ? `${sess.session_date} - ${sess.title}` : sess.session_date;
        row[label] = getStatus(sess.id, s.id) || "—";
      });
      // Summary
      const total = sessions.length;
      const present = sessions.filter(sess => {
        const st = getStatus(sess.id, s.id);
        return st === "presente";
      }).length;
      row["% Asistencia"] = total > 0 ? `${Math.round((present / total) * 100)}%` : "—";
      return row;
    });
    const courseName = courses.find(c => c.id === courseId)?.name ?? "curso";
    downloadCSV(`asistencia-${courseName.replace(/\s+/g, "_")}-${Date.now()}.csv`, toCSV(csvRows));
    toast.success("Archivo exportado correctamente");
  };

  // Delete session
  const deleteSession = async (id: string) => {
    if (!confirm("¿Eliminar esta sesión y todos sus registros?")) return;
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
          <p className="text-sm text-muted-foreground">{sessions.length} sesiones · {students.length} estudiantes</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Select value={courseId} onValueChange={setCourseId}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Curso" /></SelectTrigger>
            <SelectContent>{courses.map(c => <SelectItem key={c.id} value={c.id}>{c.name}{c.period ? ` (${c.period})` : ""}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={exportAttendance}>
            <Download className="h-4 w-4 mr-1" />CSV
          </Button>
          <Button size="sm" onClick={() => setNewSessionOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />Nueva sesión
          </Button>
        </div>
      </div>

      {/* Attendance grid */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 z-10 bg-card min-w-48">Estudiante</TableHead>
                {sessions.map(sess => (
                  <TableHead key={sess.id} className="text-center min-w-24">
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[10px]">{new Date(sess.session_date + "T00:00").toLocaleDateString(undefined, { day: "2-digit", month: "short" })}</span>
                      {sess.title && <span className="text-[9px] text-muted-foreground truncate max-w-20">{sess.title}</span>}
                    </div>
                  </TableHead>
                ))}
                <TableHead className="text-center min-w-16">%</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {students.length === 0 && (
                <TableRow><TableCell colSpan={sessions.length + 2} className="text-center text-muted-foreground py-8">No hay estudiantes matriculados.</TableCell></TableRow>
              )}
              {students.map(s => {
                const total = sessions.length;
                const present = sessions.filter(sess => {
                  const st = getStatus(sess.id, s.id);
                  return st === "presente";
                }).length;
                const pct = total > 0 ? Math.round((present / total) * 100) : 0;
                return (
                  <TableRow key={s.id}>
                    <TableCell className="sticky left-0 z-10 bg-card">
                      <div className="text-sm font-medium truncate">{s.full_name}</div>
                      <div className="text-xs text-muted-foreground truncate">{s.institutional_email}</div>
                    </TableCell>
                    {sessions.map(sess => {
                      const status = getStatus(sess.id, s.id);
                      return (
                        <TableCell key={sess.id} className="text-center p-1">
                          <Select value={status || "none"} onValueChange={(v) => setAttendance(sess.id, s.id, v)}>
                            <SelectTrigger className="h-7 w-16 mx-auto text-[10px] px-1 [&>svg]:h-3 [&>svg]:w-3">
                              <SelectValue placeholder="—" />
                            </SelectTrigger>
                            <SelectContent>
                              {STATUS_OPTIONS.map(opt => (
                                <SelectItem key={opt.value} value={opt.value}>
                                  <span className={`text-xs ${opt.color}`}>{opt.label.charAt(0)}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                      );
                    })}
                    <TableCell className="text-center">
                      <Badge variant={pct >= 80 ? "default" : pct >= 60 ? "secondary" : "destructive"} className="text-[10px]">
                        {pct}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })}
              {/* Quick actions row */}
              {sessions.length > 0 && students.length > 0 && (
                <TableRow>
                  <TableCell className="sticky left-0 z-10 bg-card text-xs text-muted-foreground">Acciones</TableCell>
                  {sessions.map(sess => (
                    <TableCell key={sess.id} className="text-center p-1">
                      <Button variant="ghost" size="sm" className="h-6 text-[9px] px-1" onClick={() => markAllPresent(sess.id)} title="Marcar todos presentes">
                        <CheckCircle2 className="h-3 w-3" />
                      </Button>
                    </TableCell>
                  ))}
                  <TableCell />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {STATUS_OPTIONS.map(opt => {
          const Icon = opt.icon;
          return (
            <div key={opt.value} className="flex items-center gap-1">
              <Icon className={`h-3 w-3 ${opt.color}`} /> {opt.label}
            </div>
          );
        })}
      </div>

      {/* New session dialog */}
      <Dialog open={newSessionOpen} onOpenChange={setNewSessionOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Nueva sesión de asistencia</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Fecha</Label><Input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} /></div>
            <div><Label>Título (opcional)</Label><Input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="Ej: Clase 5, Laboratorio 2" /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewSessionOpen(false)}>Cancelar</Button>
            <Button onClick={createSession}>Crear</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
