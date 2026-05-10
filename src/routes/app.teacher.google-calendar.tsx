import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  getGoogleAuthUrl,
  getGoogleStatus,
  listMyCalendars,
  setSelectedCalendar,
  disconnectGoogle,
  syncCourseSessions,
} from "@/lib/google-calendar.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { CalendarDays, Link2, Unlink, RefreshCw, CheckCircle2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";

export const Route = createFileRoute("/app/teacher/google-calendar")({
  component: GoogleCalendarPage,
});

function GoogleCalendarPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const fnAuthUrl = useServerFn(getGoogleAuthUrl);
  const fnStatus = useServerFn(getGoogleStatus);
  const fnListCals = useServerFn(listMyCalendars);
  const fnSetCal = useServerFn(setSelectedCalendar);
  const fnDisc = useServerFn(disconnectGoogle);
  const fnSync = useServerFn(syncCourseSessions);

  const status = useQuery({
    queryKey: ["google-status"],
    queryFn: () => fnStatus({ data: undefined as never }),
  });

  const cals = useQuery({
    queryKey: ["google-cals"],
    queryFn: () => fnListCals({ data: undefined as never }),
    enabled: !!status.data?.connected,
  });

  // Cursos del docente para el selector de sync.
  const courses = useQuery({
    queryKey: ["my-teacher-courses"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return [];
      const { data, error } = await supabase
        .from("course_teachers")
        .select("course_id, courses:course_id (id, name)")
        .eq("user_id", u.user.id);
      if (error) throw error;
      return (data ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => r.courses)
        .filter(Boolean) as Array<{ id: string; name: string }>;
    },
  });

  const [selectedCalId, setSelectedCalId] = useState<string>("");
  const [selectedCourseId, setSelectedCourseId] = useState<string>("");

  // Hidratar selectedCalId con el guardado.
  useEffect(() => {
    if (status.data?.calendar_id) setSelectedCalId(status.data.calendar_id);
  }, [status.data?.calendar_id]);

  // Toast con resultado del callback (?ok=1 o ?err=...).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("ok")) {
      toast.success("Cuenta de Google conectada");
      window.history.replaceState({}, "", window.location.pathname);
      qc.invalidateQueries({ queryKey: ["google-status"] });
    } else if (sp.get("err")) {
      toast.error(`No se pudo conectar: ${sp.get("err")}`);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [qc]);

  const connect = useMutation({
    mutationFn: async () => {
      const r = await fnAuthUrl({ data: { origin: window.location.origin } });
      window.location.href = r.url;
    },
  });

  const saveCal = useMutation({
    mutationFn: async () => {
      const cal = cals.data?.calendars.find((c) => c.id === selectedCalId);
      if (!cal) throw new Error("Calendario no encontrado");
      return fnSetCal({ data: { calendarId: cal.id, calendarName: cal.name } });
    },
    onSuccess: () => {
      toast.success("Calendario guardado");
      qc.invalidateQueries({ queryKey: ["google-status"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const disc = useMutation({
    mutationFn: () => fnDisc({ data: undefined as never }),
    onSuccess: () => {
      toast.success("Cuenta desconectada");
      qc.invalidateQueries({ queryKey: ["google-status"] });
      qc.invalidateQueries({ queryKey: ["google-cals"] });
    },
  });

  const sync = useMutation({
    mutationFn: () => fnSync({ data: { courseId: selectedCourseId } }),
    onSuccess: (r) => {
      toast.success(
        `Sincronización completa — ${r.created} creadas, ${r.updated} actualizadas${
          r.failed ? `, ${r.failed} fallidas` : ""
        }`,
      );
      if (r.errors.length) console.warn("Sync errors:", r.errors);
    },
    onError: (e) => toast.error(`Sync falló: ${(e as Error).message}`),
  });

  const connected = !!status.data?.connected;

  return (
    <div className="container max-w-4xl py-6 space-y-6">
      <PageHeader
        title="Google Calendar"
        subtitle="Conectá tu cuenta de Google y sincronizá las sesiones de tus cursos en tu calendario, invitando automáticamente a los estudiantes con un link de Google Meet."
        icon={<CalendarDays className="h-6 w-6 text-primary" />}
      />

      {status.isLoading ? (
        <Spinner />
      ) : !connected ? (
        <Card>
          <CardHeader>
            <CardTitle>Conectá tu cuenta de Google</CardTitle>
            <CardDescription>
              Te vamos a redirigir a Google para que autorices acceso a tu Calendar. Solo
              vos tenés acceso a tus tokens — cada docente conecta el suyo.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => connect.mutate()} disabled={connect.isPending}>
              {connect.isPending ? <Spinner size="sm" /> : <Link2 className="h-4 w-4 mr-2" />}
              Conectar con Google
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  Conectado
                </CardTitle>
                <CardDescription>
                  {status.data?.google_email ?? "Cuenta de Google conectada"}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (await confirm({
                    title: "Desconectar Google Calendar",
                    description: "Vas a borrar el acceso a tu calendario. Podés reconectar cuando quieras.",
                    confirmText: "Desconectar",
                    tone: "warning",
                  })) disc.mutate();
                }}
              >
                <Unlink className="h-4 w-4 mr-2" /> Desconectar
              </Button>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>1. Calendario destino</CardTitle>
              <CardDescription>
                Elegí en cuál de tus calendarios se crearán los eventos.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {cals.isLoading ? (
                <Spinner />
              ) : cals.error ? (
                <Alert variant="destructive">
                  <AlertDescription>{(cals.error as Error).message}</AlertDescription>
                </Alert>
              ) : (
                <>
                  <Label>Calendario</Label>
                  <Select value={selectedCalId} onValueChange={setSelectedCalId}>
                    <SelectTrigger><SelectValue placeholder="Elegir calendario…" /></SelectTrigger>
                    <SelectContent>
                      {cals.data?.calendars.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}{c.primary ? " (principal)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={() => saveCal.mutate()}
                    disabled={!selectedCalId || saveCal.isPending || selectedCalId === status.data?.calendar_id}
                  >
                    {saveCal.isPending ? <Spinner size="sm" /> : "Guardar calendario"}
                  </Button>
                  {status.data?.calendar_name && (
                    <p className="text-sm text-muted-foreground">
                      Actual: <span className="font-medium">{status.data.calendar_name}</span>
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Sincronizar sesiones de un curso</CardTitle>
              <CardDescription>
                Crea/actualiza un evento por cada sesión de asistencia del curso, con un link de
                Google Meet, e invita a todos los estudiantes matriculados (correo institucional).
                Las sesiones que ya tienen evento se actualizan; las nuevas se crean.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Label>Curso</Label>
              <Select value={selectedCourseId} onValueChange={setSelectedCourseId}>
                <SelectTrigger><SelectValue placeholder="Elegir curso…" /></SelectTrigger>
                <SelectContent>
                  {(courses.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={() => sync.mutate()}
                disabled={
                  !selectedCourseId ||
                  !status.data?.calendar_id ||
                  sync.isPending
                }
              >
                {sync.isPending ? <Spinner size="sm" /> : <RefreshCw className="h-4 w-4 mr-2" />}
                Sincronizar
              </Button>
              {!status.data?.calendar_id && (
                <p className="text-sm text-muted-foreground">
                  Primero guardá un calendario destino arriba.
                </p>
              )}
              {sync.data && (
                <Alert>
                  <AlertDescription className="space-y-1">
                    <div>Total: {sync.data.total} · Creadas: {sync.data.created} · Actualizadas: {sync.data.updated} · Fallidas: {sync.data.failed}</div>
                    {sync.data.errors.length > 0 && (
                      <ul className="text-xs list-disc list-inside text-destructive">
                        {sync.data.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              <p className="text-xs text-muted-foreground">
                Las sesiones se crean a las 09:00 hora Bogotá con duración 90 min (próxima
                versión: tomar la hora real de la sesión).{" "}
                <Link to="/app/teacher/attendance" className="underline">
                  Ver mis sesiones
                </Link>
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
