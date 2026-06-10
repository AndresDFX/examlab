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
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { usePollRealtime } from "@/modules/polls/use-poll-realtime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { DateCell } from "@/components/ui/date-cell";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchInput } from "@/components/ui/search-input";
import { KahootJoinCard } from "@/modules/polls/KahootJoinCard";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
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
} from "lucide-react";

export const Route = createFileRoute("/app/student/polls")({
  component: StudentPolls,
  // Deep-link: el docente comparte `/app/student/polls?poll=<id>` para que
  // el alumno aterrice y se le resalte/scrollee esa encuesta. La RLS sigue
  // aplicando — el param solo enfoca, no expone nada.
  validateSearch: (search: Record<string, unknown>): { poll?: string } => ({
    poll: typeof search.poll === "string" ? search.poll : undefined,
  }),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type PollType = "single" | "multiple" | "slot";
type ResultsVis = "always" | "after_close" | "never";

interface PollOption {
  id: string;
  poll_id: string;
  label: string;
  position: number;
  max_responses: number | null;
  responses_count: number;
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
};

function getTypeHint(type: PollType): string {
  if (type === "single") return i18n.t("studentPolls.typeHintSingle");
  if (type === "multiple") return i18n.t("studentPolls.typeHintMultiple");
  return i18n.t("studentPolls.typeHintSlot");
}

function StudentPolls() {
  const { t } = useTranslation();
  const { user } = useAuth();
  // Deep-link `?poll=<id>` compartido por el docente — resaltamos esa card.
  const { poll: deepLinkId } = Route.useSearch();
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
      <KahootJoinCard nonce={retryNonce} />

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
                  {activePagination.paginatedItems.map((p) => (
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
                  ))}
                  <DataPagination state={activePagination} entityNamePlural="encuestas" />
                </section>
              )}
              {closedPolls.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-medium text-muted-foreground">
                    {t("studentPolls.closedTitle")} ({closedPolls.length})
                  </h2>
                  {closedPagination.paginatedItems.map((p) => (
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
                  ))}
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
  const Icon = TYPE_ICONS[poll.poll_type];
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
            <CardTitle className="text-base flex items-center gap-2">
              <Icon className="h-4 w-4 text-sky-500" />
              {poll.title}
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
                disabled={!open || voting || fullSlot}
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
