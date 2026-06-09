/**
 * LinkCalendarEventsDialog — flujo INVERSO al sync.
 *
 * Caso de uso: el docente ya tiene los eventos del semestre creados en
 * Google Calendar (con sus links de Meet/Zoom) ANTES de armar las
 * sesiones en ExamLab. En lugar de copiar/pegar las URLs uno por uno,
 * abre este dialog, lista los eventos del calendario en una ventana
 * de tiempo, y asocia uno-a-uno con las sesiones del curso.
 *
 * Backend: edge `calendar` con actions `list_events` y
 * `link_events_to_sessions`. La RPC valida que las sesiones sean del
 * curso del docente y persiste `attendance_sessions.{google_event_id,
 * meeting_url}` con los datos del evento.
 *
 * UX:
 *   - Inputs: courseId, fromDate, toDate.
 *   - "Cargar eventos" → fetch al calendar; muestra count.
 *   - Tabla de sesiones del curso con un Select por fila (eventos del
 *     calendar como opciones). Filtros: búsqueda por título del evento.
 *   - Sesiones ya vinculadas muestran el evento actual + opción
 *     "Desvincular".
 *   - "Aplicar X cambios" → manda el batch.
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
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
import { DatePicker } from "@/components/ui/date-picker";
import { TableEmpty } from "@/components/ui/empty-state";
import { Search, Link2, Unlink, CheckCircle2, Video, FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";
import i18n from "@/i18n";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Curso preseleccionado. El user puede cambiarlo si pasamos la lista
   *  de cursos. Pero típicamente este dialog se abre con un curso ya
   *  elegido en el step de sync. */
  courseId: string;
  /** Llamado tras aplicar cambios — el caller puede refrescar su UI. */
  onLinked?: () => void;
}

interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  start: string | null;
  end: string | null;
  hangoutLink: string | null;
  htmlLink: string | null;
  /** Link a la grabación (Google Meet adjunta el video de Drive al evento
   *  tras grabar). null si el evento aún no tiene grabación. Al vincular,
   *  el edge la persiste en `attendance_sessions.recording_url`. */
  recordingUrl: string | null;
  /** Link a las notas de reunión / minuta (Google adjunta el doc de notas
   *  al evento). null si el evento aún no tiene notas. Al vincular,
   *  el edge las persiste en `attendance_sessions.notes_url`. */
  notesUrl: string | null;
}

interface Session {
  id: string;
  session_date: string;
  title: string | null;
  start_time: string | null;
  duration_minutes: number | null;
  google_event_id: string | null;
  meeting_url: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/** Suggested defaults: from = primer día del mes, to = último día. Da
 *  una ventana razonable sin que el docente tenga que pensar. */
function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  return { from: fmt(from), to: fmt(to) };
}

export function LinkCalendarEventsDialog({ open, onOpenChange, courseId, onLinked }: Props) {
  const initial = useMemo(() => defaultRange(), []);
  const [fromDate, setFromDate] = useState<string>(initial.from);
  const [toDate, setToDate] = useState<string>(initial.to);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [search, setSearch] = useState("");
  /** Estado in-memory de asignaciones pendientes. Mapa:
   *  sessionId → eventId | null (null = desvincular) | undefined = sin cambio. */
  const [drafts, setDrafts] = useState<Record<string, string | null | undefined>>({});
  const [applying, setApplying] = useState(false);

  // Reset state al abrir/cerrar el dialog para no mostrar resultados
  // viejos si el user reabre con otro curso.
  useEffect(() => {
    if (!open) {
      setEvents([]);
      setSessions([]);
      setDrafts({});
      setSearch("");
    }
  }, [open]);

  // Cargar sesiones del curso al abrir.
  useEffect(() => {
    if (!open || !courseId) return;
    let cancelled = false;
    setLoadingSessions(true);
    void (async () => {
      const { data, error } = await db
        .from("attendance_sessions")
        .select(
          "id, session_date, title, start_time, duration_minutes, google_event_id, meeting_url",
        )
        .eq("course_id", courseId)
        .order("session_date", { ascending: true });
      if (cancelled) return;
      if (error) {
        toast.error(friendlyError(error, "No pudimos cargar las sesiones del curso"));
        setSessions([]);
      } else {
        setSessions((data ?? []) as Session[]);
      }
      setLoadingSessions(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, courseId]);

  const loadEvents = async (silent = false): Promise<CalendarEvent[]> => {
    if (!fromDate || !toDate) {
      toast.error(
        i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.pickBothDates", {
          defaultValue: "Eligí ambas fechas",
        }),
      );
      return [];
    }
    if (fromDate > toDate) {
      toast.error(
        i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.fromBeforeTo", {
          defaultValue: "La fecha 'Desde' debe ser anterior a 'Hasta'",
        }),
      );
      return [];
    }
    setLoadingEvents(true);
    try {
      const { data, error } = await supabase.functions.invoke("calendar", {
        body: { action: "list_events", provider: "google", fromDate, toDate },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      if (error || d?.ok === false) {
        const msg = d?.error ?? error?.message ?? "error_desconocido";
        if (msg === "no_calendar_selected") {
          toast.error(
            i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.noCalendarSelected", {
              defaultValue: "Primero seleccioná un calendario en la pantalla de Calendar.",
            }),
          );
        } else if (msg === "calendar_not_accessible") {
          toast.error(
            i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.calendarNotAccessible", {
              defaultValue: "El calendario ya no es accesible. Reconectá Google Calendar.",
            }),
          );
        } else {
          toast.error(
            i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.loadEventsFailed", {
              defaultValue: "No se pudieron cargar eventos: {{error}}",
              error: msg,
            }),
          );
        }
        return [];
      }
      const evs = (d?.events ?? []) as CalendarEvent[];
      setEvents(evs);
      if (!silent) {
        if (evs.length === 0) {
          toast.info(
            i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.noEventsInRange", {
              defaultValue: "No hay eventos en ese rango de fechas.",
            }),
          );
        } else {
          toast.success(
            i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.eventsLoaded", {
              defaultValue: "{{eventCount}} evento(s) cargados",
              eventCount: evs.length,
            }),
          );
        }
      }
      return evs;
    } catch (e) {
      toast.error(friendlyError(e, "Error consultando Google Calendar"));
      return [];
    } finally {
      setLoadingEvents(false);
    }
  };

  /**
   * Resincroniza grabaciones/notas: re-aplica los eventos YA vinculados de
   * las sesiones del rango. El edge `link_events_to_sessions` re-consulta
   * cada evento y actualiza `recording_url` / `notes_url` si ahora los tiene
   * (Google Meet adjunta el video tras grabar). Útil cuando avanzan las
   * sesiones y aparecen grabaciones nuevas — sin re-elegir cada evento a mano.
   */
  const resyncRecordings = async () => {
    setApplying(true);
    try {
      const evs = events.length > 0 ? events : await loadEvents(true);
      const loadedIds = new Set(evs.map((e) => e.id));
      const links = sessions
        .filter((s) => s.google_event_id && loadedIds.has(s.google_event_id))
        .map((s) => ({ sessionId: s.id, eventId: s.google_event_id as string }));
      if (links.length === 0) {
        toast.info(
          i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.noLinkedInRange", {
            defaultValue:
              "No hay sesiones vinculadas a eventos en este rango. Ajustá las fechas para cubrir las sesiones ya vinculadas y reintentá.",
          }),
        );
        return;
      }
      const { data, error } = await supabase.functions.invoke("calendar", {
        body: { action: "link_events_to_sessions", provider: "google", courseId, links },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      if (error || d?.ok === false) {
        toast.error(
          i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.resyncFailed", {
            defaultValue: "No se pudo resincronizar: {{error}}",
            error: d?.error ?? error?.message ?? "error",
          }),
        );
        return;
      }
      toast.success(
        i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.resynced", {
          defaultValue: "Grabaciones y notas resincronizadas en {{count}} sesión(es) vinculada(s).",
          count: d?.linked ?? links.length,
        }),
      );
      onLinked?.();
    } catch (e) {
      toast.error(friendlyError(e, "Error resincronizando grabaciones"));
    } finally {
      setApplying(false);
    }
  };

  // Filtro de eventos disponibles por búsqueda.
  const filteredEvents = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return events;
    return events.filter(
      (e) =>
        e.summary.toLowerCase().includes(q) ||
        (e.description ?? "").toLowerCase().includes(q),
    );
  }, [events, search]);

  // Mapa eventId → CalendarEvent para mostrar el current selection.
  const eventById = useMemo(() => {
    const m = new Map<string, CalendarEvent>();
    for (const e of events) m.set(e.id, e);
    return m;
  }, [events]);

  /** Cuenta de cambios pendientes (drafts no vacíos). */
  const pendingChanges = useMemo(() => {
    let n = 0;
    for (const sessionId of Object.keys(drafts)) {
      const draft = drafts[sessionId];
      if (draft === undefined) continue;
      const session = sessions.find((s) => s.id === sessionId);
      const current = session?.google_event_id ?? null;
      if (draft === current) continue; // no cambia
      n += 1;
    }
    return n;
  }, [drafts, sessions]);

  const applyChanges = async () => {
    const links: Array<{ sessionId: string; eventId: string | null }> = [];
    for (const sessionId of Object.keys(drafts)) {
      const draft = drafts[sessionId];
      if (draft === undefined) continue;
      const session = sessions.find((s) => s.id === sessionId);
      const current = session?.google_event_id ?? null;
      if (draft === current) continue;
      links.push({ sessionId, eventId: draft });
    }
    if (links.length === 0) {
      toast.info(
        i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.noChangesToApply", {
          defaultValue: "No hay cambios para aplicar",
        }),
      );
      return;
    }
    setApplying(true);
    try {
      const { data, error } = await supabase.functions.invoke("calendar", {
        body: {
          action: "link_events_to_sessions",
          provider: "google",
          courseId,
          links,
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = data as any;
      if (error || d?.ok === false) {
        const linkErr = d?.error ?? error?.message ?? "error";
        toast.error(
          i18n.t("toast.modules_calendar_LinkCalendarEventsDialog.linkFailed", {
            defaultValue: "No se pudo vincular: {{error}}",
            error: linkErr,
          }),
        );
        return;
      }
      toast.success(
        `${d.linked} vinculado(s) · ${d.unlinked} desvinculado(s)` +
          (d.failed > 0 ? ` · ${d.failed} fallaron` : ""),
      );
      onLinked?.();
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e, "Error aplicando los cambios"));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-5 w-5 text-primary" />
            Vincular sesiones desde Google Calendar
          </DialogTitle>
          <DialogDescription>
            Asocia las sesiones de este curso con eventos que ya existen en tu calendario. ExamLab
            heredará el link de Meet/Zoom de cada evento y, si el evento ya tiene una{" "}
            <strong>grabación</strong> o <strong>notas de reunión</strong>, también las vinculará. No
            se crean eventos nuevos — para eso usá <em>Sincronizar curso</em> en la pantalla
            principal.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Paso 1: rango de fechas + cargar eventos */}
          <div className="rounded-md border p-3 space-y-3">
            <p className="text-sm font-medium">1. Rango de fechas del calendario</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Desde</Label>
                <DatePicker value={fromDate} onChange={setFromDate} />
              </div>
              <div>
                <Label className="text-xs">Hasta</Label>
                <DatePicker value={toDate} onChange={setToDate} />
              </div>
              <div className="flex items-end">
                <Button onClick={() => void loadEvents()} disabled={loadingEvents} className="w-full">
                  {loadingEvents ? <Spinner size="sm" className="mr-2" /> : null}
                  Cargar eventos
                </Button>
              </div>
            </div>
            {events.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary" className="text-[10px]">
                  {events.length} evento(s)
                </Badge>
                <span>Cargados — abajo asignás cada uno a una sesión.</span>
              </div>
            )}
          </div>

          {/* Paso 2: asociar */}
          {events.length > 0 && (
            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-sm font-medium">2. Asignar evento por sesión</p>
                <div className="relative w-full sm:w-64">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Buscar evento por título…"
                    className="pl-8 h-8 text-xs"
                  />
                </div>
              </div>
              {loadingSessions ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
                  <Spinner size="sm" /> Cargando sesiones…
                </div>
              ) : sessions.length === 0 ? (
                <TableEmpty
                  text="El curso no tiene sesiones todavía"
                  hint="Creá las sesiones en /app/teacher/attendance antes de vincular."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-32">Sesión</TableHead>
                      <TableHead className="hidden sm:table-cell w-32">Fecha</TableHead>
                      <TableHead className="min-w-36 sm:min-w-48">Evento del calendario</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sessions.map((s) => {
                      const draft = drafts[s.id];
                      const currentLinkedId = s.google_event_id;
                      // Si el user no tocó el draft → el valor actual.
                      // Si lo tocó a null → "Sin vincular".
                      // Si lo tocó a un string → ese eventId.
                      const effective =
                        draft === undefined ? currentLinkedId : draft;
                      const isDirty =
                        draft !== undefined && draft !== currentLinkedId;
                      return (
                        <TableRow key={s.id} className={isDirty ? "bg-primary/5" : undefined}>
                          <TableCell className="font-medium text-sm">
                            <div className="truncate">{s.title ?? "Sin título"}</div>
                            {s.meeting_url && !isDirty && (
                              <div className="text-[10px] text-muted-foreground truncate">
                                {s.meeting_url}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className="hidden sm:table-cell text-xs text-muted-foreground tabular-nums">
                            {s.session_date}
                          </TableCell>
                          <TableCell>
                            <Select
                              value={effective ?? "__none__"}
                              onValueChange={(v) =>
                                setDrafts((d) => ({
                                  ...d,
                                  [s.id]: v === "__none__" ? null : v,
                                }))
                              }
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue placeholder="Sin vincular" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">— Sin vincular —</SelectItem>
                                {filteredEvents.map((e) => {
                                  const startStr = e.start
                                    ? formatDateTime(e.start)
                                    : "(sin fecha)";
                                  return (
                                    <SelectItem key={e.id} value={e.id}>
                                      <span className="truncate">
                                        {e.summary} · {startStr}
                                      </span>
                                    </SelectItem>
                                  );
                                })}
                              </SelectContent>
                            </Select>
                            {effective && (() => {
                              const ev = eventById.get(effective);
                              if (!ev) return null;
                              return (
                                <div className="mt-1 space-y-0.5">
                                  <div className="text-[10px] text-muted-foreground truncate">
                                    {ev.hangoutLink ?? ev.htmlLink ?? "(sin link Meet)"}
                                  </div>
                                  {ev.recordingUrl && (
                                    <div className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                                      <Video className="h-3 w-3 shrink-0" />
                                      <span className="truncate">Grabación disponible — se vinculará</span>
                                    </div>
                                  )}
                                  {ev.notesUrl && (
                                    <div className="flex items-center gap-1 text-[10px] text-sky-600 dark:text-sky-400">
                                      <FileText className="h-3 w-3 shrink-0" />
                                      <span className="truncate">
                                        {i18n.t(
                                          "modules_calendar_LinkCalendarEventsDialog.notesAvailable",
                                          {
                                            defaultValue:
                                              "Notas de reunión disponibles — se vincularán",
                                          },
                                        )}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </TableCell>
                          <TableCell>
                            {isDirty && draft === null && (
                              <Unlink className="h-3.5 w-3.5 text-amber-500" />
                            )}
                            {isDirty && draft !== null && (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {/* Resincronizar: re-jala grabaciones/notas de los eventos YA
              vinculados (sin re-elegir cada uno). Útil cuando avanzan las
              sesiones y Google adjunta los videos después. */}
          <Button
            variant="outline"
            onClick={() => void resyncRecordings()}
            disabled={applying || loadingEvents}
            title="Actualiza las grabaciones/notas de las sesiones ya vinculadas en el rango"
          >
            {applying || loadingEvents ? (
              <Spinner size="sm" className="mr-2" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            Resincronizar grabaciones
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={applying}>
              Cancelar
            </Button>
            <Button
              onClick={() => void applyChanges()}
              disabled={applying || pendingChanges === 0}
            >
              {applying ? <Spinner size="sm" className="mr-2" /> : null}
              Aplicar {pendingChanges > 0 ? `${pendingChanges} cambio${pendingChanges === 1 ? "" : "s"}` : "cambios"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
