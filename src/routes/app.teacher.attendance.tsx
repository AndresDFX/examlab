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
import { Plus, CheckCircle2, X, Eraser, QrCode, Loader2 } from "lucide-react";
import { toCSV } from "@/lib/csv";
import { formatDateShort } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { ImportExportMenu } from "@/components/ImportExportMenu";
import { DatePicker } from "@/components/ui/date-picker";
import {
  AttendanceCheckInProjector,
  type CheckInState,
} from "@/components/AttendanceCheckInProjector";
import {
  ATTENDANCE_CHECK_IN_DEFAULT_MINUTES,
  ATTENDANCE_CODE_ROTATION_DEFAULT,
} from "@/lib/attendance-code";

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
  check_in_open?: boolean;
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
    color: "text-success",
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

  // Check-in self-service: configuración + estado del proyector activo
  const [checkInConfigSession, setCheckInConfigSession] = useState<Session | null>(null);
  const [checkInDuration, setCheckInDuration] = useState<number>(
    ATTENDANCE_CHECK_IN_DEFAULT_MINUTES,
  );
  const [checkInRotation, setCheckInRotation] = useState<number>(ATTENDANCE_CODE_ROTATION_DEFAULT);
  const [startingCheckIn, setStartingCheckIn] = useState(false);
  const [projector, setProjector] = useState<CheckInState | null>(null);

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

  // ── Check-in self-service ──────────────────────────────────────────
  // Total de matriculados — el proyector lo necesita para mostrar X/Y
  const totalEnrolled = students.length;

  const openCheckInConfig = (sess: Session) => {
    setCheckInDuration(ATTENDANCE_CHECK_IN_DEFAULT_MINUTES);
    setCheckInRotation(ATTENDANCE_CODE_ROTATION_DEFAULT);
    setCheckInConfigSession(sess);
  };

  const startCheckIn = async () => {
    if (!checkInConfigSession) return;
    setStartingCheckIn(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("teacher_open_attendance_check_in", {
        p_session_id: checkInConfigSession.id,
        p_duration_minutes: checkInDuration,
        p_rotation_seconds: checkInRotation,
      });
      if (error) {
        toast.error(error.message);
        return;
      }
      // RPC retorna { ok, seed, rotation_seconds, opened_at, closes_at } o { ok:false, error }
      const result = data as {
        ok: boolean;
        error?: string;
        seed?: string;
        rotation_seconds?: number;
        closes_at?: string;
      };
      if (!result?.ok || !result.seed || !result.closes_at || !result.rotation_seconds) {
        toast.error(result?.error ?? "No se pudo iniciar el check-in");
        return;
      }
      setProjector({
        sessionId: checkInConfigSession.id,
        seed: result.seed,
        rotationSeconds: result.rotation_seconds,
        closesAt: result.closes_at,
        totalEnrolled,
        sessionLabel: checkInConfigSession.title
          ? `${checkInConfigSession.session_date} · ${checkInConfigSession.title}`
          : checkInConfigSession.session_date,
      });
      setCheckInConfigSession(null);
      // Refresca listado para reflejar check_in_open=true
      loadCourse();
    } finally {
      setStartingCheckIn(false);
    }
  };

  /** Reabre el proyector de una sesión que ya está abierta (refresh / otra pestaña). */
  const reopenProjector = async (sess: Session) => {
    const { data, error } = await supabase
      .from("attendance_check_in_state" as never)
      .select("seed, rotation_seconds, closes_at")
      .eq("session_id", sess.id)
      .maybeSingle();
    if (error) {
      toast.error(error.message);
      return;
    }
    // Sesión inconsistente: check_in_open=true pero no hay state. Limpiar
    // y permitir al docente iniciar uno nuevo.
    if (!data) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).rpc("teacher_close_attendance_check_in", {
        p_session_id: sess.id,
      });
      toast.info("El check-in anterior expiró. Inicia uno nuevo.");
      loadCourse();
      openCheckInConfig(sess);
      return;
    }
    const row = data as { seed: string; rotation_seconds: number; closes_at: string };
    // State expirado en DB pero check_in_open=true: limpiar y abrir uno
    // nuevo en vez de reabrir un proyector que se cerrará en el primer tick.
    if (new Date(row.closes_at).getTime() <= Date.now()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabase as any).rpc("teacher_close_attendance_check_in", {
        p_session_id: sess.id,
      });
      toast.info("El check-in anterior expiró. Inicia uno nuevo.");
      loadCourse();
      openCheckInConfig(sess);
      return;
    }
    setProjector({
      sessionId: sess.id,
      seed: row.seed,
      rotationSeconds: row.rotation_seconds,
      closesAt: row.closes_at,
      totalEnrolled,
      sessionLabel: sess.title ? `${sess.session_date} · ${sess.title}` : sess.session_date,
    });
  };

  /** Llamado por el proyector cuando se cierra (manual o por expiración). */
  const closeProjector = async () => {
    const closedSessionId = projector?.sessionId;
    setProjector(null);
    loadCourse();
    if (!closedSessionId) return;
    // Ofrecer marcar pendientes como ausentes
    const ok = await confirm({
      title: "¿Marcar pendientes como ausentes?",
      description:
        "Los estudiantes matriculados que no se registraron quedarán como ausentes. Puedes ajustar manualmente después.",
      confirmLabel: "Marcar ausentes",
      cancelLabel: "Dejar pendientes",
      tone: "warning",
    });
    if (!ok) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("teacher_mark_pending_absent", {
      p_session_id: closedSessionId,
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    const result = data as { ok: boolean; marked_absent?: number; error?: string };
    if (result?.ok) {
      toast.success(`${result.marked_absent ?? 0} estudiante(s) marcado(s) como ausentes`);
      loadCourse();
    } else {
      toast.error(result?.error ?? "No se pudo marcar pendientes");
    }
  };

  // Delete session
  const deleteSession = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar sesión",
      description:
        "Se eliminará la sesión y todos sus registros de asistencia. Esta acción no se puede deshacer.",
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
                          variant={sess.check_in_open ? "default" : "outline"}
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() =>
                            sess.check_in_open ? reopenProjector(sess) : openCheckInConfig(sess)
                          }
                          title={
                            sess.check_in_open
                              ? "Check-in activo — abrir proyección"
                              : "Iniciar check-in con QR"
                          }
                        >
                          <QrCode className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon"
                          className="h-8 w-8 shrink-0"
                          onClick={() => markAllPresent(sess.id)}
                          title="Marcar a todos como presentes"
                        >
                          <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
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
                      {sess.check_in_open && (
                        <Badge
                          variant="default"
                          className="text-[9px] py-0 px-1 self-center"
                        >
                          Check-in activo
                        </Badge>
                      )}
                      <div className="flex flex-col items-center gap-0.5 border-t border-border/70 pt-1.5">
                        <span className="text-[10px] font-medium leading-tight tabular-nums">
                          {formatDateShort(sess.session_date + "T12:00:00")}
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
                              className={`h-8 w-12 mx-auto text-xs font-bold px-1.5 [&>svg]:h-3 [&>svg]:w-3 ${status === "presente" ? "text-success border-success/40" : status === "ausente" ? "text-destructive border-destructive/40" : ""}`}
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
              <Label required>Fecha</Label>
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

      {/* Check-in config dialog */}
      <Dialog
        open={!!checkInConfigSession}
        onOpenChange={(o) => !o && setCheckInConfigSession(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Iniciar check-in con QR</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Los estudiantes escanearán el QR (o escribirán el código) para
              marcarse presentes desde su app, sin que tengas que llamar a
              cada uno.
            </p>
            <div>
              <Label>Duración de la ventana (minutos)</Label>
              <Input
                type="number"
                min={1}
                max={240}
                value={checkInDuration || ""}
                onChange={(e) =>
                  setCheckInDuration(
                    e.target.value === "" ? 0 : Math.max(1, Math.min(240, Number(e.target.value))),
                  )
                }
              />
              <p className="text-xs text-muted-foreground mt-1">
                Cuánto tiempo permanece abierta la ventana antes de cerrarse
                automáticamente. Default 10 min.
              </p>
            </div>
            <div>
              <Label>Rotación del código (segundos)</Label>
              <Input
                type="number"
                min={15}
                max={600}
                value={checkInRotation || ""}
                onChange={(e) =>
                  setCheckInRotation(
                    e.target.value === "" ? 0 : Math.max(15, Math.min(600, Number(e.target.value))),
                  )
                }
              />
              <p className="text-xs text-muted-foreground mt-1">
                Cada cuánto cambia el código de 6 dígitos. Más corto = más
                seguro, más fricción si la red está lenta. Default 60s.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCheckInConfigSession(null)}
              disabled={startingCheckIn}
            >
              Cancelar
            </Button>
            <Button onClick={startCheckIn} disabled={startingCheckIn}>
              {startingCheckIn ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <QrCode className="h-4 w-4 mr-1" />
              )}
              Iniciar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Projector overlay */}
      {projector && (
        <AttendanceCheckInProjector state={projector} onClose={closeProjector} />
      )}
    </div>
  );
}
