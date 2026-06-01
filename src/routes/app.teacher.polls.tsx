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
  opens_at: string;
  closes_at: string | null;
  closed_manually: boolean;
  created_at: string;
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
      const { data: pollRows, error: pollErr } = await db
        .from("polls")
        .select(
          "id, course_id, attendance_session_id, title, description, poll_type, results_visible_to_students, opens_at, closes_at, closed_manually, created_at, options:poll_options(id, poll_id, label, position, max_responses, responses_count)",
        )
        .in("course_id", courseIds)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (pollErr) {
        setLoadError(friendlyError(pollErr, "No pudimos cargar las encuestas."));
        setLoading(false);
        return;
      }
      const courseNameById = new Map(myCourses.map((c) => [c.id, c.name] as const));
      const polls: Poll[] = (pollRows ?? []).map((p: Poll & { options?: PollOption[] }) => {
        const options = (p.options ?? []).slice().sort((a, b) => a.position - b.position);
        const total = options.reduce((acc, o) => acc + o.responses_count, 0);
        return {
          ...p,
          course_name: courseNameById.get(p.course_id) ?? "—",
          options,
          total_responses: total,
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
    return polls.filter((p) => p.course_id === courseFilter);
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
                          <div className="truncate">{p.course_name}</div>
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
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        courses={courses}
        userId={user?.id ?? null}
        onCreated={() => setRetryNonce((n) => n + 1)}
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
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  courses: Array<{ id: string; name: string }>;
  userId: string | null;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [courseId, setCourseId] = useState("");
  const [type, setType] = useState<PollType>("single");
  const [visibility, setVisibility] = useState<ResultsVis>("after_close");
  const [closesAt, setClosesAt] = useState(""); // datetime-local
  const [options, setOptions] = useState<DraftOption[]>([
    { label: "", max_responses: "" },
    { label: "", max_responses: "" },
  ]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      // Reset al abrir.
      setTitle("");
      setDescription("");
      setCourseId(courses[0]?.id ?? "");
      setType("single");
      setVisibility("after_close");
      setClosesAt("");
      setOptions([
        { label: "", max_responses: "" },
        { label: "", max_responses: "" },
      ]);
    }
  }, [open, courses]);

  const addOption = () => setOptions((opts) => [...opts, { label: "", max_responses: "" }]);
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
    if (!courseId) {
      toast.error("Elegí un curso");
      return;
    }
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
    setSaving(true);
    try {
      const { data: pollRow, error: pollErr } = await db
        .from("polls")
        .insert({
          course_id: courseId,
          title: title.trim(),
          description: description.trim() || null,
          poll_type: type,
          results_visible_to_students: visibility,
          closes_at: closesAt ? new Date(closesAt).toISOString() : null,
          created_by: userId,
        })
        .select("id")
        .single();
      if (pollErr || !pollRow) {
        toast.error(friendlyError(pollErr, "No se pudo crear la encuesta"));
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
        // Rollback manual: borrar la fila de polls que quedó huérfana.
        await db.from("polls").delete().eq("id", pollRow.id);
        toast.error(friendlyError(optsErr, "No se pudieron crear las opciones"));
        return;
      }
      toast.success("Encuesta creada");
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
          <DialogTitle>Nueva encuesta</DialogTitle>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label required>Curso</Label>
              <Select value={courseId} onValueChange={setCourseId}>
                <SelectTrigger>
                  <SelectValue placeholder="Elegí un curso" />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label required>Tipo</Label>
              <Select value={type} onValueChange={(v) => setType(v as PollType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">Opción única</SelectItem>
                  <SelectItem value="multiple">Múltiple (varias opciones)</SelectItem>
                  <SelectItem value="slot">Cupo por opción (Doodle)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>Cierra el (opcional)</Label>
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
              <Label>Resultados para alumnos</Label>
              <Select value={visibility} onValueChange={(v) => setVisibility(v as ResultsVis)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">{VIS_LABELS.always}</SelectItem>
                  <SelectItem value="after_close">{VIS_LABELS.after_close}</SelectItem>
                  <SelectItem value="never">{VIS_LABELS.never}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label required>Opciones</Label>
            <div className="space-y-2 mt-1">
              {options.map((o, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={o.label}
                    onChange={(e) => updateOption(idx, { label: e.target.value })}
                    placeholder={`Opción ${idx + 1}`}
                    className="flex-1"
                  />
                  {type === "slot" && (
                    <Input
                      type="number"
                      min={1}
                      value={o.max_responses}
                      onChange={(e) => updateOption(idx, { max_responses: e.target.value })}
                      placeholder="Cupo"
                      className="w-20"
                    />
                  )}
                  {options.length > 2 && (
                    <RowAction
                      label="Quitar opción"
                      icon={Trash2}
                      tone="destructive"
                      onClick={() => removeOption(idx)}
                    />
                  )}
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addOption}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Agregar opción
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Spinner size="sm" className="mr-1" />}
            Crear encuesta
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
