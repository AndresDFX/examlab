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
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { ListFilters } from "@/components/ui/list-filters";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { DateCell } from "@/components/ui/date-cell";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { formatFileSize } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";

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
  /** Curso al que pertenece el video. NULL = global (visible en todos
   *  los cursos cuando un módulo busca videos disponibles). */
  course_id: string | null;
}

interface CourseOption {
  id: string;
  name: string;
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
  const [form, setForm] = useState({ title: "", description: "", url: "", courseId: "" });
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  // Filtros del grid — search (título/descripción) + curso. null = sin filtro
  // de curso (incluye videos globales y de cualquier curso).
  const [search, setSearch] = useState("");
  const [filterCourseId, setFilterCourseId] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("videos")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar los videos."));
    } else {
      setRows((data ?? []) as VideoRow[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    void (async () => {
      const { data } = await db.from("courses").select("id, name").order("name");
      setCourses((data ?? []) as CourseOption[]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  const visible = useMemo(
    () =>
      rows.filter((r) => {
        if (!showArchived && r.is_archived) return false;
        if (filterCourseId && r.course_id !== filterCourseId) return false;
        if (search) {
          const q = search.toLowerCase();
          const hay =
            r.title.toLowerCase().includes(q) ||
            (r.description?.toLowerCase().includes(q) ?? false);
          if (!hay) return false;
        }
        return true;
      }),
    [rows, showArchived, filterCourseId, search],
  );

  const courseNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of courses) m[c.id] = c.name;
    return m;
  }, [courses]);

  const openNew = () => {
    setEditing(null);
    setForm({ title: "", description: "", url: "", courseId: "" });
    setFile(null);
    setMode("url");
    setUploadPct(0);
    setDialogOpen(true);
  };
  const openEdit = (v: VideoRow) => {
    setEditing(v);
    setForm({
      title: v.title,
      description: v.description ?? "",
      url: v.url,
      courseId: v.course_id ?? "",
    });
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
        .update({
          title,
          description: form.description.trim() || null,
          url,
          provider,
          course_id: form.courseId || null,
        })
        .eq("id", editing.id);
      setSaving(false);
      if (error) {
        toast.error(friendlyError(error));
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
        course_id: form.courseId || null,
      });
      setSaving(false);
      if (error) {
        toast.error(friendlyError(error));
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
        .update({
          title,
          description: form.description.trim() || null,
          course_id: form.courseId || null,
        })
        .eq("id", editing.id);
      setSaving(false);
      if (error) {
        toast.error(friendlyError(error));
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
      toast.error(`Archivo demasiado grande (${formatFileSize(file.size)}). El máximo es 500 MB.`);
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
      toast.error(`Error al subir el video: ${friendlyError(upErr)}`);
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
          course_id: form.courseId || null,
        })
        .eq("id", editing.id);
      if (error) {
        setSaving(false);
        setUploadPct(0);
        // Limpieza: si update falla, eliminamos el blob recién subido
        // para no dejar huérfanos.
        void supabase.storage.from("videos").remove([objectName]);
        toast.error(friendlyError(error));
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
        course_id: form.courseId || null,
      });
      if (error) {
        setSaving(false);
        setUploadPct(0);
        void supabase.storage.from("videos").remove([objectName]);
        toast.error(friendlyError(error));
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
      toast.error(friendlyError(error));
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
      toast.error(friendlyError(error));
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
    <div className="space-y-5">
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

      <ListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder="Buscar por título o descripción…"
        courseId={filterCourseId}
        onCourseChange={setFilterCourseId}
        courses={courses}
      />

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <TableSkeleton rows={5} cols={5} />
          ) : loadError ? (
            <ErrorState
              message="No pudimos cargar los videos"
              hint={loadError}
              onRetry={() => setRetryNonce((n) => n + 1)}
            />
          ) : (
            <Table resizable>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-[320px]">Video</TableHead>
                  <TableHead className="w-24">Tipo</TableHead>
                  <TableHead className="w-40 hidden md:table-cell">Curso</TableHead>
                  <TableHead className="w-32 hidden lg:table-cell">Agregado</TableHead>
                  <TableHead className="w-16 text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 ? (
                  (() => {
                    const filterActive = !!search || filterCourseId != null;
                    const noMatch = filterActive && rows.length > 0;
                    return (
                      <TableEmpty
                        colSpan={5}
                        text={noMatch ? "Sin coincidencias" : "Sin videos en la biblioteca"}
                        hint={
                          noMatch
                            ? "Ajusta el buscador o el filtro de curso para ver más resultados."
                            : "Agrega un video por URL (YouTube, Vimeo, MP4 directo) o súbelo desde tu equipo para reutilizarlo en varios proyectos o módulos."
                        }
                        action={
                          noMatch ? undefined : (
                            <Button onClick={openNew}>
                              <Plus className="h-4 w-4 mr-1" />
                              Nuevo video
                            </Button>
                          )
                        }
                      />
                    );
                  })()
                ) : (
                  visible.map((v) => (
                    <TableRow key={v.id} className={v.is_archived ? "opacity-60" : undefined}>
                      <TableCell className="max-w-md">
                        <div className="flex items-start gap-3">
                          <div className="h-9 w-9 rounded-md bg-cyan-500/10 flex items-center justify-center shrink-0">
                            <VideoIcon className="h-4 w-4 text-cyan-600" />
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium text-sm truncate" title={v.title}>
                              {v.title}
                            </div>
                            {v.description && (
                              <p
                                className="text-xs text-muted-foreground truncate mt-0.5"
                                title={v.description}
                              >
                                {v.description}
                              </p>
                            )}
                            <a
                              href={v.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] text-muted-foreground hover:underline truncate flex items-center gap-1 mt-0.5 max-w-full"
                              title={v.url}
                            >
                              <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                              <span className="truncate">{v.url}</span>
                            </a>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1">
                          <Badge variant="outline" className="text-[10px] uppercase w-fit">
                            {v.provider === "direct" ? "MP4" : v.provider}
                          </Badge>
                          {v.storage_path && (
                            <Badge variant="secondary" className="text-[10px] gap-1 w-fit">
                              <Upload className="h-2.5 w-2.5" /> Subido
                            </Badge>
                          )}
                          {v.is_archived && (
                            <Badge variant="secondary" className="text-[10px] w-fit">
                              Archivado
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        {v.course_id ? (
                          <span className="text-xs">{courseNameById[v.course_id] ?? "—"}</span>
                        ) : (
                          <Badge variant="outline" className="text-[10px]">
                            Global
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <DateCell value={v.created_at} variant="datetime" />
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            {
                              label: "Editar",
                              icon: Edit2,
                              onClick: () => openEdit(v),
                            },
                            {
                              label: v.is_archived ? "Restaurar" : "Archivar",
                              icon: v.is_archived ? RotateCcw : Archive,
                              onClick: () => void toggleArchive(v),
                            },
                            {
                              label: "Eliminar",
                              icon: Trash2,
                              tone: "destructive",
                              separatorBefore: true,
                              onClick: () => void remove(v),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

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
              <div>
                <Label>Curso (opcional)</Label>
                <Select
                  value={form.courseId || "__none"}
                  onValueChange={(v) => setForm({ ...form, courseId: v === "__none" ? "" : v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Global (todos los cursos)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Global (todos los cursos)</SelectItem>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Si lo asocias a un curso, los selectores de video (sesiones, talleres, exámenes,
                  proyectos) de ese curso lo verán además de los globales.
                </p>
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
                    {file.name} · {formatFileSize(file.size)}
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
              <div>
                <Label>Curso (opcional)</Label>
                <Select
                  value={form.courseId || "__none"}
                  onValueChange={(v) => setForm({ ...form, courseId: v === "__none" ? "" : v })}
                  disabled={saving}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Global (todos los cursos)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Global (todos los cursos)</SelectItem>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Si lo asocias a un curso, los selectores de video (sesiones, talleres, exámenes,
                  proyectos) de ese curso lo verán además de los globales.
                </p>
              </div>
            </TabsContent>
          </Tabs>

          {/* Progress bar de upload — vive FUERA del TabsContent y arriba
              del footer para que sea siempre visible. Antes estaba al
              final del tab "upload": cuando el form crecía (file +
              descripción + curso + helpers), la barra quedaba abajo del
              scroll viewport del dialog y el alumno no veía el avance. */}
          {saving && uploadPct > 0 && (
            <div className="space-y-1 border-t pt-3">
              <Progress value={uploadPct} />
              <p className="text-[11px] text-muted-foreground">Subiendo… {uploadPct}%</p>
            </div>
          )}

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
