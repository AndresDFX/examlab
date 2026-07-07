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
import { PageLoader } from "@/components/ui/loaders";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/ui/page-header";
import { StatCard } from "@/components/ui/stat-card";
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
  SortableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTableSort } from "@/hooks/use-table-sort";
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
  Trash2,
  Upload,
  Link as LinkIcon,
  Edit2,
  Globe,
} from "lucide-react";
import { useActiveRole } from "@/hooks/use-active-role";
import { formatFileSize } from "@/shared/lib/format";
import { friendlyError } from "@/shared/lib/db-errors";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";

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
  /** Tenant dueño del video. NULL = PLATFORM-GLOBAL: lo subió el
   *  SuperAdmin y es visible/referenciable por cualquier institución
   *  (mig 20260722000000_videos_platform_global). El UI lo muestra con
   *  un badge "🌐 Global plataforma" para que el docente entienda que
   *  ese video viene del catálogo central. */
  tenant_id: string | null;
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
  const { t } = useTranslation();
  const { user, roles, loading: authLoading } = useAuth();
  const activeRole = useActiveRole();
  const confirm = useConfirm();
  // SuperAdmin se considera "staff" para gestionar la biblioteca de
  // videos — además puede marcar videos como platform-global (toggle
  // específico que aparece más abajo solo cuando actúa como SuperAdmin).
  const isStaff =
    roles.includes("Docente") || roles.includes("Admin") || roles.includes("SuperAdmin");
  // El SuperAdmin actuando como tal puede publicar videos como
  // PLATFORM-GLOBAL (mig 20260722000000): `tenant_id IS NULL` los
  // hace visibles a TODOS los tenants. Cuando un usuario tiene el rol
  // pero está actuando como otro rol (Admin/Docente con role-switcher),
  // este toggle se oculta — solo aplica al SuperAdmin "puro".
  const isSuperAdminActive = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");
  const [rows, setRows] = useState<VideoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<VideoRow | null>(null);
  const [mode, setMode] = useState<"url" | "upload">("url");
  const [form, setForm] = useState({
    title: "",
    description: "",
    url: "",
    courseId: "",
    // SuperAdmin-only: publicar como video del catálogo global de
    // plataforma (tenant_id NULL). Default false para que un SuperAdmin
    // que esté gestionando un tenant concreto no publique global por
    // accidente — explícito siempre.
    publishAsGlobal: false,
  });
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  // Filtros del grid — search (título/descripción) + curso. null = sin filtro
  // de curso (incluye videos globales y de cualquier curso).
  const [search, setSearch] = useState("");
  const [filterCourseId, setFilterCourseId] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseOption[]>([]);
  // Tenants — solo el SuperAdmin ve la lista. La RLS acota a 1 para
  // Admin/Docente normal y el filtro UI no se renderiza.
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  // Filtro por institución para SuperAdmin. "all" = sin filtro,
  // "global" = solo videos del catálogo global (tenant_id NULL),
  // <uuid> = solo videos de ese tenant.
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    let q = db.from("videos").select("*").order("created_at", { ascending: false });
    // Filtro server-side por institución (solo SuperAdmin). "global"
    // mapea a `tenant_id IS NULL` (catálogo cross-tenant); un UUID
    // específico a `.eq("tenant_id", X)`. "all" = sin filtro.
    if (isSuperAdminActive && tenantFilter !== "all") {
      q = tenantFilter === "global" ? q.is("tenant_id", null) : q.eq("tenant_id", tenantFilter);
    }
    const { data, error } = await q;
    if (error) {
      setLoadError(friendlyError(error, t("videos.loadError")));
    } else {
      setRows((data ?? []) as VideoRow[]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    void (async () => {
      // Excluir cursos en papelera del selector de curso del form de video.
      const { data } = await db
        .from("courses")
        .select("id, name")
        .is("deleted_at", null)
        .order("name");
      setCourses((data ?? []) as CourseOption[]);
    })();
    // Tenants — solo el SuperAdmin los necesita para el Select.
    if (isSuperAdminActive) {
      void (async () => {
        const { data } = await db
          .from("tenants")
          .select("id, slug, name")
          .is("deleted_at", null)
          .order("name");
        setTenants((data ?? []) as Array<{ id: string; slug: string; name: string }>);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce, tenantFilter, isSuperAdminActive]);

  // Stats compactas arriba del listado — mismo patrón que proyectos /
  // talleres / exámenes / pizarras / contenidos / encuestas.
  // Estados conceptuales de un video:
  //   - En curso: course_id != null (atado a un curso específico)
  //   - Globales: course_id IS NULL (reutilizable, sin curso específico).
  //     Matchea con el badge "Global" de la columna Curso en la tabla.
  //     "En curso" + "Globales" cubren el total de videos (complementarios).
  //
  // El concepto "catálogo plataforma" (tenant_id IS NULL, publicado por
  // SuperAdmin) es distinto y se filtra desde el Select de scope
  // (tenantFilter="global"), no desde un stat.
  const videoStats = useMemo(() => {
    let global = 0;
    let inCourse = 0;
    for (const r of rows) {
      if (r.course_id) inCourse += 1;
      else global += 1;
    }
    return { total: rows.length, global, inCourse };
  }, [rows]);

  const visible = useMemo(
    () =>
      rows.filter((r) => {
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
    [rows, filterCourseId, search],
  );
  const courseNameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of courses) m[c.id] = c.name;
    return m;
  }, [courses]);

  // Orden por columna (click en el encabezado alterna asc/desc). Va ENTRE
  // el array filtrado y la paginación: filtrar → ordenar → paginar.
  const sort = useTableSort(visible, {
    columns: {
      title: (r) => r.title,
      // El tipo se muestra como "MP4" para `direct`; ordenamos por ese
      // mismo label para que el orden visible coincida con la columna.
      provider: (r) => (r.provider === "direct" ? "MP4" : r.provider),
      // Curso global (course_id NULL) se ordena por el label "Global"
      // que muestra la celda; los atados a curso por su nombre.
      course: (r) => (r.course_id ? (courseNameById[r.course_id] ?? "") : "Global"),
      created_at: (r) => r.created_at,
    },
    defaultSort: { key: "created_at", dir: "desc" },
    storageKey: "examlab_sort:videos",
  });

  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:videos",
    resetKey: `${search}|${filterCourseId ?? ""}|${tenantFilter}|${sort.resetKey}`,
  });

  const openNew = () => {
    setEditing(null);
    setForm({
      title: "",
      description: "",
      url: "",
      courseId: "",
      publishAsGlobal: false,
    });
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
      // Mantenemos el scope al editar: si la fila ya es global
      // (tenant_id NULL), el toggle viene marcado; si es del tenant,
      // queda desmarcado. El usuario puede cambiarlo si es SuperAdmin
      // y el UPDATE se persiste con tenant_id null o el del caller.
      publishAsGlobal: v.tenant_id === null,
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
      toast.error(
        i18n.t("toast.routes_app_videos.titleAndUrlRequired", {
          defaultValue: "Título y URL son obligatorios",
        }),
      );
      return;
    }
    const provider = detectProvider(url);
    if (!provider) {
      toast.error(
        i18n.t("toast.routes_app_videos.urlNotRecognized", {
          defaultValue:
            "URL no reconocida. Usa YouTube, Vimeo o un archivo MP4/WebM directo (terminado en .mp4/.webm).",
        }),
      );
      return;
    }
    setSaving(true);
    // SuperAdmin con toggle "Global plataforma": publicamos tenant_id
    // NULL → visible cross-tenant. Para cualquier otro caller (o
    // SuperAdmin con toggle off) la fila va al tenant del caller — el
    // trigger `tg_videos_set_tenant` lo deriva si no se manda.
    const publishGlobal = isSuperAdminActive && form.publishAsGlobal;
    if (editing) {
      const updatePayload: Record<string, unknown> = {
        title,
        description: form.description.trim() || null,
        url,
        provider,
        course_id: form.courseId || null,
      };
      // Permitir AL SUPERADMIN cambiar el scope al editar (global ↔
      // tenant). Para el resto, no tocamos tenant_id (la RLS le impide
      // editar filas de otros tenants igual).
      if (isSuperAdminActive) {
        updatePayload.tenant_id = publishGlobal ? null : editing.tenant_id;
      }
      const { error } = await db.from("videos").update(updatePayload).eq("id", editing.id);
      setSaving(false);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(
        i18n.t("toast.routes_app_videos.videoUpdated", { defaultValue: "Video actualizado" }),
      );
    } else {
      const insertPayload: Record<string, unknown> = {
        title,
        description: form.description.trim() || null,
        url,
        provider,
        uploaded_by: user.id,
        course_id: form.courseId || null,
      };
      if (publishGlobal) insertPayload.tenant_id = null;
      const { error } = await db.from("videos").insert(insertPayload);
      setSaving(false);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(
        publishGlobal
          ? i18n.t("toast.routes_app_videos.videoAddedGlobal", {
              defaultValue: "Video agregado al catálogo global",
            })
          : i18n.t("toast.routes_app_videos.videoAddedLibrary", {
              defaultValue: "Video agregado a la biblioteca",
            }),
      );
    }
    setDialogOpen(false);
    await load();
  };

  const saveUpload = async () => {
    if (!user) return;
    const title = form.title.trim();
    if (!title) {
      toast.error(
        i18n.t("toast.routes_app_videos.titleRequired", {
          defaultValue: "El título es obligatorio",
        }),
      );
      return;
    }
    const publishGlobal = isSuperAdminActive && form.publishAsGlobal;
    // En edición sin nuevo archivo: solo guardamos metadatos.
    if (editing && !file) {
      setSaving(true);
      const updatePayload: Record<string, unknown> = {
        title,
        description: form.description.trim() || null,
        course_id: form.courseId || null,
      };
      if (isSuperAdminActive) {
        updatePayload.tenant_id = publishGlobal ? null : editing.tenant_id;
      }
      const { error } = await db.from("videos").update(updatePayload).eq("id", editing.id);
      setSaving(false);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(
        i18n.t("toast.routes_app_videos.videoUpdated", { defaultValue: "Video actualizado" }),
      );
      setDialogOpen(false);
      await load();
      return;
    }
    if (!file) {
      toast.error(
        i18n.t("toast.routes_app_videos.selectVideoFile", {
          defaultValue: "Selecciona un archivo de video",
        }),
      );
      return;
    }
    if (!ACCEPTED_VIDEO_MIME.includes(file.type)) {
      toast.error(
        i18n.t("toast.routes_app_videos.fileTypeNotAllowed", {
          defaultValue: "Tipo de archivo no permitido ({{fileType}}). Sube MP4, WebM o MOV.",
          fileType: file.type || "desconocido",
        }),
      );
      return;
    }
    if (file.size > MAX_VIDEO_BYTES) {
      toast.error(
        i18n.t("toast.routes_app_videos.fileTooLarge", {
          defaultValue: "Archivo demasiado grande ({{size}}). El máximo es 500 MB.",
          size: formatFileSize(file.size),
        }),
      );
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
      toast.error(
        i18n.t("toast.routes_app_videos.uploadError", {
          defaultValue: "Error al subir el video: {{error}}",
          error: friendlyError(upErr),
        }),
      );
      return;
    }
    setUploadPct(80);
    const { data: pub } = supabase.storage.from("videos").getPublicUrl(objectName);
    const publicUrl = pub.publicUrl;
    if (!publicUrl) {
      setSaving(false);
      setUploadPct(0);
      toast.error(
        i18n.t("toast.routes_app_videos.publicUrlFailed", {
          defaultValue: "No se pudo obtener la URL pública del video subido",
        }),
      );
      return;
    }
    if (editing && editing.storage_path) {
      // Reemplazo: subimos el nuevo, actualizamos la fila, y al final
      // borramos el viejo en background (no bloquea la UX).
      const oldPath = editing.storage_path;
      const updatePayload: Record<string, unknown> = {
        title,
        description: form.description.trim() || null,
        url: publicUrl,
        provider: "direct",
        storage_path: objectName,
        course_id: form.courseId || null,
      };
      if (isSuperAdminActive) {
        updatePayload.tenant_id = publishGlobal ? null : editing.tenant_id;
      }
      const { error } = await db.from("videos").update(updatePayload).eq("id", editing.id);
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
      toast.success(
        i18n.t("toast.routes_app_videos.videoReplaced", { defaultValue: "Video reemplazado" }),
      );
    } else {
      const insertPayload: Record<string, unknown> = {
        title,
        description: form.description.trim() || null,
        url: publicUrl,
        provider: "direct",
        uploaded_by: user.id,
        storage_path: objectName,
        course_id: form.courseId || null,
      };
      if (publishGlobal) insertPayload.tenant_id = null;
      const { error } = await db.from("videos").insert(insertPayload);
      if (error) {
        setSaving(false);
        setUploadPct(0);
        void supabase.storage.from("videos").remove([objectName]);
        toast.error(friendlyError(error));
        return;
      }
      setUploadPct(100);
      toast.success(
        publishGlobal
          ? i18n.t("toast.routes_app_videos.videoUploadedGlobal", {
              defaultValue: "Video subido al catálogo global",
            })
          : i18n.t("toast.routes_app_videos.videoUploadedLibrary", {
              defaultValue: "Video subido a la biblioteca",
            }),
      );
    }
    setSaving(false);
    setDialogOpen(false);
    await load();
  };

  const remove = async (v: VideoRow) => {
    const ok = await confirm({
      title: t("videosPage.removeConfirmTitle", {
        title: v.title,
        defaultValue: '¿Borrar "{{title}}"?',
      }),
      description: v.storage_path
        ? t("videosPage.removeConfirmDescWithFile", {
            defaultValue:
              "Se eliminará también el archivo subido. Los proyectos que lo referencian dejarán de mostrar el video (no rompen — el field queda null). Esta acción no se puede deshacer.",
          })
        : t("videosPage.removeConfirmDesc", {
            defaultValue:
              "Los proyectos que lo referencian dejarán de mostrar el video (no rompen — el field queda null). Esta acción no se puede deshacer.",
          }),
      tone: "destructive",
      confirmLabel: t("common.delete"),
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
          i18n.t("toast.routes_app_videos.videoDeletedOrphanFile", {
            defaultValue: "Video eliminado, pero quedó el archivo huérfano en Storage ({{error}})",
            error: stErr.message,
          }),
        );
      } else {
        toast.success(
          i18n.t("toast.routes_app_videos.videoDeleted", { defaultValue: "Video eliminado" }),
        );
      }
    } else {
      toast.success(
        i18n.t("toast.routes_app_videos.videoDeleted", { defaultValue: "Video eliminado" }),
      );
    }
    void load();
  };

  // Esperar a useAuth para evitar flash del gate con roles=[] hidratando.
  if (authLoading) return <PageLoader />;
  if (!isStaff) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("videos.roleGate")}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("videosPage.title")}
        subtitle={t("videosPage.subtitle")}
        icon={<VideoIcon className="h-6 w-6 text-cyan-500" />}
        actions={
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-1" />
            {t("videosPage.newVideo")}
          </Button>
        }
      />

      {/* Stats — patrón compartido (StatCard). Aparece SIEMPRE, incluso
          cuando rows.length === 0. Un dashboard de zeros es informativo y
          mantiene consistencia visual con el resto de los módulos. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          icon={VideoIcon}
          label={t("videosPage.statTotal")}
          value={videoStats.total}
          tone={videoStats.total > 0 ? "success" : "default"}
        />
        <StatCard
          icon={LinkIcon}
          label={t("videosPage.statInProgress")}
          value={videoStats.inCourse}
        />
        <StatCard icon={Globe} label={t("videosPage.statGlobal")} value={videoStats.global} />
      </div>

      <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
        <div className="flex-1 min-w-0">
          <ListFilters
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder={t("videosPage.searchPlaceholder")}
            courseId={filterCourseId}
            onCourseChange={setFilterCourseId}
            courses={courses}
          />
        </div>
        {/* SuperAdmin cross-tenant: filtro por institución + opción
            "Global plataforma" (videos con `tenant_id IS NULL`). El
            filtro se aplica server-side en `load()` para que la RLS
            cross-tenant del SuperAdmin no traiga toda la base. */}
        {isSuperAdminActive && tenants.length > 0 && (
          <Select value={tenantFilter} onValueChange={setTenantFilter}>
            <SelectTrigger className="w-full sm:w-56 h-9 text-xs">
              <SelectValue placeholder={t("videos.institutionPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("videos.allInstitutions")}</SelectItem>
              <SelectItem value="global">{t("videos.globalPlatform")}</SelectItem>
              {tenants.map((tn) => (
                <SelectItem key={tn.id} value={tn.id}>
                  {tn.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <TableSkeleton rows={5} cols={5} />
          ) : loadError ? (
            <ErrorState
              message={t("videosPage.loadError")}
              hint={loadError}
              onRetry={() => setRetryNonce((n) => n + 1)}
            />
          ) : (
            <Table resizable>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="title" sort={sort} className="max-w-[320px]">
                    {t("videosPage.colTitle")}
                  </SortableHead>
                  <SortableHead sortKey="provider" sort={sort} className="w-24">
                    {t("videosPage.colType")}
                  </SortableHead>
                  <SortableHead sortKey="course" sort={sort} className="w-40 hidden md:table-cell">
                    {t("videosPage.colCourse")}
                  </SortableHead>
                  <SortableHead
                    sortKey="created_at"
                    sort={sort}
                    className="w-32 hidden lg:table-cell"
                  >
                    {t("videosPage.colAdded")}
                  </SortableHead>
                  <TableHead className="w-16 text-right">{t("videosPage.colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0
                  ? (() => {
                      const filterActive = !!search || filterCourseId != null;
                      const noMatch = filterActive && rows.length > 0;
                      return (
                        <TableEmpty
                          colSpan={5}
                          text={noMatch ? t("videosPage.noResults") : t("videosPage.emptyTitle")}
                          hint={
                            noMatch ? t("common.tryClearFilter") : t("videosPage.emptySubtitle")
                          }
                          action={
                            noMatch ? undefined : (
                              <Button onClick={openNew}>
                                <Plus className="h-4 w-4 mr-1" />
                                {t("videosPage.newVideo")}
                              </Button>
                            )
                          }
                        />
                      );
                    })()
                  : pagination.paginatedItems.map((v) => (
                      <TableRow key={v.id}>
                        <TableCell className="max-w-md">
                          <div className="flex items-start gap-3">
                            <div className="h-9 w-9 rounded-md bg-cyan-500/10 flex items-center justify-center shrink-0">
                              <VideoIcon className="h-4 w-4 text-cyan-600" />
                            </div>
                            <div className="min-w-0">
                              <div
                                className="font-medium text-sm truncate flex items-center gap-1.5"
                                title={v.title}
                              >
                                <span className="truncate">{v.title}</span>
                                {/* Badge "Global plataforma" cuando
                                  tenant_id IS NULL — el catálogo central
                                  del SuperAdmin. Visible para cualquier
                                  caller que vea la fila vía RLS. */}
                                {v.tenant_id === null && (
                                  <Badge
                                    variant="outline"
                                    className="text-[9px] gap-0.5 border-violet-500/40 text-violet-600 dark:text-violet-400 shrink-0"
                                  >
                                    <Globe className="h-2.5 w-2.5" />
                                    {t("videosPage.globalBadge")}
                                  </Badge>
                                )}
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
                                <Upload className="h-2.5 w-2.5" />{" "}
                                {t("videosPage.badgeUploaded", { defaultValue: "Subido" })}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {v.course_id ? (
                            <div
                              className="text-xs truncate"
                              title={courseNameById[v.course_id] ?? "—"}
                            >
                              {courseNameById[v.course_id] ?? "—"}
                            </div>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">
                              {t("videosPage.courseGlobalBadge", { defaultValue: "Global" })}
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
                                label: t("videosPage.actionEdit"),
                                icon: Edit2,
                                onClick: () => openEdit(v),
                              },
                              {
                                label: t("videosPage.actionDelete"),
                                icon: Trash2,
                                tone: "destructive",
                                separatorBefore: true,
                                onClick: () => void remove(v),
                              },
                            ]}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
              </TableBody>
            </Table>
          )}
          <DataPagination state={pagination} entityNamePlural="videos" />
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(o) => !saving && setDialogOpen(o)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("videosPage.actionEdit") : t("videosPage.newVideo")}
            </DialogTitle>
          </DialogHeader>

          <Tabs
            value={mode}
            onValueChange={(v) => !saving && !editing && setMode(v as "url" | "upload")}
          >
            <TabsList className="w-full grid grid-cols-2">
              <TabsTrigger value="url" disabled={!!editing && mode !== "url"}>
                <LinkIcon className="h-3.5 w-3.5 mr-1.5" />{" "}
                {t("videos.tabUrl", { defaultValue: "URL externa" })}
              </TabsTrigger>
              <TabsTrigger value="upload" disabled={!!editing && mode !== "upload"}>
                <Upload className="h-3.5 w-3.5 mr-1.5" /> {t("videosPage.uploadVideo")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="url" className="space-y-3 mt-3">
              <div>
                <Label>{t("videos.fieldTitle")}</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder={t("videos.titlePlaceholder")}
                  disabled={saving}
                />
              </div>
              <div>
                <Label>URL</Label>
                <Input
                  value={form.url}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder={t("videos.urlPlaceholder")}
                  disabled={saving}
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  {t("videos.urlHint")}
                </p>
              </div>
              <div>
                <Label>{t("videos.descLabel")}</Label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder={t("videos.descPlaceholder")}
                  rows={3}
                  disabled={saving}
                />
              </div>
              <div>
                <Label>{t("videos.courseLabel")}</Label>
                <Select
                  value={form.courseId || "__none"}
                  onValueChange={(v) => setForm({ ...form, courseId: v === "__none" ? "" : v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("videos.globalOption")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t("videos.globalOption")}</SelectItem>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {t("videos.courseHint")}
                </p>
              </div>
            </TabsContent>

            <TabsContent value="upload" className="space-y-3 mt-3">
              <div>
                <Label>{t("videos.fieldTitle")}</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder={t("videos.titlePlaceholder")}
                  disabled={saving}
                />
              </div>
              <div>
                <Label>
                  {editing?.storage_path ? t("videos.replaceFile") : t("videos.videoFile")}
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
                    {t("videos.keepFile")}
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground mt-1">
                  {t("videos.formatsHint")}
                </p>
              </div>
              <div>
                <Label>{t("videos.descLabel")}</Label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder={t("videos.descPlaceholder")}
                  rows={3}
                  disabled={saving}
                />
              </div>
              <div>
                <Label>{t("videos.courseLabel")}</Label>
                <Select
                  value={form.courseId || "__none"}
                  onValueChange={(v) => setForm({ ...form, courseId: v === "__none" ? "" : v })}
                  disabled={saving}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("videos.globalOption")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t("videos.globalOption")}</SelectItem>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {t("videos.courseHint")}
                </p>
              </div>
            </TabsContent>
          </Tabs>

          {/* Toggle "{t("videos.globalCatalogToggle")}" — solo SuperAdmin
              activo. Aplica a AMBOS modos (URL + upload). tenant_id NULL
              en la fila resultante = visible y referenciable por
              cualquier institución (mig 20260722000000). */}
          {isSuperAdminActive && (
            <div className="rounded-md border border-violet-500/30 bg-violet-500/5 p-3">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-violet-500"
                  checked={form.publishAsGlobal}
                  onChange={(e) => setForm({ ...form, publishAsGlobal: e.target.checked })}
                  disabled={saving}
                />
                <div className="flex-1 text-xs">
                  <div className="font-medium flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5 text-violet-500" />
                    {t("videos.globalCatalogToggle")}
                  </div>
                  <p className="text-muted-foreground mt-0.5">
                    {t("videos.globalCatalogHint")}
                  </p>
                </div>
              </label>
            </div>
          )}

          {/* Progress bar de upload — vive FUERA del TabsContent y arriba
              del footer para que sea siempre visible. Antes estaba al
              final del tab "upload": cuando el form crecía (file +
              descripción + curso + helpers), la barra quedaba abajo del
              scroll viewport del dialog y el alumno no veía el avance. */}
          {saving && uploadPct > 0 && (
            <div className="space-y-1 border-t pt-3">
              <Progress value={uploadPct} />
              <p className="text-[11px] text-muted-foreground">{t("videos.uploading", { pct: uploadPct })}</p>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => void (mode === "url" ? saveUrl() : saveUpload())}
              disabled={saving}
            >
              {saving ? <Spinner size="sm" className="mr-1" /> : null}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
