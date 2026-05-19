/**
 * Biblioteca de videos — Docente/Admin.
 *
 * CRUD simple: lista todos los videos registrados y permite agregarlos
 * de dos formas:
 *
 *   1) URL externa  — YouTube / Vimeo / MP4 directo en CDN externo. El
 *      tipo se detecta automáticamente del host.
 *   2) Subir archivo — sube un MP4/WebM/MOV al bucket `videos` de
 *      Storage y queda registrado con `provider="direct"` + un
 *      `storage_path` para poder borrarlo después.
 *
 * Los proyectos / talleres / módulos futuros referencian por video_id
 * en lugar de copiar/pegar URL.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty } from "@/components/ui/empty-state";
import { RowAction } from "@/components/ui/row-action";
import { useConfirm } from "@/components/ConfirmDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Video as VideoIcon,
  Plus,
  ExternalLink,
  Archive,
  RotateCcw,
  Trash2,
  Upload,
  Link as LinkIcon,
  Edit2,
} from "lucide-react";
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
  storage_path: string | null;
}

// MIME types aceptados por el bucket — debe coincidir con la migración.
const ACCEPTED_VIDEO_MIME = ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"];
const ACCEPTED_VIDEO_ACCEPT = ACCEPTED_VIDEO_MIME.join(",");
const MAX_VIDEO_BYTES = 524288000; // 500MB — debe coincidir con la migración.

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
    if (/\.(mp4|webm|mov|m4v)(\?|$)/i.test(u.pathname + u.search)) return "direct";
    return null;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function extFromMime(mime: string): string {
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/webm") return "webm";
  if (mime === "video/quicktime") return "mov";
  if (mime === "video/x-m4v") return "m4v";
  return "mp4";
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
  const [mode, setMode] = useState<"url" | "upload">("url");
  const [form, setForm] = useState({ title: "", description: "", url: "" });
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);

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
    setFile(null);
    setMode("url");
    setUploadPct(0);
    setDialogOpen(true);
  };
  const openEdit = (v: VideoRow) => {
    setEditing(v);
    setForm({ title: v.title, description: v.description ?? "", url: v.url });
    setFile(null);
    // Si fue subido, el modo es "upload" (no se puede cambiar a URL sin
    // perder el archivo). Si era URL, queda en "url". La UI bloquea el
    // tab opuesto en edición.
    setMode(v.storage_path ? "upload" : "url");
    setUploadPct(0);
    setDialogOpen(true);
  };

  const saveUrl = async () => {
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

  const saveUpload = async () => {
    if (!user) return;
    const title = form.title.trim();
    if (!title) {
      toast.error("El título es obligatorio");
      return;
    }
    // En edición sin nuevo archivo: solo guardamos metadatos.
    if (editing && !file) {
      setSaving(true);
      const { error } = await db
        .from("videos")
        .update({ title, description: form.description.trim() || null })
        .eq("id", editing.id);
      setSaving(false);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success("Video actualizado");
      setDialogOpen(false);
      await load();
      return;
    }
    if (!file) {
      toast.error("Selecciona un archivo de video");
      return;
    }
    if (!ACCEPTED_VIDEO_MIME.includes(file.type)) {
      toast.error(
        `Tipo de archivo no permitido (${file.type || "desconocido"}). Sube MP4, WebM o MOV.`,
      );
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      toast.error(`Archivo demasiado grande (${formatBytes(file.size)}). El máximo es 500 MB.`);
      return;
    }
    setSaving(true);
    setUploadPct(5);
    // Path: <user_id>/<uuid>.<ext> — el primer segmento sirve para que
    // si en el futuro queremos RLS por dueño, ya esté listo.
    const ext = extFromMime(file.type);
    const objectName = `${user.id}/${crypto.randomUUID()}.${ext}`;
    setUploadPct(15);
    const { error: upErr } = await supabase.storage
      .from("videos")
      .upload(objectName, file, { contentType: file.type, upsert: false });
    if (upErr) {
      setSaving(false);
      setUploadPct(0);
      toast.error(`Error al subir el video: ${upErr.message}`);
      return;
    }
    setUploadPct(80);
    const { data: pub } = supabase.storage.from("videos").getPublicUrl(objectName);
    const publicUrl = pub.publicUrl;
    if (!publicUrl) {
      setSaving(false);
      setUploadPct(0);
      toast.error("No se pudo obtener la URL pública del video subido");
      return;
    }
    if (editing && editing.storage_path) {
      // Reemplazo: subimos el nuevo, actualizamos la fila, y al final
      // borramos el viejo en background (no bloquea la UX).
      const oldPath = editing.storage_path;
      const { error } = await db
        .from("videos")
        .update({
          title,
          description: form.description.trim() || null,
          url: publicUrl,
          provider: "direct",
          storage_path: objectName,
        })
        .eq("id", editing.id);
      if (error) {
        setSaving(false);
        setUploadPct(0);
        // Limpieza: si update falla, eliminamos el blob recién subido
        // para no dejar huérfanos.
        void supabase.storage.from("videos").remove([objectName]);
        toast.error(error.message);
        return;
      }
      void supabase.storage.from("videos").remove([oldPath]);
      setUploadPct(100);
      toast.success("Video reemplazado");
    } else {
      const { error } = await db.from("videos").insert({
        title,
        description: form.description.trim() || null,
        url: publicUrl,
        provider: "direct",
        uploaded_by: user.id,
        storage_path: objectName,
      });
      if (error) {
        setSaving(false);
        setUploadPct(0);
        void supabase.storage.from("videos").remove([objectName]);
        toast.error(error.message);
        return;
      }
      setUploadPct(100);
      toast.success("Video subido a la biblioteca");
    }
    setSaving(false);
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
      description: v.storage_path
        ? "Se eliminará también el archivo subido. Los proyectos que lo referencian dejarán de mostrar el video (no rompen — el field queda null). Esta acción no se puede deshacer."
        : "Los proyectos que lo referencian dejarán de mostrar el video (no rompen — el field queda null). Esta acción no se puede deshacer.",
      tone: "destructive",
      confirmLabel: "Borrar",
    });
    if (!ok) return;
    const { error } = await db.from("videos").delete().eq("id", v.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    if (v.storage_path) {
      // Best-effort: si falla Storage queda un blob huérfano (no rompe).
      const { error: stErr } = await supabase.storage.from("videos").remove([v.storage_path]);
      if (stErr) {
        toast.warning(
          `Video eliminado, pero quedó el archivo huérfano en Storage (${stErr.message})`,
        );
      } else {
        toast.success("Video eliminado");
      }
    } else {
      toast.success("Video eliminado");
    }
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
          description="Agrega un video por URL (YouTube, Vimeo, MP4 directo) o súbelo desde tu equipo para reutilizarlo en varios proyectos o módulos."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((v) => (
            <Card key={v.id} className={v.is_archived ? "opacity-60 border-dashed" : undefined}>
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
                    {v.storage_path && (
                      <Badge variant="secondary" className="text-[10px] gap-1">
                        <Upload className="h-2.5 w-2.5" /> Subido
                      </Badge>
                    )}
                    {v.is_archived && (
                      <Badge variant="secondary" className="text-[10px]">
                        Archivado
                      </Badge>
                    )}
                  </div>
                  {v.description && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">{v.description}</p>
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
                  <RowAction label="Editar" icon={Edit2} onClick={() => openEdit(v)} />
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

          <Tabs
            value={mode}
            onValueChange={(v) => !saving && !editing && setMode(v as "url" | "upload")}
          >
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="url" disabled={!!editing && mode !== "url"}>
                <LinkIcon className="h-3.5 w-3.5 mr-1.5" /> URL externa
              </TabsTrigger>
              <TabsTrigger value="upload" disabled={!!editing && mode !== "upload"}>
                <Upload className="h-3.5 w-3.5 mr-1.5" /> Subir archivo
              </TabsTrigger>
            </TabsList>

            <TabsContent value="url" className="space-y-3 mt-3">
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
            </TabsContent>

            <TabsContent value="upload" className="space-y-3 mt-3">
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
                <Label>
                  {editing?.storage_path ? "Reemplazar archivo (opcional)" : "Archivo de video"}
                </Label>
                <Input
                  type="file"
                  accept={ACCEPTED_VIDEO_ACCEPT}
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                  disabled={saving}
                />
                {file && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {file.name} · {formatBytes(file.size)}
                  </p>
                )}
                {editing?.storage_path && !file && (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Deja vacío para mantener el archivo actual.
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground mt-1">
                  Formatos: MP4, WebM, MOV. Tamaño máximo: 500 MB.
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
              {saving && uploadPct > 0 && (
                <div className="space-y-1">
                  <Progress value={uploadPct} />
                  <p className="text-[11px] text-muted-foreground">Subiendo… {uploadPct}%</p>
                </div>
              )}
            </TabsContent>
          </Tabs>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button
              onClick={() => void (mode === "url" ? saveUrl() : saveUpload())}
              disabled={saving}
            >
              {saving ? <Spinner size="sm" className="mr-1" /> : null}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
