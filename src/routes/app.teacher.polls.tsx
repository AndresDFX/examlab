/**
 * Encuestas (docente) — `/app/teacher/polls`
 *
 * Lista las encuestas de los cursos que el docente dicta + dialog para
 * crear una nueva. Cubre dos casos:
 *
 *   1. En vivo durante una sesión: el docente plantea una pregunta
 *      mientras dicta clase. (Para que aparezca destacada DENTRO de la
 *      pantalla de la sesión, se asocia a un `attendance_session_id` —
 *      ese flujo se hace desde la ruta de Asistencia. Acá solo se crean
 *      encuestas "sueltas" del curso.)
 *
 *   2. Asíncrona tipo Doodle: ej. fechas de sustentación del proyecto.
 *      Tipo `slot` permite definir cupo por opción.
 *
 * Modelo de datos en `supabase/migrations/20260720000000_polls.sql`.
 * La RLS deja al docente del curso ver TODAS las respuestas (necesario
 * para "¿qué fecha eligió cada alumno?"); el alumno solo ve la suya y,
 * si la encuesta lo permite, los conteos agregados de cada opción.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { RowAction } from "@/components/ui/row-action";
import { DateCell } from "@/components/ui/date-cell";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import {
  Plus,
  Trash2,
  Eye,
  Lock,
  Unlock,
  ListChecks,
  CheckSquare,
  CalendarRange,
  RefreshCw,
  Radio,
  Pencil,
} from "lucide-react";
import { usePollRealtime } from "@/modules/polls/use-poll-realtime";

export const Route = createFileRoute("/app/teacher/polls")({ component: TeacherPolls });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type PollType = "single" | "multiple" | "slot";
type ResultsVis = "always" | "after_close" | "never";

interface Poll {
  id: string;
  course_id: string;
  attendance_session_id: string | null;
  title: string;
  description: string | null;
  poll_type: PollType;
  results_visible_to_students: ResultsVis;
  /** Si false, el alumno NO puede cambiar su voto una vez emitido
   *  (RPC `clear_poll_response` rechaza). Default true. */
  allow_change_response: boolean;
  /** Si true, un trigger AFTER INSERT cierra la encuesta cuando todos
   *  los matriculados del curso ya votaron. Default false. */
  auto_close_when_all_responded: boolean;
  opens_at: string;
  closes_at: string | null;
  closed_manually: boolean;
  created_at: string;
  /** Set completo de cursos al que aplica la encuesta (migración
   *  20260603010000_polls_multicourse). Si tiene >1 elemento, la
   *  encuesta es multi-curso. Siempre incluye al curso ancla
   *  (polls.course_id) tras el backfill. */
  linked_courses?: Array<{ id: string; name: string }>;
  // Derivado: nombre del curso para mostrar (joineado a courses).
  course_name?: string;
  // Derivado en el load: opciones con sus conteos.
  options?: PollOption[];
  // Derivado: total de respuestas únicas (= votantes para single/slot;
  // = total de selecciones para multiple).
  total_responses?: number;
}

interface PollOption {
  id: string;
  poll_id: string;
  label: string;
  position: number;
  max_responses: number | null;
  responses_count: number;
}

const POLL_TYPE_LABELS: Record<PollType, string> = {
  single: "Opción única",
  multiple: "Múltiple",
  slot: "Cupo por opción",
};

const POLL_TYPE_ICONS: Record<PollType, typeof ListChecks> = {
  single: ListChecks,
  multiple: CheckSquare,
  slot: CalendarRange,
};

const VIS_LABELS: Record<ResultsVis, string> = {
  always: "Visible al alumno siempre",
  after_close: "Visible al alumno tras cerrar",
  never: "Solo el docente ve resultados",
};

function pollIsOpen(p: Poll): boolean {
  if (p.closed_manually) return false;
  const now = Date.now();
  const opens = new Date(p.opens_at).getTime();
  if (opens > now) return false;
  if (p.closes_at && new Date(p.closes_at).getTime() <= now) return false;
  return true;
}

function TeacherPolls() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [polls, setPolls] = useState<Poll[]>([]);
  const [courses, setCourses] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [courseFilter, setCourseFilter] = useState<string>("all");
  // Dialog state — crear / editar.
  const [dialogOpen, setDialogOpen] = useState(false);
  // editPoll != null → el dialog opera en modo edición (hidrata desde
  // la fila, hace UPDATE + sync de poll_courses, y deja las opciones
  // como read-only para no romper poll_responses ya emitidos).
  const [editPoll, setEditPoll] = useState<Poll | null>(null);
  // Detalle de resultados.
  const [viewPoll, setViewPoll] = useState<Poll | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      // Cursos del docente para el filtro y el create dialog.
      const { data: courseRows, error: courseErr } = await db
        .from("course_teachers")
        .select("course_id, courses(id, name)")
        .eq("user_id", user.id);
      if (cancelled) return;
      if (courseErr) {
        setLoadError(friendlyError(courseErr, "No pudimos cargar tus cursos."));
        setLoading(false);
        return;
      }
      const myCourses: Array<{ id: string; name: string }> = (courseRows ?? [])
        .map((r: { courses: { id: string; name: string } | null }) => r.courses)
        .filter((c: { id: string; name: string } | null): c is { id: string; name: string } =>
          Boolean(c),
        );
      setCourses(myCourses);
      // Polls de esos cursos + sus opciones. RLS ya filtra a los cursos
      // que dicta el docente, pero igual filtramos por course_id IN para
      // no traer encuestas de cursos donde el docente NO está
      // (consistencia con el filtro de la UI).
      const courseIds = myCourses.map((c) => c.id);
      if (courseIds.length === 0) {
        setPolls([]);
        setLoading(false);
        return;
      }
      // Multi-curso (mig 20260603010000): el filtro de cursos del
      // docente se aplica vía `poll_courses` (junction) en lugar de
      // `polls.course_id` directo — así se incluyen polls donde el
      // docente es teacher de un curso EXTRA (no del ancla).
      const { data: junctionRows } = await db
        .from("poll_courses")
        .select("poll_id")
        .in("course_id", courseIds);
      const pollIds = Array.from(
        new Set(((junctionRows ?? []) as Array<{ poll_id: string }>).map((r) => r.poll_id)),
      );
      if (pollIds.length === 0) {
        setPolls([]);
        setLoading(false);
        return;
      }
      // El embed `linked_courses:poll_courses(course_id, courses(id, name))`
      // trae los N cursos asociados a cada poll, no solo el ancla.
      const { data: pollRows, error: pollErr } = await db
        .from("polls")
        .select(
          "id, course_id, attendance_session_id, title, description, poll_type, results_visible_to_students, allow_change_response, auto_close_when_all_responded, opens_at, closes_at, closed_manually, created_at, options:poll_options(id, poll_id, label, position, max_responses, responses_count), linked_courses:poll_courses(course_id, courses(id, name))",
        )
        .in("id", pollIds)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (pollErr) {
        setLoadError(friendlyError(pollErr, "No pudimos cargar las encuestas."));
        setLoading(false);
        return;
      }
      const courseNameById = new Map(myCourses.map((c) => [c.id, c.name] as const));
      // El embed nested (poll_courses → courses) confunde la inferencia
      // de TS porque el shape de `linked_courses` aquí (Array<{course_id,
      // courses}>) es distinto al final (Array<{id, name}>). Casteamos
      // a `any` localmente para evitar fricción de intersección.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const polls: Poll[] = (pollRows ?? []).map((raw: any) => {
        const options: PollOption[] = ((raw.options ?? []) as PollOption[])
          .slice()
          .sort((a, b) => a.position - b.position);
        const total = options.reduce((acc, o) => acc + o.responses_count, 0);
        const linked = (
          (raw.linked_courses ?? []) as Array<{
            course_id: string;
            courses: { id: string; name: string } | null;
          }>
        )
          .map((lc) => lc.courses)
          .filter((c): c is { id: string; name: string } => Boolean(c));
        return {
          ...(raw as Poll),
          course_name: courseNameById.get(raw.course_id as string) ?? "—",
          options,
          total_responses: total,
          linked_courses: linked,
        };
      });
      setPolls(polls);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, retryNonce]);

  const filteredPolls = useMemo(() => {
    if (courseFilter === "all") return polls;
    // El filtro por curso ahora matchea contra el set linkeado (no solo
    // el ancla). Una encuesta multi-curso aparece en el filtro de
    // cualquiera de sus cursos.
    return polls.filter(
      (p) =>
        p.course_id === courseFilter || (p.linked_courses ?? []).some((c) => c.id === courseFilter),
    );
  }, [polls, courseFilter]);

  const toggleClose = async (p: Poll) => {
    const willClose = !p.closed_manually;
    if (willClose) {
      const ok = await confirm({
        title: `Cerrar "${p.title}"`,
        description:
          "Los alumnos no podrán seguir votando. Podés reabrirla después si te equivocaste.",
        confirmLabel: "Cerrar",
        tone: "warning",
      });
      if (!ok) return;
    }
    const { error } = await db.from("polls").update({ closed_manually: willClose }).eq("id", p.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(willClose ? "Encuesta cerrada" : "Encuesta reabierta");
    setRetryNonce((n) => n + 1);
  };

  const removePoll = async (p: Poll) => {
    const ok = await confirm({
      title: `Eliminar "${p.title}"`,
      description: "Se borra la encuesta y todas sus respuestas. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("polls").delete().eq("id", p.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Encuesta eliminada");
    setRetryNonce((n) => n + 1);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Encuestas"
        subtitle="Lanzá preguntas a tus alumnos: en vivo durante una sesión, o asíncronas tipo Doodle (cupo por opción)."
        icon={<ListChecks className="h-6 w-6 text-sky-500" />}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRetryNonce((n) => n + 1)}
              disabled={loading}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              Actualizar
            </Button>
            <Button size="sm" onClick={() => setDialogOpen(true)} disabled={courses.length === 0}>
              <Plus className="h-4 w-4 mr-1" />
              Nueva encuesta
            </Button>
          </div>
        }
      />

      {courses.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={courseFilter} onValueChange={setCourseFilter}>
            <SelectTrigger className="w-full sm:w-64 h-9 text-xs">
              <SelectValue placeholder="Filtrar por curso" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los cursos</SelectItem>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {loading ? (
        <div className="p-8 flex items-center justify-center text-sm text-muted-foreground">
          <Spinner size="sm" className="mr-2" /> Cargando…
        </div>
      ) : loadError ? (
        <ErrorState
          message="No pudimos cargar las encuestas"
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-48">Encuesta</TableHead>
                  <TableHead className="hidden md:table-cell w-40">Curso</TableHead>
                  <TableHead className="w-32">Tipo</TableHead>
                  <TableHead className="hidden lg:table-cell w-36">Ventana</TableHead>
                  <TableHead className="w-24 text-right">Respuestas</TableHead>
                  <TableHead className="w-28">Estado</TableHead>
                  <TableHead className="w-32 text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredPolls.length === 0 ? (
                  <TableEmpty
                    colSpan={7}
                    icon={ListChecks}
                    title="Sin encuestas"
                    description={
                      courses.length === 0
                        ? "No dictás ningún curso todavía. Hablá con el admin para que te asigne uno."
                        : "Creá la primera encuesta con el botón de arriba."
                    }
                  />
                ) : (
                  filteredPolls.map((p) => {
                    const open = pollIsOpen(p);
                    const Icon = POLL_TYPE_ICONS[p.poll_type];
                    return (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">
                          <div className="truncate" title={p.title}>
                            {p.title}
                          </div>
                          {p.description && (
                            <div
                              className="text-[11px] text-muted-foreground truncate"
                              title={p.description}
                            >
                              {p.description}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                          {/* Multi-curso: si hay >1 curso linkeado,
                              mostramos el primero + "+N más" con
                              tooltip. */}
                          {(() => {
                            const lc = p.linked_courses ?? [];
                            if (lc.length <= 1) {
                              return <div className="truncate">{p.course_name}</div>;
                            }
                            const names = lc.map((c) => c.name).join(", ");
                            return (
                              <div className="truncate" title={names}>
                                {lc[0].name}{" "}
                                <span className="text-[10px] text-muted-foreground/80">
                                  +{lc.length - 1} más
                                </span>
                              </div>
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-[10px]">
                            <Icon className="h-3 w-3 mr-1" />
                            {POLL_TYPE_LABELS[p.poll_type]}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">
                          <DateCell value={p.opens_at} variant="datetime" />
                          {p.closes_at && (
                            <>
                              {" → "}
                              <DateCell value={p.closes_at} variant="datetime" />
                            </>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {p.total_responses ?? 0}
                        </TableCell>
                        <TableCell>
                          <Badge variant={open ? "default" : "secondary"} className="text-[10px]">
                            {open ? "Abierta" : "Cerrada"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="inline-flex items-center gap-1">
                            <RowAction
                              label="Ver resultados"
                              icon={Eye}
                              onClick={() => setViewPoll(p)}
                            />
                            <RowAction
                              label="Editar"
                              icon={Pencil}
                              onClick={() => setEditPoll(p)}
                            />
                            <RowAction
                              label={p.closed_manually ? "Reabrir" : "Cerrar"}
                              icon={p.closed_manually ? Unlock : Lock}
                              onClick={() => void toggleClose(p)}
                            />
                            <RowAction
                              label="Eliminar"
                              icon={Trash2}
                              tone="destructive"
                              onClick={() => void removePoll(p)}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <CreatePollDialog
        open={dialogOpen || editPoll !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialogOpen(false);
            setEditPoll(null);
          } else {
            setDialogOpen(true);
          }
        }}
        courses={courses}
        userId={user?.id ?? null}
        editingPoll={editPoll}
        onCreated={() => {
          setEditPoll(null);
          setRetryNonce((n) => n + 1);
        }}
      />
      <ResultsDialog poll={viewPoll} onOpenChange={(open) => !open && setViewPoll(null)} />
    </div>
  );
}

// ── Create dialog ──────────────────────────────────────────────────

interface DraftOption {
  label: string;
  max_responses: string; // string en form, convertimos a number en save
}

function CreatePollDialog({
  open,
  onOpenChange,
  courses,
  userId,
  onCreated,
  editingPoll,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  courses: Array<{ id: string; name: string }>;
  userId: string | null;
  onCreated: () => void;
  /** Si está presente, el dialog opera en modo edición: hidrata todos
   *  los campos desde la fila, hace UPDATE en lugar de INSERT y
   *  sincroniza poll_courses (diff add/remove). Las OPCIONES quedan
   *  read-only — cambiarlas rompería los votos ya emitidos
   *  (poll_responses.option_id), así que para reescribirlas hay que
   *  eliminar y recrear la encuesta. */
  editingPoll?: Poll | null;
}) {
  const isEdit = editingPoll != null;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Multi-curso (migración 20260603010000): la encuesta puede aplicar a
  // N cursos. Internamente seguimos pasando `polls.course_id` = primer
  // curso seleccionado (curso ancla) por compat de queries antiguas;
  // los demás se persisten en la junction `poll_courses`.
  const [courseIds, setCourseIds] = useState<string[]>([]);
  const [type, setType] = useState<PollType>("single");
  const [visibility, setVisibility] = useState<ResultsVis>("after_close");
  const [closesAt, setClosesAt] = useState(""); // datetime-local
  // Parámetros nuevos (migración 20260603000000):
  //  - allowChange: si false, el alumno no puede cambiar su voto.
  //  - autoCloseAll: si true, la encuesta cierra sola cuando todos los
  //    matriculados del curso ya respondieron.
  const [allowChange, setAllowChange] = useState(true);
  const [autoCloseAll, setAutoCloseAll] = useState(false);
  const [options, setOptions] = useState<DraftOption[]>([
    { label: "", max_responses: "" },
    { label: "", max_responses: "" },
  ]);
  const [saving, setSaving] = useState(false);

  // Conteo de matriculados (DISTINCT user_id) a través de TODOS los
  // cursos seleccionados — sirve para el hint del cupo y para
  // dimensionar el auto-cierre. Se recalcula cuando cambia courseIds.
  const [enrolledCount, setEnrolledCount] = useState<number | null>(null);
  useEffect(() => {
    if (courseIds.length === 0) {
      setEnrolledCount(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await db
        .from("course_enrollments")
        .select("user_id")
        .in("course_id", courseIds);
      if (cancelled) return;
      const unique = new Set(((data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id));
      setEnrolledCount(unique.size);
    })();
    return () => {
      cancelled = true;
    };
    // courseIds es estable por reference (siempre nuevo array al setear);
    // usamos su join como key para no re-disparar en re-renders idénticos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseIds.join("|")]);

  // ─── Generador de slots de tiempo ────────────────────────────────
  // Estado del mini-form (visible solo en type='slot'). Cuando el
  // docente clickea "Generar", calculamos las opciones entre slotStart
  // y slotEnd con paso slotStepMin y las AÑADIMOS al array existente.
  // Cada opción nueva tiene cupo=1 (default típico para sustentaciones
  // individuales — el docente puede sobreescribir después).
  const [slotDate, setSlotDate] = useState<string>(""); // yyyy-mm-dd
  const [slotStartTime, setSlotStartTime] = useState<string>("18:00");
  const [slotEndTime, setSlotEndTime] = useState<string>("19:00");
  const [slotStepMin, setSlotStepMin] = useState<string>("15");
  const [slotCupo, setSlotCupo] = useState<string>("1");

  const generateSlots = () => {
    if (!slotDate) {
      toast.error("Elegí una fecha para los slots");
      return;
    }
    const step = Math.max(1, Math.floor(Number(slotStepMin) || 0));
    const cupo = Math.max(1, Math.floor(Number(slotCupo) || 0));
    if (!step || !cupo) {
      toast.error("Periodicidad y cupo deben ser enteros mayores que 0");
      return;
    }
    const [sh, sm] = slotStartTime.split(":").map(Number);
    const [eh, em] = slotEndTime.split(":").map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (endMin <= startMin) {
      toast.error("La hora de fin debe ser posterior a la de inicio");
      return;
    }
    // Parse fecha y armamos las etiquetas en es-CO ("vie 14 jun, 6:00 PM").
    const baseDate = new Date(`${slotDate}T00:00:00`);
    const fmtDate = new Intl.DateTimeFormat("es-CO", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    const datePart = fmtDate.format(baseDate);
    const generated: DraftOption[] = [];
    for (let m = startMin; m < endMin; m += step) {
      const hh = Math.floor(m / 60);
      const mm = m % 60;
      // Formato 12h con AM/PM (más natural para horario académico).
      const period = hh >= 12 ? "PM" : "AM";
      const h12 = hh % 12 === 0 ? 12 : hh % 12;
      const label = `${datePart}, ${h12}:${String(mm).padStart(2, "0")} ${period}`;
      generated.push({ label, max_responses: String(cupo) });
    }
    if (generated.length === 0) {
      toast.error("El rango no produce ningún slot — revisá inicio/fin/periodicidad");
      return;
    }
    // Si las dos opciones iniciales están vacías, REEMPLAZAMOS; si el
    // docente ya escribió algo, AÑADIMOS al final para no destruir su
    // trabajo.
    setOptions((prev) => {
      const allEmpty = prev.every((o) => !o.label.trim());
      return allEmpty ? generated : [...prev, ...generated];
    });
    toast.success(`${generated.length} slot(s) generados`);
  };

  useEffect(() => {
    if (!open) return;
    if (editingPoll) {
      // Modo edición: hidratamos desde la fila. closes_at en DB es
      // timestamptz ISO; el <input type="datetime-local"> espera
      // YYYY-MM-DDTHH:mm en hora local, así que cortamos los 16
      // primeros chars del toISOString tras restar el offset.
      setTitle(editingPoll.title);
      setDescription(editingPoll.description ?? "");
      const linkedIds = (editingPoll.linked_courses ?? []).map((c) => c.id);
      // Garantizamos que el anchor esté en el set inicial (compat).
      setCourseIds(
        linkedIds.length > 0 ? linkedIds : editingPoll.course_id ? [editingPoll.course_id] : [],
      );
      setType(editingPoll.poll_type);
      setVisibility(editingPoll.results_visible_to_students);
      if (editingPoll.closes_at) {
        const d = new Date(editingPoll.closes_at);
        const offsetMs = d.getTimezoneOffset() * 60_000;
        setClosesAt(new Date(d.getTime() - offsetMs).toISOString().slice(0, 16));
      } else {
        setClosesAt("");
      }
      setAllowChange(editingPoll.allow_change_response);
      setAutoCloseAll(editingPoll.auto_close_when_all_responded);
      // Las opciones se muestran read-only en modo edit — las hidratamos
      // para mostrar al docente lo que existe sin modificar.
      setOptions(
        (editingPoll.options ?? []).map((o) => ({
          label: o.label,
          max_responses: o.max_responses != null ? String(o.max_responses) : "",
        })),
      );
    } else {
      // Reset al abrir en modo create.
      setTitle("");
      setDescription("");
      setCourseIds(courses[0] ? [courses[0].id] : []);
      setType("single");
      setVisibility("after_close");
      setClosesAt("");
      setAllowChange(true);
      setAutoCloseAll(false);
      setOptions([
        { label: "", max_responses: "" },
        { label: "", max_responses: "" },
      ]);
    }
  }, [open, courses, editingPoll]);

  // Default cupo = "1" cuando type='slot' (típico para sustentaciones
  // individuales). Para otros tipos se ignora el campo.
  const addOption = () =>
    setOptions((opts) => [...opts, { label: "", max_responses: type === "slot" ? "1" : "" }]);
  const removeOption = (idx: number) =>
    setOptions((opts) => (opts.length > 2 ? opts.filter((_, i) => i !== idx) : opts));
  const updateOption = (idx: number, patch: Partial<DraftOption>) =>
    setOptions((opts) => opts.map((o, i) => (i === idx ? { ...o, ...patch } : o)));

  const save = async () => {
    if (!userId) return;
    if (!title.trim()) {
      toast.error("El título es obligatorio");
      return;
    }
    if (courseIds.length === 0) {
      toast.error("Elegí al menos un curso");
      return;
    }
    // Opciones solo se validan en modo create — en edit son read-only.
    if (!isEdit) {
      const validOptions = options.filter((o) => o.label.trim());
      if (validOptions.length < 2) {
        toast.error("Se necesitan al menos 2 opciones");
        return;
      }
      if (type === "slot") {
        const bad = validOptions.some((o) => {
          const n = Number(o.max_responses);
          return !Number.isInteger(n) || n <= 0;
        });
        if (bad) {
          toast.error("En tipo 'cupo por opción' cada opción necesita un cupo entero > 0");
          return;
        }
      }
    }
    setSaving(true);
    try {
      // El anchor es el primer curso del set. Si estamos editando y el
      // anchor previo ya no está en courseIds, lo reemplazamos por el
      // nuevo primero — polls.course_id es NOT NULL así que siempre
      // necesita un valor válido del set.
      const anchorCourseId = courseIds[0];

      if (isEdit && editingPoll) {
        // ── MODO EDICIÓN ──
        // 1) UPDATE polls con todos los campos editables. NO tocamos
        //    options (son read-only). closed_manually queda igual: para
        //    cerrar/reabrir está el botón Cerrar/Reabrir.
        const { error: updErr } = await db
          .from("polls")
          .update({
            course_id: anchorCourseId,
            title: title.trim(),
            description: description.trim() || null,
            poll_type: type,
            results_visible_to_students: visibility,
            closes_at: closesAt ? new Date(closesAt).toISOString() : null,
            allow_change_response: allowChange,
            auto_close_when_all_responded: autoCloseAll,
          })
          .eq("id", editingPoll.id);
        if (updErr) {
          toast.error(friendlyError(updErr, "No se pudo actualizar la encuesta"));
          return;
        }
        // 2) Sync de poll_courses: insert nuevos, delete los que ya no
        //    están. Diff sobre el set actual.
        const currentSet = new Set((editingPoll.linked_courses ?? []).map((c) => c.id));
        const nextSet = new Set(courseIds);
        const toAdd = courseIds.filter((cid) => !currentSet.has(cid));
        const toRemove = [...currentSet].filter((cid) => !nextSet.has(cid));
        if (toAdd.length > 0) {
          const { error: addErr } = await db.from("poll_courses").upsert(
            toAdd.map((cid) => ({ poll_id: editingPoll.id, course_id: cid })),
            { onConflict: "poll_id,course_id", ignoreDuplicates: true },
          );
          if (addErr) {
            toast.error(friendlyError(addErr, "No se pudieron agregar cursos"));
            return;
          }
        }
        if (toRemove.length > 0) {
          const { error: delErr } = await db
            .from("poll_courses")
            .delete()
            .eq("poll_id", editingPoll.id)
            .in("course_id", toRemove);
          if (delErr) {
            toast.error(friendlyError(delErr, "No se pudieron quitar cursos"));
            return;
          }
        }
        toast.success("Encuesta actualizada");
        onOpenChange(false);
        onCreated();
        return;
      }

      // ── MODO CREATE (original) ──
      const validOptions = options.filter((o) => o.label.trim());
      const { data: pollRow, error: pollErr } = await db
        .from("polls")
        .insert({
          course_id: anchorCourseId,
          title: title.trim(),
          description: description.trim() || null,
          poll_type: type,
          results_visible_to_students: visibility,
          closes_at: closesAt ? new Date(closesAt).toISOString() : null,
          allow_change_response: allowChange,
          auto_close_when_all_responded: autoCloseAll,
          created_by: userId,
        })
        .select("id")
        .single();
      if (pollErr || !pollRow) {
        toast.error(friendlyError(pollErr, "No se pudo crear la encuesta"));
        return;
      }
      // Junction multi-curso: insertamos UN row por cada curso. El
      // trigger AFTER INSERT en polls (mig 20260603020000) ya insertó el
      // anchor automáticamente, así que usamos upsert con
      // ignoreDuplicates para no chocar con esa fila.
      const junctionPayload = courseIds.map((cid) => ({
        poll_id: pollRow.id,
        course_id: cid,
      }));
      const { error: jErr } = await db
        .from("poll_courses")
        .upsert(junctionPayload, { onConflict: "poll_id,course_id", ignoreDuplicates: true });
      if (jErr) {
        await db.from("polls").delete().eq("id", pollRow.id);
        toast.error(friendlyError(jErr, "No se pudieron asociar los cursos"));
        return;
      }
      const optionsPayload = validOptions.map((o, idx) => ({
        poll_id: pollRow.id,
        label: o.label.trim(),
        position: idx,
        max_responses: type === "slot" ? Number(o.max_responses) : null,
      }));
      const { error: optsErr } = await db.from("poll_options").insert(optionsPayload);
      if (optsErr) {
        // Rollback manual: la cascada de poll_courses se dispara por FK
        // ON DELETE CASCADE al borrar el poll.
        await db.from("polls").delete().eq("id", pollRow.id);
        toast.error(friendlyError(optsErr, "No se pudieron crear las opciones"));
        return;
      }
      toast.success(
        courseIds.length === 1 ? "Encuesta creada" : `Encuesta creada (${courseIds.length} cursos)`,
      );
      onOpenChange(false);
      onCreated();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Editar encuesta" : "Nueva encuesta"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label required>Título</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej: ¿Quedó claro el concepto?"
            />
          </div>
          <div>
            <Label>Descripción (opcional)</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Contexto extra para los alumnos"
            />
          </div>
          {/* Multi-curso: una encuesta puede aplicar a N cursos a la vez.
              El primer curso seleccionado es el "ancla" (polls.course_id)
              y los demás se insertan en poll_courses. Cualquier alumno
              matriculado en CUALQUIERA de los cursos puede votar. */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <Label required>
                Cursos{" "}
                <HelpHint side="right">
                  Una sola encuesta puede aplicar a varios cursos. Los alumnos matriculados en
                  CUALQUIERA de los cursos seleccionados pueden votar. Los cupos y el cierre
                  automático suman los matriculados de todos los cursos. Útil cuando dictás el mismo
                  material en varios cursos y querés consolidar resultados.
                </HelpHint>
              </Label>
              {courses.length > 1 && (
                <button
                  type="button"
                  className="text-[11px] text-primary hover:underline disabled:opacity-50"
                  onClick={() =>
                    setCourseIds(
                      courseIds.length === courses.length ? [] : courses.map((c) => c.id),
                    )
                  }
                >
                  {courseIds.length === courses.length ? "Limpiar" : "Seleccionar todos"}
                </button>
              )}
            </div>
            {courses.length === 0 ? (
              <p className="text-xs text-muted-foreground">No dictás ningún curso.</p>
            ) : (
              <div className="max-h-32 overflow-y-auto rounded-md border divide-y">
                {courses.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40 cursor-pointer text-sm"
                  >
                    <Checkbox
                      checked={courseIds.includes(c.id)}
                      onCheckedChange={(checked) =>
                        setCourseIds((prev) =>
                          checked ? [...prev, c.id] : prev.filter((x) => x !== c.id),
                        )
                      }
                    />
                    <span className="flex-1 truncate">{c.name}</span>
                  </label>
                ))}
              </div>
            )}
            {courseIds.length > 1 && (
              <p className="text-[11px] text-muted-foreground mt-1">
                {courseIds.length} cursos seleccionados — un alumno matriculado en varios cuenta
                como uno solo.
              </p>
            )}
          </div>
          <div>
            <Label required>
              Tipo{" "}
              <HelpHint side="right">
                <div className="space-y-2 text-xs">
                  <p>
                    <strong>Opción única:</strong> el alumno elige <em>una sola</em> opción. Útil
                    para comprensión rápida o satisfacción (ej. ¿quedó claro el tema?).
                  </p>
                  <p>
                    <strong>Múltiple:</strong> el alumno puede marcar <em>varias</em> opciones a la
                    vez. Útil cuando varias respuestas son válidas (ej. ¿qué temas te interesan?).
                  </p>
                  <p>
                    <strong>Cupo por opción (Doodle):</strong> cada opción tiene un cupo limitado y
                    se cierra cuando se llena. Ideal para repartir slots — por ejemplo, fechas u
                    horarios de sustentación de proyecto: cada fecha es una opción con cupo de N
                    estudiantes y los alumnos eligen su turno preferido.
                  </p>
                </div>
              </HelpHint>
            </Label>
            <Select
              value={type}
              onValueChange={(v) => {
                const nextType = v as PollType;
                setType(nextType);
                // Si se pasa a slot, rellenamos cupos vacíos con "1"
                // (default sustentación individual). Si se sale de
                // slot, dejamos los cupos como estén — son ignorados.
                if (nextType === "slot") {
                  setOptions((opts) =>
                    opts.map((o) => (o.max_responses ? o : { ...o, max_responses: "1" })),
                  );
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="single">
                  <div className="flex flex-col gap-0.5">
                    <span>Opción única</span>
                    <span className="text-[11px] text-muted-foreground">
                      El alumno elige una sola opción
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="multiple">
                  <div className="flex flex-col gap-0.5">
                    <span>Múltiple</span>
                    <span className="text-[11px] text-muted-foreground">
                      El alumno puede marcar varias opciones
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="slot">
                  <div className="flex flex-col gap-0.5">
                    <span>Cupo por opción (Doodle)</span>
                    <span className="text-[11px] text-muted-foreground">
                      Cada opción tiene un cupo limitado — ej. fechas de sustentación
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>
                Cierra el (opcional){" "}
                <HelpHint side="right">
                  Fecha y hora en que la encuesta deja de aceptar respuestas. Después de ese momento
                  los alumnos ya no pueden votar y, según la configuración de resultados, recién ahí
                  podrían verlos. Si lo dejas vacío, la encuesta permanece abierta hasta que la
                  cierres manualmente desde el listado.
                </HelpHint>
              </Label>
              <Input
                type="datetime-local"
                value={closesAt}
                onChange={(e) => setClosesAt(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Vacío = abierta hasta que la cierres manualmente.
              </p>
            </div>
            <div>
              <Label>
                Resultados para alumnos{" "}
                <HelpHint side="left">
                  <div className="space-y-2 text-xs">
                    <p>
                      <strong>Visible siempre:</strong> el alumno ve resultados parciales en cuanto
                      vota. Útil en clase para visualizar consensos al instante.
                    </p>
                    <p>
                      <strong>Visible tras cerrar:</strong> los resultados aparecen solo cuando
                      cierras la encuesta. Evita el sesgo de "todos votan lo que ya va ganando".
                    </p>
                    <p>
                      <strong>Solo el docente:</strong> los alumnos nunca ven los resultados; solo
                      tú. Útil para feedback honesto o evaluación entre pares.
                    </p>
                  </div>
                </HelpHint>
              </Label>
              <Select value={visibility} onValueChange={(v) => setVisibility(v as ResultsVis)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">
                    <div className="flex flex-col gap-0.5">
                      <span>{VIS_LABELS.always}</span>
                      <span className="text-[11px] text-muted-foreground">
                        Ve resultados parciales mientras vota
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="after_close">
                    <div className="flex flex-col gap-0.5">
                      <span>{VIS_LABELS.after_close}</span>
                      <span className="text-[11px] text-muted-foreground">
                        Solo cuando termines la encuesta
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="never">
                    <div className="flex flex-col gap-0.5">
                      <span>{VIS_LABELS.never}</span>
                      <span className="text-[11px] text-muted-foreground">
                        El alumno nunca los ve
                      </span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Switches de comportamiento del voto. Persistidos en
              polls.allow_change_response y polls.auto_close_when_all_responded
              (migración 20260603000000). */}
          <div className="space-y-2 rounded-md border bg-muted/20 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className="text-sm font-medium">Permitir cambiar la respuesta</span>
                  <HelpHint>
                    Si está activado, el alumno puede modificar su voto mientras la encuesta siga
                    abierta. Si lo desactivás, una vez que vote queda en piedra hasta el cierre.
                    Útil cuando la decisión es definitiva (ej. confirmar asistencia).
                  </HelpHint>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {allowChange
                    ? "Los alumnos pueden cambiar su voto antes del cierre."
                    : "Bloqueado: el primer voto queda definitivo."}
                </p>
              </div>
              <Switch checked={allowChange} onCheckedChange={setAllowChange} />
            </div>

            <div className="flex items-start justify-between gap-3 pt-1 border-t">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className="text-sm font-medium">Cerrar al responder todos</span>
                  <HelpHint>
                    Si está activado, la encuesta se cierra sola en cuanto todos los alumnos
                    matriculados (de los cursos asociados) hayan respondido al menos una vez. Útil
                    para no dejarla "abierta para siempre" tras que el último alumno elija. Si algún
                    alumno nunca responde, el cierre automático no se dispara y tenés que cerrarla a
                    mano.
                  </HelpHint>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {autoCloseAll
                    ? "Se cerrará sola cuando todos los matriculados hayan votado."
                    : "Solo se cierra por fecha o manualmente."}
                </p>
              </div>
              <Switch checked={autoCloseAll} onCheckedChange={setAutoCloseAll} />
            </div>
          </div>

          <div>
            <Label required>
              Opciones{" "}
              <HelpHint side="right">
                <div className="space-y-1 text-xs">
                  <p>
                    Las respuestas que verán los alumnos. Mínimo 2; agrega tantas como necesites.
                  </p>
                  {type === "slot" && (
                    <p>
                      <strong>Cupo:</strong> número máximo de alumnos que pueden elegir esa opción.
                      Por ejemplo, si cada opción es una fecha de sustentación y solo caben 5
                      estudiantes por día, pon <code>5</code> en cada cupo.
                    </p>
                  )}
                </div>
              </HelpHint>
            </Label>
            {isEdit && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5 mt-1 mb-2">
                Las opciones quedan en solo lectura: cambiarlas rompería los votos ya emitidos. Para
                reemplazarlas, eliminá esta encuesta y creá una nueva.
              </p>
            )}
            {type === "slot" && !isEdit && (
              <>
                <p className="text-[11px] text-muted-foreground mt-1 mb-2">
                  Modo Doodle: cada opción se cierra cuando se llena su cupo. Útil para repartir
                  slots como fechas de sustentación o turnos de laboratorio.
                  {enrolledCount != null && enrolledCount > 0 && (
                    <>
                      {" "}
                      <span className="text-foreground font-medium">
                        Tu{courseIds.length > 1 ? "s curso(s) tienen" : " curso tiene"}{" "}
                        {enrolledCount} alumno{enrolledCount === 1 ? "" : "s"}
                      </span>{" "}
                      en total, y el cupo por opción decide cuántos alumnos pueden elegir esa misma
                      opción.
                    </>
                  )}
                </p>

                {/* Generador de slots de tiempo. Permite definir una
                    fecha, hora inicio/fin y periodicidad y genera
                    automáticamente todas las opciones (etiqueta +
                    cupo). Especialmente útil para sustentaciones. */}
                <div className="rounded-md border bg-muted/20 p-3 space-y-2 mb-3">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-medium">Generar slots de tiempo</span>
                    <HelpHint>
                      Definí una fecha, hora de inicio/fin y periodicidad, y se generarán las
                      opciones automáticamente. Ej. <code>14 jun 2026</code>, <code>6:00 PM</code> a{" "}
                      <code>7:00 PM</code>, cada <code>15 min</code> → genera 4 slots (6:00, 6:15,
                      6:30, 6:45) con cupo de 1 cada uno. Si ya escribiste opciones a mano, las
                      nuevas se añaden al final.
                    </HelpHint>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    <div className="col-span-2 sm:col-span-1">
                      <Label className="text-[11px]">Fecha</Label>
                      <Input
                        type="date"
                        value={slotDate}
                        onChange={(e) => setSlotDate(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px]">Desde</Label>
                      <Input
                        type="time"
                        value={slotStartTime}
                        onChange={(e) => setSlotStartTime(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px]">Hasta</Label>
                      <Input
                        type="time"
                        value={slotEndTime}
                        onChange={(e) => setSlotEndTime(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px]">Cada (min)</Label>
                      <Input
                        type="number"
                        min={1}
                        value={slotStepMin}
                        onChange={(e) => setSlotStepMin(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px]">Cupo</Label>
                      <Input
                        type="number"
                        min={1}
                        value={slotCupo}
                        onChange={(e) => setSlotCupo(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={generateSlots}
                    className="w-full sm:w-auto"
                  >
                    <CalendarRange className="h-3.5 w-3.5 mr-1" />
                    Generar slots
                  </Button>
                </div>
              </>
            )}
            <div className="space-y-2 mt-1">
              {options.map((o, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={o.label}
                    onChange={(e) => updateOption(idx, { label: e.target.value })}
                    placeholder={
                      type === "slot"
                        ? idx === 0
                          ? "Ej: Lun 10 jun, 9:00 AM"
                          : idx === 1
                            ? "Ej: Lun 10 jun, 10:00 AM"
                            : `Opción ${idx + 1}`
                        : `Opción ${idx + 1}`
                    }
                    className="flex-1"
                    disabled={isEdit}
                  />
                  {type === "slot" && (
                    <Input
                      type="number"
                      min={1}
                      value={o.max_responses}
                      onChange={(e) => updateOption(idx, { max_responses: e.target.value })}
                      placeholder="Cupo"
                      className="w-20"
                      title="Máximo de alumnos que pueden elegir esta opción"
                      disabled={isEdit}
                    />
                  )}
                  {!isEdit && options.length > 2 && (
                    <RowAction
                      label="Quitar opción"
                      icon={Trash2}
                      tone="destructive"
                      onClick={() => removeOption(idx)}
                    />
                  )}
                </div>
              ))}
              {!isEdit && (
                <Button variant="outline" size="sm" onClick={addOption}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Agregar opción
                </Button>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Spinner size="sm" className="mr-1" />}
            {isEdit ? "Guardar cambios" : "Crear encuesta"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Results dialog ─────────────────────────────────────────────────

function ResultsDialog({
  poll,
  onOpenChange,
}: {
  poll: Poll | null;
  onOpenChange: (v: boolean) => void;
}) {
  // El dialog mantiene SU PROPIA copia de las opciones y respondents,
  // refetcheada por realtime — no depende de que el padre re-renderice
  // su lista. Así los conteos se actualizan al instante cuando un
  // alumno vota durante el show-of-hands sin click manual.
  const [liveOptions, setLiveOptions] = useState<PollOption[]>([]);
  const [respondents, setRespondents] = useState<
    Array<{ option_id: string; user_id: string; full_name: string | null }>
  >([]);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(async () => {
    if (!poll) return;
    setLoading(true);
    const [optsRes, respRes] = await Promise.all([
      db
        .from("poll_options")
        .select("id, poll_id, label, position, max_responses, responses_count")
        .eq("poll_id", poll.id)
        .order("position"),
      db
        .from("poll_responses")
        .select("option_id, user_id, profiles:user_id(full_name)")
        .eq("poll_id", poll.id),
    ]);
    setLiveOptions((optsRes.data ?? []) as PollOption[]);
    setRespondents(
      (
        (respRes.data ?? []) as Array<{
          option_id: string;
          user_id: string;
          profiles: { full_name: string } | null;
        }>
      ).map((r) => ({
        option_id: r.option_id,
        user_id: r.user_id,
        full_name: r.profiles?.full_name ?? null,
      })),
    );
    setLoading(false);
  }, [poll]);

  // Cuando se abre el dialog (poll cambia de null → algo), hacemos el
  // primer fetch. Cuando se cierra (poll → null), limpiamos para no
  // dejar datos viejos en memoria.
  useEffect(() => {
    if (!poll) {
      setLiveOptions([]);
      setRespondents([]);
      return;
    }
    void refetch();
  }, [poll, refetch]);

  // Realtime: en el momento que cualquier alumno vota / el docente
  // cierra la encuesta, refetcheamos. El hook debounce-a las ráfagas
  // (ver use-poll-realtime.ts), así que 30 votos casi simultáneos
  // generan UN refetch, no 30.
  usePollRealtime(poll?.id ?? null, refetch, Boolean(poll));

  if (!poll) return null;
  // Si el realtime fetch ya pobló liveOptions, usamos esos; si todavía
  // no llegó (primer render), fallback a las del prop.
  const options = liveOptions.length > 0 ? liveOptions : (poll.options ?? []);
  const total = options.reduce((acc, o) => acc + o.responses_count, 0);
  return (
    <Dialog open={Boolean(poll)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {poll.title}
            <Badge
              variant="outline"
              className="text-[9px] gap-1 text-emerald-600 dark:text-emerald-400"
            >
              <Radio className="h-2.5 w-2.5 animate-pulse" />
              EN VIVO
            </Badge>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {total} respuesta{total === 1 ? "" : "s"} · {POLL_TYPE_LABELS[poll.poll_type]}
          </p>
          <div className="space-y-2">
            {options.map((o) => {
              const pct = total > 0 ? Math.round((o.responses_count / total) * 100) : 0;
              const voters = respondents.filter((r) => r.option_id === o.id);
              return (
                <div key={o.id} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium truncate" title={o.label}>
                      {o.label}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {o.responses_count}
                      {o.max_responses != null && ` / ${o.max_responses}`}
                      {total > 0 && ` · ${pct}%`}
                    </span>
                  </div>
                  <div className="h-1.5 bg-muted rounded overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                  </div>
                  {voters.length > 0 && (
                    <p className="text-[10px] text-muted-foreground truncate">
                      {voters.map((v) => v.full_name ?? v.user_id.slice(0, 8)).join(", ")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {loading && (
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <Spinner size="sm" /> Cargando respuestas…
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cerrar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
