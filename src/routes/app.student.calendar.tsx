/**
 * Calendario integral del estudiante.
 *
 * Vista unificada de TODOS los eventos académicos: exámenes, talleres,
 * proyectos, sesiones de asistencia. Agrupado por mes con filtros por
 * tipo, búsqueda y "ver solo próximos / todos".
 *
 * Incluye sección "Suscribir" con el URL .ics (token privado) para que
 * el estudiante lo agregue a Google/Outlook/Apple Calendar. Botón
 * "Regenerar URL" rota el token si lo compartió accidentalmente.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty } from "@/components/ui/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import {
  Calendar as CalendarIcon,
  Copy,
  RefreshCw,
  FileText,
  Hammer,
  FolderKanban,
  Presentation,
  Search,
  Info,
  ExternalLink,
} from "lucide-react";
import { formatDateTime, formatWeekday } from "@/shared/lib/format";

export const Route = createFileRoute("/app/student/calendar")({ component: StudentCalendar });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface CalendarEvent {
  id: string;
  kind: "exam" | "workshop" | "project" | "session";
  title: string;
  courseName: string;
  start: Date;
  end?: Date | null;
  allDay: boolean;
  location?: string | null;
  link?: string | null;
}

const KIND_LABEL: Record<CalendarEvent["kind"], string> = {
  exam: "Examen",
  workshop: "Taller",
  project: "Proyecto",
  session: "Clase",
};

const KIND_ICON: Record<CalendarEvent["kind"], React.ComponentType<{ className?: string }>> = {
  exam: FileText,
  workshop: Hammer,
  project: FolderKanban,
  session: Presentation,
};

const KIND_COLOR: Record<CalendarEvent["kind"], string> = {
  exam: "text-violet-600 bg-violet-500/10 border-violet-500/40",
  workshop: "text-amber-600 bg-amber-500/10 border-amber-500/40",
  project: "text-rose-600 bg-rose-500/10 border-rose-500/40",
  session: "text-blue-600 bg-blue-500/10 border-blue-500/40",
};

function StudentCalendar() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [search, setSearch] = useState("");
  const [activeKinds, setActiveKinds] = useState<Set<CalendarEvent["kind"]>>(
    new Set(["exam", "workshop", "project", "session"]),
  );
  const [showPast, setShowPast] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Load events
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      // Reusamos la misma estructura de queries que el edge function
      // para coherencia. El RLS asegura que el estudiante solo ve lo suyo.
      const lookback = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const lookbackIso = lookback.toISOString();
      const lookbackDate = lookbackIso.slice(0, 10);

      const [examsRes, wsRes, pjRes, sessRes] = await Promise.all([
        db
          .from("exam_assignments")
          .select(
            "exam_id, exams(id, title, start_time, end_time, status, courses(name))",
          )
          .eq("user_id", user.id),
        db
          .from("course_enrollments")
          .select("course_id, courses(id, name, workshops(id, title, due_date, status))")
          .eq("user_id", user.id),
        db
          .from("course_enrollments")
          .select("course_id, courses(id, name, projects(id, title, due_date, status))")
          .eq("user_id", user.id),
        db
          .from("course_enrollments")
          .select(
            "course_id, courses(id, name, attendance_sessions(id, session_date, start_time, title, meeting_url))",
          )
          .eq("user_id", user.id),
      ]);
      if (cancelled) return;

      const evs: CalendarEvent[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const row of (examsRes.data ?? []) as any[]) {
        const e = row.exams;
        if (!e?.start_time || !e?.end_time) continue;
        if (e.status && e.status !== "publicado") continue;
        const end = new Date(e.end_time);
        if (end < lookback) continue;
        evs.push({
          id: `exam-${e.id}`,
          kind: "exam",
          title: e.title,
          courseName: e.courses?.name ?? "Curso",
          start: new Date(e.start_time),
          end,
          allDay: false,
          link: `/app/student/exams`,
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const enr of (wsRes.data ?? []) as any[]) {
        const c = enr.courses;
        if (!c?.workshops) continue;
        for (const ws of c.workshops) {
          if (!ws.due_date || (ws.status && ws.status !== "published")) continue;
          if (String(ws.due_date) < lookbackDate) continue;
          const hasTime = /T\d{2}:\d{2}/.test(String(ws.due_date));
          evs.push({
            id: `workshop-${ws.id}`,
            kind: "workshop",
            title: ws.title,
            courseName: c.name,
            start: new Date(ws.due_date),
            allDay: !hasTime,
            link: "/app/student/workshops",
          });
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const enr of (pjRes.data ?? []) as any[]) {
        const c = enr.courses;
        if (!c?.projects) continue;
        for (const pj of c.projects) {
          if (!pj.due_date || (pj.status && pj.status !== "published")) continue;
          if (String(pj.due_date) < lookbackDate) continue;
          const hasTime = /T\d{2}:\d{2}/.test(String(pj.due_date));
          evs.push({
            id: `project-${pj.id}`,
            kind: "project",
            title: pj.title,
            courseName: c.name,
            start: new Date(pj.due_date),
            allDay: !hasTime,
            link: "/app/student/projects",
          });
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const enr of (sessRes.data ?? []) as any[]) {
        const c = enr.courses;
        if (!c?.attendance_sessions) continue;
        for (const s of c.attendance_sessions) {
          if (!s.session_date) continue;
          if (String(s.session_date) < lookbackDate) continue;
          const timeStr = s.start_time ? String(s.start_time).slice(0, 5) : null;
          // Anclamos al día local de Colombia para que el badge muestre la
          // fecha esperada por el estudiante (no UTC).
          const start = timeStr
            ? new Date(`${s.session_date}T${timeStr}:00-05:00`)
            : new Date(`${s.session_date}T12:00:00-05:00`);
          evs.push({
            id: `session-${s.id}`,
            kind: "session",
            title: s.title ? s.title : `Clase del curso`,
            courseName: c.name,
            start,
            allDay: !timeStr,
            location: s.meeting_url ?? null,
            link: "/app/student/attendance",
          });
        }
      }

      evs.sort((a, b) => a.start.getTime() - b.start.getTime());
      setEvents(evs);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  // Load token (creates if not exists)
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setTokenLoading(true);
      const { data, error } = await db.rpc("get_or_create_calendar_token");
      if (cancelled) return;
      if (error) {
        toast.error(error.message);
      } else {
        const row = Array.isArray(data) ? data[0] : data;
        if (row?.token) setToken(row.token);
      }
      setTokenLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const now = Date.now();
    return events.filter((e) => {
      if (!activeKinds.has(e.kind)) return false;
      if (!showPast && e.start.getTime() < now - 24 * 60 * 60 * 1000) return false;
      if (q) {
        const hay = (e.title + " " + e.courseName).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [events, search, activeKinds, showPast]);

  // Agrupar por mes
  const groups = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const e of filtered) {
      const key = `${e.start.getFullYear()}-${String(e.start.getMonth() + 1).padStart(2, "0")}`;
      const arr = map.get(key) ?? [];
      arr.push(e);
      map.set(key, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const toggleKind = (k: CalendarEvent["kind"]) => {
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const icsUrl = useMemo(() => {
    if (!token) return null;
    const supaUrl = (import.meta as { env: Record<string, string> }).env.VITE_SUPABASE_URL ?? "";
    if (!supaUrl) return null;
    return `${supaUrl}/functions/v1/student-calendar-ics?token=${token}`;
  }, [token]);

  const webcalUrl = useMemo(
    () => (icsUrl ? icsUrl.replace(/^https?:\/\//, "webcal://") : null),
    [icsUrl],
  );

  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      const { data, error } = await db.rpc("regenerate_calendar_token");
      if (error) {
        toast.error(error.message);
        return;
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.token) {
        setToken(row.token);
        toast.success("URL regenerada. El link anterior dejó de funcionar.");
      }
    } finally {
      setRegenerating(false);
    }
  };

  const handleCopy = () => {
    if (!icsUrl) return;
    void navigator.clipboard.writeText(icsUrl);
    toast.success("URL copiada");
  };

  return (
    <div className="container mx-auto space-y-6 p-4 sm:p-6">
      <PageHeader
        backTo="/app"
        icon={<CalendarIcon className="h-6 w-6 text-blue-500" />}
        title="Mi calendario"
        subtitle="Vista unificada de exámenes, talleres, proyectos y sesiones. Suscríbete desde tu calendario favorito."
      />

      {/* Bloque de suscripción .ics */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarIcon className="h-4 w-4 text-blue-500" />
            Suscribir a calendario externo
            <HelpHint>
              Esta URL es PRIVADA — quien la tenga ve tus eventos. Si la compartiste por error
              presiona "Regenerar URL".
            </HelpHint>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Pega esta URL en Google Calendar (Otros calendarios → Agregar → De URL), Apple
            Calendar (Archivo → Nueva suscripción) o Outlook (Suscribirse desde web).
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {tokenLoading ? (
            <div className="text-sm text-muted-foreground flex items-center gap-2">
              <Spinner size="sm" inline /> Generando URL…
            </div>
          ) : icsUrl ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Input value={icsUrl} readOnly className="font-mono text-xs flex-1 min-w-64" />
                <Button size="sm" variant="outline" onClick={handleCopy}>
                  <Copy className="h-3.5 w-3.5 mr-1" />
                  Copiar
                </Button>
                {webcalUrl && (
                  <Button size="sm" variant="outline" asChild>
                    <a href={webcalUrl}>
                      <ExternalLink className="h-3.5 w-3.5 mr-1" />
                      Abrir en mi calendario
                    </a>
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleRegenerate()}
                  disabled={regenerating}
                  className="text-amber-700 dark:text-amber-300"
                >
                  {regenerating ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  )}
                  Regenerar URL
                </Button>
              </div>
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  Los calendarios externos refrescan cada 1–24h (depende del cliente). Para ver
                  cambios al instante usa esta página directamente.
                </AlertDescription>
              </Alert>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No se pudo generar la URL. Intenta recargar la página.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Filtros */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por título o curso…"
                className="pl-8"
              />
            </div>
            <Button
              size="sm"
              variant={showPast ? "default" : "outline"}
              onClick={() => setShowPast((v) => !v)}
            >
              {showPast ? "Mostrando todos" : "Solo próximos"}
            </Button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(["exam", "workshop", "project", "session"] as const).map((k) => {
              const Icon = KIND_ICON[k];
              const active = activeKinds.has(k);
              return (
                <Button
                  key={k}
                  size="sm"
                  variant={active ? "default" : "outline"}
                  onClick={() => toggleKind(k)}
                  className="h-7 text-[11px]"
                >
                  <Icon className="h-3 w-3 mr-1" />
                  {KIND_LABEL[k]}
                </Button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Eventos por mes */}
      {loading ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <Spinner size="md" /> Cargando eventos…
          </CardContent>
        </Card>
      ) : groups.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <TableEmpty
              title="Sin eventos para mostrar"
              description={
                showPast
                  ? "Ajusta los filtros o escribe en el buscador."
                  : "No tienes eventos próximos con los filtros actuales. Activa 'Mostrando todos' para ver los pasados."
              }
              icon={CalendarIcon}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map(([monthKey, evs]) => (
            <section key={monthKey}>
              <h2 className="text-sm font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                {monthLabel(monthKey)}
              </h2>
              <div className="space-y-2">
                {evs.map((e) => (
                  <EventRow key={e.id} event={e} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: CalendarEvent }) {
  const Icon = KIND_ICON[event.kind];
  return (
    <Card className="border-l-4" style={borderLeftStyle(event.kind)}>
      <CardContent className="p-3 flex items-start gap-3">
        <div className={`shrink-0 rounded-md p-2 ${KIND_COLOR[event.kind]}`}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{event.title}</span>
            <Badge variant="outline" className="text-[10px]">
              {KIND_LABEL[event.kind]}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">{event.courseName}</div>
          <div className="text-xs text-muted-foreground mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span>
              {event.allDay
                ? formatWeekday(event.start)
                : formatDateTime(event.start)}
            </span>
            {event.end && !event.allDay && (
              <span>
                Fin: {formatDateTime(event.end)}
              </span>
            )}
            {event.allDay && <Badge variant="secondary" className="text-[9px]">Todo el día</Badge>}
          </div>
        </div>
        <div className="shrink-0 flex flex-col gap-1 items-end">
          {event.location && (
            <a
              href={event.location}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
            >
              <ExternalLink className="h-3 w-3" />
              Reunión
            </a>
          )}
          {event.link && (
            <a
              href={event.link}
              className="text-[11px] text-muted-foreground hover:underline"
            >
              Ir →
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function borderLeftStyle(kind: CalendarEvent["kind"]): React.CSSProperties {
  const colorMap: Record<CalendarEvent["kind"], string> = {
    exam: "rgb(139, 92, 246)",
    workshop: "rgb(245, 158, 11)",
    project: "rgb(244, 63, 94)",
    session: "rgb(59, 130, 246)",
  };
  return { borderLeftColor: colorMap[kind] };
}

function monthLabel(key: string): string {
  const [yStr, mStr] = key.split("-");
  const d = new Date(Number(yStr), Number(mStr) - 1, 1);
  // "enero de 2026", "junio de 2026", etc. — locale es-CO hardcoded para coherencia
  // con el resto de la app (ver src/lib/format.ts).
  return new Intl.DateTimeFormat("es-CO", { month: "long", year: "numeric" })
    .format(d);
}
