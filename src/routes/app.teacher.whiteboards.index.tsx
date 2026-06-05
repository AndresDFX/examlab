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
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { RowAction } from "@/components/ui/row-action";
import { DateCell } from "@/components/ui/date-cell";
import { SearchInput } from "@/components/ui/search-input";
import { usePagination } from "@/hooks/use-pagination";
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
import {
  filterWhiteboards,
  sortWhiteboards,
  type WhiteboardSort,
} from "@/modules/whiteboard/whiteboards-filter";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Trash2, Palette } from "lucide-react";
import { StatTile } from "@/components/ui/stat-tile";
import { HelpHint } from "@/components/ui/help-hint";
import { formatDate } from "@/shared/lib/format";
import {
  useMultiSelect,
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
  const { user } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [items, setItems] = useState<Whiteboard[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  // Sort persistido en localStorage para que el docente vuelva al mismo
  // orden entre sesiones. Default "updated_desc" — la pizarra que tocó
  // más recientemente es la que típicamente quiere reabrir.
  const [sort, setSort] = useState<WhiteboardSort>(() => {
    if (typeof window === "undefined") return "updated_desc";
    const stored = window.localStorage.getItem("examlab_whiteboards_sort");
    return (stored as WhiteboardSort) || "updated_desc";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("examlab_whiteboards_sort", sort);
  }, [sort]);
  // Create dialog state.
  const [createOpen, setCreateOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftCourseId, setDraftCourseId] = useState<string>("none");
  const [draftSessionId, setDraftSessionId] = useState<string>("none");
  const [saving, setSaving] = useState(false);
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
          .select("course_id, courses(id, name)")
          .eq("user_id", user.id);
        if (cancelled) return;
        const list = ((data ?? []) as Array<{ courses: { id: string; name: string } | null }>)
          .map((r) => r.courses)
          .filter((c): c is { id: string; name: string } => Boolean(c));
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
      .order("updated_at", { ascending: false });
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar tus pizarras."));
      setLoading(false);
      return;
    }
    setItems((data ?? []) as Whiteboard[]);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  // Filter + sort extraídos a `whiteboards-filter.ts` para testear sin
  // React. Encadenados — sort se aplica DESPUÉS del filter (sino los
  // items ocultos por search seguirían ocupando memoria comparable).
  const filteredAndSorted = useMemo(
    () => sortWhiteboards(filterWhiteboards(items, search), sort),
    [items, search, sort],
  );

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

  // Grid de cards — defaults consistentes con otras vistas de cards del
  // estudiante (cursos, exámenes, talleres): 12 / 6-12-24-48. Las cards
  // son más altas que filas de tabla, por eso el page size baja desde
  // 25 (default de grids) a 12.
  const pagination = usePagination(filteredAndSorted, {
    defaultPageSize: 12,
    pageSizes: [6, 12, 24, 48],
    storageKey: "examlab_pag:teacher_whiteboards",
    resetKey: `${search}|${sort}`,
  });

  // Multi-selección + bulk delete — mismo patrón que cursos, usuarios,
  // exámenes, talleres y proyectos. Opera sobre `filteredAndSorted`
  // (no sobre `paginatedItems`) para que "seleccionar todos" abarque
  // todas las páginas del filtro activo.
  const sel = useMultiSelect(filteredAndSorted);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const bulkDeleteWhiteboards = async (ids: string[]) => {
    if (ids.length === 0) return;
    const { error } = await db.from("whiteboards").delete().in("id", ids);
    if (error) {
      toast.error(friendlyError(error, "No se pudieron eliminar las pizarras"));
      throw error;
    }
    setItems((prev) => prev.filter((p) => !ids.includes(p.id)));
    sel.clear();
    toast.success(
      `${ids.length} pizarra${ids.length === 1 ? "" : "s"} eliminada${ids.length === 1 ? "" : "s"}`,
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
      toast.error("Dale un nombre a la pizarra");
      return;
    }
    // Si se eligió una sesión, también debe haber un curso (la sesión
    // pertenece a un curso). El trigger SQL valida esto pero atajamos
    // client-side con un toast más amigable.
    if (draftSessionId !== "none" && draftCourseId === "none") {
      toast.error("Si elegís una sesión, primero hay que elegir el curso.");
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
      if (draftCourseId !== "none") payload.course_id = draftCourseId;
      if (draftSessionId !== "none") payload.attendance_session_id = draftSessionId;
      const { data, error } = await db.from("whiteboards").insert(payload).select("id").single();
      if (error || !data) {
        toast.error(friendlyError(error, "No se pudo crear la pizarra"));
        return;
      }
      toast.success("Pizarra creada");
      setCreateOpen(false);
      resetCreateDialog();
      // Navegamos directo al editor — el flujo "click para abrir" es
      // implícito tras crear.
      navigate({ to: "/app/teacher/whiteboards/$id", params: { id: data.id } });
    } catch (e) {
      // Caller: `() => void createWhiteboard()` desde onClick del botón
      // del dialog. Sin catch acá, una rejection del insert (network
      // throw, RLS panic) burbujea como unhandled rejection → audit log.
      toast.error(friendlyError(e, "No se pudo crear la pizarra"));
    } finally {
      setSaving(false);
    }
  };

  const deleteWhiteboard = async (w: Whiteboard) => {
    const ok = await confirm({
      title: "¿Eliminar pizarra?",
      description: `"${w.name}" se eliminará permanentemente, junto con todo su contenido. Esta acción no se puede deshacer.`,
      tone: "destructive",
      confirmLabel: "Eliminar",
    });
    if (!ok) return;
    try {
      const { error } = await db.from("whiteboards").delete().eq("id", w.id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo eliminar la pizarra"));
        return;
      }
      toast.success("Pizarra eliminada");
      setItems((prev) => prev.filter((p) => p.id !== w.id));
    } catch (e) {
      // Caller: `() => void deleteWhiteboard(w)` desde RowAction.onClick.
      // Mismo riesgo que createWhiteboard — envolvemos para capturar
      // rejections del network/RLS y mostrar toast amigable.
      toast.error(friendlyError(e, "No se pudo eliminar la pizarra"));
    }
  };

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<Palette className="h-6 w-6 text-primary" />}
          title="Pizarras"
          subtitle="Crea pizarras en blanco para explicar conceptos a tus alumnos o pensar en libertad."
        />
        <ErrorState
          message="No pudimos cargar tus pizarras"
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
        title="Pizarras"
        subtitle={
          items.length > 0
            ? `${items.length} pizarra${items.length === 1 ? "" : "s"}`
            : "Crea pizarras en blanco para explicar conceptos a tus alumnos o pensar en libertad."
        }
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Nueva pizarra
          </Button>
        }
      />

      {items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatTile
            label="Total"
            value={whiteboardStats.total}
            color="text-violet-600 dark:text-violet-400"
            bg="bg-violet-500/10"
          />
          <StatTile
            label="Compartidas"
            value={whiteboardStats.shared}
            color="text-emerald-600 dark:text-emerald-400"
            bg="bg-emerald-500/10"
          />
          <StatTile
            label="Privadas"
            value={whiteboardStats.priv}
            color="text-muted-foreground"
            bg="bg-muted/40"
          />
          <StatTile
            label="En curso"
            value={whiteboardStats.inCourse}
            color="text-sky-600 dark:text-sky-400"
            bg="bg-sky-500/10"
          />
        </div>
      )}

      {/* Toolbar de bulk delete — solo se renderiza cuando hay items
          seleccionados. Mismo patrón que el resto de listados
          (proyectos, talleres, exámenes, cursos). */}
      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular="pizarra"
        entityNamePlural="pizarras"
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="flex-1 min-w-0">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Buscar por nombre o descripción…"
              />
            </div>
            {/* Sort persistido en localStorage. En mobile cae debajo del
                search; en sm+ va a la derecha. Mismo patrón que
                /app/student/courses. */}
            <Select value={sort} onValueChange={(v) => setSort(v as WhiteboardSort)}>
              <SelectTrigger className="h-9 w-full sm:w-56 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="updated_desc" className="text-xs">
                  Última edición (más reciente)
                </SelectItem>
                <SelectItem value="updated_asc" className="text-xs">
                  Última edición (más antigua)
                </SelectItem>
                <SelectItem value="created_desc" className="text-xs">
                  Creación (más reciente)
                </SelectItem>
                <SelectItem value="name_asc" className="text-xs">
                  Nombre (A → Z)
                </SelectItem>
                <SelectItem value="name_desc" className="text-xs">
                  Nombre (Z → A)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
              <Spinner size="sm" /> Cargando…
            </div>
          ) : filteredAndSorted.length === 0 ? (
            <TableEmpty
              icon={Palette}
              title="No tienes pizarras todavía"
              description={
                search.trim()
                  ? "Ningún resultado coincide con tu búsqueda."
                  : "Crea tu primera pizarra para escribir, dibujar y explicar conceptos a tu manera."
              }
              action={
                !search.trim() ? (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="h-4 w-4 mr-1" />
                    Crear pizarra
                  </Button>
                ) : undefined
              }
            />
          ) : (
            // Grid de cards (no Table) — consistente con los otros
            // listados visuales del producto (cursos, exámenes, talleres
            // del estudiante). 1 col mobile → 2 sm → 3 lg.
            //
            // Cada card es: link al editor (Link wrapper) + descripción +
            // metadata abajo + ícono delete arriba a la derecha. El
            // delete tiene `stopPropagation` para que clickearlo no
            // dispare la navegación del Link.
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {pagination.paginatedItems.map((w) => {
                const isSelected = sel.isSelected(w.id);
                return (
                  // Wrapper `div` (no Link) — necesario para que el
                  // checkbox quede CLICKABLE sin disparar la navegación.
                  // El navigate ocurre via onClick del Link interno que
                  // ocupa la mayor parte del card.
                  <div
                    key={w.id}
                    className={`group relative rounded-lg border bg-card transition-colors p-4 flex flex-col gap-2 min-h-[8rem] ${
                      isSelected
                        ? "border-primary ring-2 ring-primary/30"
                        : "hover:bg-muted/40 hover:border-primary/40"
                    }`}
                  >
                    {/* Checkbox de multi-select arriba a la izquierda.
                        Z-index para flotar sobre el Link transparente. */}
                    <div className="absolute top-3 left-3 z-10">
                      <MultiSelectCheckbox id={w.id} state={sel} />
                    </div>
                    {/* Link transparente que cubre el card (excepto
                        áreas interactivas con z-10 encima) para mantener
                        UX de "click en el card abre el editor". */}
                    <Link
                      to="/app/teacher/whiteboards/$id"
                      params={{ id: w.id }}
                      className="absolute inset-0 rounded-lg z-0"
                      aria-label={`Abrir pizarra ${w.name}`}
                    />
                    <div className="flex items-start justify-between gap-2 relative z-10 pointer-events-none">
                      <div className="flex items-center gap-2 min-w-0 flex-1 pl-7">
                        <Palette className="h-4 w-4 text-violet-500 shrink-0" />
                        <h3
                          className="font-semibold text-base leading-tight truncate"
                          title={w.name}
                        >
                          {w.name}
                        </h3>
                      </div>
                      {/* Delete por card. pointer-events-auto para que
                          reciba el click (el padre del flex lo ignora
                          para que el Link de abajo capture el click en
                          el área vacía). */}
                      <span className="shrink-0 -mt-2 -mr-2 pointer-events-auto">
                        <RowAction
                          label="Eliminar"
                          icon={Trash2}
                          tone="destructive"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void deleteWhiteboard(w);
                          }}
                        />
                      </span>
                    </div>
                    {w.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2 relative z-10 pointer-events-none pl-7">
                        {w.description}
                      </p>
                    )}
                    <div className="mt-auto pt-2 text-[11px] text-muted-foreground tabular-nums flex items-center gap-1 relative z-10 pointer-events-none pl-7">
                      <span>Última edición:</span>
                      <DateCell value={w.updated_at} variant="datetime" />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <DataPagination state={pagination} entityNamePlural="pizarras" />
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) resetCreateDialog();
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Nueva pizarra</DialogTitle>
            <DialogDescription>
              Crea una pizarra y opcionalmente asóciala a un curso o a una sesión concreta. Si
              eliges un curso podrás compartirla con sus alumnos desde la pizarra.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label required>Nombre</Label>
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="Ej: Conceptos de POO, Clase 3"
                autoFocus
              />
            </div>
            <div>
              <Label>Descripción (opcional)</Label>
              <Textarea
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                rows={2}
                placeholder="Notas, contexto, recordatorios"
              />
            </div>
            <div>
              <Label>
                Curso (opcional){" "}
                <HelpHint>
                  Al asociar la pizarra a un curso, los alumnos del curso podrán verla en modo
                  solo-lectura cuando actives "Compartir con alumnos" desde la pizarra. Sin curso,
                  la pizarra es privada (solo vos la ves).
                </HelpHint>
              </Label>
              <Select value={draftCourseId} onValueChange={setDraftCourseId}>
                <SelectTrigger>
                  <SelectValue placeholder="Sin curso (privada)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Sin curso (privada)</SelectItem>
                  {draftCourses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
                  Sesión del curso (opcional){" "}
                  <HelpHint>
                    Si el curso tiene sesiones programadas, podés atar la pizarra a una específica
                    para que aparezca en el contexto de esa clase. Podés tener varias pizarras por
                    sesión.
                  </HelpHint>
                </Label>
                {loadingSessions ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                    <Spinner size="xs" /> Cargando sesiones…
                  </div>
                ) : draftSessions.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">
                    Este curso no tiene sesiones registradas. La pizarra queda asociada al curso.
                  </p>
                ) : (
                  <Select value={draftSessionId} onValueChange={setDraftSessionId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Sin sesión específica" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Sin sesión específica</SelectItem>
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
              Cancelar
            </Button>
            <Button onClick={() => void createWhiteboard()} disabled={saving}>
              {saving && <Spinner size="sm" className="mr-1" />}
              Crear y abrir
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
        items={filteredAndSorted
          .filter((w) => sel.isSelected(w.id))
          .map((w) => ({ id: w.id, label: w.name }))}
        entityNameSingular="pizarra"
        entityNamePlural="pizarras"
        onConfirm={bulkDeleteWhiteboards}
      />
    </div>
  );
}
