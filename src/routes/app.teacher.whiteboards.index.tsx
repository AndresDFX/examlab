/**
 * Whiteboards (docente) — `/app/teacher/whiteboards`
 *
 * Lista de pizarras standalone del docente + creación + eliminación.
 * El editor vive en una ruta hija `/$id` para que cada pizarra tenga
 * URL propia (compartible, bookmarkable).
 *
 * Las pizarras de SESIÓN no aparecen acá — viven dentro de la sesión
 * presencial (attendance) y se acceden desde el botón "Pizarra" allí.
 *
 * RLS: el docente ve solo las suyas. Admin/SA ven todas en el tenant.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { softDelete, softDeleteMany } from "@/modules/trash/soft-delete";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { DateCell } from "@/components/ui/date-cell";
import { SearchInput } from "@/components/ui/search-input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  SortableHead,
} from "@/components/ui/table";
import { usePagination } from "@/hooks/use-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { DataPagination } from "@/components/ui/data-pagination";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { filterWhiteboards } from "@/modules/whiteboard/whiteboards-filter";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Palette, Globe, Lock, BookOpen, Copy, Eye } from "lucide-react";
import { DuplicateOptionsDialog } from "@/shared/components/DuplicateOptionsDialog";
import { StatCard } from "@/components/ui/stat-card";
import { HelpHint } from "@/components/ui/help-hint";
import { formatDate } from "@/shared/lib/format";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";

// Convención TanStack: para tener LIST en `/app/teacher/whiteboards` y
// DETALLE en `/app/teacher/whiteboards/$id` SIN tener que renderizar
// <Outlet /> manualmente en un layout, este archivo se llama
// `.index.tsx` (mismo patrón que app.teacher.exams.index.tsx). Antes
// vivía como `app.teacher.whiteboards.tsx` (layout) + `.$id.tsx` (child)
// — pero el layout no renderizaba Outlet, así que navegar a un id
// dejaba "la lista visible y el editor invisible". Con `.index.tsx`
// TanStack auto-crea el layout vacío que sirve de container al child.
export const Route = createFileRoute("/app/teacher/whiteboards/")({
  component: TeacherWhiteboards,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Whiteboard {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  course_id: string | null;
  is_shared_with_course: boolean;
}

function TeacherWhiteboards() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [items, setItems] = useState<Whiteboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  // Create dialog state.
  const [createOpen, setCreateOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftCourseId, setDraftCourseId] = useState<string>("none");
  const [draftSessionId, setDraftSessionId] = useState<string>("none");
  const [saving, setSaving] = useState(false);
  // Guard "cambios sin guardar" para el dialog de creación. Agrupa los
  // campos editables del draft en un memo (el hook compara por
  // JSON.stringify).
  const createFormMemo = useMemo(
    () => ({ draftName, draftDescription, draftCourseId, draftSessionId }),
    [draftName, draftDescription, draftCourseId, draftSessionId],
  );
  const createDirty = useDirtyDialog(createOpen, createFormMemo);
  // Cursos del docente (cargados al abrir el dialog). Mismo patrón que
  // /app/teacher/whiteboards/$id (selector de "compartir con curso").
  const [draftCourses, setDraftCourses] = useState<Array<{ id: string; name: string }>>([]);
  // Sesiones del curso seleccionado (cargadas cuando draftCourseId
  // cambia). Si el curso no tiene sesiones, el array queda vacío y
  // el selector de sesión no se muestra.
  const [draftSessions, setDraftSessions] = useState<
    Array<{ id: string; session_date: string; title: string | null }>
  >([]);
  const [loadingSessions, setLoadingSessions] = useState(false);

  // Cargar cursos del docente al abrir el dialog (lazy — no en mount).
  useEffect(() => {
    if (!createOpen || !user) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await db
          .from("course_teachers")
          // deleted_at en el embed para saltar cursos en papelera en JS
          // (PostgREST no filtra fácil en embeds anidados).
          .select("course_id, courses(id, name, deleted_at)")
          .eq("user_id", user.id);
        if (cancelled) return;
        const list = (
          (data ?? []) as Array<{
            courses: { id: string; name: string; deleted_at: string | null } | null;
          }>
        )
          .map((r) => r.courses)
          .filter(
            (c): c is { id: string; name: string; deleted_at: string | null } =>
              Boolean(c) && !c!.deleted_at,
          )
          .map((c) => ({ id: c.id, name: c.name }));
        setDraftCourses(list);
      } catch {
        /* silent — el draft sigue funcionando sin curso */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [createOpen, user]);

  // Cuando se elige curso, cargar sus sesiones. Si cambia a "none" o a
  // otro curso, resetear session selector.
  useEffect(() => {
    setDraftSessionId("none");
    if (draftCourseId === "none") {
      setDraftSessions([]);
      return;
    }
    let cancelled = false;
    setLoadingSessions(true);
    void (async () => {
      try {
        const { data } = await db
          .from("attendance_sessions")
          .select("id, session_date, title")
          .eq("course_id", draftCourseId)
          // No listar sesiones en papelera en el selector de sesión.
          .is("deleted_at", null)
          .order("session_date", { ascending: false });
        if (cancelled) return;
        setDraftSessions(
          (data ?? []) as Array<{ id: string; session_date: string; title: string | null }>,
        );
      } catch {
        setDraftSessions([]);
      } finally {
        if (!cancelled) setLoadingSessions(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftCourseId]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("whiteboards")
      .select(
        "id, owner_id, name, description, created_at, updated_at, course_id, is_shared_with_course",
      )
      // Ocultar pizarras en papelera de la lista del docente.
      .is("deleted_at", null)
      .order("updated_at", { ascending: false });
    if (error) {
      setLoadError(
        friendlyError(error, i18n.t("hc_routesAppTeacherWhiteboardsIndex.loadErrorFallback")),
      );
      setLoading(false);
      return;
    }
    setItems((data ?? []) as Whiteboard[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  // Filtro por nombre/descripción extraído a `whiteboards-filter.ts` (puro,
  // testeable sin React). El orden por columna lo maneja `useTableSort`
  // sobre la lista ya filtrada (flujo: filtrar → ORDENAR → paginar). El
  // accessor de curso resuelve el nombre desde `draftCourses` (cargado al
  // abrir el dialog de creación); si todavía está vacío, ordena por "".
  const sort = useTableSort(filterWhiteboards(items, search), {
    columns: {
      name: (w) => w.name,
      course: (w) => draftCourses.find((c) => c.id === w.course_id)?.name ?? "",
      shared: (w) => w.is_shared_with_course,
      updated_at: (w) => w.updated_at,
    },
    defaultSort: { key: "updated_at", dir: "desc" },
    storageKey: "examlab_sort:teacher_whiteboards",
  });

  // Stats compactas arriba del listado — mismo patrón que proyectos /
  // talleres / exámenes (4 tiles de cuenta por estado). Para pizarras
  // los estados conceptuales son: total, compartidas con curso (visibles
  // a los alumnos), privadas (solo el docente), y asociadas a un curso
  // (con o sin compartir). NO hay draft/published — la persistencia
  // es siempre real-time; el toggle "compartir" hace el rol de
  // visibilidad para alumnos.
  const whiteboardStats = useMemo(() => {
    let shared = 0;
    let priv = 0;
    let inCourse = 0;
    for (const w of items) {
      if (w.is_shared_with_course) shared += 1;
      else priv += 1;
      if (w.course_id) inCourse += 1;
    }
    return { total: items.length, shared, priv, inCourse };
  }, [items]);

  // Paginación client-side — default de grids de listado (25 / 10-25-50-100),
  // igual que Exámenes/Talleres/Proyectos ahora que es tabla y no cards.
  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:teacher_whiteboards",
    resetKey: `${search}|${sort.resetKey}`,
  });

  // Multi-selección + bulk delete — mismo patrón que cursos, usuarios,
  // exámenes, talleres y proyectos. Opera sobre `sort.sorted`
  // (no sobre `paginatedItems`) para que "seleccionar todos" abarque
  // todas las páginas del filtro activo.
  const sel = useMultiSelect(sort.sorted);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  // Pizarra a duplicar — abre el DuplicateOptionsDialog parametrizable.
  const [duplicateFor, setDuplicateFor] = useState<Whiteboard | null>(null);
  const bulkDeleteWhiteboards = async (ids: string[]) => {
    if (ids.length === 0) return;
    const { error } = await softDeleteMany("whiteboards", ids);
    if (error) {
      toast.error(
        friendlyError(error, t("hc_routesAppTeacherWhiteboardsIndex.bulkTrashError")),
      );
      throw error;
    }
    setItems((prev) => prev.filter((p) => !ids.includes(p.id)));
    sel.clear();
    const isOne = ids.length === 1;
    toast.success(
      i18n.t("toast.routes_app_teacher_whiteboards_index.bulkSentToTrash", {
        defaultValue: "{{count}} {{noun}} {{verb}} a papelera",
        count: ids.length,
        noun: isOne ? "pizarra" : "pizarras",
        verb: isOne ? "enviada" : "enviadas",
      }),
    );
  };

  const resetCreateDialog = () => {
    setDraftName("");
    setDraftDescription("");
    setDraftCourseId("none");
    setDraftSessionId("none");
    setDraftSessions([]);
  };

  const createWhiteboard = async () => {
    if (!user) return;
    if (!draftName.trim()) {
      toast.error(
        i18n.t("toast.routes_app_teacher_whiteboards_index.nameRequired", {
          defaultValue: "Dale un nombre a la pizarra",
        }),
      );
      return;
    }
    // Si se eligió una sesión, también debe haber un curso (la sesión
    // pertenece a un curso). El trigger SQL valida esto pero atajamos
    // client-side con un toast más amigable.
    if (draftSessionId !== "none" && draftCourseId === "none") {
      toast.error(
        i18n.t("toast.routes_app_teacher_whiteboards_index.sessionNeedsCourse", {
          defaultValue: "Si elegís una sesión, primero hay que elegir el curso.",
        }),
      );
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        owner_id: user.id,
        name: draftName.trim(),
        description: draftDescription.trim() || null,
      };
      // course_id y attendance_session_id solo se mandan si el usuario
      // los seleccionó. Mandar `null` también funcionaría pero
      // omitirlos hace explícito en el payload qué se está creando.
      if (draftCourseId !== "none") {
        payload.course_id = draftCourseId;
        // Por defecto, una pizarra asociada a un curso se COMPARTE con los
        // estudiantes (la ven en /app/student/whiteboards). El docente puede
        // dejar de compartirla luego desde el editor (toggle "Compartir con
        // alumnos"). Sin curso no aplica (is_shared_with_course queda false).
        payload.is_shared_with_course = true;
      }
      if (draftSessionId !== "none") payload.attendance_session_id = draftSessionId;
      const { data, error } = await db.from("whiteboards").insert(payload).select("id").single();
      if (error || !data) {
        toast.error(friendlyError(error, t("hc_routesAppTeacherWhiteboardsIndex.createError")));
        return;
      }
      toast.success(
        i18n.t("toast.routes_app_teacher_whiteboards_index.created", {
          defaultValue: "Pizarra creada",
        }),
      );
      setCreateOpen(false);
      resetCreateDialog();
      // Navegamos directo al editor — el flujo "click para abrir" es
      // implícito tras crear.
      navigate({ to: "/app/teacher/whiteboards/$id", params: { id: data.id } });
    } catch (e) {
      // Caller: `() => void createWhiteboard()` desde onClick del botón
      // del dialog. Sin catch acá, una rejection del insert (network
      // throw, RLS panic) burbujea como unhandled rejection → audit log.
      toast.error(friendlyError(e, t("hc_routesAppTeacherWhiteboardsIndex.createError")));
    } finally {
      setSaving(false);
    }
  };

  const deleteWhiteboard = async (w: Whiteboard) => {
    const ok = await confirm({
      title: t("hc_routesAppTeacherWhiteboardsIndex.deleteConfirmTitle"),
      description: t("hc_routesAppTeacherWhiteboardsIndex.deleteConfirmDescription", {
        name: w.name,
      }),
      tone: "destructive",
      confirmLabel: t("hc_routesAppTeacherWhiteboardsIndex.deleteConfirmLabel"),
    });
    if (!ok) return;
    try {
      const { error } = await softDelete("whiteboards", w.id);
      if (error) {
        toast.error(friendlyError(error, t("hc_routesAppTeacherWhiteboardsIndex.deleteTrashError")));
        return;
      }
      toast.success(
        i18n.t("toast.routes_app_teacher_whiteboards_index.sentToTrash", {
          defaultValue: "Pizarra enviada a papelera",
        }),
      );
      setItems((prev) => prev.filter((p) => p.id !== w.id));
    } catch (e) {
      // Caller: `() => void deleteWhiteboard(w)` desde el RowActionsMenu de
      // la fila. Mismo riesgo que createWhiteboard — envolvemos para capturar
      // rejections del network/RLS y mostrar toast amigable.
      toast.error(friendlyError(e, t("hc_routesAppTeacherWhiteboardsIndex.deleteError")));
    }
  };

  /** Duplica una pizarra: crea una fila nueva (mía, en borrador de
   *  contenido) y, según los flags, copia las hojas (whiteboard_pages) y la
   *  asociación al curso. NUNCA copia el vínculo a la sesión (es de la
   *  instancia puntual de clase) ni el flag de compartida. Lanza si algo
   *  falla — el DuplicateOptionsDialog lo captura y muestra el toast. */
  const duplicateWhiteboard = async (
    w: Whiteboard,
    opts: { copyContent: boolean; copyCourse: boolean },
  ) => {
    if (!user) return;
    const copyName = t("hc_routesAppTeacherWhiteboardsIndex.copyOfName", { name: w.name });
    const payload: Record<string, unknown> = {
      owner_id: user.id,
      name: copyName,
      description: w.description,
    };
    if (opts.copyCourse && w.course_id) payload.course_id = w.course_id;
    const { data: created, error: insErr } = await db
      .from("whiteboards")
      .insert(payload)
      .select("id")
      .single();
    if (insErr || !created?.id) throw insErr ?? new Error("insert failed");
    const newId = created.id as string;

    if (opts.copyContent) {
      const { data: pages, error: pagesErr } = await db
        .from("whiteboard_pages")
        .select("position, name, scene_json, page_type")
        .eq("whiteboard_id", w.id)
        .order("position");
      if (pagesErr) {
        // Rollback: dejamos la pizarra sin contenido en vez de a medias.
        await db.from("whiteboards").delete().eq("id", newId);
        throw pagesErr;
      }
      const rows = (pages ?? []) as Array<{
        position: number;
        name: string | null;
        scene_json: unknown;
        page_type: string | null;
      }>;
      if (rows.length > 0) {
        const { error: copyErr } = await db.from("whiteboard_pages").insert(
          rows.map((p) => ({
            whiteboard_id: newId,
            position: p.position,
            name: p.name,
            scene_json: p.scene_json,
            page_type: p.page_type,
          })),
        );
        if (copyErr) {
          await db.from("whiteboards").delete().eq("id", newId);
          throw copyErr;
        }
      }
    }

    toast.success(
      i18n.t("toast.routes_app_teacher_whiteboards_index.duplicated", {
        defaultValue: 'Pizarra duplicada: "{{name}}"',
        name: copyName,
      }),
    );
    setRetryNonce((n) => n + 1);
  };

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<Palette className="h-6 w-6 text-primary" />}
          title={t("hc_routesAppTeacherWhiteboardsIndex.pageTitle")}
          subtitle={t("hc_routesAppTeacherWhiteboardsIndex.pageSubtitle")}
        />
        <ErrorState
          message={t("hc_routesAppTeacherWhiteboardsIndex.loadErrorMessage")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Palette className="h-6 w-6 text-primary" />}
        title={t("hc_routesAppTeacherWhiteboardsIndex.pageTitle")}
        subtitle={
          items.length > 0
            ? t("hc_routesAppTeacherWhiteboardsIndex.subtitleCount", { count: items.length })
            : t("hc_routesAppTeacherWhiteboardsIndex.pageSubtitle")
        }
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)} data-tour-id="create-whiteboard">
            <Plus className="h-4 w-4 mr-1" />
            {t("hc_routesAppTeacherWhiteboardsIndex.newWhiteboard")}
          </Button>
        }
      />

      {/* Stats 4-card — siempre visible. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Palette}
          label={t("hc_routesAppTeacherWhiteboardsIndex.statTotal")}
          value={whiteboardStats.total}
        />
        <StatCard
          icon={Globe}
          label={t("hc_routesAppTeacherWhiteboardsIndex.statShared")}
          value={whiteboardStats.shared}
          tone={whiteboardStats.shared > 0 ? "success" : "default"}
        />
        <StatCard
          icon={Lock}
          label={t("hc_routesAppTeacherWhiteboardsIndex.statPrivate")}
          value={whiteboardStats.priv}
        />
        <StatCard
          icon={BookOpen}
          label={t("hc_routesAppTeacherWhiteboardsIndex.statInCourse")}
          value={whiteboardStats.inCourse}
        />
      </div>

      <div className="flex-1 min-w-0">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t("hc_routesAppTeacherWhiteboardsIndex.searchPlaceholder")}
        />
      </div>

      {/* Toolbar de bulk delete — solo se renderiza cuando hay items
          seleccionados. Mismo patrón que el resto de listados
          (proyectos, talleres, exámenes, cursos). */}
      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular={t("hc_routesAppTeacherWhiteboardsIndex.entitySingular")}
        entityNamePlural={t("hc_routesAppTeacherWhiteboardsIndex.entityPlural")}
      />

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
              <Spinner size="sm" /> {t("hc_routesAppTeacherWhiteboardsIndex.loading")}
            </div>
          ) : (
            // Grid estándar de tabla — mismo patrón que Exámenes / Talleres /
            // Proyectos (Table fixed resizable + SortableHead + RowActionsMenu).
            <Table fixed resizable>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <MultiSelectHeaderCheckbox state={sel} />
                  </TableHead>
                  <SortableHead sortKey="name" sort={sort}>
                    {t("hc_routesAppTeacherWhiteboardsIndex.colName")}
                  </SortableHead>
                  <SortableHead sortKey="course" sort={sort} className="hidden sm:table-cell w-40">
                    {t("hc_routesAppTeacherWhiteboardsIndex.colCourse")}
                  </SortableHead>
                  <SortableHead sortKey="shared" sort={sort} className="hidden md:table-cell w-28">
                    {t("hc_routesAppTeacherWhiteboardsIndex.colVisibility")}
                  </SortableHead>
                  <SortableHead
                    sortKey="updated_at"
                    sort={sort}
                    className="hidden lg:table-cell w-40"
                  >
                    {t("hc_routesAppTeacherWhiteboardsIndex.colUpdated")}
                  </SortableHead>
                  <TableHead className="text-right w-16">
                    {t("hc_routesAppTeacherWhiteboardsIndex.colActions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sort.sorted.length === 0 ? (
                  <TableEmpty
                    colSpan={6}
                    icon={Palette}
                    text={
                      search.trim()
                        ? t("hc_routesAppTeacherWhiteboardsIndex.emptySearchText")
                        : t("hc_routesAppTeacherWhiteboardsIndex.emptyText")
                    }
                    hint={
                      search.trim()
                        ? t("hc_routesAppTeacherWhiteboardsIndex.emptySearchHint")
                        : t("hc_routesAppTeacherWhiteboardsIndex.emptyHint")
                    }
                    action={
                      !search.trim() ? (
                        <Button size="sm" onClick={() => setCreateOpen(true)}>
                          <Plus className="h-4 w-4 mr-1" />
                          {t("hc_routesAppTeacherWhiteboardsIndex.createWhiteboard")}
                        </Button>
                      ) : undefined
                    }
                  />
                ) : null}
                {pagination.paginatedItems.map((w) => {
                  const courseName = w.course_id
                    ? (draftCourses.find((c) => c.id === w.course_id)?.name ?? "—")
                    : "—";
                  return (
                    <TableRow
                      key={w.id}
                      data-state={sel.isSelected(w.id) ? "selected" : undefined}
                    >
                      <TableCell className="w-10">
                        <MultiSelectCheckbox id={w.id} state={sel} />
                      </TableCell>
                      <TableCell className="font-medium">
                        <div className="flex flex-col gap-0.5 min-w-0">
                          <Link
                            to="/app/teacher/whiteboards/$id"
                            params={{ id: w.id }}
                            className="font-medium hover:underline truncate"
                            title={w.name}
                          >
                            {w.name}
                          </Link>
                          {w.description && (
                            <span className="text-xs text-muted-foreground truncate">
                              {w.description}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm hidden sm:table-cell">
                        <div className="truncate" title={courseName}>
                          {courseName}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant={w.is_shared_with_course ? "default" : "secondary"}>
                          {w.is_shared_with_course
                            ? t("hc_routesAppTeacherWhiteboardsIndex.badgeShared")
                            : t("hc_routesAppTeacherWhiteboardsIndex.badgePrivate")}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <DateCell value={w.updated_at} variant="datetime" />
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            {
                              label: t("hc_routesAppTeacherWhiteboardsIndex.actionOpen"),
                              icon: Eye,
                              to: "/app/teacher/whiteboards/$id",
                              params: { id: w.id },
                            },
                            {
                              label: t("hc_routesAppTeacherWhiteboardsIndex.actionDuplicate"),
                              icon: Copy,
                              onClick: () => setDuplicateFor(w),
                            },
                            {
                              label: t("hc_routesAppTeacherWhiteboardsIndex.actionDelete"),
                              icon: Trash2,
                              tone: "destructive",
                              separatorBefore: true,
                              onClick: () => void deleteWhiteboard(w),
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <DataPagination
            state={pagination}
            entityNamePlural={t("hc_routesAppTeacherWhiteboardsIndex.entityPlural")}
          />
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={createDirty.guardOpenChange((open) => {
          setCreateOpen(open);
          if (!open) resetCreateDialog();
        })}
      >
        <DialogContent
          className="max-w-[calc(100vw-2rem)] sm:max-w-md"
          data-tour-id="dialog-whiteboard"
        >
          <DialogHeader>
            <DialogTitle>{t("hc_routesAppTeacherWhiteboardsIndex.dialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("hc_routesAppTeacherWhiteboardsIndex.dialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div data-tour-id="whiteboard-field-name">
              <Label required>{t("hc_routesAppTeacherWhiteboardsIndex.fieldName")}</Label>
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t("hc_routesAppTeacherWhiteboardsIndex.fieldNamePlaceholder")}
                autoFocus
              />
            </div>
            <div data-tour-id="whiteboard-field-description">
              <Label>{t("hc_routesAppTeacherWhiteboardsIndex.fieldDescription")}</Label>
              <Textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                rows={2}
                placeholder={t("hc_routesAppTeacherWhiteboardsIndex.fieldDescriptionPlaceholder")}
              />
            </div>
            <div data-tour-id="whiteboard-field-course">
              <Label>
                {t("hc_routesAppTeacherWhiteboardsIndex.fieldCourse")}{" "}
                <HelpHint>{t("help.whiteboardCourseSharingHelp")}</HelpHint>
              </Label>
              <Select value={draftCourseId} onValueChange={setDraftCourseId}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={t("hc_routesAppTeacherWhiteboardsIndex.coursePlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {t("hc_routesAppTeacherWhiteboardsIndex.courseNone")}
                  </SelectItem>
                  {draftCourses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {draftCourseId !== "none" && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("hc_routesAppTeacherWhiteboardsIndex.courseShareNote")}
                </p>
              )}
            </div>
            {/* El selector de sesión solo se muestra cuando hay un curso
                seleccionado Y el curso tiene sesiones registradas. Si el
                curso es de modelo "sin sesiones" (solo material), el
                Select no aparece y la pizarra queda asociada al curso
                en general. Multiple pizarras por sesión están permitidas
                (sin UNIQUE constraint en attendance_session_id). */}
            {draftCourseId !== "none" && (
              <div>
                <Label>
                  {t("hc_routesAppTeacherWhiteboardsIndex.fieldSession")}{" "}
                  <HelpHint>{t("help.whiteboardSessionBindingHelp")}</HelpHint>
                </Label>
                {loadingSessions ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                    <Spinner size="xs" />{" "}
                    {t("hc_routesAppTeacherWhiteboardsIndex.loadingSessions")}
                  </div>
                ) : draftSessions.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">
                    {t("hc_routesAppTeacherWhiteboardsIndex.noSessionsNote")}
                  </p>
                ) : (
                  <Select value={draftSessionId} onValueChange={setDraftSessionId}>
                    <SelectTrigger>
                      <SelectValue
                        placeholder={t("hc_routesAppTeacherWhiteboardsIndex.sessionPlaceholder")}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        {t("hc_routesAppTeacherWhiteboardsIndex.sessionNone")}
                      </SelectItem>
                      {draftSessions.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {formatDate(s.session_date)}
                          {s.title ? ` · ${s.title}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={saving}>
              {t("hc_routesAppTeacherWhiteboardsIndex.cancel")}
            </Button>
            <Button onClick={() => void createWhiteboard()} disabled={saving}>
              {saving && <Spinner size="sm" className="mr-1" />}
              {t("hc_routesAppTeacherWhiteboardsIndex.createAndOpen")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete dialog — abrirá el modal con conteo + preview
          expandible (5 items + el resto al click "Ver todos"). Llama
          a `bulkDeleteWhiteboards` que hace `.in('id', ids)` atómico. */}
      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={sort.sorted
          .filter((w) => sel.isSelected(w.id))
          .map((w) => ({ id: w.id, label: w.name }))}
        entityNameSingular={t("hc_routesAppTeacherWhiteboardsIndex.entitySingular")}
        entityNamePlural={t("hc_routesAppTeacherWhiteboardsIndex.entityPlural")}
        onConfirm={bulkDeleteWhiteboards}
      />

      <DuplicateOptionsDialog
        open={duplicateFor !== null}
        onOpenChange={(o) => !o && setDuplicateFor(null)}
        title={t("hc_routesAppTeacherWhiteboardsIndex.duplicateTitle")}
        description={<>{t("hc_routesAppTeacherWhiteboardsIndex.duplicateDescription")}</>}
        options={[
          {
            param: "copyContent",
            label: t("hc_routesAppTeacherWhiteboardsIndex.duplicateCopyContentLabel"),
            hint: t("hc_routesAppTeacherWhiteboardsIndex.duplicateCopyContentHint"),
          },
          {
            param: "copyCourse",
            label: t("hc_routesAppTeacherWhiteboardsIndex.duplicateCopyCourseLabel"),
            hint: duplicateFor?.course_id
              ? t("hc_routesAppTeacherWhiteboardsIndex.duplicateCopyCourseHint")
              : t("hc_routesAppTeacherWhiteboardsIndex.duplicateCopyCourseHintNone"),
          },
        ]}
        onConfirm={async (flags) => {
          if (duplicateFor)
            await duplicateWhiteboard(duplicateFor, {
              copyContent: flags.copyContent !== false,
              copyCourse: flags.copyCourse !== false,
            });
        }}
      />
    </div>
  );
}
