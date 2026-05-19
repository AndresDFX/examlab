/**
 * Biblioteca de videos — Docente/Admin.
 *
 * CRUD simple: lista todos los videos registrados, permite agregar uno
 * nuevo (con detección automática del provider desde la URL) y archivar
 * los obsoletos. Los proyectos / talleres / módulos futuros pueden
 * referenciar por video_id en lugar de copiar/pegar URL.
 *
 * No subimos archivos a Storage desde acá — el video vive en YouTube/
 * Vimeo o en un CDN externo. Para MP4 hospedados internamente, el
 * docente sube el archivo a `videos` bucket (uno futuro) y pega la
 * signed URL — fuera de alcance V1.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty } from "@/components/ui/empty-state";
import { RowAction } from "@/components/ui/row-action";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Video as VideoIcon, Plus, ExternalLink, Archive, RotateCcw, Trash2 } from "lucide-react";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/app/videos")({ component: VideoLibrary });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface VideoRow {
  id: string;
  title: string;
  description: string | null;
  url: string;
  provider: "youtube" | "vimeo" | "direct";
  duration_sec: number | null;
  uploaded_by: string | null;
  is_archived: boolean;
  created_at: string;
}

function detectProvider(url: string): "youtube" | "vimeo" | "direct" | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtu.be" ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com")
    ) {
      return "youtube";
    }
    if (host === "vimeo.com" || host.endsWith(".vimeo.com") || host === "player.vimeo.com") {
      return "vimeo";
    }
    // MP4/WebM directo
    if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u.pathname + u.search)) return "direct";
    return null;
  } catch {
    return null;
  }
}

function VideoLibrary() {
  const { user, roles } = useAuth();
  const confirm = useConfirm();
  const isStaff = roles.includes("Docente") || roles.includes("Admin");
  const [rows, setRows] = useState<VideoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<VideoRow | null>(null);
  const [form, setForm] = useState({ title: "", description: "", url: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await db
      .from("videos")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) toast.error(error.message);
    else setRows((data ?? []) as VideoRow[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const visible = useMemo(
    () => rows.filter((r) => showArchived || !r.is_archived),
    [rows, showArchived],
  );

  const openNew = () => {
    setEditing(null);
    setForm({ title: "", description: "", url: "" });
    setDialogOpen(true);
  };
  const openEdit = (v: VideoRow) => {
    setEditing(v);
    setForm({ title: v.title, description: v.description ?? "", url: v.url });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!user) return;
    const title = form.title.trim();
    const url = form.url.trim();
    if (!title || !url) {
      toast.error("Título y URL son obligatorios");
      return;
    }
    const provider = detectProvider(url);
    if (!provider) {
      toast.error(
        "URL no reconocida. Usa YouTube, Vimeo o un archivo MP4/WebM directo (terminado en .mp4/.webm).",
      );
      return;
    }
    setSaving(true);
    if (editing) {
      const { error } = await db
        .from("videos")
        .update({ title, description: form.description.trim() || null, url, provider })
        .eq("id", editing.id);
      setSaving(false);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Video actualizado");
    } else {
      const { error } = await db.from("videos").insert({
        title,
        description: form.description.trim() || null,
        url,
        provider,
        uploaded_by: user.id,
      });
      setSaving(false);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Video agregado a la biblioteca");
    }
    setDialogOpen(false);
    await load();
  };

  const toggleArchive = async (v: VideoRow) => {
    const next = !v.is_archived;
    const { error } = await db.from("videos").update({ is_archived: next }).eq("id", v.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(next ? "Video archivado" : "Video restaurado");
    void load();
  };

  const remove = async (v: VideoRow) => {
    const ok = await confirm({
      title: `¿Borrar "${v.title}"?`,
      description:
        "Los proyectos que lo referencian dejarán de mostrar el video (no rompen — el field queda null). Esta acción no se puede deshacer.",
      tone: "destructive",
      confirmLabel: "Borrar",
    });
    if (!ok) return;
    const { error } = await db.from("videos").delete().eq("id", v.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Video eliminado");
    void load();
  };

  if (!isStaff) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Necesitas rol Docente o Admin para gestionar la biblioteca de videos.
      </div>
    );
  }

  return (
    <div className="space-y-5 max-w-4xl mx-auto">
      <PageHeader
        title="Biblioteca de videos"
        subtitle="Videos reutilizables. Referenciados desde proyectos, talleres y módulos que exijan reproducción obligatoria."
        icon={<VideoIcon className="h-6 w-6 text-cyan-500" />}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowArchived((v) => !v)}
              title="Mostrar/ocultar videos archivados"
            >
              <Archive className="h-3.5 w-3.5 mr-1" />
              {showArchived ? "Ocultar archivados" : "Ver archivados"}
            </Button>
            <Button size="sm" onClick={openNew}>
              <Plus className="h-4 w-4 mr-1" />
              Nuevo video
            </Button>
          </div>
        }
      />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground p-6">
          <Spinner size="sm" /> Cargando videos…
        </div>
      ) : visible.length === 0 ? (
        <TableEmpty
          icon={VideoIcon}
          title="Sin videos en la biblioteca"
          description="Agrega un video con la URL pública (YouTube, Vimeo o MP4 directo) para reutilizarlo en varios proyectos o módulos."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((v) => (
            <Card
              key={v.id}
              className={v.is_archived ? "opacity-60 border-dashed" : undefined}
            >
              <CardContent className="p-3 flex items-center gap-3">
                <div className="h-9 w-9 rounded-md bg-cyan-500/10 flex items-center justify-center shrink-0">
                  <VideoIcon className="h-4 w-4 text-cyan-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{v.title}</span>
                    <Badge variant="outline" className="text-[10px] uppercase">
                      {v.provider === "direct" ? "MP4" : v.provider}
                    </Badge>
                    {v.is_archived && (
                      <Badge variant="secondary" className="text-[10px]">
                        Archivado
                      </Badge>
                    )}
                  </div>
                  {v.description && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {v.description}
                    </p>
                  )}
                  <a
                    href={v.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-muted-foreground hover:underline truncate flex items-center gap-1 mt-0.5"
                  >
                    <ExternalLink className="h-2.5 w-2.5" /> {v.url}
                  </a>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Agregado: {formatDateTime(v.created_at)}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <RowAction label="Editar" icon={Plus} onClick={() => openEdit(v)} />
                  <RowAction
                    label={v.is_archived ? "Restaurar" : "Archivar"}
                    icon={v.is_archived ? RotateCcw : Archive}
                    onClick={() => void toggleArchive(v)}
                  />
                  <RowAction
                    label="Eliminar"
                    icon={Trash2}
                    tone="destructive"
                    onClick={() => void remove(v)}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(o) => !saving && setDialogOpen(o)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? "Editar video" : "Nuevo video"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Título</Label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Ej. Introducción al proyecto VetCare"
                disabled={saving}
              />
            </div>
            <div>
              <Label>URL</Label>
              <Input
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder="https://www.youtube.com/watch?v=… ó https://cdn.tucentro.edu/video.mp4"
                disabled={saving}
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                Soporta YouTube, Vimeo o MP4/WebM directo. El tipo se detecta automáticamente.
              </p>
            </div>
            <div>
              <Label>Descripción (opcional)</Label>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Notas internas para identificar el video"
                rows={3}
                disabled={saving}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size="sm" className="mr-1" /> : null}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
