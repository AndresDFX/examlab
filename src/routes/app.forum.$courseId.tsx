/**
 * Foros del curso — listado de los contenedores (foros) que el docente
 * ha creado. Cada foro agrupa hilos (preguntas/respuestas) y opcionalmente
 * está asociado a una sesión de clase.
 *
 * Quién accede: matriculados + docentes del curso + admin.
 * Quién crea foros: admin + docentes del curso (estudiantes NO).
 *
 * Flujo:
 *   1. Docente crea foro con título + descripción opcional + ventana
 *      apertura/cierre opcional + sesión asociada opcional.
 *   2. Estudiantes ven la lista y entran a participar en cada foro.
 *   3. Si el foro tiene ventana, los estudiantes solo pueden postear
 *      mientras esté abierto (RLS enforza). Docente puede postear
 *      siempre y cerrar manualmente.
 *
 * RLS en DB protege todo: un estudiante de otro curso no ve estos foros.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { TableEmpty } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  MessageSquareText,
  Plus,
  Lock,
  CalendarClock,
  ArrowRight,
  Trash2,
  Unlock,
} from "lucide-react";
import { formatDateTime, formatDate } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";

export const Route = createFileRoute("/app/forum/$courseId")({ component: ForumsList });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Forum {
  id: string;
  course_id: string;
  session_id: string | null;
  title: string;
  description: string | null;
  opens_at: string | null;
  closes_at: string | null;
  manually_closed_at: string | null;
  created_at: string;
  thread_count?: number;
  session?: {
    title: string | null;
    session_date: string;
  } | null;
}

interface Session {
  id: string;
  title: string | null;
  session_date: string;
}

/** Estado computado del foro: abierto / aún-no-abre / cerrado-auto /
 *  cerrado-manual. Se renderiza como Badge en cada fila.
 *
 *  INVARIANTE: el predicado "abierto" debe coincidir con la SQL
 *  `public.is_forum_open(_forum_id)` (migración 20260603105000) que
 *  usa RLS server-side. Si cambias el cálculo, actualiza ambos lados. */
type ForumState =
  | { kind: "open"; closesAt: string | null }
  | { kind: "scheduled"; opensAt: string }
  | { kind: "closed_auto"; closedAt: string }
  | { kind: "closed_manual"; closedAt: string };

function computeForumState(f: Forum): ForumState {
  if (f.manually_closed_at) return { kind: "closed_manual", closedAt: f.manually_closed_at };
  const now = Date.now();
  if (f.opens_at && new Date(f.opens_at).getTime() > now) {
    return { kind: "scheduled", opensAt: f.opens_at };
  }
  if (f.closes_at && new Date(f.closes_at).getTime() <= now) {
    return { kind: "closed_auto", closedAt: f.closes_at };
  }
  return { kind: "open", closesAt: f.closes_at };
}

function ForumsList() {
  const { courseId } = Route.useParams();
  const { user, roles } = useAuth();
  const confirm = useConfirm();
  const isStaff = roles.includes("Admin") || roles.includes("Docente");

  const [course, setCourse] = useState<{ id: string; name: string } | null>(null);
  const [forums, setForums] = useState<Forum[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  // Form de creación (solo docente/admin)
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newSessionId, setNewSessionId] = useState<string>("__none__");
  const [newOpensAt, setNewOpensAt] = useState(""); // datetime-local string
  const [newClosesAt, setNewClosesAt] = useState("");

  const load = async () => {
    setLoading(true);
    const [
      { data: c },
      { data: f },
      { data: s },
    ] = await Promise.all([
      db.from("courses").select("id, name").eq("id", courseId).maybeSingle(),
      // Trae foros + conteo de hilos via group-by manual abajo
      db
        .from("forums")
        .select(
          "id, course_id, session_id, title, description, opens_at, closes_at, manually_closed_at, created_at, session:attendance_sessions(title, session_date)",
        )
        .eq("course_id", courseId)
        .order("created_at", { ascending: false }),
      // Sesiones para el selector de "asociar a sesión" (solo si docente).
      // No filtramos por fecha — el docente puede asociar a una sesión
      // pasada para reabrir discusión sobre esa clase.
      db
        .from("attendance_sessions")
        .select("id, title, session_date")
        .eq("course_id", courseId)
        .order("session_date", { ascending: false })
        .limit(60),
    ]);
    setCourse(c as { id: string; name: string } | null);
    const forumRows = (f ?? []) as Forum[];
    // Trae conteos por foro en una sola query (subselect manual).
    if (forumRows.length > 0) {
      const ids = forumRows.map((x) => x.id);
      const { data: counts } = await db
        .from("forum_threads")
        .select("forum_id")
        .in("forum_id", ids);
      const byForum = new Map<string, number>();
      for (const row of (counts ?? []) as Array<{ forum_id: string }>) {
        byForum.set(row.forum_id, (byForum.get(row.forum_id) ?? 0) + 1);
      }
      for (const f of forumRows) f.thread_count = byForum.get(f.id) ?? 0;
    }
    setForums(forumRows);
    setSessions((s ?? []) as Session[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  /** Convierte string `datetime-local` (sin zona) a ISO timestamptz. */
  const datetimeLocalToIso = (s: string): string | null => {
    if (!s.trim()) return null;
    // datetime-local emite "YYYY-MM-DDTHH:mm" sin zona — interpretamos
    // como hora local del navegador, no UTC. new Date() lo respeta.
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };

  const createForum = async () => {
    if (!user) return;
    const title = newTitle.trim();
    if (title.length < 3) {
      toast.error("El título debe tener al menos 3 caracteres");
      return;
    }
    const opensAt = datetimeLocalToIso(newOpensAt);
    const closesAt = datetimeLocalToIso(newClosesAt);
    if (opensAt && closesAt && new Date(opensAt) >= new Date(closesAt)) {
      toast.error("La fecha de apertura debe ser anterior a la de cierre");
      return;
    }
    setCreating(true);
    const { error } = await db.from("forums").insert({
      course_id: courseId,
      session_id: newSessionId === "__none__" ? null : newSessionId,
      title,
      description: newDescription.trim() || null,
      opens_at: opensAt,
      closes_at: closesAt,
      created_by: user.id,
    });
    setCreating(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Foro creado");
    setCreateOpen(false);
    setNewTitle("");
    setNewDescription("");
    setNewSessionId("__none__");
    setNewOpensAt("");
    setNewClosesAt("");
    await load();
  };

  const toggleClosed = async (forum: Forum) => {
    const isClosed = !!forum.manually_closed_at;
    const action = isClosed ? "reabrir" : "cerrar";
    const ok = await confirm({
      title: `¿${isClosed ? "Reabrir" : "Cerrar"} el foro?`,
      description: isClosed
        ? `Los estudiantes podrán volver a publicar y responder en "${forum.title}".`
        : `Los estudiantes ya NO podrán publicar ni responder en "${forum.title}" hasta que lo reabras. Tú y otros docentes sí pueden seguir interactuando.`,
      tone: isClosed ? "default" : "warning",
      confirmLabel: isClosed ? "Reabrir" : "Cerrar",
    });
    if (!ok) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).rpc("toggle_forum_closed", {
      _forum_id: forum.id,
      _close: !isClosed,
    });
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(`Foro ${action === "cerrar" ? "cerrado" : "reabierto"}`);
    await load();
  };

  const deleteForum = async (forum: Forum) => {
    const ok = await confirm({
      title: "¿Eliminar este foro?",
      description: `Se eliminarán "${forum.title}" y TODOS sus hilos y respuestas (${forum.thread_count ?? 0} hilos). Esta acción no se puede deshacer.`,
      tone: "destructive",
      confirmLabel: "Eliminar",
    });
    if (!ok) return;
    const { error } = await db.from("forums").delete().eq("id", forum.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Foro eliminado");
    await load();
  };

  const sortedForums = useMemo(() => {
    // Foros abiertos arriba, luego programados, luego cerrados.
    const order = { open: 0, scheduled: 1, closed_auto: 2, closed_manual: 2 } as const;
    return forums.slice().sort((a, b) => {
      const sa = computeForumState(a).kind;
      const sb = computeForumState(b).kind;
      if (order[sa] !== order[sb]) return order[sa] - order[sb];
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [forums]);

  return (
    <div className="container mx-auto space-y-5 p-4 sm:p-6">
      <PageHeader
        backTo="/app"
        icon={<MessageSquareText className="h-6 w-6 text-indigo-500" />}
        title={course ? `Foros · ${course.name}` : "Foros"}
        subtitle="Espacios de discusión asíncrona por curso. Tu docente crea los foros y los estudiantes participan."
        actions={
          isStaff ? (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Nuevo foro
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <Card>
          <CardContent className="p-4 sm:p-8 text-center text-muted-foreground">
            <Spinner size="md" /> Cargando foros…
          </CardContent>
        </Card>
      ) : sortedForums.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <TableEmpty
              icon={MessageSquareText}
              title="Aún no hay foros en este curso"
              description={
                isStaff
                  ? "Crea el primer foro para que los estudiantes empiecen a discutir."
                  : "Tu docente abrirá uno cuando quiera iniciar una discusión."
              }
              action={
                isStaff ? (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="h-4 w-4 mr-1" />
                    Crear primer foro
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {sortedForums.map((forum) => (
            <ForumRow
              key={forum.id}
              forum={forum}
              courseId={courseId}
              isStaff={isStaff}
              onToggleClosed={() => void toggleClosed(forum)}
              onDelete={() => void deleteForum(forum)}
            />
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Nuevo foro</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label required>Título</Label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Ej: Dudas sobre el parcial 1"
                maxLength={200}
              />
            </div>
            <div>
              <Label>Descripción</Label>
              <Textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Opcional. Reglas, temas a tratar, contexto…"
                rows={3}
                maxLength={5000}
              />
            </div>
            <div>
              <Label>Asociar a sesión</Label>
              <Select value={newSessionId} onValueChange={setNewSessionId}>
                <SelectTrigger>
                  <SelectValue placeholder="Sin sesión asociada" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Sin sesión asociada</SelectItem>
                  {sessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {formatDate(s.session_date)}
                      {s.title ? ` · ${s.title}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Útil cuando el foro corresponde a una clase específica. Si la sesión se elimina,
                el foro sigue existiendo (solo pierde el vínculo).
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Apertura (opcional)</Label>
                <Input
                  type="datetime-local"
                  value={newOpensAt}
                  onChange={(e) => setNewOpensAt(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Vacío = abierto desde ya.
                </p>
              </div>
              <div>
                <Label>Cierre automático (opcional)</Label>
                <Input
                  type="datetime-local"
                  value={newClosesAt}
                  onChange={(e) => setNewClosesAt(e.target.value)}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Vacío = sin cierre. Puedes cerrarlo manualmente cuando quieras.
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void createForum()} disabled={creating}>
              {creating ? <Spinner size="sm" className="mr-1" /> : null}
              Crear foro
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ForumRow({
  forum,
  courseId,
  isStaff,
  onToggleClosed,
  onDelete,
}: {
  forum: Forum;
  courseId: string;
  isStaff: boolean;
  onToggleClosed: () => void;
  onDelete: () => void;
}) {
  const state = computeForumState(forum);
  const isClosed = state.kind !== "open";

  return (
    <Card className={isClosed ? "opacity-90" : undefined}>
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-start gap-3 flex-wrap">
          <Link
            to="/app/forum/$courseId/$forumId"
            params={{ courseId, forumId: forum.id }}
            className="flex-1 min-w-0 hover:opacity-90"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-sm truncate">{forum.title}</h3>
              <ForumStateBadge state={state} />
              {forum.session && (
                <Badge variant="secondary" className="text-[10px]">
                  <CalendarClock className="h-2.5 w-2.5 mr-0.5" />
                  Sesión {formatDate(forum.session.session_date)}
                  {forum.session.title ? ` · ${forum.session.title}` : ""}
                </Badge>
              )}
            </div>
            {forum.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                {forum.description}
              </p>
            )}
            <div className="text-[11px] text-muted-foreground mt-2">
              {forum.thread_count ?? 0} hilo{forum.thread_count === 1 ? "" : "s"} · creado{" "}
              {formatDateTime(forum.created_at)}
            </div>
          </Link>
          <div className="flex items-center gap-1 shrink-0">
            {isStaff && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onToggleClosed}
                  title={forum.manually_closed_at ? "Reabrir foro" : "Cerrar foro manualmente"}
                >
                  {forum.manually_closed_at ? (
                    <Unlock className="h-3.5 w-3.5" />
                  ) : (
                    <Lock className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onDelete}
                  title="Eliminar foro"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Link
              to="/app/forum/$courseId/$forumId"
              params={{ courseId, forumId: forum.id }}
            >
              <Button size="sm" variant="outline">
                Entrar
                <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </Link>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ForumStateBadge({ state }: { state: ForumState }) {
  switch (state.kind) {
    case "open":
      return (
        <Badge
          variant="outline"
          className="text-[10px] text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
        >
          Abierto
          {state.closesAt && <span className="ml-1">· cierra {formatDateTime(state.closesAt)}</span>}
        </Badge>
      );
    case "scheduled":
      return (
        <Badge
          variant="outline"
          className="text-[10px] text-amber-700 dark:text-amber-300 border-amber-500/40 bg-amber-500/10"
        >
          Programado · abre {formatDateTime(state.opensAt)}
        </Badge>
      );
    case "closed_auto":
      return (
        <Badge variant="outline" className="text-[10px]">
          <Lock className="h-2.5 w-2.5 mr-0.5" />
          Cerrado (auto) · {formatDateTime(state.closedAt)}
        </Badge>
      );
    case "closed_manual":
      return (
        <Badge variant="outline" className="text-[10px]">
          <Lock className="h-2.5 w-2.5 mr-0.5" />
          Cerrado · {formatDateTime(state.closedAt)}
        </Badge>
      );
  }
}
