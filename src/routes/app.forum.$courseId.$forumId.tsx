/**
 * Foro Q&A — listado de hilos DE UN FORO específico.
 *
 * Reemplaza al antiguo /app/forum/$courseId (que listaba threads a nivel
 * curso). Ahora los threads viven dentro de un `forum` (contenedor) que
 * el docente crea con título + descripción + opcional sesión + opcional
 * ventana apertura/cierre.
 *
 * Reglas:
 *   - Cualquiera con acceso al curso ve los hilos (admin / teacher /
 *     enrolled). RLS lo enforza.
 *   - Crear hilo: requiere foro ABIERTO si eres estudiante. Docente/
 *     admin pueden postear aunque esté cerrado.
 *   - El banner superior muestra estado del foro (abierto / programado /
 *     cerrado-auto / cerrado-manual) y la sesión asociada si la hay.
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
import { MarkdownInline } from "@/shared/components/MarkdownInline";
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
  Search,
  Pin,
  Lock,
  CheckCircle2,
  ArrowUp,
  MessageSquare,
  CalendarClock,
} from "lucide-react";
import { formatDateTime, formatDate } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";

export const Route = createFileRoute("/app/forum/$courseId/$forumId")({ component: ForumThreads });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Forum {
  id: string;
  course_id: string;
  title: string;
  description: string | null;
  opens_at: string | null;
  closes_at: string | null;
  manually_closed_at: string | null;
  session?: {
    title: string | null;
    session_date: string;
  } | null;
}

interface Thread {
  id: string;
  course_id: string;
  forum_id: string;
  author_id: string | null;
  title: string;
  body: string;
  tags: string[];
  is_pinned: boolean;
  is_locked: boolean;
  official_reply_id: string | null;
  reply_count: number;
  upvotes: number;
  last_activity_at: string;
  created_at: string;
  author?: { full_name: string | null } | null;
}

type SortMode = "recent" | "top" | "unanswered";

/**
 * INVARIANTE: la lógica debe coincidir con la función SQL
 * `public.is_forum_open(_forum_id)` definida en la migración
 * 20260603105000. La RLS server-side usa la SQL para decidir si un
 * estudiante puede postear; este helper hace lo mismo en cliente
 * para reflejar el estado en UI sin un round-trip. Si cambias una,
 * actualiza la otra (un INSERT que pasa por cliente puede ser
 * rechazado por RLS si divergen).
 */
function isForumOpen(f: Forum): boolean {
  if (f.manually_closed_at) return false;
  const now = Date.now();
  if (f.opens_at && new Date(f.opens_at).getTime() > now) return false;
  if (f.closes_at && new Date(f.closes_at).getTime() <= now) return false;
  return true;
}

function ForumThreads() {
  const { courseId, forumId } = Route.useParams();
  const { user, roles } = useAuth();
  const isStaff = roles.includes("Admin") || roles.includes("Docente");

  const [course, setCourse] = useState<{ id: string; name: string } | null>(null);
  const [forum, setForum] = useState<Forum | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");

  // Nuevo hilo dialog
  const [newOpen, setNewOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newTagsRaw, setNewTagsRaw] = useState("");

  const load = async () => {
    setLoading(true);
    const [{ data: c }, { data: f }, { data: t }] = await Promise.all([
      db.from("courses").select("id, name").eq("id", courseId).maybeSingle(),
      db
        .from("forums")
        .select(
          "id, course_id, title, description, opens_at, closes_at, manually_closed_at, session:attendance_sessions(title, session_date)",
        )
        .eq("id", forumId)
        .maybeSingle(),
      db
        .from("forum_threads")
        .select(
          "id, course_id, forum_id, author_id, title, body, tags, is_pinned, is_locked, official_reply_id, reply_count, upvotes, last_activity_at, created_at, author:profiles!forum_threads_author_id_fkey(full_name)",
        )
        .eq("forum_id", forumId)
        .order("is_pinned", { ascending: false })
        .order("last_activity_at", { ascending: false }),
    ]);
    setCourse(c as { id: string; name: string } | null);
    setForum(f as Forum | null);
    setThreads((t ?? []) as Thread[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId, forumId]);

  const open = forum ? isForumOpen(forum) : false;
  const canPost = isStaff || open;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = threads.slice();
    if (q) {
      arr = arr.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.body.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q)),
      );
    }
    if (sortMode === "top") {
      arr.sort((a, b) =>
        a.is_pinned !== b.is_pinned ? (a.is_pinned ? -1 : 1) : b.upvotes - a.upvotes,
      );
    } else if (sortMode === "unanswered") {
      arr = arr.filter((t) => t.reply_count === 0);
    }
    return arr;
  }, [threads, search, sortMode]);

  const createThread = async () => {
    if (!user || !forum) return;
    const title = newTitle.trim();
    const body = newBody.trim();
    if (title.length < 3) {
      toast.error("El título debe tener al menos 3 caracteres");
      return;
    }
    if (!body) {
      toast.error("Escribe el cuerpo de la pregunta");
      return;
    }
    const tags = newTagsRaw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 8);
    setCreating(true);
    const { error } = await db.from("forum_threads").insert({
      course_id: courseId,
      forum_id: forumId,
      author_id: user.id,
      title,
      body,
      tags,
    });
    setCreating(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Pregunta publicada");
    setNewOpen(false);
    setNewTitle("");
    setNewBody("");
    setNewTagsRaw("");
    await load();
  };

  return (
    <div className="container mx-auto space-y-5 p-4 sm:p-6">
      <PageHeader
        backTo="/app/forum/$courseId"
        backParams={{ courseId }}
        icon={<MessageSquareText className="h-6 w-6 text-indigo-500" />}
        title={forum ? forum.title : "Foro"}
        subtitle={course ? `${course.name} · pregunta, responde, marca lo útil.` : undefined}
        actions={
          canPost ? (
            <Button size="sm" onClick={() => setNewOpen(true)} disabled={!forum}>
              <Plus className="h-4 w-4 mr-1" />
              Nueva pregunta
            </Button>
          ) : undefined
        }
      />

      {/* Banner del estado del foro. Cuando está cerrado para estudiantes
          mostramos un mensaje claro de "no puedes postear". */}
      {forum && (
        <div
          className={`rounded-md border px-3 py-2 text-xs flex items-center gap-2 flex-wrap ${
            open
              ? "bg-emerald-500/5 border-emerald-500/30"
              : "bg-amber-500/5 border-amber-500/30"
          }`}
        >
          {open ? (
            <Badge
              variant="outline"
              className="text-[10px] text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
            >
              Abierto
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">
              <Lock className="h-2.5 w-2.5 mr-0.5" />
              {forum.manually_closed_at
                ? "Cerrado manualmente"
                : forum.opens_at && new Date(forum.opens_at) > new Date()
                  ? "Aún no abre"
                  : "Cerrado"}
            </Badge>
          )}
          {forum.session && (
            <Badge variant="secondary" className="text-[10px]">
              <CalendarClock className="h-2.5 w-2.5 mr-0.5" />
              Sesión {formatDate(forum.session.session_date)}
              {forum.session.title ? ` · ${forum.session.title}` : ""}
            </Badge>
          )}
          {forum.description && (
            <span className="text-muted-foreground">{forum.description}</span>
          )}
          {!open && !isStaff && (
            <span className="text-amber-700 dark:text-amber-300 ml-auto">
              No puedes publicar hasta que el docente lo reabra.
            </span>
          )}
          {forum.opens_at && new Date(forum.opens_at) > new Date() && (
            <span className="text-muted-foreground ml-auto">
              Abre {formatDateTime(forum.opens_at)}
            </span>
          )}
          {open && forum.closes_at && (
            <span className="text-muted-foreground ml-auto">
              Cierra {formatDateTime(forum.closes_at)}
            </span>
          )}
        </div>
      )}

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px] sm:min-w-48">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por título, cuerpo o tag…"
                className="pl-8"
              />
            </div>
            <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Actividad reciente</SelectItem>
                <SelectItem value="top">Más votados</SelectItem>
                <SelectItem value="unanswered">Sin respuesta</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <Card>
          <CardContent className="p-4 sm:p-8 text-center text-muted-foreground">
            <Spinner size="md" /> Cargando hilos…
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <TableEmpty
              title={search ? "Sin resultados" : "Aún no hay preguntas en este foro"}
              description={
                search
                  ? "Ajusta el buscador o cambia el ordenamiento."
                  : canPost
                    ? "Sé el primero en preguntar — tu docente y compañeros podrán responder."
                    : "Espera a que el docente reabra el foro para participar."
              }
              icon={MessageSquareText}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => (
            <ThreadCard key={t.id} thread={t} courseId={courseId} forumId={forumId} />
          ))}
        </div>
      )}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Nueva pregunta</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label required>Título</Label>
              <Input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="¿Cuál es tu duda? Sé concreto."
                maxLength={200}
              />
            </div>
            <div>
              <Label required>Cuerpo</Label>
              <Textarea
                value={newBody}
                onChange={(e) => setNewBody(e.target.value)}
                placeholder="Describe tu pregunta. Soporta Markdown."
                rows={8}
                maxLength={20000}
                className="font-mono text-sm"
              />
            </div>
            <div>
              <Label>Tags (separados por coma)</Label>
              <Input
                value={newTagsRaw}
                onChange={(e) => setNewTagsRaw(e.target.value)}
                placeholder="recursividad, parcial1, java"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void createThread()} disabled={creating}>
              {creating ? <Spinner size="sm" className="mr-1" /> : null}
              Publicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ThreadCard({
  thread,
  courseId,
  forumId,
}: {
  thread: Thread;
  courseId: string;
  forumId: string;
}) {
  const isResolved = !!thread.official_reply_id;
  return (
    <Card className={thread.is_pinned ? "border-indigo-500/40 bg-indigo-500/5" : undefined}>
      <CardContent className="p-3 sm:p-4">
        <Link
          to="/app/forum/$courseId/$forumId/$threadId"
          params={{ courseId, forumId, threadId: thread.id }}
          className="block hover:opacity-90"
        >
          <div className="flex items-start gap-3">
            <div className="shrink-0 flex flex-col items-center gap-0.5 w-12 text-muted-foreground">
              <ArrowUp className="h-3.5 w-3.5" />
              <span className="text-xs font-medium tabular-nums">{thread.upvotes}</span>
              <MessageSquare className="h-3.5 w-3.5 mt-1" />
              <span className="text-xs font-medium tabular-nums">{thread.reply_count}</span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {thread.is_pinned && (
                  <Badge
                    variant="outline"
                    className="text-[10px] text-indigo-700 dark:text-indigo-300 border-indigo-500/40"
                  >
                    <Pin className="h-2.5 w-2.5 mr-0.5" />
                    Fijado
                  </Badge>
                )}
                {thread.is_locked && (
                  <Badge
                    variant="outline"
                    className="text-[10px] text-amber-700 dark:text-amber-300 border-amber-500/40"
                  >
                    <Lock className="h-2.5 w-2.5 mr-0.5" />
                    Cerrado
                  </Badge>
                )}
                {isResolved && (
                  <Badge
                    variant="outline"
                    className="text-[10px] text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10"
                  >
                    <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                    Resuelto
                  </Badge>
                )}
                <h3 className="font-semibold text-sm truncate">{thread.title}</h3>
              </div>
              <div className="text-xs text-muted-foreground mt-1 line-clamp-2 prose-sm">
                <MarkdownInline>{thread.body.slice(0, 200)}</MarkdownInline>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-2">
                {thread.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-[10px]">
                    #{tag}
                  </Badge>
                ))}
              </div>
              <div className="text-[11px] text-muted-foreground mt-2">
                {thread.author?.full_name ?? "Anónimo"} · última actividad{" "}
                {formatDateTime(thread.last_activity_at)}
              </div>
            </div>
          </div>
        </Link>
      </CardContent>
    </Card>
  );
}
