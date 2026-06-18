/**
 * Encuestas (estudiante) — `/app/student/polls`
 *
 * Muestra las encuestas activas de los cursos en los que el alumno está
 * matriculado y permite votar. La emisión del voto pasa por la RPC
 * `vote_poll_option` (SECURITY DEFINER, mig 20260720000000) — los
 * INSERTs directos a `poll_responses` están bloqueados por RLS para
 * que la lógica de cupo (`slot`) y "abierta/cerrada" se enforce
 * server-side de forma atómica.
 *
 * El alumno SOLO ve sus propias respuestas (RLS de poll_responses).
 * Los conteos agregados los lee de `poll_options.responses_count`
 * (denormalizado por trigger), respetando
 * `results_visible_to_students`:
 *   - 'always'      → siempre.
 *   - 'after_close' → solo si la encuesta ya cerró.
 *   - 'never'       → nunca al alumno.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { usePollRealtime } from "@/modules/polls/use-poll-realtime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { DateCell } from "@/components/ui/date-cell";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchInput } from "@/components/ui/search-input";
import { KahootJoinCard } from "@/modules/polls/KahootJoinCard";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import {
  ListChecks,
  CheckSquare,
  CalendarRange,
  Check,
  RefreshCw,
  Presentation,
  X,
  MessageSquareText,
} from "lucide-react";

export const Route = createFileRoute("/app/student/polls")({
  component: StudentPolls,
  // Deep-link: el docente comparte `/app/student/polls?poll=<id>` para que
  // el alumno aterrice y se le resalte/scrollee esa encuesta. La RLS sigue
  // aplicando — el param solo enfoca, no expone nada.
  // `kahootPin`: deep-link del QR de un Kahoot en vivo. Al aterrizar (logueado;
  // si no, el login con returnTo lo trae acá), se auto-une por PIN y redirige
  // al juego. La seguridad la enforza el RPC kahoot_join_game (matrícula).
  validateSearch: (search: Record<string, unknown>): { poll?: string; kahootPin?: string } => ({
    poll: typeof search.poll === "string" ? search.poll : undefined,
    kahootPin: typeof search.kahootPin === "string" ? search.kahootPin : undefined,
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type PollType = "single" | "multiple" | "slot" | "mixed";
type ResultsVis = "always" | "after_close" | "never";

interface PollOption {
  id: string;
  poll_id: string;
  label: string;
  position: number;
  max_responses: number | null;
  responses_count: number;
}

/** Pregunta de una encuesta MIXTA (poll_type='mixed'). */
interface MixedQuestion {
  id: string;
  type: "abierta" | "cerrada";
  text: string;
  required: boolean;
  max_chars: number | null;
  choices: string[];
}
/** Mi respuesta a una pregunta mixta (abierta o cerrada). */
interface MyMixedAnswer {
  answer_text: string | null;
  selected_index: number | null;
}

interface Poll {
  id: string;
  course_id: string;
  /** Si la encuesta nació en una sesión presencial, marcamos al alumno
   *  con un badge "Sesión presencial" para que entienda el contexto
   *  ("este es el show-of-hands de la clase") y la priorice sobre las
   *  asíncronas. */
  attendance_session_id: string | null;
  title: string;
  description: string | null;
  poll_type: PollType;
  results_visible_to_students: ResultsVis;
  /** Si false, el alumno no puede cambiar su voto una vez emitido.
   *  Default true (legacy). Vino con la migración 20260603000000. */
  allow_change_response: boolean;
  opens_at: string;
  closes_at: string | null;
  closed_manually: boolean;
  course_name?: string;
  options: PollOption[];
  // option_ids que YO voté.
  my_votes: string[];
  // Solo para poll_type='mixed': sus preguntas + mis respuestas.
  questions?: MixedQuestion[];
  my_answers?: Record<string, MyMixedAnswer>;
}

function pollIsOpen(p: Poll): boolean {
  if (p.closed_manually) return false;
  const now = Date.now();
  if (new Date(p.opens_at).getTime() > now) return false;
  if (p.closes_at && new Date(p.closes_at).getTime() <= now) return false;
  return true;
}

function showResultsToStudent(p: Poll): boolean {
  if (p.results_visible_to_students === "always") return true;
  if (p.results_visible_to_students === "after_close" && !pollIsOpen(p)) return true;
  return false;
}

const TYPE_ICONS: Record<PollType, typeof ListChecks> = {
  single: ListChecks,
  multiple: CheckSquare,
  slot: CalendarRange,
  mixed: MessageSquareText,
};

function getTypeHint(type: PollType): string {
  if (type === "single") return i18n.t("studentPolls.typeHintSingle");
  if (type === "multiple") return i18n.t("studentPolls.typeHintMultiple");
  if (type === "mixed")
    return i18n.t("studentPolls.typeHintMixed", {
      defaultValue: "Responde cada pregunta. Tus respuestas se guardan al instante.",
    });
  return i18n.t("studentPolls.typeHintSlot");
}

function StudentPolls() {
  const { t } = useTranslation();
  const { user } = useAuth();
  // Deep-link `?poll=<id>` compartido por el docente — resaltamos esa card.
  const { poll: deepLinkId, kahootPin } = Route.useSearch();
  const navigate = useNavigate();
  // Capturamos el PIN del QR UNA vez (al montar): lo pasamos a KahootJoinCard
  // para auto-unirse, y limpiamos el param de la URL para que un refresh /
  // back no re-dispare el join. El valor viene del router (determinista en
  // SSR+cliente), así que es seguro leerlo en el initializer.
  const [autoKahootPin] = useState<string | null>(kahootPin ?? null);
  useEffect(() => {
    if (kahootPin) {
      navigate({
        to: "/app/student/polls",
        search: deepLinkId ? { poll: deepLinkId } : {},
        replace: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [polls, setPolls] = useState<Poll[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  // Filtro compartido entre las dos listas (activas + cerradas). Busca
  // por título / descripción / nombre del curso.
  const [search, setSearch] = useState("");
  // Estado de "voting" por poll_id → option_id para mostrar spinner en
  // el botón mientras se ejecuta la RPC.
  const [voting, setVoting] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      // Cursos en los que estoy matriculado → IDs.
      const { data: enrolls, error: enrollErr } = await db
        .from("course_enrollments")
        .select("course_id, courses(id, name)")
        .eq("user_id", user.id);
      if (cancelled) return;
      if (enrollErr) {
        setLoadError(friendlyError(enrollErr, "No pudimos cargar tus cursos."));
        setLoading(false);
        return;
      }
      const courseIds = (enrolls ?? [])
        .map((r: { course_id: string }) => r.course_id)
        .filter(Boolean);
      const courseNameById = new Map<string, string>(
        (enrolls ?? [])
          .map((r: { courses: { id: string; name: string } | null }) => r.courses)
          .filter((c: { id: string; name: string } | null): c is { id: string; name: string } =>
            Boolean(c),
          )
          .map((c: { id: string; name: string }) => [c.id, c.name] as const),
      );
      if (courseIds.length === 0) {
        setPolls([]);
        setLoading(false);
        return;
      }
      // Multi-curso (mig 20260603010000): el filtro NO puede ser
      // `.in("course_id", courseIds)` porque eso solo matchea el curso
      // ancla. Una encuesta linkeada a [X, Y] con ancla X NO le
      // aparecería al alumno matriculado solo en Y. Usamos la
      // junction `poll_courses` para resolver los poll_ids visibles.
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
      // Polls + opciones + mis votos en paralelo.
      const [pollsRes, mineRes] = await Promise.all([
        db
          .from("polls")
          .select(
            "id, course_id, attendance_session_id, title, description, poll_type, results_visible_to_students, allow_change_response, opens_at, closes_at, closed_manually, options:poll_options(id, poll_id, label, position, max_responses, responses_count)",
          )
          .in("id", pollIds)
          .is("deleted_at", null)
          // Excluir los Kahoot (poll_type='kahoot', mig 20260921000000): son
          // quizzes en vivo que el alumno juega vía <KahootJoinCard> + la ruta
          // del juego, NO encuestas votables como card. Sin este filtro un
          // poll Kahoot se renderizaba como <PollCard> y TYPE_ICONS['kahoot']
          // quedaba undefined → React #130 ("Element type is invalid") que
          // tumbaba TODA la pantalla de encuestas del estudiante.
          .neq("poll_type", "kahoot")
          .order("created_at", { ascending: false }),
        db.from("poll_responses").select("poll_id, option_id").eq("user_id", user.id),
      ]);
      if (cancelled) return;
      if (pollsRes.error) {
        setLoadError(friendlyError(pollsRes.error, "No pudimos cargar las encuestas."));
        setLoading(false);
        return;
      }
      const myVotesByPoll = new Map<string, string[]>();
      for (const r of (mineRes.data ?? []) as Array<{ poll_id: string; option_id: string }>) {
        const arr = myVotesByPoll.get(r.poll_id) ?? [];
        arr.push(r.option_id);
        myVotesByPoll.set(r.poll_id, arr);
      }
      const list: Poll[] = (pollsRes.data ?? []).map((p: Poll & { options?: PollOption[] }) => {
        const options = (p.options ?? []).slice().sort((a, b) => a.position - b.position);
        return {
          ...p,
          course_name: courseNameById.get(p.course_id) ?? undefined,
          options,
          my_votes: myVotesByPoll.get(p.id) ?? [],
        };
      });
      // Encuestas MIXTAS: sus preguntas viven en poll_questions y mis
      // respuestas en poll_question_responses (no en poll_options). Las
      // traemos aparte y se las adjuntamos a las polls mixtas.
      const mixedIds = list.filter((p) => p.poll_type === "mixed").map((p) => p.id);
      if (mixedIds.length > 0) {
        const [qRes, aRes] = await Promise.all([
          db
            .from("poll_questions")
            .select("id, poll_id, type, text, required, max_chars, options, position")
            .in("poll_id", mixedIds)
            .order("position"),
          db
            .from("poll_question_responses")
            .select("poll_id, question_id, answer_text, selected_index")
            .eq("user_id", user.id)
            .in("poll_id", mixedIds),
        ]);
        if (cancelled) return;
        const qByPoll = new Map<string, MixedQuestion[]>();
        for (const q of (qRes.data ?? []) as Array<{
          id: string;
          poll_id: string;
          type: "abierta" | "cerrada";
          text: string;
          required: boolean;
          max_chars: number | null;
          options: { choices?: string[] } | null;
        }>) {
          const arr = qByPoll.get(q.poll_id) ?? [];
          arr.push({
            id: q.id,
            type: q.type,
            text: q.text,
            required: !!q.required,
            max_chars: q.max_chars ?? null,
            choices: Array.isArray(q.options?.choices) ? q.options!.choices! : [],
          });
          qByPoll.set(q.poll_id, arr);
        }
        const aByPoll = new Map<string, Record<string, MyMixedAnswer>>();
        for (const a of (aRes.data ?? []) as Array<{
          poll_id: string;
          question_id: string;
          answer_text: string | null;
          selected_index: number | null;
        }>) {
          const m = aByPoll.get(a.poll_id) ?? {};
          m[a.question_id] = { answer_text: a.answer_text, selected_index: a.selected_index };
          aByPoll.set(a.poll_id, m);
        }
        for (const p of list) {
          if (p.poll_type === "mixed") {
            p.questions = qByPoll.get(p.id) ?? [];
            p.my_answers = aByPoll.get(p.id) ?? {};
          }
        }
      }
      // Ordenamos: abiertas primero (con voto pendiente arriba), luego
      // cerradas. Dentro de cada grupo por opens_at desc.
      list.sort((a, b) => {
        const ao = pollIsOpen(a) ? 1 : 0;
        const bo = pollIsOpen(b) ? 1 : 0;
        if (ao !== bo) return bo - ao;
        return b.opens_at.localeCompare(a.opens_at);
      });
      setPolls(list);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [user, retryNonce]);

  // Filtra por título / descripción / curso ANTES de partir en activas /
  // cerradas, así una sola búsqueda aplica a ambas secciones.
  const filteredPolls = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return polls;
    return polls.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.description?.toLowerCase().includes(q) ?? false) ||
        (p.course_name?.toLowerCase().includes(q) ?? false),
    );
  }, [polls, search]);

  const activePolls = useMemo(() => filteredPolls.filter((p) => pollIsOpen(p)), [filteredPolls]);
  const closedPolls = useMemo(() => filteredPolls.filter((p) => !pollIsOpen(p)), [filteredPolls]);

  // Paginación independiente por sección. defaultPageSize 6 — cards de
  // encuesta son verticalmente densas (preguntas + opciones + barras).
  const activePagination = usePagination(activePolls, {
    defaultPageSize: 6,
    storageKey: "examlab_pag:student_polls_active",
    resetKey: search,
  });
  const closedPagination = usePagination(closedPolls, {
    defaultPageSize: 6,
    storageKey: "examlab_pag:student_polls_closed",
    resetKey: search,
  });

  const castVote = async (poll: Poll, optionId: string) => {
    // Guard cliente: si la encuesta NO permite cambiar respuesta y el
    // alumno ya votó, evitamos siquiera intentarlo. La RPC también lo
    // rechaza server-side; este guard solo da feedback inmediato.
    if (poll.poll_type !== "multiple" && poll.my_votes.length > 0 && !poll.allow_change_response) {
      toast.info(t("studentPolls.cannotChangeVote"));
      return;
    }
    setVoting(poll.id);
    try {
      // Para single/slot: si ya voté algo distinto, limpiamos primero
      // (la RPC `clear_poll_response` borra mi voto previo). El trigger
      // de `_tg_poll_response_enforce_single` rechazaría el INSERT si
      // no lo hacemos.
      if (poll.poll_type !== "multiple" && poll.my_votes.length > 0) {
        const { error: clearErr } = await db.rpc("clear_poll_response", { _poll_id: poll.id });
        if (clearErr) {
          toast.error(friendlyError(clearErr));
          return;
        }
      }
      const { error } = await db.rpc("vote_poll_option", { _option_id: optionId });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(t("studentPolls.voteRecorded"));
      setRetryNonce((n) => n + 1);
    } finally {
      setVoting(null);
    }
  };

  const toggleMultiple = async (poll: Poll, optionId: string, checked: boolean) => {
    setVoting(poll.id);
    try {
      if (checked) {
        const { error } = await db.rpc("vote_poll_option", { _option_id: optionId });
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
      } else {
        // En 'multiple' borrar UNA fila específica no tiene RPC propia;
        // sería un DELETE directo que la RLS bloquea. Por ahora le
        // permitimos al estudiante NO desmarcar (idempotente: cada voto
        // queda). Trade-off conocido: para des-votar en 'multiple'
        // habría que agregar `clear_poll_option(option_id)`.
        toast.info(t("studentPolls.cannotUncheckMultiple"));
        return;
      }
      setRetryNonce((n) => n + 1);
    } finally {
      setVoting(null);
    }
  };

  /** Quita la respuesta del alumno SIN obligarlo a elegir otra opción.
   *  Llama a `clear_poll_response` (borra todas sus filas en la encuesta).
   *  El RPC rechaza si la encuesta está cerrada o no permite cambios, por
   *  eso el botón solo se muestra cuando `allow_change_response` y abierta. */
  const clearMyVote = async (poll: Poll) => {
    setVoting(poll.id);
    try {
      const { error } = await db.rpc("clear_poll_response", { _poll_id: poll.id });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(t("studentPolls.responseCleared"));
      setRetryNonce((n) => n + 1);
    } finally {
      setVoting(null);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("studentPolls.title")}
        subtitle={t("studentPolls.subtitle")}
        icon={<ListChecks className="h-6 w-6 text-sky-500" />}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetryNonce((n) => n + 1)}
            disabled={loading}
          >
            <RefreshCw className="h-4 w-4 mr-1" />
            {t("studentPolls.refresh")}
          </Button>
        }
      />

      {/* Kahoot en vivo: se auto-muestra solo si hay un juego activo en
          alguno de los cursos del alumno. */}
      <KahootJoinCard nonce={retryNonce} autoPin={autoKahootPin} />

      {loading ? (
        <div className="p-4 sm:p-8 flex items-center justify-center text-sm text-muted-foreground">
          <Spinner size="sm" className="mr-2" /> {t("studentPolls.loading")}
        </div>
      ) : loadError ? (
        <ErrorState
          message={t("studentPolls.loadError")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      ) : polls.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title={t("studentPolls.emptyTitle")}
          description={t("studentPolls.emptySubtitle")}
        />
      ) : (
        <div className="space-y-5">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t("studentPolls.searchPlaceholder")}
          />
          {filteredPolls.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              text={t("studentPolls.noResults")}
              hint={t("studentPolls.noResultsHint")}
            />
          ) : (
            <>
              {activePolls.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-medium text-muted-foreground">
                    {t("studentPolls.activeTitle")} ({activePolls.length})
                  </h2>
                  {activePagination.paginatedItems.map((p) =>
                    p.poll_type === "mixed" ? (
                      <MixedPollCard
                        key={p.id}
                        poll={p}
                        highlight={p.id === deepLinkId}
                        onChanged={() => setRetryNonce((n) => n + 1)}
                      />
                    ) : (
                      <PollCard
                        key={p.id}
                        poll={p}
                        voting={voting === p.id}
                        onVote={castVote}
                        onToggleMultiple={toggleMultiple}
                        onClear={clearMyVote}
                        highlight={p.id === deepLinkId}
                        onRealtimeChange={() => setRetryNonce((n) => n + 1)}
                      />
                    ),
                  )}
                  <DataPagination state={activePagination} entityNamePlural="encuestas" />
                </section>
              )}
              {closedPolls.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-medium text-muted-foreground">
                    {t("studentPolls.closedTitle")} ({closedPolls.length})
                  </h2>
                  {closedPagination.paginatedItems.map((p) =>
                    p.poll_type === "mixed" ? (
                      <MixedPollCard
                        key={p.id}
                        poll={p}
                        highlight={p.id === deepLinkId}
                        onChanged={() => setRetryNonce((n) => n + 1)}
                      />
                    ) : (
                      <PollCard
                        key={p.id}
                        poll={p}
                        voting={false}
                        onVote={castVote}
                        onToggleMultiple={toggleMultiple}
                        onClear={clearMyVote}
                        highlight={p.id === deepLinkId}
                        onRealtimeChange={() => setRetryNonce((n) => n + 1)}
                      />
                    ),
                  )}
                  <DataPagination state={closedPagination} entityNamePlural="encuestas" />
                </section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PollCard({
  poll,
  voting,
  onVote,
  onToggleMultiple,
  onClear,
  highlight = false,
  onRealtimeChange,
}: {
  poll: Poll;
  voting: boolean;
  onVote: (poll: Poll, optionId: string) => void;
  onToggleMultiple: (poll: Poll, optionId: string, checked: boolean) => void;
  /** Quita la respuesta del alumno sin re-seleccionar (clear_poll_response). */
  onClear: (poll: Poll) => void;
  /** True cuando esta card es la apuntada por el deep-link `?poll=`. */
  highlight?: boolean;
  /** Llamado cuando llega un evento realtime (otro alumno votó o el
   *  docente cerró la encuesta). El parent refetchea su lista. */
  onRealtimeChange: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  // Deep-link: al montar con highlight, scrolleamos la card al centro.
  useEffect(() => {
    if (highlight && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlight]);
  const open = pollIsOpen(poll);
  // Fallback defensivo: si llegara un poll_type fuera del set conocido
  // (ej. un tipo nuevo agregado al enum antes de mapear su ícono acá), NO
  // dejamos que `<Icon/>` reciba undefined y tumbe la página con React #130.
  const Icon = TYPE_ICONS[poll.poll_type] ?? ListChecks;
  const showResults = showResultsToStudent(poll);
  const totalVotes = showResults ? poll.options.reduce((acc, o) => acc + o.responses_count, 0) : 0;
  // Suscripción realtime: solo activa cuando la encuesta está abierta
  // (cerrada = los conteos ya no cambian). En 'multiple' también
  // queremos saber cuándo otros votan para refrescar el barómetro.
  usePollRealtime(poll.id, onRealtimeChange, open);
  const hasVoted = poll.my_votes.length > 0;
  return (
    <Card
      ref={cardRef}
      className={highlight ? "ring-2 ring-primary ring-offset-2 transition-shadow" : undefined}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2 min-w-0">
              <Icon className="h-4 w-4 text-sky-500 shrink-0" />
              <span className="truncate">{poll.title}</span>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
              {poll.course_name && (
                <p className="text-[11px] text-muted-foreground">{poll.course_name}</p>
              )}
              {poll.attendance_session_id && (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <Presentation className="h-3 w-3" />
                  {i18n.t("studentPolls.sessionBadge")}
                </Badge>
              )}
            </div>
            {poll.description && (
              <p className="text-xs text-muted-foreground mt-1">{poll.description}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Badge variant={open ? "default" : "secondary"} className="text-[10px]">
              {open ? i18n.t("studentPolls.badgeOpen") : i18n.t("studentPolls.badgeClosed")}
            </Badge>
            {poll.closes_at && (
              <span className="text-[10px] text-muted-foreground">
                {open ? i18n.t("studentPolls.closesPrefix") : i18n.t("studentPolls.closedPrefix")}
                <DateCell value={poll.closes_at} variant="datetime" />
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[11px] text-muted-foreground">{getTypeHint(poll.poll_type)}</p>
        <div className="space-y-2">
          {poll.options.map((o) => {
            const myVote = poll.my_votes.includes(o.id);
            const pct =
              showResults && totalVotes > 0
                ? Math.round((o.responses_count / totalVotes) * 100)
                : 0;
            const fullSlot =
              poll.poll_type === "slot" &&
              o.max_responses != null &&
              o.responses_count >= o.max_responses;
            if (poll.poll_type === "multiple") {
              return (
                <label
                  key={o.id}
                  className="flex items-start gap-2 rounded-md border p-2 cursor-pointer hover:border-primary/40"
                >
                  <Checkbox
                    checked={myVote}
                    disabled={!open || voting || myVote}
                    onCheckedChange={(v) => onToggleMultiple(poll, o.id, Boolean(v))}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm flex items-center justify-between gap-2">
                      <span className="truncate">{o.label}</span>
                      {showResults && (
                        <span className="text-[10px] text-muted-foreground tabular-nums">
                          {o.responses_count} · {pct}%
                        </span>
                      )}
                    </div>
                    {showResults && (
                      <div className="h-1 bg-muted rounded mt-1 overflow-hidden">
                        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </div>
                </label>
              );
            }
            // single / slot — botón.
            return (
              <Button
                key={o.id}
                type="button"
                variant={myVote ? "default" : "outline"}
                className="w-full justify-start h-auto py-2"
                // Si la encuesta NO permite cambiar el voto y el alumno YA
                // votó, deshabilitamos las opciones NO elegidas (re-votar está
                // prohibido — el guard de castVote y la RPC lo rechazan). La
                // opción ya elegida (myVote) queda habilitada como indicador
                // visual de la selección. Paralelo al gating de intentos en
                // talleres/proyectos: no mostrar un CTA que la acción prohíbe.
                disabled={
                  !open || voting || fullSlot || (!poll.allow_change_response && hasVoted && !myVote)
                }
                onClick={() => onVote(poll, o.id)}
              >
                <div className="flex-1 min-w-0 text-left">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate flex items-center gap-2">
                      {myVote && <Check className="h-3.5 w-3.5" />}
                      {o.label}
                    </span>
                    <span className="text-[10px] tabular-nums opacity-80">
                      {poll.poll_type === "slot" && o.max_responses != null && (
                        <>
                          {o.responses_count} / {o.max_responses}
                          {fullSlot && ` · ${i18n.t("studentPolls.slotFull")}`}
                        </>
                      )}
                      {poll.poll_type === "single" && showResults && (
                        <>
                          {o.responses_count} · {pct}%
                        </>
                      )}
                    </span>
                  </div>
                  {showResults && poll.poll_type !== "slot" && (
                    <div className="h-1 bg-muted/60 rounded mt-1 overflow-hidden">
                      <div
                        className="h-full bg-primary-foreground/50"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
              </Button>
            );
          })}
        </div>
        {hasVoted && open && (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {poll.poll_type !== "multiple" && (
              <p className="text-[11px] text-muted-foreground">
                {poll.allow_change_response
                  ? i18n.t("studentPolls.changeVoteHint")
                  : i18n.t("studentPolls.noChangeHint")}
              </p>
            )}
            {poll.allow_change_response && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive ml-auto"
                disabled={voting}
                onClick={() => onClear(poll)}
                title={i18n.t("studentPolls.removeVoteTitle")}
              >
                <X className="h-3.5 w-3.5 mr-1" />
                {i18n.t("studentPolls.removeVote")}
              </Button>
            )}
          </div>
        )}
        {!showResults && (
          <p className="text-[11px] text-muted-foreground">
            {poll.results_visible_to_students === "never"
              ? i18n.t("studentPolls.resultsNever")
              : i18n.t("studentPolls.resultsAfterClose")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * MixedPollCard — toma de una encuesta MIXTA (poll_type='mixed'). Renderiza
 * cada pregunta: abierta = textarea (autosave al salir del campo), cerrada =
 * botones de opción única (autosave al click). Cada respuesta se persiste por
 * separado vía `submit_poll_question_response` (no hay "enviar" único — igual
 * que el voto de single/slot). Las respuestas abiertas solo las ve el docente.
 *
 * Hidrata desde `poll.my_answers`. "Quitar mis respuestas" llama a
 * `clear_poll_question_responses` (solo si abierta y allow_change_response).
 */
function MixedPollCard({
  poll,
  highlight = false,
  onChanged,
}: {
  poll: Poll;
  highlight?: boolean;
  /** Recarga la lista del padre tras "quitar mis respuestas". */
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [highlight]);

  const open = pollIsOpen(poll);
  const questions = poll.questions ?? [];
  // Texto actual de cada pregunta abierta + lo último persistido (para
  // detectar cambios en blur y no re-guardar si no cambió).
  const [text, setText] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of questions) {
      if (q.type === "abierta") init[q.id] = poll.my_answers?.[q.id]?.answer_text ?? "";
    }
    return init;
  });
  const savedTextRef = useRef<Record<string, string>>({ ...text });
  // Mirror del `text` actual en un ref → permite que el handler de
  // `beforeunload` (registrado UNA vez) lea la versión más reciente sin
  // re-suscribirse en cada keystroke.
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  // Timers de autosave debounced (1.5s) por pregunta abierta — se cancelan
  // si el alumno sigue tipeando, dispara el RPC cuando hay pausa o blur.
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Índice seleccionado de cada pregunta cerrada.
  const [selected, setSelected] = useState<Record<string, number | null>>(() => {
    const init: Record<string, number | null> = {};
    for (const q of questions) {
      if (q.type === "cerrada") init[q.id] = poll.my_answers?.[q.id]?.selected_index ?? null;
    }
    return init;
  });
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [clearing, setClearing] = useState(false);

  const setSavingFor = (qid: string, v: boolean) =>
    setSaving((prev) => ({ ...prev, [qid]: v }));

  // Programar autosave de una pregunta abierta tras 1.5s sin teclear. Si el
  // alumno sigue escribiendo, cada keystroke resetea el timer. `submitOpen`
  // YA hace short-circuit si el texto no cambió respecto al último guardado.
  const scheduleOpenSave = (qid: string) => {
    const existing = debounceTimersRef.current.get(qid);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceTimersRef.current.delete(qid);
      void submitOpen(qid);
    }, 1500);
    debounceTimersRef.current.set(qid, timer);
  };

  // Limpiar timers pendientes al desmontar. Sin esto, si la card se desmonta
  // mid-debounce (cambio de pestaña / cierre del modal), el setTimeout sigue
  // vivo e intenta llamar `submitOpen` sobre estado liberado.
  useEffect(() => {
    const timers = debounceTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Beforeunload: si hay textareas con cambios sin guardar, avisar antes de
  // cerrar la pestaña / navegar fuera (típico riesgo cuando el alumno escribe
  // y nunca pierde el foco antes de cerrar). Solo activo si la encuesta está
  // abierta — cerrada ya no admite cambios.
  useEffect(() => {
    if (!open) return;
    const handler = (e: BeforeUnloadEvent) => {
      const hasDirty = questions.some((q) => {
        if (q.type !== "abierta") return false;
        const current = (textRef.current[q.id] ?? "").trim();
        const saved = (savedTextRef.current[q.id] ?? "").trim();
        return current !== saved;
      });
      if (!hasDirty) return;
      e.preventDefault();
      // Chrome/Edge/Firefox necesitan `returnValue` set para mostrar el prompt
      // (el texto real lo decide el browser desde hace años; no es customizable).
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [open, questions]);

  const submitClosed = async (qid: string, index: number) => {
    if (saving[qid]) return;
    setSavingFor(qid, true);
    try {
      const { error } = await db.rpc("submit_poll_question_response", {
        _question_id: qid,
        _selected_index: index,
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      setSelected((prev) => ({ ...prev, [qid]: index }));
      toast.success(t("studentPolls.answerSaved", { defaultValue: "Respuesta guardada" }));
    } finally {
      setSavingFor(qid, false);
    }
  };

  const submitOpen = async (qid: string) => {
    const value = (text[qid] ?? "").trim();
    if (value === (savedTextRef.current[qid] ?? "").trim()) return; // sin cambios
    setSavingFor(qid, true);
    try {
      const { error } = await db.rpc("submit_poll_question_response", {
        _question_id: qid,
        _answer_text: value,
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      savedTextRef.current[qid] = value;
      // SIN toast: el autosave dispara este RPC cada 1.5s mientras el alumno
      // escribe → un toast por save satura. El indicador "✓ Guardado" debajo
      // del textarea ya es feedback suficiente. (submitClosed sí toastea
      // porque las preguntas cerradas no tienen indicador por pregunta.)
    } finally {
      setSavingFor(qid, false);
    }
  };

  const clearAll = async () => {
    const ok = await confirm({
      title: t("studentPolls.clearAnswersTitle", { defaultValue: "¿Quitar tus respuestas?" }),
      description: t("studentPolls.clearAnswersDesc", {
        defaultValue: "Se borrarán todas tus respuestas a esta encuesta. Podrás volver a responder.",
      }),
      tone: "warning",
      confirmLabel: t("studentPolls.removeVote", { defaultValue: "Quitar" }),
    });
    if (!ok) return;
    // Cancelar autosaves pendientes — sino un debounce que se dispara DESPUÉS
    // del clear re-pisaría la DB con el texto que el alumno acaba de borrar.
    for (const t of debounceTimersRef.current.values()) clearTimeout(t);
    debounceTimersRef.current.clear();
    setClearing(true);
    try {
      const { error } = await db.rpc("clear_poll_question_responses", { _poll_id: poll.id });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      // Reset local: la card NO se remonta tras el refetch del padre (misma
      // key), así que limpiamos su estado manualmente.
      setSelected((prev) => {
        const next: Record<string, number | null> = {};
        for (const k of Object.keys(prev)) next[k] = null;
        return next;
      });
      setText((prev) => {
        const next: Record<string, string> = {};
        for (const k of Object.keys(prev)) next[k] = "";
        return next;
      });
      savedTextRef.current = {};
      toast.success(t("studentPolls.responseCleared"));
      onChanged();
    } finally {
      setClearing(false);
    }
  };

  const hasAnyAnswer =
    Object.values(selected).some((v) => v != null) ||
    Object.values(savedTextRef.current).some((v) => (v ?? "").trim().length > 0);

  return (
    <Card
      ref={cardRef}
      className={highlight ? "ring-2 ring-primary ring-offset-2 transition-shadow" : undefined}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base flex items-center gap-2 min-w-0">
              <MessageSquareText className="h-4 w-4 text-sky-500 shrink-0" />
              <span className="truncate">{poll.title}</span>
            </CardTitle>
            <div className="flex flex-wrap items-center gap-1.5 mt-0.5">
              {poll.course_name && (
                <p className="text-[11px] text-muted-foreground">{poll.course_name}</p>
              )}
              {poll.attendance_session_id && (
                <Badge variant="outline" className="text-[10px] gap-1">
                  <Presentation className="h-3 w-3" />
                  {i18n.t("studentPolls.sessionBadge")}
                </Badge>
              )}
            </div>
            {poll.description && (
              <p className="text-xs text-muted-foreground mt-1">{poll.description}</p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <Badge variant={open ? "default" : "secondary"} className="text-[10px]">
              {open ? i18n.t("studentPolls.badgeOpen") : i18n.t("studentPolls.badgeClosed")}
            </Badge>
            {poll.closes_at && (
              <span className="text-[10px] text-muted-foreground">
                {open ? i18n.t("studentPolls.closesPrefix") : i18n.t("studentPolls.closedPrefix")}
                <DateCell value={poll.closes_at} variant="datetime" />
              </span>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[11px] text-muted-foreground">{getTypeHint("mixed")}</p>
        {questions.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("studentPolls.mixedNoQuestions", { defaultValue: "Esta encuesta aún no tiene preguntas." })}
          </p>
        ) : (
          questions.map((q, qi) => {
            const isSaving = !!saving[q.id];
            if (q.type === "abierta") {
              const maxLen = q.max_chars ?? 500;
              const value = text[q.id] ?? "";
              const near = value.length >= maxLen * 0.9;
              // Estado del borrador (sin botón de submit explícito — autosave).
              //   saving  → RPC en curso (gana sobre los otros)
              //   dirty   → texto != último guardado (esperando debounce o falla previa)
              //   saved   → todo persistido (solo si hay texto, para no ruido)
              const savedText = (savedTextRef.current[q.id] ?? "").trim();
              const dirty = value.trim() !== savedText;
              const draftStatus: "saving" | "dirty" | "saved" | "none" = isSaving
                ? "saving"
                : value.trim() === "" && savedText === ""
                  ? "none"
                  : dirty
                    ? "dirty"
                    : "saved";
              return (
                <div key={q.id} className="space-y-1 rounded-md border p-2.5">
                  <p className="text-sm font-medium">
                    {qi + 1}. {q.text}
                    {q.required && <span className="text-destructive ml-0.5">*</span>}
                  </p>
                  <Textarea
                    value={value}
                    maxLength={maxLen}
                    rows={3}
                    disabled={!open}
                    placeholder={t("studentPolls.openAnswerPlaceholder", {
                      defaultValue: "Escribe tu respuesta…",
                    })}
                    onChange={(e) => {
                      setText((prev) => ({ ...prev, [q.id]: e.target.value }));
                      scheduleOpenSave(q.id);
                    }}
                    onBlur={() => {
                      // Cancelar el debounce y guardar inmediato — el usuario
                      // explícitamente salió del campo, no hace falta esperar.
                      const existing = debounceTimersRef.current.get(q.id);
                      if (existing) {
                        clearTimeout(existing);
                        debounceTimersRef.current.delete(q.id);
                      }
                      void submitOpen(q.id);
                    }}
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] flex items-center gap-1">
                      {draftStatus === "saving" && (
                        <>
                          <Spinner size="xs" />
                          <span className="text-muted-foreground">{t("studentPolls.draftSaving")}</span>
                        </>
                      )}
                      {draftStatus === "dirty" && (
                        <span className="text-amber-600 dark:text-amber-400">
                          ● {t("studentPolls.draftDirty")}
                        </span>
                      )}
                      {draftStatus === "saved" && (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          ✓ {t("studentPolls.draftSaved")}
                        </span>
                      )}
                    </span>
                    <span
                      className={`text-[10px] tabular-nums ${near ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}
                    >
                      {value.length} / {maxLen}
                    </span>
                  </div>
                </div>
              );
            }
            // cerrada — opción única (botones).
            const sel = selected[q.id] ?? null;
            const answered = sel != null;
            return (
              <div key={q.id} className="space-y-1.5 rounded-md border p-2.5">
                <p className="text-sm font-medium">
                  {qi + 1}. {q.text}
                  {q.required && <span className="text-destructive ml-0.5">*</span>}
                </p>
                <div className="space-y-1.5">
                  {q.choices.map((choice, ci) => {
                    const mine = sel === ci;
                    return (
                      <Button
                        key={ci}
                        type="button"
                        variant={mine ? "default" : "outline"}
                        className="w-full justify-start h-auto py-2"
                        // Si no se permite cambiar y ya respondió, bloqueamos las
                        // opciones NO elegidas (el RPC también lo rechaza).
                        disabled={
                          !open ||
                          isSaving ||
                          (!poll.allow_change_response && answered && !mine)
                        }
                        onClick={() => void submitClosed(q.id, ci)}
                      >
                        <span className="truncate flex items-center gap-2 text-sm">
                          {mine && <Check className="h-3.5 w-3.5" />}
                          {choice}
                        </span>
                        {isSaving && mine && <Spinner size="xs" className="ml-auto" />}
                      </Button>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}

        {open && poll.allow_change_response && hasAnyAnswer && (
          <div className="flex justify-end pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
              disabled={clearing}
              onClick={() => void clearAll()}
            >
              {clearing ? <Spinner size="xs" className="mr-1" /> : <X className="h-3.5 w-3.5 mr-1" />}
              {i18n.t("studentPolls.removeVote")}
            </Button>
          </div>
        )}
        {!open && (
          <p className="text-[11px] text-muted-foreground">
            {t("studentPolls.mixedClosedNote", {
              defaultValue: "La encuesta está cerrada. Ya no puedes modificar tus respuestas.",
            })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
