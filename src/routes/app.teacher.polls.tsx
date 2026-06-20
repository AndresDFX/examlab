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
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
import { TableEmpty, ErrorState, EmptyState } from "@/components/ui/empty-state";
import { RowAction } from "@/components/ui/row-action";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { DateCell } from "@/components/ui/date-cell";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  SortableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { SectionLoader } from "@/components/ui/loaders";
import { DuplicateOptionsDialog } from "@/shared/components/DuplicateOptionsDialog";
import { ReopenClosedBanner } from "@/shared/components/ReopenClosedBanner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { DateTimePicker, DatePicker } from "@/components/ui/date-picker";
import { generateSlotsForDates, suggestSlotCupo, formatSlotLabel } from "@/modules/polls/slot-generation";
import { formatSessionLabel } from "@/shared/lib/format";
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
  X,
  Copy,
  Link2,
  Gamepad2,
  Play,
  ArrowRightLeft,
  Shuffle,
  MessageSquareText,
} from "lucide-react";
import { usePollRealtime } from "@/modules/polls/use-poll-realtime";
import { KahootQuestionsEditor } from "@/modules/polls/KahootQuestionsEditor";
import { PollQuestionsEditor } from "@/modules/polls/PollQuestionsEditor";
import { optionFillPercent } from "@/modules/polls/poll-results";
import { cn } from "@/shared/lib/utils";
import { softDelete } from "@/modules/trash/soft-delete";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

export const Route = createFileRoute("/app/teacher/polls")({ component: TeacherPolls });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type PollType = "single" | "multiple" | "slot" | "kahoot" | "mixed";
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
  /** Si false, la encuesta es un borrador — solo el docente la ve (la
   *  RLS oculta `is_published=false` a los alumnos). Cuando se cambia a
   *  true, el trigger de publicación dispara la notif + correo al curso. */
  is_published: boolean;
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

/** Forma mínima de una pregunta Kahoot del poll origen al duplicar
 *  (kahoot_questions + sus kahoot_question_options embebidas). */
interface KahootSrcQuestion {
  id: string;
  text: string;
  time_limit_seconds: number;
  points: number;
  multi_select: boolean;
  position: number;
  options?: Array<{ label: string; is_correct: boolean; position: number }>;
}

const pollTypeLabel = (type: PollType): string =>
  ({
    single: i18n.t("teacherPolls.typeSingle"),
    multiple: i18n.t("teacherPolls.typeMultiple"),
    slot: i18n.t("teacherPolls.typeSlot"),
    kahoot: i18n.t("teacherPolls.typeKahoot"),
    mixed: i18n.t("teacherPolls.typeMixed", { defaultValue: "Mixta (preguntas)" }),
  })[type];

const POLL_TYPE_ICONS: Record<PollType, typeof ListChecks> = {
  single: ListChecks,
  multiple: CheckSquare,
  slot: CalendarRange,
  kahoot: Gamepad2,
  mixed: MessageSquareText,
};

const visLabel = (vis: ResultsVis): string =>
  ({
    always: i18n.t("teacherPolls.visAlways"),
    after_close: i18n.t("teacherPolls.visAfterClose"),
    never: i18n.t("teacherPolls.visNever"),
  })[vis];

function pollIsOpen(p: Poll): boolean {
  if (p.closed_manually) return false;
  const now = Date.now();
  const opens = new Date(p.opens_at).getTime();
  if (opens > now) return false;
  if (p.closes_at && new Date(p.closes_at).getTime() <= now) return false;
  return true;
}

function TeacherPolls() {
  const { t } = useTranslation();
  const { user, roles } = useAuth();
  const activeRole = useActiveRole();
  // SuperAdmin actuando como SA (no enmascarado como otro rol) NO tiene
  // entradas en `course_teachers` — su UID es el suyo, no el de un
  // docente del tenant. Si filtráramos cursos por `course_teachers
  // .eq(user_id)` para él, vería 0 cursos y "Nueva encuesta" quedaría
  // disabled. Para SA traemos todos los cursos visibles vía RLS
  // (cross-tenant si está en modo puro, del tenant si tiene override).
  const isSuperAdminCaller = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");
  const confirm = useConfirm();
  const [polls, setPolls] = useState<Poll[]>([]);
  const [courses, setCourses] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [courseFilter, setCourseFilter] = useState<string>("all");
  // SuperAdmin cross-tenant: filtro por institución que acota la query
  // de cursos al tenant elegido. Si NO está activo o está en "all", la
  // RLS deja al SuperAdmin ver cross-tenant. Mismo patrón que en
  // /app/teacher/contents y /app/admin/courses.
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  // Dialog state — crear / editar.
  const [dialogOpen, setDialogOpen] = useState(false);
  // editPoll != null → el dialog opera en modo edición (hidrata desde
  // la fila, hace UPDATE + sync de poll_courses, y deja las opciones
  // como read-only para no romper poll_responses ya emitidos).
  const [editPoll, setEditPoll] = useState<Poll | null>(null);
  // Detalle de resultados.
  const [viewPoll, setViewPoll] = useState<Poll | null>(null);
  // Encuesta a duplicar — abre el DuplicatePollDialog parametrizable.
  const [duplicateFor, setDuplicateFor] = useState<Poll | null>(null);
  // Kahoot: encuesta cuyas preguntas se están editando (abre el editor).
  const [questionsFor, setQuestionsFor] = useState<Poll | null>(null);
  // Mixta: encuesta cuyas preguntas (abiertas/cerradas) se están editando.
  const [mixedQuestionsFor, setMixedQuestionsFor] = useState<{ id: string; title: string } | null>(
    null,
  );
  const [hosting, setHosting] = useState<string | null>(null);
  const navigate = useNavigate();

  // Crea un juego en vivo para el Kahoot y navega a la vista host.
  const hostKahoot = async (p: Poll) => {
    setHosting(p.id);
    try {
      const { data, error } = await db.rpc("kahoot_create_game", { _poll_id: p.id });
      if (error || !data?.id) {
        toast.error(friendlyError(error, i18n.t("kahoot.hostError", { defaultValue: "No se pudo iniciar el juego" })));
        return;
      }
      navigate({ to: "/app/teacher/kahoot/$gameId", params: { gameId: data.id } });
    } finally {
      setHosting(null);
    }
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      // Cursos disponibles para el filtro y el create dialog.
      // Docente: cursos donde es teacher (course_teachers).
      // SuperAdmin: todos los cursos visibles vía RLS (cross-tenant si
      // pure, del tenant si tiene override aplicado por RLS contextual).
      let myCourses: Array<{ id: string; name: string }> = [];
      if (isSuperAdminCaller) {
        // Cuando el SA elige una institución en el filtro, acotamos
        // server-side por tenant_id. "all" deja la RLS cross-tenant
        // (todos los cursos visibles para el SA).
        let courseQuery = db
          .from("courses")
          .select("id, name")
          .is("deleted_at", null)
          .order("name");
        if (tenantFilter !== "all") {
          courseQuery = courseQuery.eq("tenant_id", tenantFilter);
        }
        const { data: courseRows, error: courseErr } = await courseQuery;
        if (cancelled) return;
        if (courseErr) {
          setLoadError(friendlyError(courseErr, t("teacherPolls.errLoadCourses")));
          setLoading(false);
          return;
        }
        myCourses = (courseRows ?? []) as Array<{ id: string; name: string }>;

        // Carga de tenants (paralela en concept, pero acá un await más
        // no agrega latencia perceptible — el listado de tenants es
        // pequeño). Solo SA: cualquier otro rol nunca ve este filtro.
        const { data: tenantRows } = await db
          .from("tenants")
          .select("id, slug, name")
          .is("deleted_at", null)
          .order("name");
        if (cancelled) return;
        setTenants(
          (tenantRows ?? []) as Array<{ id: string; slug: string; name: string }>,
        );
      } else {
        // Embed PostgREST: traemos `deleted_at` del curso embebido y lo
        // descartamos en JS. PostgREST no permite filtrar `deleted_at IS NULL`
        // sobre embeds anidados directamente, así que el filtro va en código.
        // Patrón documentado en CLAUDE.md (regla universal de papelera).
        const { data: courseRows, error: courseErr } = await db
          .from("course_teachers")
          .select("course_id, courses(id, name, deleted_at)")
          .eq("user_id", user.id);
        if (cancelled) return;
        if (courseErr) {
          setLoadError(friendlyError(courseErr, t("teacherPolls.errLoadYourCourses")));
          setLoading(false);
          return;
        }
        myCourses = (courseRows ?? [])
          .map(
            (r: { courses: { id: string; name: string; deleted_at: string | null } | null }) =>
              r.courses,
          )
          .filter(
            (
              c: { id: string; name: string; deleted_at: string | null } | null,
            ): c is { id: string; name: string; deleted_at: string | null } =>
              Boolean(c) && c!.deleted_at === null,
          )
          .map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }));
      }
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
          "id, course_id, attendance_session_id, title, description, poll_type, results_visible_to_students, allow_change_response, auto_close_when_all_responded, is_published, opens_at, closes_at, closed_manually, created_at, options:poll_options(id, poll_id, label, position, max_responses, responses_count), linked_courses:poll_courses(course_id, courses(id, name))",
        )
        .in("id", pollIds)
        // Ocultar encuestas en papelera. El docente puede restaurar
        // desde /app/trash si fue accidental.
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (cancelled) return;
      if (pollErr) {
        setLoadError(friendlyError(pollErr, t("teacherPolls.errLoadPolls")));
        setLoading(false);
        return;
      }
      const courseNameById = new Map(myCourses.map((c) => [c.id, c.name] as const));
      // Para encuestas MIXTAS: las respuestas viven en poll_question_responses
      // (no en poll_options), así que el sum(responses_count) sobre opciones
      // siempre da 0 → la columna "Respuestas" mostraba 0 aunque los alumnos
      // hubieran contestado (bug reportado). Hacemos una query extra para los
      // poll_ids mixtos y contamos USUARIOS ÚNICOS que respondieron al menos
      // una pregunta. Coherente con la semántica de la columna en los otros
      // tipos (single/slot = 1 voto por alumno).
      const mixedIds = ((pollRows ?? []) as Array<{ id: string; poll_type: string }>)
        .filter((r) => r.poll_type === "mixed")
        .map((r) => r.id);
      const mixedRespondersByPoll = new Map<string, Set<string>>();
      if (mixedIds.length > 0) {
        const { data: pqrRows } = await db
          .from("poll_question_responses")
          .select("poll_id, user_id")
          .in("poll_id", mixedIds);
        for (const row of (pqrRows ?? []) as Array<{ poll_id: string; user_id: string }>) {
          let set = mixedRespondersByPoll.get(row.poll_id);
          if (!set) {
            set = new Set<string>();
            mixedRespondersByPoll.set(row.poll_id, set);
          }
          set.add(row.user_id);
        }
      }
      // El embed nested (poll_courses → courses) confunde la inferencia
      // de TS porque el shape de `linked_courses` aquí (Array<{course_id,
      // courses}>) es distinto al final (Array<{id, name}>). Casteamos
      // a `any` localmente para evitar fricción de intersección.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const polls: Poll[] = (pollRows ?? []).map((raw: any) => {
        const options: PollOption[] = ((raw.options ?? []) as PollOption[])
          .slice()
          .sort((a, b) => a.position - b.position);
        const isMixed = raw.poll_type === "mixed";
        const total = isMixed
          ? (mixedRespondersByPoll.get(raw.id as string)?.size ?? 0)
          : options.reduce((acc, o) => acc + o.responses_count, 0);
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
    // tenantFilter: cuando el SA cambia institución, recargamos cursos
    // del nuevo tenant + polls correspondientes. isSuperAdminCaller se
    // computa de roles + activeRole — si cualquiera cambia, también
    // re-ejecutamos para refrescar el set visible. Suprimimos la regla
    // exhaustive-deps porque las funciones del cuerpo (db, friendlyError)
    // son módulos, no closures con state cambiante.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce, tenantFilter, isSuperAdminCaller]);

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

  // Orden por columna (asc/desc al clic en el encabezado), persistido.
  const sort = useTableSort(filteredPolls, {
    columns: {
      title: (p) => p.title,
      course: (p) => p.course_name ?? p.linked_courses?.[0]?.name ?? "",
      type: (p) => pollTypeLabel(p.poll_type) ?? p.poll_type,
      window: (p) => p.opens_at,
      responses: (p) => p.total_responses ?? 0,
      status: (p) => (pollIsOpen(p) ? "abierta" : "cerrada"),
    },
    storageKey: "examlab_sort:teacher_polls",
  });

  // Stats compactas — mismo patrón que proyectos / talleres / exámenes.
  // Estados conceptuales de una encuesta:
  //   - Borradores: is_published=false (solo el docente la ve)
  //   - Activas: publicada y NO cerrada (alumnos pueden votar)
  //   - Cerradas: closed_manually=true O closes_at en el pasado
  //   - Doodle: poll_type='slot' (cupo por opción — flujo distinto)
  const pollStats = useMemo(() => {
    const now = Date.now();
    let draft = 0;
    let active = 0;
    let closed = 0;
    let slot = 0;
    for (const p of polls) {
      if (!p.is_published) {
        draft += 1;
        continue;
      }
      const isClosed =
        p.closed_manually || (p.closes_at != null && new Date(p.closes_at).getTime() < now);
      if (isClosed) closed += 1;
      else active += 1;
      if (p.poll_type === "slot") slot += 1;
    }
    return { draft, active, closed, slot };
  }, [polls]);

  const toggleClose = async (p: Poll) => {
    const willClose = !p.closed_manually;
    if (willClose) {
      const ok = await confirm({
        title: t("teacherPolls.confirmCloseTitle", { title: p.title }),
        description: t("teacherPolls.confirmCloseDescription"),
        confirmLabel: t("teacherPolls.confirmCloseLabel"),
        tone: "warning",
      });
      if (!ok) return;
    }
    const { error } = await db.from("polls").update({ closed_manually: willClose }).eq("id", p.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      willClose
        ? i18n.t("toast.routes_app_teacher_polls.pollClosed", { defaultValue: "Encuesta cerrada" })
        : i18n.t("toast.routes_app_teacher_polls.pollReopened", {
            defaultValue: "Encuesta reabierta",
          }),
    );
    setRetryNonce((n) => n + 1);
  };

  const removePoll = async (p: Poll) => {
    const ok = await confirm({
      title: t("teacherPolls.confirmDeleteTitle", { title: p.title }),
      description: t("teacherPolls.confirmDeleteDescription"),
      confirmLabel: t("teacherPolls.confirmDeleteLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await softDelete("polls", p.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.routes_app_teacher_polls.pollSentToTrash", {
        defaultValue: "Encuesta enviada a papelera",
      }),
    );
    setRetryNonce((n) => n + 1);
  };

  /** Duplica la ESTRUCTURA de una encuesta (config + opcionalmente opciones
   *  y cursos asociados) SIN copiar respuestas. La copia queda como
   *  borrador (is_published=false); no hereda la ventana de cierre ni el
   *  vínculo a la sesión original. Parametrizable vía `opts` desde el
   *  DuplicatePollDialog (qué info interna copiar). */
  const duplicatePoll = async (
    p: Poll,
    opts: {
      copyOptions: boolean;
      copyCourses: boolean;
      copyKahootQuestions: boolean;
      copyQuestions: boolean;
    },
  ) => {
    if (!user) return;
    try {
      const { data: newPoll, error: pErr } = await db
        .from("polls")
        .insert({
          course_id: p.course_id,
          title: `${p.title} (copia)`,
          description: p.description,
          poll_type: p.poll_type,
          results_visible_to_students: p.results_visible_to_students,
          allow_change_response: p.allow_change_response,
          auto_close_when_all_responded: p.auto_close_when_all_responded,
          is_published: false,
          closes_at: null,
          attendance_session_id: null,
          created_by: user.id,
        })
        .select("id")
        .single();
      if (pErr || !newPoll) {
        toast.error(friendlyError(pErr, t("teacherPolls.errDuplicatePoll")));
        return;
      }
      // El trigger AFTER INSERT en polls ya creó el row ancla en
      // poll_courses (curso = p.course_id). Si el docente pidió copiar los
      // cursos asociados, agregamos los demás con upsert ignoreDuplicates
      // (mismo patrón que el create multi-curso). Si NO, la copia queda
      // solo en el curso ancla.
      if (opts.copyCourses) {
        const linkedIds = (p.linked_courses ?? []).map((c) => c.id);
        const courseIds = linkedIds.length > 0 ? linkedIds : [p.course_id];
        const { error: jErr } = await db
          .from("poll_courses")
          .upsert(
            courseIds.map((cid) => ({ poll_id: newPoll.id, course_id: cid })),
            { onConflict: "poll_id,course_id", ignoreDuplicates: true },
          );
        if (jErr) {
          await db.from("polls").delete().eq("id", newPoll.id);
          toast.error(friendlyError(jErr, t("teacherPolls.errLinkCoursesToCopy")));
          return;
        }
      }
      // Opciones: copiamos estructura (label + cupo) solo si el docente lo
      // pidió. responses_count arranca en 0 por default — la copia nace sin
      // votos. Si NO se copian, la copia queda como borrador sin opciones
      // (el docente las define antes de publicar).
      if (opts.copyOptions) {
        const optsPayload = (p.options ?? []).map((o, i) => ({
          poll_id: newPoll.id,
          label: o.label,
          position: i,
          max_responses: o.max_responses,
        }));
        if (optsPayload.length > 0) {
          const { error: oErr } = await db.from("poll_options").insert(optsPayload);
          if (oErr) {
            await db.from("polls").delete().eq("id", newPoll.id);
            toast.error(friendlyError(oErr, t("teacherPolls.errCopyOptions")));
            return;
          }
        }
      }
      // Kahoot: las preguntas NO viven en poll_options sino en kahoot_questions
      // (+ kahoot_question_options). Sin copiarlas, una copia de Kahoot nacía
      // VACÍA (bug). Clonamos pregunta por pregunta preservando posición,
      // tiempo, puntos, multi_select y las opciones con su is_correct. Si algo
      // falla a mitad, borramos el poll nuevo (cascade limpia las preguntas ya
      // insertadas) para no dejar una copia a medias.
      if (p.poll_type === "kahoot" && opts.copyKahootQuestions) {
        const { data: srcQs, error: qLoadErr } = await db
          .from("kahoot_questions")
          .select(
            "id, text, time_limit_seconds, points, multi_select, position, options:kahoot_question_options(label, is_correct, position)",
          )
          .eq("poll_id", p.id)
          .order("position");
        if (qLoadErr) {
          await db.from("polls").delete().eq("id", newPoll.id);
          toast.error(friendlyError(qLoadErr, t("teacherPolls.errReadKahootQuestions")));
          return;
        }
        for (const q of (srcQs ?? []) as KahootSrcQuestion[]) {
          const { data: newQ, error: qInsErr } = await db
            .from("kahoot_questions")
            .insert({
              poll_id: newPoll.id,
              text: q.text,
              time_limit_seconds: q.time_limit_seconds,
              points: q.points,
              multi_select: q.multi_select,
              position: q.position,
            })
            .select("id")
            .single();
          if (qInsErr || !newQ) {
            await db.from("polls").delete().eq("id", newPoll.id);
            toast.error(friendlyError(qInsErr, t("teacherPolls.errCopyKahootQuestions")));
            return;
          }
          const optRows = (q.options ?? []).map((o) => ({
            question_id: newQ.id,
            label: o.label,
            is_correct: o.is_correct,
            position: o.position,
          }));
          if (optRows.length > 0) {
            const { error: oInsErr } = await db.from("kahoot_question_options").insert(optRows);
            if (oInsErr) {
              await db.from("polls").delete().eq("id", newPoll.id);
              toast.error(friendlyError(oInsErr, t("teacherPolls.errCopyKahootOptions")));
              return;
            }
          }
        }
      }
      // Mixta: las preguntas viven en poll_questions (no en poll_options).
      // Las clonamos preservando tipo/texto/opciones/posición SIN respuestas.
      if (p.poll_type === "mixed" && opts.copyQuestions) {
        const { data: srcQs, error: qErr } = await db
          .from("poll_questions")
          .select("type, text, required, max_chars, options, position")
          .eq("poll_id", p.id)
          .order("position");
        if (qErr) {
          await db.from("polls").delete().eq("id", newPoll.id);
          toast.error(
            friendlyError(qErr, t("teacherPolls.errReadKahootQuestions", { defaultValue: "No se pudieron leer las preguntas" })),
          );
          return;
        }
        const rows = ((srcQs ?? []) as Array<{
          type: string;
          text: string;
          required: boolean;
          max_chars: number | null;
          options: unknown;
          position: number;
        }>).map((q, i) => ({
          poll_id: newPoll.id,
          type: q.type,
          text: q.text,
          required: q.required,
          max_chars: q.max_chars,
          options: q.options,
          position: q.position ?? i,
        }));
        if (rows.length > 0) {
          const { error: insErr } = await db.from("poll_questions").insert(rows);
          if (insErr) {
            await db.from("polls").delete().eq("id", newPoll.id);
            toast.error(
              friendlyError(insErr, t("teacherPolls.errCopyKahootQuestions", { defaultValue: "No se pudieron copiar las preguntas" })),
            );
            return;
          }
        }
      }
      toast.success(
        i18n.t("toast.routes_app_teacher_polls.pollDuplicated", {
          defaultValue: 'Encuesta duplicada como borrador: "{{title}} (copia)"',
          title: p.title,
        }),
      );
      setRetryNonce((n) => n + 1);
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  /** Copia al portapapeles un enlace único a la encuesta para enviarlo a
   *  los estudiantes por otro medio (correo, WhatsApp). El enlace lleva al
   *  alumno (autenticado + matriculado) directo a la encuesta en su vista;
   *  la RLS sigue aplicando, así que NO expone la encuesta a terceros. */
  const sharePoll = async (p: Poll) => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const url = `${origin}/app/student/polls?poll=${p.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(
        i18n.t("toast.routes_app_teacher_polls.shareLinkCopied", {
          defaultValue:
            "Enlace copiado. Compártelo con tus estudiantes (deben iniciar sesión y estar matriculados).",
        }),
      );
    } catch {
      // Algunos navegadores bloquean clipboard sin gesto/https — mostramos
      // el enlace en un toast largo para copiar a mano.
      toast.info(url, { duration: 15000 });
    }
    if (!p.is_published) {
      toast.warning(
        i18n.t("toast.routes_app_teacher_polls.shareLinkDraft", {
          defaultValue:
            "Ojo: esta encuesta es un borrador. Publícala para que los estudiantes puedan verla con el enlace.",
        }),
      );
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("teacherPolls.pageTitle")}
        subtitle={t("teacherPolls.pageSubtitle")}
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
              {t("teacherPolls.refresh")}
            </Button>
            <Button
              size="sm"
              onClick={() => setDialogOpen(true)}
              disabled={courses.length === 0}
              data-tour-id="create-poll"
            >
              <Plus className="h-4 w-4 mr-1" />
              {t("teacherPolls.newPoll")}
            </Button>
          </div>
        }
      />

      {/* Stats 4-card — patrón compartido (StatCard) con el resto de los
          módulos. Antes usábamos StatTile compact, pero rompía la
          consistencia visual: Cursos / Exámenes / Talleres / Proyectos /
          Pizarras / Contenidos usan el patrón Card con icono+label+value.
          Aparece SIEMPRE (no gateado por polls.length > 0) — un dashboard
          vacío con 0s es informativo, ocultarlo le dice al docente
          "tu rol no tiene este módulo". */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Pencil}
          label={t("teacherPolls.statDrafts")}
          value={pollStats.draft}
          tone={pollStats.draft > 0 ? "warning" : "default"}
        />
        <StatCard
          icon={Radio}
          label={t("teacherPolls.statActive")}
          value={pollStats.active}
          tone={pollStats.active > 0 ? "success" : "default"}
        />
        <StatCard icon={Lock} label={t("teacherPolls.statClosed")} value={pollStats.closed} />
        <StatCard icon={CalendarRange} label={t("teacherPolls.statDoodle")} value={pollStats.slot} />
      </div>

      {(courses.length > 1 || (isSuperAdminCaller && tenants.length > 0)) && (
        <div className="flex flex-wrap items-center gap-2">
          {courses.length > 1 && (
            <Select value={courseFilter} onValueChange={setCourseFilter}>
              <SelectTrigger className="w-full sm:w-64 h-9 text-xs">
                <SelectValue placeholder={t("teacherPolls.filterByCourse")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("teacherPolls.allCourses")}</SelectItem>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {/* SuperAdmin cross-tenant: filtro por institución. Solo se
              renderiza cuando el usuario actúa como SuperAdmin Y hay
              tenants cargados. El filtro acota la query de cursos
              server-side (`.eq("tenant_id", X)`); al cambiar dispara
              el re-load via useEffect deps. */}
          {isSuperAdminCaller && tenants.length > 0 && (
            <Select value={tenantFilter} onValueChange={setTenantFilter}>
              <SelectTrigger className="w-full sm:w-56 h-9 text-xs">
                <SelectValue placeholder={t("teacherPolls.institution")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("teacherPolls.allInstitutions")}</SelectItem>
                {tenants.map((tn) => (
                  <SelectItem key={tn.id} value={tn.id}>
                    {tn.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {loading ? (
        <div className="p-4 sm:p-8 flex items-center justify-center text-sm text-muted-foreground">
          <Spinner size="sm" className="mr-2" /> {t("common.loading")}
        </div>
      ) : loadError ? (
        <ErrorState
          message={t("teacherPolls.loadErrorTitle")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      ) : (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            <Table fixed resizable>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="title" sort={sort} className="min-w-36 sm:min-w-48">
                    {t("teacherPolls.colPoll")}
                  </SortableHead>
                  <SortableHead sortKey="course" sort={sort} className="hidden md:table-cell w-40">
                    {t("teacherPolls.colCourse")}
                  </SortableHead>
                  <SortableHead sortKey="type" sort={sort} className="w-32">
                    {t("teacherPolls.colType")}
                  </SortableHead>
                  <SortableHead sortKey="window" sort={sort} className="hidden lg:table-cell w-36">
                    {t("teacherPolls.colWindow")}
                  </SortableHead>
                  <SortableHead sortKey="responses" sort={sort} className="w-24 text-right">
                    {t("teacherPolls.colResponses")}
                  </SortableHead>
                  <SortableHead sortKey="status" sort={sort} className="w-28">
                    {t("teacherPolls.colStatus")}
                  </SortableHead>
                  <TableHead className="w-32 text-right">{t("teacherPolls.colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sort.sorted.length === 0 ? (
                  <TableEmpty
                    colSpan={7}
                    icon={ListChecks}
                    title={t("teacherPolls.emptyTitle")}
                    description={
                      courses.length === 0
                        ? t("teacherPolls.emptyNoCourses")
                        : t("teacherPolls.emptyCreateFirst")
                    }
                  />
                ) : (
                  sort.sorted.map((p) => {
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
                                  {t("teacherPolls.plusMore", { count: lc.length - 1 })}
                                </span>
                              </div>
                            );
                          })()}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-1">
                            <Badge variant="outline" className="text-[10px]">
                              <Icon className="h-3 w-3 mr-1" />
                              {pollTypeLabel(p.poll_type)}
                            </Badge>
                            {!p.is_published && (
                              <Badge variant="secondary" className="text-[10px]">
                                {t("teacherPolls.badgeDraft")}
                              </Badge>
                            )}
                          </div>
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
                            {open ? t("teacherPolls.statusOpen") : t("teacherPolls.statusClosed")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            actions={
                              p.poll_type === "kahoot"
                                ? [
                                    {
                                      label: i18n.t("kahoot.menuQuestions", { defaultValue: "Preguntas" }),
                                      icon: ListChecks,
                                      onClick: () => setQuestionsFor(p),
                                    },
                                    {
                                      label: i18n.t("kahoot.menuHost", { defaultValue: "Hospedar en vivo" }),
                                      icon: Play,
                                      iconColor: "#26890c",
                                      disabled: hosting === p.id,
                                      onClick: () => void hostKahoot(p),
                                    },
                                    { label: t("common.edit"), icon: Pencil, onClick: () => setEditPoll(p) },
                                    // Re-jugar un Kahoot terminado = Duplicar
                                    // (copia preguntas, nace borrador). El
                                    // DuplicateOptionsDialog ramifica en kahoot
                                    // con copyKahootQuestions.
                                    { label: t("common.duplicate"), icon: Copy, onClick: () => setDuplicateFor(p) },
                                    {
                                      label: t("common.delete"),
                                      icon: Trash2,
                                      tone: "destructive",
                                      separatorBefore: true,
                                      onClick: () => void removePoll(p),
                                    },
                                  ]
                                : [
                                    { label: t("teacherPolls.actionViewResults"), icon: Eye, onClick: () => setViewPoll(p) },
                                    // Encuestas mixtas: editar sus preguntas
                                    // (abiertas/cerradas). nullish → filtrado.
                                    p.poll_type === "mixed" && {
                                      label: i18n.t("teacherPolls.menuQuestions", {
                                        defaultValue: "Preguntas",
                                      }),
                                      icon: MessageSquareText,
                                      onClick: () => setMixedQuestionsFor({ id: p.id, title: p.title }),
                                    },
                                    {
                                      label: t("teacherPolls.actionShareLink"),
                                      icon: Link2,
                                      onClick: () => void sharePoll(p),
                                    },
                                    { label: t("common.edit"), icon: Pencil, onClick: () => setEditPoll(p) },
                                    { label: t("common.duplicate"), icon: Copy, onClick: () => setDuplicateFor(p) },
                                    {
                                      label: p.closed_manually ? t("teacherPolls.actionReopen") : t("teacherPolls.actionClose"),
                                      icon: p.closed_manually ? Unlock : Lock,
                                      onClick: () => void toggleClose(p),
                                    },
                                    {
                                      label: t("common.delete"),
                                      icon: Trash2,
                                      tone: "destructive",
                                      separatorBefore: true,
                                      onClick: () => void removePoll(p),
                                    },
                                  ]
                            }
                          />
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
        onCreated={(created) => {
          setEditPoll(null);
          setRetryNonce((n) => n + 1);
          // Recién creada una encuesta mixta → abrir el editor de preguntas
          // (sin preguntas no se puede publicar; el trigger DB lo bloquea).
          if (created?.poll_type === "mixed") {
            setMixedQuestionsFor({ id: created.id, title: created.title });
          }
        }}
      />
      <ResultsDialog poll={viewPoll} onOpenChange={(open) => !open && setViewPoll(null)} />
      <DuplicateOptionsDialog
        open={duplicateFor !== null}
        onOpenChange={(open) => !open && setDuplicateFor(null)}
        title={t("teacherPolls.duplicateDialogTitle")}
        description={
          <>
            {t("teacherPolls.duplicateDialogDescriptionBefore")}{" "}
            <strong>{t("teacherPolls.duplicateDialogDescriptionDraft")}</strong>
            {t("teacherPolls.duplicateDialogDescriptionAfter")}
          </>
        }
        options={
          duplicateFor?.poll_type === "kahoot"
            ? [
                {
                  // Kahoot guarda sus preguntas en kahoot_questions, no en
                  // poll_options — por eso el toggle es "preguntas", no "opciones".
                  param: "copyKahootQuestions",
                  label: t("teacherPolls.dupCopyKahootQuestionsLabel"),
                  hint: t("teacherPolls.dupCopyKahootQuestionsHint"),
                },
                {
                  param: "copyCourses",
                  label:
                    (duplicateFor?.linked_courses?.length ?? 0) > 1
                      ? t("teacherPolls.dupCopyCoursesLabelCount", {
                          count: duplicateFor?.linked_courses?.length,
                        })
                      : t("teacherPolls.dupCopyCoursesLabel"),
                  hint: t("teacherPolls.dupCopyCoursesHint"),
                },
              ]
            : duplicateFor?.poll_type === "mixed"
            ? [
                {
                  // Mixta: las preguntas viven en poll_questions.
                  param: "copyQuestions",
                  label: t("teacherPolls.dupCopyQuestionsLabel", {
                    defaultValue: "Copiar preguntas",
                  }),
                  hint: t("teacherPolls.dupCopyQuestionsHint", {
                    defaultValue: "Copia las preguntas abiertas/cerradas (sin las respuestas).",
                  }),
                },
                {
                  param: "copyCourses",
                  label:
                    (duplicateFor?.linked_courses?.length ?? 0) > 1
                      ? t("teacherPolls.dupCopyCoursesLabelCount", {
                          count: duplicateFor?.linked_courses?.length,
                        })
                      : t("teacherPolls.dupCopyCoursesLabel"),
                  hint: t("teacherPolls.dupCopyCoursesHint"),
                },
              ]
            : [
                {
                  param: "copyOptions",
                  label:
                    (duplicateFor?.options?.length ?? 0) > 0
                      ? t("teacherPolls.dupCopyOptionsLabelCount", {
                          count: duplicateFor?.options?.length,
                        })
                      : t("teacherPolls.dupCopyOptionsLabel"),
                  hint: t("teacherPolls.dupCopyOptionsHint"),
                },
                {
                  param: "copyCourses",
                  label:
                    (duplicateFor?.linked_courses?.length ?? 0) > 1
                      ? t("teacherPolls.dupCopyCoursesLabelCount", {
                          count: duplicateFor?.linked_courses?.length,
                        })
                      : t("teacherPolls.dupCopyCoursesLabel"),
                  hint: t("teacherPolls.dupCopyCoursesHint"),
                },
              ]
        }
        onConfirm={async (flags) => {
          if (duplicateFor)
            await duplicatePoll(duplicateFor, {
              copyOptions: flags.copyOptions !== false,
              copyCourses: flags.copyCourses !== false,
              copyKahootQuestions: flags.copyKahootQuestions !== false,
              copyQuestions: flags.copyQuestions !== false,
            });
        }}
      />
      <KahootQuestionsEditor
        poll={questionsFor ? { id: questionsFor.id, title: questionsFor.title } : null}
        onOpenChange={(open) => !open && setQuestionsFor(null)}
      />
      <PollQuestionsEditor
        poll={mixedQuestionsFor}
        onOpenChange={(open) => !open && setMixedQuestionsFor(null)}
        onSaved={() => setRetryNonce((n) => n + 1)}
      />
    </div>
  );
}

// ── Create dialog ──────────────────────────────────────────────────

interface DraftOption {
  // `id` presente SOLO para opciones/slots que ya existen en DB (modo edit).
  // Permite el sync por diff vote-safe de los slots (actualizar/insertar/
  // borrar-solo-sin-reservas) sin romper poll_responses. Los slots nuevos
  // (generados o agregados a mano) nacen sin id → se insertan.
  id?: string;
  label: string;
  max_responses: string; // string en form, convertimos a number en save
  // Reservas ya hechas en este slot (modo edit). Bloquea su eliminación.
  responses_count?: number;
}

function CreatePollDialog({
  open,
  onOpenChange,
  courses,
  userId,
  onCreated,
  editingPoll,
  prefilledSessionId,
  prefilledCourseId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  courses: Array<{ id: string; name: string }>;
  userId: string | null;
  /** Se llama tras crear/editar. En CREATE recibe la fila nueva para que el
   *  padre pueda, p.ej., abrir el editor de preguntas de una encuesta mixta. */
  onCreated: (created?: { id: string; title: string; poll_type: PollType }) => void;
  /** Si está presente, el dialog opera en modo edición: hidrata todos
   *  los campos desde la fila, hace UPDATE en lugar de INSERT y
   *  sincroniza poll_courses (diff add/remove). Las OPCIONES quedan
   *  read-only — cambiarlas rompería los votos ya emitidos
   *  (poll_responses.option_id), así que para reescribirlas hay que
   *  eliminar y recrear la encuesta. */
  editingPoll?: Poll | null;
  /** Cuando se abre desde la vista de una sesión específica
   *  (`/app/teacher/attendance` → "Crear encuesta para esta sesión"),
   *  el padre pre-selecciona la sesión + curso. Modo create únicamente
   *  — en edit se hidrata de `editingPoll.attendance_session_id`. */
  prefilledSessionId?: string | null;
  prefilledCourseId?: string | null;
}) {
  const { t } = useTranslation();
  const isEdit = editingPoll != null;
  // Las opciones se bloquean SOLO si ya hay votos emitidos — cambiarlas
  // rompería poll_responses. Si nadie votó todavía, el docente puede
  // editar las opciones/slots libremente (incluso en modo edit).
  const hasVotes = (editingPoll?.options ?? []).some(
    (o) => ((o as { responses_count?: number }).responses_count ?? 0) > 0,
  );
  // Composer de slot manual (modo cupo): fecha + hora + cupo para agregar
  // un slot que faltó en la generación masiva.
  const [manualSlotDate, setManualSlotDate] = useState("");
  const [manualSlotTime, setManualSlotTime] = useState("09:00");
  const [manualSlotCupo, setManualSlotCupo] = useState("1");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  // Multi-curso (migración 20260603010000): la encuesta puede aplicar a
  // N cursos. Internamente seguimos pasando `polls.course_id` = primer
  // curso seleccionado (curso ancla) por compat de queries antiguas;
  // los demás se persisten en la junction `poll_courses`.
  const [courseIds, setCourseIds] = useState<string[]>([]);
  const [type, setType] = useState<PollType>("single");
  // Las encuestas de CUPO (slot) quedan SIEMPRE editables, incluso con
  // reservas: su sync usa un diff vote-safe (actualiza/inserta/borra-solo-
  // sin-reservas) que preserva poll_responses. Caso de uso: reabrir un cupo
  // que no se llenó y agregar/quitar fechas para los estudiantes que faltan.
  // single/multiple SÍ se bloquean con votos (su sync es delete-all +
  // reinsert, que rompería las respuestas existentes).
  const optionsLocked = isEdit && hasVotes && type !== "slot";
  const [visibility, setVisibility] = useState<ResultsVis>("after_close");
  const [closesAt, setClosesAt] = useState(""); // datetime-local
  // Parámetros nuevos (migración 20260603000000):
  //  - allowChange: si false, el alumno no puede cambiar su voto.
  //  - autoCloseAll: si true, la encuesta cierra sola cuando todos los
  //    matriculados del curso ya respondieron.
  const [allowChange, setAllowChange] = useState(true);
  const [autoCloseAll, setAutoCloseAll] = useState(false);
  // Publicación: si false, la encuesta queda como borrador y solo el
  // docente la ve. Al activarse, los triggers de DB notifican + emailan
  // al curso. Default false para evitar publicar a medio armar.
  const [isPublished, setIsPublished] = useState(false);
  // Sesión asociada (opcional). Cuando se setea, la encuesta aparece
  // destacada en la pantalla de la sesión (asistencia teacher + tarjeta
  // de sesión en student). El selector lista las sesiones del curso ancla.
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [availableSessions, setAvailableSessions] = useState<
    Array<{ id: string; title: string | null; session_date: string }>
  >([]);
  const [options, setOptions] = useState<DraftOption[]>([
    { label: "", max_responses: "" },
    { label: "", max_responses: "" },
  ]);
  const [saving, setSaving] = useState(false);
  // Sincronización de la encuesta de cupo con el calendario del docente
  // (crea/actualiza un evento por estudiante). Solo aplica a tipo 'slot' y
  // requiere que la encuesta YA exista (necesita pollId) → habilitado en edit.
  const [syncingCalendar, setSyncingCalendar] = useState(false);

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

  // ─── Generador de slots de tiempo (V2) ───────────────────────────
  // Modelo (refactor 2026-06): el docente agrega MÚLTIPLES FECHAS
  // manualmente + define UNA ventana horaria + paso + cupo. La
  // generación produce `fechas × slots-por-día`.
  //
  // V1 tenía dos DateTimePickers (Inicio + Fin) que cruzaba días
  // continuamente — confuso: si querías "9-12 lun, mar, mié" había
  // que poner inicio=lun 9:00 y fin=mié 12:00, lo cual generaba
  // también slots de lun 12:00 a lun 18:00 cruzando la noche. V2
  // separa el concepto: las fechas son los días disponibles y la
  // ventana horaria aplica DENTRO de cada día.
  //
  // La lógica de generación + suggestSlotCupo vive en `slot-generation.ts`
  // como funciones puras testeables sin React.
  const [slotDates, setSlotDates] = useState<string[]>([]); // YYYY-MM-DD[]
  const [slotDraftDate, setSlotDraftDate] = useState<string>(""); // input temporal del DatePicker para agregar
  const [slotTimeStart, setSlotTimeStart] = useState<string>("09:00");
  const [slotTimeEnd, setSlotTimeEnd] = useState<string>("12:00");
  const [slotStepMin, setSlotStepMin] = useState<string>("15");
  const [slotCupo, setSlotCupo] = useState<string>("1");
  // Modo del cupo: "auto" recalcula con cada cambio de fechas/horas/step
  // para que TODOS los matriculados quepan. "manual" respeta lo que el
  // docente tipeó (se setea en true cuando el user edita el input cupo).
  // V1 sobrescribía ciegamente el cupo en cada cambio incluso cuando el
  // docente ya lo había ajustado a un valor específico — UX confusa.
  const [cupoManual, setCupoManual] = useState<boolean>(false);

  const addSlotDate = () => {
    if (!slotDraftDate) return;
    setSlotDates((prev) => (prev.includes(slotDraftDate) ? prev : [...prev, slotDraftDate].sort()));
    setSlotDraftDate("");
  };
  const removeSlotDate = (d: string) => {
    setSlotDates((prev) => prev.filter((x) => x !== d));
  };

  // Auto-cálculo del cupo: ceil(matriculados / total_slots) para que
  // TODOS los matriculados quepan. Recalcula al cambiar fechas / ventana
  // / step. SOLO aplica cuando cupoManual=false; si el docente tipeó un
  // valor propio, respetamos su decisión hasta que clickee "Volver a auto".
  useEffect(() => {
    if (type !== "slot") return;
    if (slotDates.length === 0) return;
    if (cupoManual) return;
    const step = Math.floor(Number(slotStepMin) || 0);
    const suggested = suggestSlotCupo(
      slotDates,
      slotTimeStart,
      slotTimeEnd,
      step,
      enrolledCount ?? 0,
    );
    setSlotCupo(String(suggested));
  }, [type, enrolledCount, slotDates, slotTimeStart, slotTimeEnd, slotStepMin, cupoManual]);

  // ── Resumen del cálculo de slots ──
  // Memoizado: cambia cuando cambian las dimensiones. Lo usa el panel
  // "Resumen" debajo de los inputs para que el docente vea en vivo
  // cuántos slots producirá la config actual + qué capacidad total dará
  // ese cupo. Sin ejecutar la generación completa (cara con muchas fechas).
  const slotSummary = useMemo(() => {
    const step = Math.floor(Number(slotStepMin) || 0);
    const cupo = Math.max(1, Math.floor(Number(slotCupo) || 0));
    const [sh, sm] = slotTimeStart.split(":").map(Number);
    const [eh, em] = slotTimeEnd.split(":").map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    const validWindow =
      Number.isFinite(startMin) && Number.isFinite(endMin) && endMin > startMin && step > 0;
    const slotsPerDay = validWindow ? Math.floor((endMin - startMin) / step) : 0;
    const days = slotDates.length;
    const totalSlots = days * slotsPerDay;
    const totalCapacity = totalSlots * cupo;
    return {
      slotsPerDay,
      days,
      totalSlots,
      totalCapacity,
      cupo,
      validWindow,
      enough: enrolledCount == null || totalCapacity >= enrolledCount,
    };
  }, [slotDates.length, slotTimeStart, slotTimeEnd, slotStepMin, slotCupo, enrolledCount]);

  const generateSlots = () => {
    if (slotDates.length === 0) {
      toast.error(
        i18n.t("toast.routes_app_teacher_polls.addAtLeastOneDate", {
          defaultValue: "Agregá al menos una fecha",
        }),
      );
      return;
    }
    const step = Math.max(1, Math.floor(Number(slotStepMin) || 0));
    const cupo = Math.max(1, Math.floor(Number(slotCupo) || 0));
    if (!step || !cupo) {
      toast.error(
        i18n.t("toast.routes_app_teacher_polls.stepAndCupoMustBePositive", {
          defaultValue: "Periodicidad y cupo deben ser enteros mayores que 0",
        }),
      );
      return;
    }
    if (!slotTimeStart || !slotTimeEnd) {
      toast.error(
        i18n.t("toast.routes_app_teacher_polls.defineTimeWindow", {
          defaultValue: "Definí la ventana horaria (inicio y fin)",
        }),
      );
      return;
    }
    const generated = generateSlotsForDates({
      dates: slotDates,
      timeStart: slotTimeStart,
      timeEnd: slotTimeEnd,
      stepMin: step,
      cupo,
    });
    if (generated.length === 0) {
      toast.error(
        i18n.t("toast.routes_app_teacher_polls.configProducesNoSlots", {
          defaultValue:
            "La configuración no produce ningún slot — revisá la ventana horaria y la periodicidad",
        }),
      );
      return;
    }
    // Si las opciones iniciales están todas vacías, REEMPLAZAMOS; si el
    // docente ya escribió algo, AÑADIMOS al final para no destruir su trabajo.
    setOptions((prev) => {
      const allEmpty = prev.every((o) => !o.label.trim());
      return allEmpty ? generated : [...prev, ...generated];
    });
    const generatedDates = slotDates.length;
    toast.success(
      i18n.t("toast.routes_app_teacher_polls.slotsGenerated", {
        defaultValue:
          "{{count}} slot(s) generados de {{dates}} fecha{{plural}}. Esas fechas se quitaron de la lista — agregá más y volvé a generar si necesitás.",
        count: generated.length,
        dates: generatedDates,
        plural: generatedDates === 1 ? "" : "s",
      }),
    );
    // CONSUMIMOS las fechas ya generadas: las quitamos de "Fechas
    // disponibles" para que NO se puedan volver a generar (evita slots/
    // fechas duplicados). El flujo queda: agregar fechas → generar (se
    // convierten en slots y desaparecen de la lista) → agregar más →
    // generar de nuevo. El botón "Generar slots" queda deshabilitado
    // hasta que haya fechas nuevas pendientes.
    setSlotDates([]);
  };

  // Carga sesiones del curso ancla (el primer course del set). Se
  // dispara cuando cambia el anchor — al abrir el dialog, al cambiar
  // el set de cursos seleccionados, etc. Las sesiones de OTROS cursos
  // del set NO se listan (modelo: la encuesta se ata a UNA sola sesión,
  // y debe pertenecer al curso ancla — los cursos extra son para
  // ampliar la audiencia, no para multi-sesión).
  const anchorCourseIdLoaded = courseIds[0] ?? null;
  useEffect(() => {
    if (!open || !anchorCourseIdLoaded) {
      setAvailableSessions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await db
          .from("attendance_sessions")
          .select("id, title, session_date")
          .eq("course_id", anchorCourseIdLoaded)
          .is("deleted_at", null)
          .order("session_date", { ascending: false })
          .limit(60);
        if (cancelled) return;
        if (error) {
          // No bloqueamos el dialog — el selector quedará vacío con
          // hint "no hay sesiones". El usuario puede seguir guardando
          // sin asociar sesión.
          setAvailableSessions([]);
          return;
        }
        setAvailableSessions(
          (data ?? []) as Array<{ id: string; title: string | null; session_date: string }>,
        );
        // Si el sessionId actual no pertenece al curso ancla, lo limpiamos.
        // Esto pasa cuando el docente cambia el anchor course después de
        // haber elegido una sesión: la sesión antigua queda inválida.
        if (sessionId && !((data ?? []) as Array<{ id: string }>).some((s) => s.id === sessionId)) {
          setSessionId(null);
        }
      } catch {
        if (cancelled) return;
        setAvailableSessions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // sessionId fuera de deps: solo queremos re-leer las sesiones cuando
    // cambia el anchor course o se abre el dialog; chequeamos sessionId
    // dentro pero no como trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, anchorCourseIdLoaded]);

  // Ref que captura el último `open` para detectar transiciones
  // false → true. Esto evita que el reset se dispare cuando solo
  // cambia `courses` (TOKEN_REFRESHED al volver al tab refetchea
  // cursos y emite un array nuevo) o cuando el padre re-renderiza
  // por cualquier otra razón. Sin esto, alternar a otra pestaña y
  // volver borraba lo que el docente había seleccionado.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;
    if (!justOpened) return; // Solo resetear en la transición false → true.
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
      setIsPublished(editingPoll.is_published);
      setSessionId(editingPoll.attendance_session_id ?? null);
      // Las opciones se muestran read-only en modo edit — las hidratamos
      // para mostrar al docente lo que existe sin modificar.
      setOptions(
        (editingPoll.options ?? []).map((o) => ({
          id: o.id,
          label: o.label,
          max_responses: o.max_responses != null ? String(o.max_responses) : "",
          responses_count: (o as { responses_count?: number }).responses_count ?? 0,
        })),
      );
    } else {
      // Reset al abrir en modo create. Si el padre pasó prefilledCourseId
      // (desde la vista de una sesión), arrancamos con ese curso ancla.
      setTitle("");
      setDescription("");
      const initialCourse =
        prefilledCourseId && courses.some((c) => c.id === prefilledCourseId)
          ? prefilledCourseId
          : (courses[0]?.id ?? null);
      setCourseIds(initialCourse ? [initialCourse] : []);
      setType("single");
      setVisibility("after_close");
      setClosesAt("");
      setAllowChange(true);
      setAutoCloseAll(false);
      setIsPublished(false);
      setSessionId(prefilledSessionId ?? null);
      // Cupo arranca en modo auto en cada apertura — sino la siguiente
      // encuesta heredaba el "manual" de la anterior y el auto-cálculo
      // no disparaba aunque cambiaras fechas.
      setCupoManual(false);
      setOptions([
        { label: "", max_responses: "" },
        { label: "", max_responses: "" },
      ]);
    }
    // `courses` se lee dentro pero se queda fuera del dep array a
    // propósito: solo se necesita su valor inicial al abrir; si el
    // padre refetchea, no debemos resetear el estado del dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingPoll]);

  // Default cupo = "1" cuando type='slot' (típico para sustentaciones
  // individuales). Para otros tipos se ignora el campo.
  const addOption = () =>
    setOptions((opts) => [...opts, { label: "", max_responses: type === "slot" ? "1" : "" }]);
  // Agrega UN slot a mano (fecha + hora) en modo cupo — para el slot que
  // faltó en la generación masiva. Compone el label con el MISMO formato
  // que los slots generados (formatSlotLabel).
  const addManualSlot = () => {
    if (!manualSlotDate || !manualSlotTime) {
      toast.error(
        i18n.t("toast.routes_app_teacher_polls.pickSlotDateTime", {
          defaultValue: "Elegí fecha y hora para el slot",
        }),
      );
      return;
    }
    const label = formatSlotLabel(manualSlotDate, manualSlotTime);
    if (!label) {
      toast.error(
        i18n.t("toast.routes_app_teacher_polls.invalidSlotDateTime", {
          defaultValue: "Fecha u hora inválida",
        }),
      );
      return;
    }
    const cupo = Math.max(1, Math.floor(Number(manualSlotCupo) || 1));
    setOptions((prev) => {
      // Si todas las opciones están vacías (estado inicial), reemplazamos;
      // si ya hay slots, agregamos al final.
      const base = prev.every((o) => !o.label.trim()) ? [] : prev;
      return [...base, { label, max_responses: String(cupo) }];
    });
    setManualSlotDate("");
    toast.success(
      i18n.t("toast.routes_app_teacher_polls.slotAdded", {
        defaultValue: "Slot agregado",
      }),
    );
  };
  const removeOption = (idx: number) =>
    setOptions((opts) => (opts.length > 2 ? opts.filter((_, i) => i !== idx) : opts));
  const updateOption = (idx: number, patch: Partial<DraftOption>) =>
    setOptions((opts) => opts.map((o, i) => (i === idx ? { ...o, ...patch } : o)));

  // Sincroniza la encuesta de cupo con el calendario del docente: invoca la
  // edge `calendar` (acción `sync_poll_to_calendar`) que crea un evento por
  // estudiante matriculado, con el docente como invitado, y los actualiza en
  // re-sincronizaciones (no duplica). Solo tiene sentido para tipo 'slot' y
  // cuando la encuesta ya existe (modo edición → tenemos editingPoll.id).
  const handleSyncPollToCalendar = async () => {
    if (!editingPoll) return;
    setSyncingCalendar(true);
    try {
      const { data, error } = await supabase.functions.invoke("calendar", {
        body: { action: "sync_poll_to_calendar", pollId: editingPoll.id },
      });
      const res = data as
        | { ok?: boolean; created?: number; updated?: number; failed?: number; total?: number }
        | null;
      if (error || res?.ok === false) {
        toast.error(friendlyError(error, t("teacherPolls.errSyncCalendar")));
        return;
      }
      if ((res?.total ?? 0) === 0) {
        toast.warning(t("teacherPolls.syncCalendarNoStudents"));
        return;
      }
      toast.success(
        t("teacherPolls.syncCalendarResult", {
          created: res?.created ?? 0,
          updated: res?.updated ?? 0,
          failed: res?.failed ?? 0,
        }),
      );
    } catch (e) {
      toast.error(friendlyError(e, t("teacherPolls.errSyncCalendar")));
    } finally {
      setSyncingCalendar(false);
    }
  };

  const save = async () => {
    if (!userId) return;
    if (!title.trim()) {
      toast.error(
        i18n.t("toast.routes_app_teacher_polls.titleRequired", {
          defaultValue: "El título es obligatorio",
        }),
      );
      return;
    }
    if (courseIds.length === 0) {
      toast.error(
        i18n.t("toast.routes_app_teacher_polls.chooseAtLeastOneCourse", {
          defaultValue: "Elegí al menos un curso",
        }),
      );
      return;
    }
    // effectiveOptions: para tipo 'slot', si el docente configuró el
    // generador (fechas + ventana horaria) pero NO clickeó "Generar slots",
    // los auto-generamos acá. Sin esto, `options` queda vacío y crear la
    // encuesta fallaba con "faltan 2 opciones" aunque la config era válida.
    // El botón "Generar slots" queda como preview opcional.
    let effectiveOptions = options;
    // Validamos/generamos opciones salvo que estén bloqueadas por votos ya
    // emitidos (optionsLocked). En edit SIN votos el docente puede editar
    // las opciones/slots libremente. El tipo 'kahoot' NO usa poll_options
    // (sus preguntas viven en kahoot_questions, editadas aparte) → se salta
    // toda la validación/manejo de opciones.
    if (!optionsLocked && type !== "kahoot" && type !== "mixed") {
      if (
        type === "slot" &&
        !options.some((o) => o.label.trim()) &&
        slotDates.length > 0
      ) {
        const step = Math.max(1, Math.floor(Number(slotStepMin) || 0));
        const cupo = Math.max(1, Math.floor(Number(slotCupo) || 0));
        const generated = generateSlotsForDates({
          dates: slotDates,
          timeStart: slotTimeStart,
          timeEnd: slotTimeEnd,
          stepMin: step,
          cupo,
        });
        if (generated.length > 0) {
          effectiveOptions = generated;
          setOptions(generated); // reflejar en la UI
        }
      }
      const validOptions = effectiveOptions.filter((o) => o.label.trim());
      if (validOptions.length < 2) {
        toast.error(
          type === "slot"
            ? i18n.t("toast.routes_app_teacher_polls.slotNeedsConfig", {
                defaultValue:
                  "Agregá al menos una fecha y una ventana horaria válida (inicio antes de fin) para generar los slots.",
              })
            : i18n.t("toast.routes_app_teacher_polls.atLeastTwoOptions", {
                defaultValue: "Se necesitan al menos 2 opciones",
              }),
        );
        return;
      }
      if (type === "slot") {
        const bad = validOptions.some((o) => {
          const n = Number(o.max_responses);
          return !Number.isInteger(n) || n <= 0;
        });
        if (bad) {
          toast.error(
            i18n.t("toast.routes_app_teacher_polls.slotOptionNeedsPositiveCupo", {
              defaultValue:
                "En tipo 'cupo por opción' cada opción necesita un cupo entero > 0",
            }),
          );
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
            is_published: isPublished,
            attendance_session_id: sessionId,
            // Reabrir al editar: si el docente fija un cierre futuro (o sin
            // cierre), la encuesta vuelve a quedar abierta. Caso típico de
            // cupo: reabrir el que no se llenó para los que faltan. Con
            // cierre en el pasado, se respeta el estado manual previo.
            closed_manually:
              !closesAt || new Date(closesAt).getTime() > Date.now()
                ? false
                : editingPoll.closed_manually,
          })
          .eq("id", editingPoll.id);
        if (updErr) {
          toast.error(friendlyError(updErr, t("teacherPolls.errUpdatePoll")));
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
            toast.error(friendlyError(addErr, t("teacherPolls.errAddCourses")));
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
            toast.error(friendlyError(delErr, t("teacherPolls.errRemoveCourses")));
            return;
          }
        }
        // Sync de opciones/slots.
        if (type === "slot") {
          // DIFF vote-safe: las encuestas de cupo pueden editarse con reservas
          // ya hechas. Preservamos los slots existentes (referenciados por
          // poll_responses), insertamos los nuevos, actualizamos cupo/etiqueta,
          // y borramos SOLO los que el docente quitó y NO tienen reservas.
          const validOpts = effectiveOptions.filter((o) => o.label.trim());
          const existing = (editingPoll.options ?? []) as Array<{
            id: string;
            label: string;
            responses_count?: number;
          }>;
          const keptIds = new Set(
            validOpts.map((o) => o.id).filter((x): x is string => Boolean(x)),
          );
          const removed = existing.filter((e) => !keptIds.has(e.id));
          const removedWithVotes = removed.filter((e) => (e.responses_count ?? 0) > 0);
          if (removedWithVotes.length > 0) {
            toast.error(
              i18n.t("toast.routes_app_teacher_polls.cannotRemoveSlotWithVotes", {
                defaultValue:
                  "No puedes eliminar fechas con reservas: {{labels}}. Quítale primero la respuesta a esos estudiantes desde «Ver resultados».",
                labels: removedWithVotes.map((r) => r.label).join(", "),
              }),
            );
            return;
          }
          if (removed.length > 0) {
            const { error: delErr } = await db
              .from("poll_options")
              .delete()
              .in(
                "id",
                removed.map((r) => r.id),
              );
            if (delErr) {
              toast.error(friendlyError(delErr, t("teacherPolls.errUpdateOptions")));
              return;
            }
          }
          // Actualizar existentes (label/posición/cupo) e insertar nuevos,
          // respetando el orden de la lista del formulario.
          const toInsert: Array<{
            poll_id: string;
            label: string;
            position: number;
            max_responses: number;
          }> = [];
          for (let i = 0; i < validOpts.length; i++) {
            const o = validOpts[i];
            const cupo = Math.max(1, Math.floor(Number(o.max_responses) || 1));
            if (o.id) {
              const { error: upErr } = await db
                .from("poll_options")
                .update({ label: o.label.trim(), position: i, max_responses: cupo })
                .eq("id", o.id);
              if (upErr) {
                toast.error(friendlyError(upErr, t("teacherPolls.errUpdateOptions")));
                return;
              }
            } else {
              toInsert.push({
                poll_id: editingPoll.id,
                label: o.label.trim(),
                position: i,
                max_responses: cupo,
              });
            }
          }
          if (toInsert.length > 0) {
            const { error: insErr } = await db.from("poll_options").insert(toInsert);
            if (insErr) {
              toast.error(friendlyError(insErr, t("teacherPolls.errUpdateOptions")));
              return;
            }
          }
        } else if (!optionsLocked && type !== "kahoot" && type !== "mixed") {
          // single/multiple SIN votos: seguro borrar + reinsertar porque
          // ningún poll_response referencia las opciones todavía. Con votos,
          // optionsLocked=true y este bloque se salta (quedan intactas).
          // kahoot/mixed NO usan poll_options (sus preguntas viven en tablas
          // hijas) → se saltan.
          const validOpts = effectiveOptions.filter((o) => o.label.trim());
          const { error: delOptErr } = await db
            .from("poll_options")
            .delete()
            .eq("poll_id", editingPoll.id);
          if (delOptErr) {
            toast.error(friendlyError(delOptErr, t("teacherPolls.errUpdateOptions")));
            return;
          }
          const optsPayload = validOpts.map((o, i) => ({
            poll_id: editingPoll.id,
            label: o.label.trim(),
            position: i,
            max_responses: null,
          }));
          if (optsPayload.length > 0) {
            const { error: insOptErr } = await db.from("poll_options").insert(optsPayload);
            if (insOptErr) {
              toast.error(friendlyError(insOptErr, t("teacherPolls.errUpdateOptions")));
              return;
            }
          }
        }
        toast.success(
          i18n.t("toast.routes_app_teacher_polls.pollUpdated", {
            defaultValue: "Encuesta actualizada",
          }),
        );
        onOpenChange(false);
        onCreated();
        return;
      }

      // ── MODO CREATE (original) ──
      // Usamos effectiveOptions (incluye los slots auto-generados arriba).
      const validOptions = effectiveOptions.filter((o) => o.label.trim());
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
          // Una encuesta mixta NACE en borrador: aún no tiene preguntas (se
          // agregan en el editor que abre tras crear). El trigger DB bloquea
          // publicar mixtas con 0 preguntas; forzar draft evita ese error y
          // deja al docente publicar desde "Editar" cuando ya tenga preguntas.
          is_published: type === "mixed" ? false : isPublished,
          attendance_session_id: sessionId,
          created_by: userId,
        })
        .select("id")
        .single();
      if (pollErr || !pollRow) {
        toast.error(friendlyError(pollErr, t("teacherPolls.errCreatePoll")));
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
        toast.error(friendlyError(jErr, t("teacherPolls.errLinkCourses")));
        return;
      }
      // Kahoot/mixta no usan poll_options (sus preguntas van en
      // kahoot_questions / poll_questions, que el docente agrega con el
      // editor "Preguntas" tras crear).
      if (type !== "kahoot" && type !== "mixed") {
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
          toast.error(friendlyError(optsErr, t("teacherPolls.errCreateOptions")));
          return;
        }
      }
      toast.success(
        courseIds.length === 1
          ? i18n.t("toast.routes_app_teacher_polls.pollCreated", {
              defaultValue: "Encuesta creada",
            })
          : i18n.t("toast.routes_app_teacher_polls.pollCreatedMultiCourse", {
              defaultValue: "Encuesta creada ({{count}} cursos)",
              count: courseIds.length,
            }),
      );
      onOpenChange(false);
      onCreated({ id: pollRow.id, title: title.trim(), poll_type: type });
    } finally {
      setSaving(false);
    }
  };

  // Guard "cambios sin guardar": agrupa los campos editables del form (no
  // los derivados ni los inputs auxiliares del generador de slots, que se
  // consumen al generar). El hook captura el snapshot tras la hidratación
  // (que corre en la transición open false→true) y pide confirmación al
  // cerrar si algo cambió.
  const formMemo = useMemo(
    () => ({
      title,
      description,
      courseIds,
      type,
      visibility,
      closesAt,
      allowChange,
      autoCloseAll,
      isPublished,
      sessionId,
      options,
    }),
    [
      title,
      description,
      courseIds,
      type,
      visibility,
      closesAt,
      allowChange,
      autoCloseAll,
      isPublished,
      sessionId,
      options,
    ],
  );
  const dirty = useDirtyDialog(open, formMemo);

  return (
    <Dialog open={open} onOpenChange={dirty.guardOpenChange(onOpenChange)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg" data-tour-id="dialog-poll">
        <DialogHeader>
          <DialogTitle>{isEdit ? t("teacherPolls.editPoll") : t("teacherPolls.newPoll")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div data-tour-id="poll-field-title">
            <Label required>{t("teacherPolls.fieldTitle")}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("teacherPolls.fieldTitlePlaceholder")}
            />
          </div>
          <div>
            <Label>{t("teacherPolls.fieldDescription")}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={t("teacherPolls.fieldDescriptionPlaceholder")}
            />
          </div>
          {/* Multi-curso: una encuesta puede aplicar a N cursos a la vez.
              El primer curso seleccionado es el "ancla" (polls.course_id)
              y los demás se insertan en poll_courses. Cualquier alumno
              matriculado en CUALQUIERA de los cursos puede votar. */}
          <div data-tour-id="poll-field-courses">
            <div className="flex items-center justify-between mb-1">
              <Label required>
                {t("teacherPolls.fieldCourses")}{" "}
                <HelpHint side="right">{t("help.pollMulticourseHint")}</HelpHint>
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
                  {courseIds.length === courses.length
                    ? t("teacherPolls.clear")
                    : t("teacherPolls.selectAll")}
                </button>
              )}
            </div>
            {courses.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("teacherPolls.noCoursesTaught")}</p>
            ) : (
              <div className="max-h-32 overflow-y-auto rounded-md border divide-y">
                {courses.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 px-3 py-2 hover:bg-muted/40 cursor-pointer text-sm min-w-0"
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
                {t("teacherPolls.coursesSelected", { count: courseIds.length })}
              </p>
            )}
          </div>
          {/* Sesión asociada (opcional). Si se setea, la encuesta aparece
              destacada en la pantalla de asistencia del docente y en el
              card de la sesión para el alumno. Solo lista sesiones del
              curso ancla (primer curso del set). Vacía → encuesta "suelta"
              del curso. */}
          <div>
            <Label className="flex items-center gap-1.5">
              {t("teacherPolls.fieldAssociateSession")}
              <HelpHint side="right">{t("help.pollSessionAssociationHint")}</HelpHint>
            </Label>
            <Select
              value={sessionId ?? "__none__"}
              onValueChange={(v) => setSessionId(v === "__none__" ? null : v)}
              disabled={!anchorCourseIdLoaded}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("teacherPolls.sessionNone")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("teacherPolls.sessionNone")}</SelectItem>
                {availableSessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {formatSessionLabel(s.session_date, s.title)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {anchorCourseIdLoaded && availableSessions.length === 0 && (
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("teacherPolls.noSessionsRegistered")}
              </p>
            )}
          </div>
          <div data-tour-id="poll-field-type">
            <Label required>
              {t("teacherPolls.fieldType")}{" "}
              <HelpHint side="right">
                <div className="space-y-2 text-xs">
                  <p>
                    <strong>{t("teacherPolls.typeSingle")}:</strong>{" "}
                    {t("teacherPolls.typeHintSingle")}
                  </p>
                  <p>
                    <strong>{t("teacherPolls.typeMultiple")}:</strong>{" "}
                    {t("teacherPolls.typeHintMultiple")}
                  </p>
                  <p>
                    <strong>{t("teacherPolls.typeSlotDoodle")}:</strong>{" "}
                    {t("teacherPolls.typeHintSlot")}
                  </p>
                  <p>
                    <strong>
                      {t("teacherPolls.typeMixed", { defaultValue: "Mixta (preguntas)" })}:
                    </strong>{" "}
                    {t("teacherPolls.typeHintMixed", {
                      defaultValue:
                        "Mezcla preguntas abiertas (texto libre) y cerradas (opción única), como un taller. Las respuestas abiertas solo las ve el docente.",
                    })}
                  </p>
                </div>
              </HelpHint>
            </Label>
            <Select
              value={type}
              // No se puede cambiar el tipo de una encuesta mixta/kahoot ya
              // creada: sus preguntas viven en tablas hijas (poll_questions /
              // kahoot_questions) y cambiar de tipo las dejaría huérfanas.
              disabled={isEdit && (editingPoll?.poll_type === "mixed" || editingPoll?.poll_type === "kahoot")}
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
                    <span>{t("teacherPolls.typeSingle")}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("teacherPolls.typeOptionSingleDesc")}
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="multiple">
                  <div className="flex flex-col gap-0.5">
                    <span>{t("teacherPolls.typeMultiple")}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("teacherPolls.typeOptionMultipleDesc")}
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="slot">
                  <div className="flex flex-col gap-0.5">
                    <span>{t("teacherPolls.typeSlotDoodle")}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("teacherPolls.typeOptionSlotDesc")}
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="kahoot">
                  <div className="flex flex-col gap-0.5">
                    <span>{t("teacherPolls.typeKahoot")}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("teacherPolls.typeOptionKahootDesc")}
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="mixed">
                  <div className="flex flex-col gap-0.5">
                    <span>{t("teacherPolls.typeMixed", { defaultValue: "Mixta (preguntas)" })}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("teacherPolls.typeOptionMixedDesc", {
                        defaultValue: "Preguntas abiertas y/o cerradas, como un taller",
                      })}
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {/* closesAt / visibilidad de resultados / switches de voto NO aplican
              a Kahoot (sesión en vivo con su propio leaderboard y una respuesta
              por pregunta). Render condicional estricto para no mostrar campos
              irrelevantes al flujo de Kahoot. */}
          {type !== "kahoot" && (
          <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label>
                {t("teacherPolls.fieldClosesAt")}{" "}
                <HelpHint side="right">{t("help.pollCloseDatetimeHint")}</HelpHint>
              </Label>
              <DateTimePicker value={closesAt} onChange={setClosesAt} />
              <p className="text-[11px] text-muted-foreground mt-1">
                {t("teacherPolls.closesAtEmptyHint")}
              </p>
              {isEdit && editingPoll && !pollIsOpen(editingPoll) && (
                <div className="mt-2">
                  <ReopenClosedBanner
                    hint="Fija un cierre futuro y guarda para reabrir la encuesta."
                    onReopen={() => {
                      // Plazo futuro por defecto = ahora + 7 días, en el MISMO
                      // formato datetime-local (YYYY-MM-DDTHH:mm, hora local) que
                      // usa la hidratación de `closesAt`. Si el cierre actual ya
                      // es futuro, lo conservamos. Al Guardar, `closed_manually`
                      // pasa a false porque el cierre queda en el futuro.
                      const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
                      const offsetMs = sevenDays.getTimezoneOffset() * 60_000;
                      const localValue = new Date(sevenDays.getTime() - offsetMs)
                        .toISOString()
                        .slice(0, 16);
                      setClosesAt((prev) =>
                        prev && new Date(prev).getTime() > Date.now() ? prev : localValue,
                      );
                    }}
                  />
                </div>
              )}
            </div>
            <div>
              <Label>
                {t("teacherPolls.fieldResultsForStudents")}{" "}
                <HelpHint side="left">
                  <div className="space-y-2 text-xs">
                    <p>
                      <strong>{t("teacherPolls.visHintAlwaysTitle")}:</strong>{" "}
                      {t("teacherPolls.visHintAlwaysBody")}
                    </p>
                    <p>
                      <strong>{t("teacherPolls.visHintAfterCloseTitle")}:</strong>{" "}
                      {t("teacherPolls.visHintAfterCloseBody")}
                    </p>
                    <p>
                      <strong>{t("teacherPolls.visHintNeverTitle")}:</strong>{" "}
                      {t("teacherPolls.visHintNeverBody")}
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
                      <span>{visLabel("always")}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {t("teacherPolls.visDescAlways")}
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="after_close">
                    <div className="flex flex-col gap-0.5">
                      <span>{visLabel("after_close")}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {t("teacherPolls.visDescAfterClose")}
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="never">
                    <div className="flex flex-col gap-0.5">
                      <span>{visLabel("never")}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {t("teacherPolls.visDescNever")}
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
                  <span className="text-sm font-medium">{t("teacherPolls.allowChangeTitle")}</span>
                  <HelpHint>{t("help.pollAllowChangeResponseHint")}</HelpHint>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {allowChange
                    ? t("teacherPolls.allowChangeOn")
                    : t("teacherPolls.allowChangeOff")}
                </p>
              </div>
              <Switch checked={allowChange} onCheckedChange={setAllowChange} />
            </div>

            {/* auto-cierre "cuando todos respondieron": el trigger legacy
                corre sobre poll_responses, que las encuestas mixtas NO usan
                (responden en poll_question_responses) — por eso se oculta. */}
            {type !== "mixed" && (
              <div className="flex items-start justify-between gap-3 pt-1 border-t">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-sm font-medium">{t("teacherPolls.autoCloseTitle")}</span>
                    <HelpHint>{t("help.pollAutoCloseAllRespondedHint")}</HelpHint>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {autoCloseAll
                      ? t("teacherPolls.autoCloseOn")
                      : t("teacherPolls.autoCloseOff")}
                  </p>
                </div>
                <Switch checked={autoCloseAll} onCheckedChange={setAutoCloseAll} />
              </div>
            )}
          </div>
          </>
          )}

          {/* Estado de publicación — control estándar Select para
              alinearse con workshops/exams/projects (que ya usan
              draft/published vía Select). Se sale del bloque de
              Switches de comportamiento (allowChange / autoClose) que
              SÍ son toggles booleanos. Se OCULTA al crear una mixta: nace
              en borrador (no tiene preguntas aún) y se publica desde Editar. */}
          {!(type === "mixed" && !isEdit) && (
          <div>
            <Label>
              {t("teacherPolls.fieldStatus")}{" "}
              <HelpHint>
                <strong>{t("teacherPolls.statusDraftLabel")}</strong>
                {t("teacherPolls.statusDraftHint")}
                <br />
                <br />
                <strong>{t("teacherPolls.statusPublishedLabel")}</strong>
                {t("teacherPolls.statusPublishedHint")}
              </HelpHint>
            </Label>
            <Select
              value={isPublished ? "published" : "draft"}
              onValueChange={(v) => setIsPublished(v === "published")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">
                  <div className="flex flex-col gap-0.5">
                    <span>{t("teacherPolls.statusOptionDraft")}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("teacherPolls.statusOptionDraftDesc")}
                    </span>
                  </div>
                </SelectItem>
                <SelectItem value="published">
                  <div className="flex flex-col gap-0.5">
                    <span>{t("teacherPolls.statusOptionPublished")}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t("teacherPolls.statusOptionPublishedDesc")}
                    </span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          )}

          {type === "kahoot" && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm space-y-1">
              <p className="font-medium flex items-center gap-1.5">
                <Gamepad2 className="h-4 w-4 text-primary" />
                {t("kahoot.createInfoTitle")}
              </p>
              <p className="text-muted-foreground text-xs">{t("kahoot.createInfoBody")}</p>
            </div>
          )}

          {type === "mixed" && (
            <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-sm space-y-1">
              <p className="font-medium flex items-center gap-1.5">
                <MessageSquareText className="h-4 w-4 text-sky-500" />
                {t("teacherPolls.mixedInfoTitle", { defaultValue: "Encuesta con preguntas" })}
              </p>
              <p className="text-muted-foreground text-xs">
                {isEdit
                  ? t("teacherPolls.mixedInfoBodyEdit", {
                      defaultValue:
                        "Usa «Preguntas» en el menú de la encuesta para agregar/editar preguntas abiertas y cerradas.",
                    })
                  : t("teacherPolls.mixedInfoBody", {
                      defaultValue:
                        "Al guardar se abrirá el editor de preguntas para que agregues abiertas (texto) y/o cerradas (opción única). Necesitas al menos una para publicar.",
                    })}
              </p>
            </div>
          )}

          {type !== "kahoot" && type !== "mixed" && (
          <div>
            <Label required>
              {t("teacherPolls.fieldOptions")}{" "}
              <HelpHint side="right">
                <div className="space-y-1 text-xs">
                  <p>{t("teacherPolls.optionsHintGeneral")}</p>
                  {type === "slot" && (
                    <>
                      <p>
                        <strong>{t("teacherPolls.optionsHintCupoLabel")}</strong>{" "}
                        {t("teacherPolls.optionsHintCupoBody")}
                      </p>
                      <p>
                        <strong>{t("teacherPolls.optionsHintDoodleLabel")}</strong>{" "}
                        {t("teacherPolls.optionsHintDoodleBody")}
                        {enrolledCount != null && enrolledCount > 0 && (
                          <>
                            {" "}
                            {courseIds.length > 1
                              ? t("teacherPolls.optionsHintEnrolledMultiCourse", {
                                  count: enrolledCount,
                                })
                              : t("teacherPolls.optionsHintEnrolledSingleCourse", {
                                  count: enrolledCount,
                                })}
                          </>
                        )}
                      </p>
                    </>
                  )}
                </div>
              </HelpHint>
            </Label>
            {optionsLocked && (
              <p className="text-[11px] text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5 mt-1 mb-2">
                {t("teacherPolls.optionsLockedNote")}
              </p>
            )}
            {type === "slot" && isEdit && hasVotes && (
              <p className="text-[11px] text-sky-700 dark:text-sky-400 bg-sky-500/10 border border-sky-500/30 rounded px-2 py-1.5 mt-1 mb-2">
                {t("teacherPolls.slotEditWithVotesNote", {
                  defaultValue:
                    "Puedes agregar nuevas fechas, ampliar el cupo y reabrir la encuesta (fija un cierre futuro). Las fechas que ya tienen reservas no se pueden eliminar.",
                })}
              </p>
            )}
            {type === "slot" && !optionsLocked && (
              <>
                {/* Generador de slots (V2): el docente agrega múltiples
                    fechas manualmente + define UNA ventana horaria
                    compartida + paso + cupo. Genera cross-product
                    fechas × slots-por-día. Más natural que V1 (dos
                    DateTimePickers que cruzaban días continuos). */}
                <div className="rounded-md border bg-muted/20 p-3 space-y-3 mb-3">
                  <div className="flex items-center gap-1">
                    <span className="text-xs font-medium">{t("teacherPolls.generateSlotsTitle")}</span>
                    <HelpHint>{t("teacherPolls.generateSlotsHint")}</HelpHint>
                  </div>

                  {/* Lista de fechas elegidas + DatePicker para agregar */}
                  <div>
                    <Label className="text-[11px]">{t("teacherPolls.availableDates")}</Label>
                    <div className="flex flex-wrap gap-1.5 mt-1.5 mb-2">
                      {slotDates.length === 0 ? (
                        <span className="text-[11px] text-muted-foreground italic">
                          {t("teacherPolls.noDatesYet")}
                        </span>
                      ) : (
                        slotDates.map((d) => (
                          <Badge
                            key={d}
                            variant="secondary"
                            className="text-[11px] gap-1 pl-2 pr-1"
                          >
                            {d}
                            <button
                              type="button"
                              onClick={() => removeSlotDate(d)}
                              className="hover:text-destructive transition-colors rounded p-0.5"
                              aria-label={t("teacherPolls.removeDateAria", { date: d })}
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </Badge>
                        ))
                      )}
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
                      <div className="flex-1 min-w-0">
                        <DatePicker
                          value={slotDraftDate}
                          onChange={setSlotDraftDate}
                          placeholder={t("teacherPolls.selectDatePlaceholder")}
                          className="h-8 text-xs w-full"
                        />
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addSlotDate}
                        disabled={!slotDraftDate}
                        className="h-8 text-xs"
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        {t("teacherPolls.addDate")}
                      </Button>
                    </div>
                  </div>

                  {/* Ventana horaria del día (aplica a cada fecha) */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[11px]">{t("teacherPolls.startTime")}</Label>
                      <Input
                        type="time"
                        value={slotTimeStart}
                        onChange={(e) => setSlotTimeStart(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="text-[11px]">{t("teacherPolls.endTime")}</Label>
                      <Input
                        type="time"
                        value={slotTimeEnd}
                        onChange={(e) => setSlotTimeEnd(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <Label className="text-[11px]">{t("teacherPolls.everyMinutes")}</Label>
                      <Input
                        type="number"
                        min={1}
                        value={slotStepMin}
                        onChange={(e) => setSlotStepMin(e.target.value)}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between gap-1 mb-0.5">
                        <Label className="text-[11px]">{t("teacherPolls.cupoPerSlot")}</Label>
                        {/* Badge auto/manual. En modo auto el cupo se
                            recalcula con cada cambio de fechas/horas/step
                            usando ceil(matriculados / total_slots). Pasa
                            a manual cuando el docente tipea su propio valor;
                            el botón "Auto" abajo del input revierte. */}
                        {cupoManual ? (
                          <Badge variant="outline" className="text-[9px] h-4 px-1">
                            {t("teacherPolls.badgeManual")}
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="text-[9px] h-4 px-1 bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300 border-sky-300/50"
                          >
                            {t("teacherPolls.badgeAuto")}
                          </Badge>
                        )}
                      </div>
                      <Input
                        type="number"
                        min={1}
                        value={slotCupo}
                        onChange={(e) => {
                          setSlotCupo(e.target.value);
                          // Si el docente tipea, pasamos a modo manual
                          // para que el useEffect deje de sobreescribir.
                          if (!cupoManual) setCupoManual(true);
                        }}
                        className="h-8 text-xs"
                      />
                      {cupoManual && (
                        <button
                          type="button"
                          className="text-[10px] text-primary hover:underline mt-0.5"
                          onClick={() => setCupoManual(false)}
                        >
                          {t("teacherPolls.backToAuto")}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Resumen del cálculo. Aparece tan pronto haya al menos
                      una fecha y una ventana válida. Muestra la matemática
                      en vivo + warning si la capacidad total no alcanza
                      para todos los matriculados (ej. el docente bajó el
                      cupo en modo manual a un número que no cubre al
                      grupo). */}
                  {slotDates.length > 0 && slotSummary.validWindow && (
                    <div
                      className={cn(
                        "rounded-md border px-2.5 py-2 text-[11px] space-y-0.5",
                        slotSummary.enough
                          ? "bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-300/50 text-emerald-900 dark:text-emerald-200"
                          : "bg-amber-50/70 dark:bg-amber-950/30 border-amber-400/60 text-amber-900 dark:text-amber-200",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <span className="font-medium">
                          {t("teacherPolls.slotSummaryDates", { count: slotSummary.days })} ×{" "}
                          {t("teacherPolls.slotSummaryPerDay", { count: slotSummary.slotsPerDay })}{" "}
                          ={" "}
                          <span className="tabular-nums">{slotSummary.totalSlots}</span>{" "}
                          {t("teacherPolls.slotSummaryTotalUnit", { count: slotSummary.totalSlots })}
                        </span>
                        <span className="tabular-nums">
                          {t("teacherPolls.totalCapacity")}{" "}
                          <strong>
                            {slotSummary.totalCapacity}
                            {enrolledCount != null && enrolledCount > 0 && <> / {enrolledCount}</>}
                          </strong>
                        </span>
                      </div>
                      {!slotSummary.enough && enrolledCount != null && enrolledCount > 0 && (
                        <p className="text-[10px] opacity-90">
                          {t("teacherPolls.capacityShortfall", {
                            count: enrolledCount - slotSummary.totalCapacity,
                          })}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="space-y-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={generateSlots}
                      disabled={slotDates.length === 0}
                      className="w-full sm:w-auto"
                    >
                      <CalendarRange className="h-3.5 w-3.5 mr-1" />
                      {slotDates.length > 0
                        ? t("teacherPolls.generateSlotsFromDates", { count: slotDates.length })
                        : t("teacherPolls.generateSlots")}
                    </Button>
                    <p className="text-[10px] text-muted-foreground">
                      {t("teacherPolls.generateSlotsFooterHint")}
                    </p>
                  </div>

                  {/* Agregar UN slot a mano (fecha + hora) — para el que
                      faltó en la generación masiva. Compone el label con el
                      mismo formato que los generados. */}
                  <div className="border-t pt-3 space-y-1.5">
                    <Label className="text-[11px]">{t("teacherPolls.addSingleSlot")}</Label>
                    <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
                      <div className="flex-1 min-w-0">
                        <DatePicker
                          value={manualSlotDate}
                          onChange={setManualSlotDate}
                          placeholder={t("teacherPolls.datePlaceholder")}
                          className="h-8 text-xs w-full"
                        />
                      </div>
                      <Input
                        type="time"
                        value={manualSlotTime}
                        onChange={(e) => setManualSlotTime(e.target.value)}
                        className="h-8 text-xs w-28"
                        aria-label={t("teacherPolls.slotTimeAria")}
                      />
                      <Input
                        type="number"
                        min={1}
                        value={manualSlotCupo}
                        onChange={(e) => setManualSlotCupo(e.target.value)}
                        className="h-8 text-xs w-20"
                        title={t("teacherPolls.slotCupoAria")}
                        aria-label={t("teacherPolls.slotCupoAria")}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={addManualSlot}
                        disabled={!manualSlotDate || !manualSlotTime}
                        className="h-8 text-xs"
                      >
                        <Plus className="h-3.5 w-3.5 mr-1" />
                        {t("teacherPolls.addSlot")}
                      </Button>
                    </div>
                  </div>
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
                          ? t("teacherPolls.slotPlaceholderExample1")
                          : idx === 1
                            ? t("teacherPolls.slotPlaceholderExample2")
                            : t("teacherPolls.optionPlaceholder", { number: idx + 1 })
                        : t("teacherPolls.optionPlaceholder", { number: idx + 1 })
                    }
                    className="flex-1"
                    disabled={optionsLocked}
                  />
                  {type === "slot" && (
                    <Input
                      type="number"
                      min={Math.max(1, o.responses_count ?? 1)}
                      value={o.max_responses}
                      onChange={(e) => updateOption(idx, { max_responses: e.target.value })}
                      placeholder={t("teacherPolls.cupoPlaceholder")}
                      className="w-20"
                      title={t("teacherPolls.cupoOptionTitle")}
                      disabled={optionsLocked}
                    />
                  )}
                  {type === "slot" ? (
                    // Slot con reservas → NO eliminable (rompería poll_responses):
                    // se muestra el conteo. Sin reservas → botón borrar normal.
                    (o.responses_count ?? 0) > 0 ? (
                      <span
                        className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        title={t("teacherPolls.slotHasReservations", {
                          defaultValue: "Esta fecha tiene reservas y no puede eliminarse",
                        })}
                      >
                        {t("teacherPolls.slotReservationsCount", {
                          defaultValue: "{{count}} reserva(s)",
                          count: o.responses_count ?? 0,
                        })}
                      </span>
                    ) : (
                      options.length > 2 && (
                        <RowAction
                          label={t("teacherPolls.removeOption")}
                          icon={Trash2}
                          tone="destructive"
                          onClick={() => removeOption(idx)}
                        />
                      )
                    )
                  ) : (
                    !optionsLocked &&
                    options.length > 2 && (
                      <RowAction
                        label={t("teacherPolls.removeOption")}
                        icon={Trash2}
                        tone="destructive"
                        onClick={() => removeOption(idx)}
                      />
                    )
                  )}
                </div>
              ))}
              {/* "Agregar opción" en blanco solo para single/multiple. En
                  modo cupo los slots se agregan con el composer fecha+hora
                  de arriba (no un input vacío). */}
              {!optionsLocked && type !== "slot" && (
                <Button variant="outline" size="sm" onClick={addOption}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {t("teacherPolls.addOption")}
                </Button>
              )}
            </div>
          </div>
          )}
        </div>
        <DialogFooter>
          {/* Sincronizar con calendario — solo encuestas de CUPO (slot). En
              modo crear queda deshabilitado (necesita pollId) con un hint que
              invita a guardar primero; en edit ya tenemos editingPoll.id. */}
          {type === "slot" && (
            <div className="mr-auto flex items-center gap-1">
              <Button
                variant="outline"
                onClick={() => void handleSyncPollToCalendar()}
                disabled={!isEdit || saving || syncingCalendar}
              >
                {syncingCalendar ? (
                  <Spinner size="sm" className="mr-1" />
                ) : (
                  <CalendarRange className="h-4 w-4 mr-1" />
                )}
                {t("teacherPolls.syncToCalendar")}
              </Button>
              <HelpHint>
                {isEdit
                  ? t("teacherPolls.syncToCalendarHint")
                  : t("teacherPolls.syncToCalendarSaveFirst")}
              </HelpHint>
            </div>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Spinner size="sm" className="mr-1" />}
            {isEdit ? t("teacherPolls.saveChanges") : t("teacherPolls.createPoll")}
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
  const { t } = useTranslation();
  const confirm = useConfirm();
  // El dialog mantiene SU PROPIA copia de las opciones y respondents,
  // refetcheada por realtime — no depende de que el padre re-renderice
  // su lista. Así los conteos se actualizan al instante cuando un
  // alumno vota durante el show-of-hands sin click manual.
  const [liveOptions, setLiveOptions] = useState<PollOption[]>([]);
  const [respondents, setRespondents] = useState<
    Array<{ option_id: string; user_id: string; full_name: string | null }>
  >([]);
  const [loading, setLoading] = useState(false);
  // Set de user_ids en proceso de borrado — para mostrar spinner y
  // evitar dobles clicks. Si el docente clickea borrar dos veces sobre
  // el mismo alumno, el segundo click no hace nada.
  const [clearing, setClearing] = useState<Set<string>>(new Set());
  // user_ids en proceso de MOVE (reasignación de cupo) — spinner + anti doble.
  const [moving, setMoving] = useState<Set<string>>(new Set());
  // Asignación masiva de estudiantes restantes en curso.
  const [assigning, setAssigning] = useState(false);

  /** Mueve a un alumno a OTRO cupo (slot). El backend hace el claim atómico
   *  del cupo destino; si se llenó en el instante, rechaza con "El cupo ya ha
   *  sido ocupado por otra respuesta" y refetcheamos para revertir la UI. */
  const moveVoteTo = async (userId: string, toOptionId: string) => {
    if (!poll || moving.has(userId)) return;
    setMoving((prev) => new Set(prev).add(userId));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("teacher_reassign_poll_response", {
        _poll_id: poll.id,
        _user_id: userId,
        _to_option_id: toOptionId,
      });
      if (error) {
        toast.error(friendlyError(error, t("teacherPolls.errMoveVote")));
        // Revertir: re-sincronizar desde la BD (la UI es realtime-driven, no
        // optimista, pero forzamos por si el toast llegó antes del evento).
        void refetch();
        return;
      }
      toast.success(t("teacherPolls.moveVoteOk"));
      void refetch();
    } finally {
      setMoving((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  };

  /** Asigna automáticamente a los matriculados que NO han respondido a los
   *  cupos que queden libres (claim atómico por cupo, sin sobrecupo). */
  const assignRemaining = async () => {
    if (!poll || assigning) return;
    const ok = await confirm({
      title: t("teacherPolls.assignRemainingTitle"),
      description: t("teacherPolls.assignRemainingDesc"),
      confirmLabel: t("teacherPolls.assignRemainingConfirm"),
    });
    if (!ok) return;
    setAssigning(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc("teacher_assign_remaining_to_slots", {
        _poll_id: poll.id,
      });
      if (error) {
        toast.error(friendlyError(error, t("teacherPolls.errAssignRemaining")));
        return;
      }
      toast.success(t("teacherPolls.assignRemainingResult", { count: Number(data) || 0 }));
      void refetch();
    } finally {
      setAssigning(false);
    }
  };

  /** Borra TODAS las respuestas de un alumno en esta encuesta. Útil
   *  cuando el alumno eligió una fecha y necesita re-elegir después,
   *  sin que `allow_change_response` esté abierto para todos. */
  const clearVoteFor = async (userId: string, fullName: string | null) => {
    if (!poll || clearing.has(userId)) return;
    const label = fullName ?? userId.slice(0, 8);
    const ok = await confirm({
      title: t("teacherPolls.confirmClearVoteTitle"),
      description: t("teacherPolls.confirmClearVoteDescription", { label }),
      tone: "destructive",
      confirmLabel: t("teacherPolls.confirmClearVoteLabel"),
    });
    if (!ok) return;
    setClearing((prev) => new Set(prev).add(userId));
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("teacher_clear_poll_response_for_user", {
        _poll_id: poll.id,
        _user_id: userId,
      });
      if (error) {
        toast.error(friendlyError(error, t("teacherPolls.errClearResponse")));
        return;
      }
      toast.success(
        i18n.t("toast.routes_app_teacher_polls.responseClearedForUser", {
          defaultValue: 'Respuesta de "{{label}}" borrada. Ya puede volver a votar.',
          label,
        }),
      );
      // El realtime debería detectar el DELETE y disparar refetch — pero
      // forzamos uno por si la subscription debounce tarda.
      void refetch();
    } finally {
      setClearing((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      });
    }
  };

  const refetch = useCallback(async () => {
    if (!poll) return;
    setLoading(true);
    const [optsRes, respRes] = await Promise.all([
      db
        .from("poll_options")
        .select("id, poll_id, label, position, max_responses, responses_count")
        .eq("poll_id", poll.id)
        .order("position"),
      // OJO: `poll_responses.user_id` apunta a `auth.users`, NO a `profiles`,
      // así que el embed PostgREST `profiles:user_id(full_name)` falla con
      // PGRST200 (sin relación) y deja `respondents` vacío → el docente NO
      // veía ningún nombre por cupo. Patrón 2-query (CLAUDE.md): traemos las
      // respuestas y resolvemos los nombres en una 2ª consulta a profiles.
      db.from("poll_responses").select("option_id, user_id").eq("poll_id", poll.id),
    ]);
    setLiveOptions((optsRes.data ?? []) as PollOption[]);
    const rawResp = (respRes.data ?? []) as Array<{ option_id: string; user_id: string }>;
    const userIds = Array.from(new Set(rawResp.map((r) => r.user_id)));
    const nameById = new Map<string, string | null>();
    if (userIds.length > 0) {
      const { data: profs } = await db
        .from("profiles")
        .select("id, full_name")
        .in("id", userIds);
      for (const p of (profs ?? []) as Array<{ id: string; full_name: string | null }>) {
        nameById.set(p.id, p.full_name ?? null);
      }
    }
    setRespondents(
      rawResp.map((r) => ({
        option_id: r.option_id,
        user_id: r.user_id,
        full_name: nameById.get(r.user_id) ?? null,
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
  // Encuestas MIXTAS: resultados por pregunta (cerradas = conteo de opciones,
  // abiertas = lista de textos). Viven en poll_questions/poll_question_responses,
  // no en poll_options — vista propia.
  if (poll.poll_type === "mixed") {
    return <MixedResultsDialog poll={poll} onOpenChange={onOpenChange} />;
  }
  // Si el realtime fetch ya pobló liveOptions, usamos esos; si todavía
  // no llegó (primer render), fallback a las del prop.
  const options = liveOptions.length > 0 ? liveOptions : (poll.options ?? []);
  const total = options.reduce((acc, o) => acc + o.responses_count, 0);
  // Gestión de cupos en encuestas de tipo slot:
  //  - REASIGNAR (mover un alumno a otro cupo): permitido también con la
  //    encuesta CERRADA — es una corrección puntual post-cierre. El backend
  //    ya no lo bloquea; el claim atómico evita sobrecupo.
  //  - ASIGNAR RESTANTES (masivo de no-respondientes): solo con la encuesta
  //    ABIERTA (el backend lo sigue bloqueando con poll_is_open).
  const isSlot = poll.poll_type === "slot";
  const pollOpen = pollIsOpen(poll);
  const canReassign = isSlot;
  const canAssignRemaining = isSlot && pollOpen;
  return (
    <Dialog open={Boolean(poll)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {poll.title}
            <Badge
              variant="outline"
              className="text-[9px] gap-1 text-emerald-600 dark:text-emerald-400"
            >
              <Radio className="h-2.5 w-2.5 animate-pulse" />
              {t("teacherPolls.liveBadge")}
            </Badge>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t("teacherPolls.responsesCount", { count: total })} · {pollTypeLabel(poll.poll_type)}
          </p>
          <div className="space-y-2">
            {options.map((o) => {
              // En encuestas de CUPO (slot) la barra/porcentaje miden el
              // LLENADO DEL CUPO de la opción; en single/multiple, la cuota
              // sobre el total. Lógica pura testeada en poll-results.test.ts.
              const { pct, full: slotFull, showPct } = optionFillPercent({
                // ResultsDialog no se abre para 'kahoot' (sin acción "Ver
                // resultados"); narrow al tipo que entiende optionFillPercent.
                pollType: poll.poll_type === "slot" ? "slot" : "single",
                responsesCount: o.responses_count,
                maxResponses: o.max_responses,
                totalResponses: total,
              });
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
                      {showPct && ` · ${pct}%`}
                      {slotFull && ` · ${t("teacherPolls.slotFull")}`}
                    </span>
                  </div>
                  <div className="h-1.5 bg-muted rounded overflow-hidden">
                    <div
                      className={`h-full ${slotFull ? "bg-emerald-500" : "bg-primary"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {voters.length > 0 && (
                    // Lista de votantes como chips con botón borrar
                    // por alumno. Antes era un join de texto plano sin
                    // acción; ahora el docente puede limpiar la
                    // respuesta de UN alumno específico (útil para
                    // Doodle: alumno tuvo un conflicto y necesita
                    // re-elegir slot, sin tener que abrir el lock
                    // global de la encuesta).
                    <div className="flex flex-wrap gap-1">
                      {voters.map((v) => {
                        const display = v.full_name ?? v.user_id.slice(0, 8);
                        const isClearing = clearing.has(v.user_id);
                        const isMoving = moving.has(v.user_id);
                        // Cupos DESTINO con espacio (≠ al actual). Disponible en
                        // slot, abierta o cerrada. El backend re-valida el cupo
                        // atómicamente (sin sobrecupo).
                        const freeSlots = canReassign
                          ? options.filter(
                              (x) =>
                                x.id !== o.id &&
                                x.max_responses != null &&
                                x.responses_count < x.max_responses,
                            )
                          : [];
                        return (
                          <span
                            key={v.user_id}
                            className="inline-flex items-center gap-0.5 rounded border bg-muted/40 pl-1.5 pr-0.5 py-0.5 text-[10px]"
                          >
                            <span className="truncate max-w-[140px]" title={display}>
                              {display}
                            </span>
                            {canReassign ? (
                              isMoving ? (
                                <Spinner size="xs" />
                              ) : (
                                <RowActionsMenu
                                  className="h-5 w-5 shrink-0"
                                  label={t("teacherPolls.manageVoteAria", { name: display })}
                                  actions={[
                                    ...freeSlots.map((fs) => ({
                                      label: t("teacherPolls.moveVoteTo", { slot: fs.label }),
                                      icon: ArrowRightLeft,
                                      disabled: isClearing,
                                      onClick: () => void moveVoteTo(v.user_id, fs.id),
                                    })),
                                    {
                                      label: t("teacherPolls.clearVoteMenu"),
                                      icon: Trash2,
                                      tone: "destructive" as const,
                                      separatorBefore: freeSlots.length > 0,
                                      disabled: isClearing,
                                      onClick: () => void clearVoteFor(v.user_id, v.full_name),
                                    },
                                  ]}
                                />
                              )
                            ) : (
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="h-4 w-4 shrink-0 text-muted-foreground hover:text-destructive"
                                disabled={isClearing}
                                onClick={() => void clearVoteFor(v.user_id, v.full_name)}
                                title={t("teacherPolls.clearVoteTitle")}
                                aria-label={t("teacherPolls.clearVoteAria", { name: display })}
                              >
                                {isClearing ? (
                                  <Spinner size="xs" />
                                ) : (
                                  <Trash2 className="h-2.5 w-2.5" />
                                )}
                              </Button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {loading && (
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              <Spinner size="sm" /> {t("teacherPolls.loadingResponses")}
            </div>
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          {/* Asignación masiva: reparte los matriculados que NO respondieron a
              los cupos libres (claim atómico por cupo, sin sobrecupo). Solo en
              slot ABIERTO (a diferencia de reasignar, que también va en cerradas). */}
          {canAssignRemaining && (
            <Button
              variant="secondary"
              onClick={() => void assignRemaining()}
              disabled={assigning}
              className="mr-auto"
            >
              {assigning ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Shuffle className="h-4 w-4 mr-1" />
              )}
              {t("teacherPolls.assignRemaining")}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * MixedResultsDialog — resultados de una encuesta MIXTA. Por cada pregunta:
 *  - cerrada → barras de conteo por opción + chips de votantes (con nombre).
 *  - abierta → lista de textos con autor (solo el docente las ve).
 *
 * No usa realtime de payload (la tabla poll_question_responses no se publica
 * por privacidad de las respuestas abiertas) → botón "Actualizar" para refetch.
 * Nombres por patrón 2-query (poll_question_responses.user_id → auth.users no
 * es embebible a profiles).
 */
interface MixedQ {
  id: string;
  type: "abierta" | "cerrada";
  text: string;
  choices: string[];
}
interface MixedResp {
  question_id: string;
  user_id: string;
  answer_text: string | null;
  selected_index: number | null;
  created_at: string;
  full_name: string | null;
}

function MixedResultsDialog({
  poll,
  onOpenChange,
}: {
  poll: Poll;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [loading, setLoading] = useState(false);
  const [questions, setQuestions] = useState<MixedQ[]>([]);
  const [responses, setResponses] = useState<MixedResp[]>([]);
  const [clearing, setClearing] = useState<Set<string>>(new Set());

  const refetch = useCallback(async () => {
    setLoading(true);
    const { data: qs } = await db
      .from("poll_questions")
      .select("id, type, text, options, position")
      .eq("poll_id", poll.id)
      .order("position");
    const qrows = ((qs ?? []) as Array<{
      id: string;
      type: "abierta" | "cerrada";
      text: string;
      options: { choices?: string[] } | null;
    }>).map((q) => ({
      id: q.id,
      type: q.type,
      text: q.text,
      choices: Array.isArray(q.options?.choices) ? q.options!.choices! : [],
    }));
    const { data: rs } = await db
      .from("poll_question_responses")
      .select("question_id, user_id, answer_text, selected_index, created_at")
      .eq("poll_id", poll.id);
    const rawResp = (rs ?? []) as Array<Omit<MixedResp, "full_name">>;
    const userIds = Array.from(new Set(rawResp.map((r) => r.user_id)));
    const nameById = new Map<string, string | null>();
    if (userIds.length > 0) {
      const { data: profs } = await db.from("profiles").select("id, full_name").in("id", userIds);
      for (const p of (profs ?? []) as Array<{ id: string; full_name: string | null }>) {
        nameById.set(p.id, p.full_name ?? null);
      }
    }
    setQuestions(qrows);
    setResponses(rawResp.map((r) => ({ ...r, full_name: nameById.get(r.user_id) ?? null })));
    setLoading(false);
  }, [poll.id]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const clearOne = async (questionId: string, userId: string, name: string | null) => {
    const key = `${questionId}:${userId}`;
    if (clearing.has(key)) return;
    const label = name ?? userId.slice(0, 8);
    const ok = await confirm({
      title: t("teacherPolls.confirmClearVoteTitle"),
      description: t("teacherPolls.confirmClearVoteDescription", { label }),
      tone: "destructive",
      confirmLabel: t("teacherPolls.confirmClearVoteLabel"),
    });
    if (!ok) return;
    setClearing((prev) => new Set(prev).add(key));
    try {
      const { error } = await db.rpc("teacher_clear_poll_question_response_for_user", {
        _question_id: questionId,
        _user_id: userId,
      });
      if (error) {
        toast.error(friendlyError(error, t("teacherPolls.errClearResponse")));
        return;
      }
      void refetch();
    } finally {
      setClearing((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareText className="h-5 w-5 text-sky-500" />
            {poll.title}
          </DialogTitle>
          <DialogDescription>
            {t("teacherPolls.mixedResultsPrivacy", {
              defaultValue: "Las respuestas abiertas solo las ve el docente.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={loading}>
            <RefreshCw className="h-4 w-4 mr-1" />
            {t("teacherPolls.refresh")}
          </Button>
        </div>

        {loading && questions.length === 0 ? (
          <SectionLoader text={t("teacherPolls.loadingResponses")} />
        ) : questions.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            text={t("pollQuestions.empty", {
              defaultValue: "Aún no hay preguntas. Agrega una abierta o una cerrada.",
            })}
          />
        ) : (
          <div className="space-y-5">
            {questions.map((q, qi) => {
              const qResp = responses.filter((r) => r.question_id === q.id);
              return (
                <div key={q.id} className="rounded-lg border p-3 space-y-2">
                  <div className="flex items-start gap-2">
                    <span className="text-sm font-bold text-muted-foreground tabular-nums">
                      {qi + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{q.text}</p>
                      <Badge variant="outline" className="text-[9px] mt-1">
                        {q.type === "abierta"
                          ? t("pollQuestions.typeOpen", { defaultValue: "Abierta (texto)" })
                          : t("pollQuestions.typeClosed", { defaultValue: "Cerrada (opción única)" })}
                        {" · "}
                        {t("teacherPolls.responsesCount", { count: qResp.length })}
                      </Badge>
                    </div>
                  </div>

                  {q.type === "cerrada" ? (
                    <div className="space-y-1.5 pl-6">
                      {q.choices.map((choice, ci) => {
                        const voters = qResp.filter((r) => r.selected_index === ci);
                        const pct = qResp.length > 0 ? Math.round((voters.length / qResp.length) * 100) : 0;
                        return (
                          <div key={ci} className="space-y-1">
                            <div className="flex items-center justify-between text-xs">
                              <span className="truncate" title={choice}>
                                {choice}
                              </span>
                              <span className="text-muted-foreground tabular-nums">
                                {voters.length} · {pct}%
                              </span>
                            </div>
                            <div className="h-1.5 bg-muted rounded overflow-hidden">
                              <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                            </div>
                            {voters.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {voters.map((v) => {
                                  const display = v.full_name ?? v.user_id.slice(0, 8);
                                  const key = `${q.id}:${v.user_id}`;
                                  return (
                                    <span
                                      key={v.user_id}
                                      className="inline-flex items-center gap-0.5 rounded border bg-muted/40 pl-1.5 pr-0.5 py-0.5 text-[10px]"
                                    >
                                      <span className="truncate max-w-[140px]" title={display}>
                                        {display}
                                      </span>
                                      <Button
                                        type="button"
                                        size="icon"
                                        variant="ghost"
                                        className="h-4 w-4 shrink-0 text-muted-foreground hover:text-destructive"
                                        disabled={clearing.has(key)}
                                        onClick={() => void clearOne(q.id, v.user_id, v.full_name)}
                                        title={t("teacherPolls.clearVoteTitle")}
                                      >
                                        {clearing.has(key) ? (
                                          <Spinner size="xs" />
                                        ) : (
                                          <Trash2 className="h-2.5 w-2.5" />
                                        )}
                                      </Button>
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="space-y-1.5 pl-6">
                      {qResp.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          {t("teacherPolls.mixedNoAnswers", { defaultValue: "Sin respuestas todavía." })}
                        </p>
                      ) : (
                        qResp.map((r) => {
                          const display = r.full_name ?? r.user_id.slice(0, 8);
                          const key = `${q.id}:${r.user_id}`;
                          return (
                            <div
                              key={r.user_id}
                              className="rounded border bg-muted/30 p-2 text-xs space-y-1"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-medium truncate" title={display}>
                                  {display}
                                </span>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
                                  disabled={clearing.has(key)}
                                  onClick={() => void clearOne(q.id, r.user_id, r.full_name)}
                                  title={t("teacherPolls.clearVoteTitle")}
                                >
                                  {clearing.has(key) ? (
                                    <Spinner size="xs" />
                                  ) : (
                                    <Trash2 className="h-3 w-3" />
                                  )}
                                </Button>
                              </div>
                              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                                {r.answer_text}
                              </p>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
