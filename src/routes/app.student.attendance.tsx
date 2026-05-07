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
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { CalendarCheck, CheckCircle2, X, Loader2, QrCode, Keyboard, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { AttendanceQRScanner } from "@/components/AttendanceQRScanner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const CHECK_IN_ERROR_MESSAGES: Record<string, string> = {
  no_auth: "Necesitas iniciar sesión.",
  session_not_found: "La sesión ya no existe.",
  check_in_closed: "El check-in está cerrado o expiró.",
  not_enrolled: "No estás matriculado en este curso.",
  invalid_code: "Código inválido. Pídele al docente el actual.",
  unauthorized: "No tienes permiso.",
};

export const Route = createFileRoute("/app/student/attendance")({
  component: StudentAttendance,
});

type Course = { id: string; name: string; period: string | null };
type Session = {
  id: string;
  course_id: string;
  session_date: string;
  title: string | null;
  check_in_open?: boolean;
};
type OpenSession = Session & { course_name: string };
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

  // Check-in self-service
  const [openSessions, setOpenSessions] = useState<OpenSession[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState<OpenSession | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [submittingCheckIn, setSubmittingCheckIn] = useState(false);

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

  // Carga sesiones con check_in abierto en cualquier curso del estudiante.
  const loadOpenSessions = useCallback(async () => {
    if (!user || courses.length === 0) {
      setOpenSessions([]);
      return;
    }
    const courseIds = courses.map((c) => c.id);
    const { data } = await db
      .from("attendance_sessions")
      .select("id, course_id, session_date, title, check_in_open")
      .eq("check_in_open", true)
      .in("course_id", courseIds);
    const courseName = new Map(courses.map((c) => [c.id, c.name]));
    setOpenSessions(
      ((data ?? []) as Session[]).map((s) => ({
        ...s,
        course_name: courseName.get(s.course_id) ?? "",
      })),
    );
  }, [user, courses]);

  useEffect(() => {
    void loadOpenSessions();
  }, [loadOpenSessions]);

  // Realtime: si una sesión abre/cierra, refrescamos.
  useEffect(() => {
    if (!user || courses.length === 0) return;
    const channel = supabase
      .channel(`student-attendance-open-${user.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "attendance_sessions" },
        () => void loadOpenSessions(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, courses, loadOpenSessions]);

  const submitCheckIn = useCallback(
    async (sessionId: string, code: string): Promise<boolean> => {
      const cleaned = code.replace(/\s+/g, "");
      if (!/^\d{6}$/.test(cleaned)) {
        toast.error("El código debe tener 6 dígitos");
        return false;
      }
      setSubmittingCheckIn(true);
      try {
        const { data, error } = await db.rpc("student_check_in_attendance", {
          p_session_id: sessionId,
          p_code: cleaned,
        });
        if (error) {
          toast.error(error.message);
          return false;
        }
        const result = data as { ok: boolean; error?: string };
        if (!result?.ok) {
          toast.error(CHECK_IN_ERROR_MESSAGES[result?.error ?? ""] ?? result?.error ?? "Error");
          return false;
        }
        toast.success("¡Marcado como presente!");
        // Refresca records del curso seleccionado para que se vea inmediato
        if (selectedCourseId) {
          const { data: recs } = await supabase
            .from("attendance_records")
            .select("id, session_id, status, note")
            .eq("user_id", user!.id);
          setRecords((recs ?? []) as Record_[]);
        }
        return true;
      } finally {
        setSubmittingCheckIn(false);
      }
    },
    [selectedCourseId, user],
  );

  // Deep-link: si llegamos con ?session=...&code=... auto check-in.
  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("session");
    const code = params.get("code");
    if (!sessionId || !code) return;
    // Limpia la URL antes para no re-disparar al reciclar el effect.
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    url.searchParams.delete("code");
    window.history.replaceState({}, "", url.toString());
    void submitCheckIn(sessionId, code);
  }, [user, submitCheckIn]);

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
    return <p className="text-muted-foreground p-6">Inicia sesión para ver tu asistencia.</p>;
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

      {/* Check-in disponible */}
      {openSessions.length > 0 && (
        <Card className="border-primary/30 bg-primary/5">
          <CardHeader className="py-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              Check-in de asistencia disponible
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <p className="text-xs text-muted-foreground">
              Tu docente abrió la asistencia. Escanea el QR proyectado o escribe el código.
            </p>
            <div className="space-y-2">
              {openSessions.map((s) => (
                <div
                  key={s.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background p-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{s.course_name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {formatDateOnly(s.session_date)}
                      {s.title ? ` · ${s.title}` : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button size="sm" onClick={() => setScannerOpen(true)}>
                      <QrCode className="h-4 w-4 mr-1" />
                      Escanear QR
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setManualCode("");
                        setManualOpen(s);
                      }}
                    >
                      <Keyboard className="h-4 w-4 mr-1" />
                      Tengo el código
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

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

      {/* Scanner dialog */}
      {scannerOpen && (
        <CheckInDialog title="Escanear QR" onClose={() => setScannerOpen(false)}>
          <AttendanceQRScanner
            onClose={() => setScannerOpen(false)}
            onDetected={async ({ sessionId, code }) => {
              const ok = await submitCheckIn(sessionId, code);
              if (ok) {
                setScannerOpen(false);
                void loadOpenSessions();
              }
            }}
          />
        </CheckInDialog>
      )}

      {/* Manual code dialog */}
      {manualOpen && (
        <CheckInDialog title="Ingresar código manual" onClose={() => setManualOpen(null)}>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Pídele al docente el código de 6 dígitos que aparece bajo el QR.
            </p>
            <Input
              autoFocus
              inputMode="numeric"
              pattern="\d*"
              maxLength={7}
              placeholder="123456"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value.replace(/[^\d\s]/g, ""))}
              className="text-center text-2xl font-mono tracking-widest tabular-nums"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setManualOpen(null)}
                disabled={submittingCheckIn}
              >
                Cancelar
              </Button>
              <Button
                onClick={async () => {
                  if (!manualOpen) return;
                  const ok = await submitCheckIn(manualOpen.id, manualCode);
                  if (ok) {
                    setManualOpen(null);
                    void loadOpenSessions();
                  }
                }}
                disabled={submittingCheckIn}
              >
                {submittingCheckIn ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 mr-1" />
                )}
                Marcar presente
              </Button>
            </div>
          </div>
        </CheckInDialog>
      )}
    </div>
  );
}

function CheckInDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border rounded-lg shadow-lg w-full max-w-sm p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-base font-semibold mb-3">{title}</div>
        {children}
      </div>
    </div>
  );
}
