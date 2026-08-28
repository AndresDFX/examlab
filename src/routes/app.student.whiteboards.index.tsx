/**
 * Pizarras del estudiante — `/app/student/whiteboards`
 *
 * Dos listas, y la separación es el punto de la pantalla:
 *
 *  - **Mis pizarras**: las que el estudiante creó. Son suyas: las edita, las
 *    renombra y las borra. Sirven de espacio de borrador —los talleres del
 *    semestre le piden diagramas C4 y modelos ER, y esto es donde los ensaya
 *    antes de responder— y de cuaderno de clase.
 *  - **Compartidas por el docente**: las que el docente publicó a su curso
 *    (`is_shared_with_course=true`). Solo lectura.
 *
 * El reparto vive en `@/modules/whiteboard/student-whiteboards` porque tiene tres
 * reglas que no se deducen leyendo el render (una pizarra propia Y compartida no
 * puede salir dos veces; a lo propio no se le aplica el filtro de `closed` de la
 * cascada de cierre de curso; y un curso en papelera oculta lo compartido pero no
 * lo propio).
 *
 * La RLS hace el filtrado de fondo: `whiteboards_select` devuelve las propias
 * (por `owner_id`) y las compartidas de los cursos donde está matriculado. Lo que
 * el estudiante NO puede es compartir la suya con el curso ni atarla a una sesión
 * de clase — eso lo bloquea el trigger `trg_whiteboard_student_guard`
 * (mig 20261910000000), no la interfaz.
 *
 * ── Límite conocido de esta versión ───────────────────────────────────────
 * Si el estudiante asocia su pizarra a un curso, la RLS se la deja VER al docente
 * de ese curso (rama `course_teachers` de `whiteboards_select`), pero el grid del
 * docente todavía no la LISTA: su query pide `is_shared_with_course = true` para
 * lo que no es propio. O sea que hoy el docente llega solo por enlace. Listarla
 * pide, además de aflojar esa condición, resolver el nombre del dueño, sacarla del
 * borrado masivo y acotarle las acciones de fila — cambios sobre la tabla que el
 * docente usa a diario. Se dejó afuera a propósito: lo que se pidió acá es que el
 * estudiante tenga pizarras propias, y media implementación de un buzón docente
 * (listarlas pero dejar que el borrado masivo se las lleve) sería peor que no
 * tenerlo. El aviso del diálogo dice lo que hoy es cierto y nada más.
 */
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { ListFilters } from "@/components/ui/list-filters";
import { RowAction } from "@/components/ui/row-action";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatTile } from "@/components/ui/stat-tile";
import { DateCell } from "@/components/ui/date-cell";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { Palette, BookOpen, Plus, Trash2 } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  construirPizarraNueva,
  partirPizarras,
} from "@/modules/whiteboard/student-whiteboards";

export const Route = createFileRoute("/app/student/whiteboards/")({
  component: StudentWhiteboards,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const SIN_CURSO = "none";

interface PizarraFila {
  id: string;
  name: string;
  description: string | null;
  owner_id: string;
  course_id: string | null;
  is_shared_with_course: boolean;
  status: string | null;
  updated_at: string;
  /** Joineado en el cliente para la card y el buscador. */
  course_name?: string;
}

function StudentWhiteboards() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [items, setItems] = useState<PizarraFila[]>([]);
  const [courses, setCourses] = useState<Array<{ id: string; name: string }>>([]);
  const [trashedCourses, setTrashedCourses] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState<string>("all");
  const [sortMode, setSortMode] = useState<"updated_desc" | "name_asc" | "course_asc">(
    "updated_desc",
  );

  // ── Diálogo de creación ──
  const [createOpen, setCreateOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftCourseId, setDraftCourseId] = useState<string>(SIN_CURSO);
  const [saving, setSaving] = useState(false);

  // Guard `cancelled` obligatorio (convención del proyecto): si el usuario navega
  // antes de que resuelva el await, sin él el setState avisa de un componente
  // desmontado y el toast de error aparece huérfano en la pantalla siguiente.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!user) return;
      setLoading(true);
      setLoadError(null);
      try {
        // La RLS ya acota: propias (owner_id) + compartidas de los cursos donde
        // está matriculado. NO se filtra por is_shared_with_course en la query —
        // eso es justo lo que dejaba fuera las propias.
        const [{ data: wbs, error: wbErr }, { data: enrollments }] = await Promise.all([
          db
            .from("whiteboards")
            .select(
              "id, name, description, owner_id, course_id, is_shared_with_course, status, updated_at",
            )
            .is("deleted_at", null)
            .order("updated_at", { ascending: false }),
          db
            .from("course_enrollments")
            .select("course_id, courses(id, name, deleted_at)")
            .eq("user_id", user.id),
        ]);
        if (cancelled) return;
        if (wbErr) {
          setLoadError(friendlyError(wbErr, t("studentWhiteboards.loadError")));
          return;
        }
        const courseMap = new Map<string, string>();
        const myCourses: Array<{ id: string; name: string }> = [];
        const enPapelera = new Set<string>();
        for (const r of (enrollments ?? []) as Array<{
          courses: { id: string; name: string; deleted_at: string | null } | null;
        }>) {
          if (!r.courses) continue;
          if (r.courses.deleted_at) {
            enPapelera.add(r.courses.id);
            continue;
          }
          courseMap.set(r.courses.id, r.courses.name);
          myCourses.push({ id: r.courses.id, name: r.courses.name });
        }
        setCourses(myCourses);
        setTrashedCourses(enPapelera);
        setItems(
          ((wbs ?? []) as PizarraFila[]).map((w) => ({
            ...w,
            course_name: w.course_id ? courseMap.get(w.course_id) : undefined,
          })),
        );
      } catch (e) {
        if (cancelled) return;
        setLoadError(friendlyError(e, t("studentWhiteboards.loadError")));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, t, retryNonce]);

  // Filtrar → ordenar → PARTIR → paginar. El reparto va después del orden para
  // que las dos listas salgan con el criterio elegido.
  const filtered = useMemo(() => {
    let arr = items;
    if (courseFilter !== "all") arr = arr.filter((w) => w.course_id === courseFilter);
    const q = search.trim().toLowerCase();
    if (!q) return arr;
    return arr.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        (w.description ?? "").toLowerCase().includes(q) ||
        (w.course_name ?? "").toLowerCase().includes(q),
    );
  }, [items, search, courseFilter]);

  const sorted = useMemo(() => {
    const arr = filtered.slice();
    const col = (a: string, b: string) => a.localeCompare(b, "es-CO", { sensitivity: "base" });
    switch (sortMode) {
      case "name_asc":
        arr.sort((a, b) => col(a.name, b.name));
        break;
      case "course_asc":
        arr.sort((a, b) => col(a.course_name ?? "", b.course_name ?? ""));
        break;
      case "updated_desc":
      default:
        arr.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
        break;
    }
    return arr;
  }, [filtered, sortMode]);

  const { propias, compartidas } = useMemo(
    () => partirPizarras(sorted, user?.id, trashedCourses),
    [sorted, user?.id, trashedCourses],
  );

  // Los totales se cuentan sobre TODO (sin filtros), igual que en el resto de las
  // vistas: un tile que cambia al escribir en el buscador no informa nada.
  const stats = useMemo(() => {
    const todo = partirPizarras(items, user?.id, trashedCourses);
    return { propias: todo.propias.length, compartidas: todo.compartidas.length };
  }, [items, user?.id, trashedCourses]);

  const pagPropias = usePagination(propias, {
    defaultPageSize: 12,
    pageSizes: [6, 12, 24, 48],
    storageKey: "examlab_pag:student_whiteboards_own",
    resetKey: `${search}|${courseFilter}|${sortMode}`,
  });
  const pagCompartidas = usePagination(compartidas, {
    defaultPageSize: 12,
    pageSizes: [6, 12, 24, 48],
    storageKey: "examlab_pag:student_whiteboards",
    resetKey: `${search}|${courseFilter}|${sortMode}`,
  });

  const resetCreate = () => {
    setDraftName("");
    setDraftDescription("");
    setDraftCourseId(SIN_CURSO);
  };

  const crearPizarra = async () => {
    if (!user) return;
    if (!draftName.trim()) {
      toast.error(t("studentWhiteboards.createNameRequired"));
      return;
    }
    setSaving(true);
    try {
      // El payload lo arma `construirPizarraNueva`, que tiene test propio: lo que
      // se está fijando ahí es que is_shared_with_course y attendance_session_id
      // NO viajen nunca, porque son del docente.
      const payload = construirPizarraNueva({
        ownerId: user.id,
        name: draftName,
        description: draftDescription,
        courseId: draftCourseId === SIN_CURSO ? null : draftCourseId,
      });
      const { data, error } = await db.from("whiteboards").insert(payload).select("id").single();
      if (error || !data) {
        toast.error(friendlyError(error, t("studentWhiteboards.createError")));
        return;
      }
      // Primera hoja de dibujo. Si fallara, MultiPageWhiteboard auto-crea una al
      // abrir, así que no se bloquea la navegación por esto.
      const { error: pageErr } = await db.from("whiteboard_pages").insert({
        whiteboard_id: data.id,
        position: 0,
        page_type: "drawing",
        name: t("studentWhiteboards.firstSheetName"),
        scene_json: { elements: [], appState: {} },
      });
      if (pageErr) {
        console.warn("No se pudo crear la primera hoja:", pageErr);
      }
      toast.success(t("studentWhiteboards.created"));
      setCreateOpen(false);
      resetCreate();
      navigate({ to: "/app/student/whiteboards/$id", params: { id: data.id } });
    } catch (e) {
      toast.error(friendlyError(e, t("studentWhiteboards.createError")));
    } finally {
      setSaving(false);
    }
  };

  const borrarPizarra = async (wb: PizarraFila) => {
    // Borrado DEFINITIVO, no papelera: el módulo Papelera es de Docente/Admin, así
    // que una pizarra del estudiante en `deleted_at` quedaría invisible para él
    // (no puede restaurarla) y también para el resto (no tiene curso que la ate a
    // ningún listado). Eso es peor que un borrado explícito: el estudiante creería
    // que puede recuperarla. Por eso el confirm lo dice y es destructive.
    const ok = await confirm({
      title: t("studentWhiteboards.deleteTitle"),
      description: t("studentWhiteboards.deleteDescription", { name: wb.name }),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("whiteboards").delete().eq("id", wb.id);
    if (error) {
      toast.error(friendlyError(error, t("studentWhiteboards.deleteError")));
      return;
    }
    toast.success(t("studentWhiteboards.deleted"));
    setItems((prev) => prev.filter((x) => x.id !== wb.id));
  };

  const nuevaPizarraBtn = (
    <Button onClick={() => setCreateOpen(true)}>
      <Plus className="h-4 w-4 mr-1" />
      {t("studentWhiteboards.newWhiteboard")}
    </Button>
  );

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<Palette className="h-6 w-6" />}
          title={t("studentWhiteboards.title")}
          subtitle={t("studentWhiteboards.subtitleStatic")}
          actions={nuevaPizarraBtn}
        />
        <ErrorState
          message={t("studentWhiteboards.loadError")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  const tarjeta = (w: PizarraFila, propia: boolean) => (
    <div key={w.id} className="relative group">
      <Link
        to="/app/student/whiteboards/$id"
        params={{ id: w.id }}
        className="rounded-lg border bg-card hover:bg-muted/40 hover:border-primary/40 transition-colors p-4 flex flex-col gap-2 min-h-[8rem] h-full"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Palette className="h-4 w-4 text-violet-500 shrink-0" />
            <h3 className="font-semibold text-base leading-tight truncate" title={w.name}>
              {w.name}
            </h3>
          </div>
        </div>
        {w.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">{w.description}</p>
        )}
        {w.course_name && (
          <Badge variant="outline" className="text-3xs self-start inline-flex items-center gap-1">
            <BookOpen className="h-2.5 w-2.5" />
            {w.course_name}
          </Badge>
        )}
        <div className="mt-auto pt-2 text-2xs text-muted-foreground tabular-nums flex items-center gap-1">
          <span>{t("studentWhiteboards.lastEdited")}</span>
          <DateCell value={w.updated_at} variant="datetime" />
        </div>
      </Link>
      {propia && (
        // Fuera del <Link> para no anidar un botón dentro de un ancla.
        <div className="absolute top-2 right-2">
          <RowAction
            label={t("studentWhiteboards.deleteAction")}
            icon={Trash2}
            tone="destructive"
            onClick={() => void borrarPizarra(w)}
          />
        </div>
      )}
    </div>
  );

  const seccion = (
    titulo: string,
    lista: PizarraFila[],
    pag: ReturnType<typeof usePagination<PizarraFila>>,
    propia: boolean,
    vacio: { text: string; hint: string },
  ) => (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        {titulo} ({lista.length})
      </h2>
      {lista.length === 0 ? (
        <EmptyState icon={Palette} text={vacio.text} hint={vacio.hint} />
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pag.paginatedItems.map((w) => tarjeta(w, propia))}
          </div>
          <DataPagination state={pag} entityNamePlural={t("studentWhiteboards.paginationEntity")} />
        </>
      )}
    </div>
  );

  const hayFiltro = search.trim() !== "" || courseFilter !== "all";

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Palette className="h-6 w-6" />}
        title={t("studentWhiteboards.title")}
        subtitle={t("studentWhiteboards.subtitleOwn", {
          own: stats.propias,
          shared: stats.compartidas,
        })}
        actions={nuevaPizarraBtn}
      />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatTile
          label={t("studentWhiteboards.statOwn")}
          value={stats.propias}
          color="text-violet-600 dark:text-violet-400"
          bg="bg-violet-500/10"
        />
        <StatTile
          label={t("studentWhiteboards.statShared")}
          value={stats.compartidas}
          color="text-sky-600 dark:text-sky-400"
          bg="bg-sky-500/10"
        />
      </div>

      <Card>
        <CardContent className="p-4 space-y-5">
          <ListFilters
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder={t("studentWhiteboards.searchPlaceholder")}
            courseId={courseFilter === "all" ? null : courseFilter}
            onCourseChange={(v) => setCourseFilter(v ?? "all")}
            courses={courses}
            allLabel={t("studentWhiteboards.allCourses")}
            extra={
              <Select value={sortMode} onValueChange={(v) => setSortMode(v as typeof sortMode)}>
                <SelectTrigger className="w-full sm:w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="updated_desc">
                    {t("studentWhiteboards.sortUpdatedDesc")}
                  </SelectItem>
                  <SelectItem value="name_asc">{t("studentWhiteboards.sortNameAsc")}</SelectItem>
                  <SelectItem value="course_asc">
                    {t("studentWhiteboards.sortCourseAsc")}
                  </SelectItem>
                </SelectContent>
              </Select>
            }
          />

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
              <Spinner size="sm" /> {t("studentWhiteboards.loading")}
            </div>
          ) : (
            <>
              {seccion(t("studentWhiteboards.ownTitle"), propias, pagPropias, true, {
                text: hayFiltro
                  ? t("studentWhiteboards.emptyFiltered")
                  : t("studentWhiteboards.emptyOwn"),
                hint: hayFiltro
                  ? t("studentWhiteboards.emptyFilteredHint")
                  : t("studentWhiteboards.emptyOwnHint"),
              })}
              {seccion(t("studentWhiteboards.sharedTitle"), compartidas, pagCompartidas, false, {
                text: hayFiltro
                  ? t("studentWhiteboards.emptyFiltered")
                  : t("studentWhiteboards.emptyAll"),
                hint: hayFiltro
                  ? t("studentWhiteboards.emptyFilteredHint")
                  : t("studentWhiteboards.emptyAllHint"),
              })}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) resetCreate();
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("studentWhiteboards.createTitle")}</DialogTitle>
            <DialogDescription>{t("studentWhiteboards.createDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label required htmlFor="wb-nombre">
                {t("studentWhiteboards.fieldName")}
              </Label>
              <Input
                id="wb-nombre"
                className="mt-1"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t("studentWhiteboards.fieldNamePlaceholder")}
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="wb-desc">{t("studentWhiteboards.fieldDescription")}</Label>
              <Textarea
                id="wb-desc"
                className="mt-1"
                rows={2}
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                placeholder={t("studentWhiteboards.fieldDescriptionPlaceholder")}
              />
            </div>
            <div>
              <Label htmlFor="wb-curso">{t("studentWhiteboards.fieldCourse")}</Label>
              <Select value={draftCourseId} onValueChange={setDraftCourseId}>
                <SelectTrigger id="wb-curso" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={SIN_CURSO}>{t("studentWhiteboards.noCourse")}</SelectItem>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Decirlo acá y no en una nota al pie: atar la pizarra a un curso
                  la deja ver al docente de ese curso, y una regla que el usuario
                  no ve se siente como una filtración aunque sea intencional. */}
              <p className="text-xs text-muted-foreground mt-1">
                {draftCourseId === SIN_CURSO
                  ? t("studentWhiteboards.courseHintNone")
                  : t("studentWhiteboards.courseHintTeacherSees")}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void crearPizarra()} disabled={saving}>
              {saving && <Spinner size="sm" className="mr-1" />}
              {t("studentWhiteboards.createConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
