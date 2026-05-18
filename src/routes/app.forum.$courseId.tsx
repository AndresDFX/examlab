/**
 * Foro Q&A — listado de hilos por curso.
 *
 * Quién accede: matriculados al curso + docentes del curso + admin.
 * Filtros: búsqueda por título/cuerpo, tags, "sin respuesta", "destacados".
 * Ordenamiento: actividad reciente (default), más votos, más vistos.
 *
 * RLS en DB garantiza que un estudiante de otro curso no vea estos hilos.
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
import { MarkdownInline } from "@/components/MarkdownInline";
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
} from "lucide-react";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/app/forum/$courseId")({ component: ForumList });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Thread {
  id: string;
  course_id: string;
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

function ForumList() {
  const { courseId } = Route.useParams();
  const { user } = useAuth();
  const [course, setCourse] = useState<{ id: string; name: string } | null>(null);
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
    const [{ data: c }, { data: t }] = await Promise.all([
      db.from("courses").select("id, name").eq("id", courseId).maybeSingle(),
      db
        .from("forum_threads")
        .select(
          "id, course_id, author_id, title, body, tags, is_pinned, is_locked, official_reply_id, reply_count, upvotes, last_activity_at, created_at, author:profiles!forum_threads_author_id_fkey(full_name)",
        )
        .eq("course_id", courseId)
        .order("is_pinned", { ascending: false })
        .order("last_activity_at", { ascending: false }),
    ]);
    setCourse(c as { id: string; name: string } | null);
    setThreads((t ?? []) as Thread[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

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
    if (!user) return;
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
      author_id: user.id,
      title,
      body,
      tags,
    });
    setCreating(false);
    if (error) {
      toast.error(error.message);
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
        backTo="/app"
        icon={<MessageSquareText className="h-6 w-6 text-indigo-500" />}
        title={course ? `Foro · ${course.name}` : "Foro"}
        subtitle="Pregunta, responde, marca lo útil. Tu docente puede destacar respuestas oficiales."
        actions={
          <Button size="sm" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Nueva pregunta
          </Button>
        }
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-48">
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
          <CardContent className="p-8 text-center text-muted-foreground">
            <Spinner size="md" /> Cargando hilos…
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <TableEmpty
              title={search ? "Sin resultados" : "Aún no hay preguntas"}
              description={
                search
                  ? "Ajusta el buscador o cambia el ordenamiento."
                  : "Sé el primero en preguntar — tu docente y compañeros podrán responder."
              }
              icon={MessageSquareText}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((t) => (
            <ThreadCard key={t.id} thread={t} courseId={courseId} />
          ))}
        </div>
      )}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-2xl">
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

function ThreadCard({ thread, courseId }: { thread: Thread; courseId: string }) {
  const isResolved = !!thread.official_reply_id;
  return (
    <Card
      className={
        thread.is_pinned ? "border-indigo-500/40 bg-indigo-500/5" : undefined
      }
    >
      <CardContent className="p-3 sm:p-4">
        <Link
          to="/app/forum/$courseId/$threadId"
          params={{ courseId, threadId: thread.id }}
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
                  <Badge variant="outline" className="text-[10px] text-indigo-700 dark:text-indigo-300 border-indigo-500/40">
                    <Pin className="h-2.5 w-2.5 mr-0.5" />
                    Fijado
                  </Badge>
                )}
                {thread.is_locked && (
                  <Badge variant="outline" className="text-[10px] text-amber-700 dark:text-amber-300 border-amber-500/40">
                    <Lock className="h-2.5 w-2.5 mr-0.5" />
                    Cerrado
                  </Badge>
                )}
                {isResolved && (
                  <Badge variant="outline" className="text-[10px] text-emerald-700 dark:text-emerald-400 border-emerald-500/40 bg-emerald-500/10">
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
