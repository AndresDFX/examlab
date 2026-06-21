/**
 * Student-side whiteboard list — `/app/student/whiteboards`
 *
 * Vista del alumno con las pizarras que el docente compartió con sus
 * cursos (`is_shared_with_course=true` + `course_id` matchea un curso
 * donde el alumno está matriculado). Mismo estilo de cards que
 * talleres / exámenes / proyectos del estudiante.
 *
 * El alumno SOLO LEE — la RLS de `whiteboards` filtra a las compartidas
 * de sus cursos; INSERT/UPDATE/DELETE quedan bloqueados.
 *
 * Card → link a `/app/student/whiteboards/$id` (visor de solo lectura
 * del estudiante; embebe MultiPageWhiteboard con readOnly).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState, ErrorState } from "@/components/ui/empty-state";
import { SearchInput } from "@/components/ui/search-input";
import { StatTile } from "@/components/ui/stat-tile";
import { DateCell } from "@/components/ui/date-cell";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Palette, BookOpen } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/app/student/whiteboards/")({
  component: StudentWhiteboards,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface SharedWhiteboard {
  id: string;
  name: string;
  description: string | null;
  course_id: string | null;
  is_shared_with_course: boolean;
  updated_at: string;
  // Joineado: nombre del curso para mostrar en la card.
  course_name?: string;
}

function StudentWhiteboards() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [items, setItems] = useState<SharedWhiteboard[]>([]);
  const [courses, setCourses] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [courseFilter, setCourseFilter] = useState<string>("all");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    try {
      // RLS ya filtra: solo trae las pizarras donde
      // is_shared_with_course=true Y el alumno está enrolled en el
      // course_id. Nuestra query no necesita filtros extra.
      const [{ data: wbs, error: wbErr }, { data: enrollments }] = await Promise.all([
        db
          .from("whiteboards")
          .select("id, name, description, course_id, is_shared_with_course, updated_at, status")
          .eq("is_shared_with_course", true)
          .is("deleted_at", null)
          .order("updated_at", { ascending: false }),
        db.from("course_enrollments").select("course_id, courses(id, name)").eq("user_id", user.id),
      ]);
      if (wbErr) {
        setLoadError(friendlyError(wbErr, "No pudimos cargar las pizarras compartidas."));
        return;
      }
      // Enriquecer con nombre de curso. Mapa courseId → name.
      const courseMap = new Map<string, string>();
      const myCourses: Array<{ id: string; name: string }> = [];
      for (const r of (enrollments ?? []) as Array<{
        courses: { id: string; name: string } | null;
      }>) {
        if (r.courses) {
          courseMap.set(r.courses.id, r.courses.name);
          myCourses.push(r.courses);
        }
      }
      setCourses(myCourses);
      const enriched = ((wbs ?? []) as SharedWhiteboard[])
        // Una pizarra CERRADA no se le muestra al alumno (paridad con el resto:
        // lo cerrado sale del listado activo). nullish ⇒ published (no cerrada).
        .filter((w) => ((w as { status?: string | null }).status ?? "published") !== "closed")
        .map((w) => ({
          ...w,
          course_name: w.course_id ? courseMap.get(w.course_id) : undefined,
        }));
      setItems(enriched);
    } catch (e) {
      setLoadError(friendlyError(e, "No pudimos cargar las pizarras compartidas."));
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load, retryNonce]);

  const filtered = useMemo(() => {
    let arr = items;
    if (courseFilter !== "all") {
      arr = arr.filter((w) => w.course_id === courseFilter);
    }
    const q = search.trim().toLowerCase();
    if (!q) return arr;
    return arr.filter(
      (w) =>
        w.name.toLowerCase().includes(q) ||
        (w.description ?? "").toLowerCase().includes(q) ||
        (w.course_name ?? "").toLowerCase().includes(q),
    );
  }, [items, search, courseFilter]);

  // Stats — mismo patrón que el resto. Las pizarras del alumno NO
  // tienen estados (siempre son shared+published para que aparezcan),
  // así que las tiles son agregados visualmente útiles: total + por
  // curso (cuántas pizarras vienen de cuántos cursos distintos).
  const stats = useMemo(() => {
    const courseSet = new Set(items.map((w) => w.course_id).filter(Boolean));
    return { total: items.length, courses: courseSet.size };
  }, [items]);

  // Cards grandes → defaultPageSize 12 (mismo patrón que cursos /
  // exámenes / talleres del estudiante).
  const pagination = usePagination(filtered, {
    defaultPageSize: 12,
    pageSizes: [6, 12, 24, 48],
    storageKey: "examlab_pag:student_whiteboards",
    resetKey: `${search}|${courseFilter}`,
  });

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={<Palette className="h-6 w-6 text-violet-500" />}
          title={t("studentWhiteboards.title")}
          subtitle={t("studentWhiteboards.subtitleStatic")}
        />
        <ErrorState
          message={t("studentWhiteboards.loadError")}
          hint={loadError}
          onRetry={() => setRetryNonce((n) => n + 1)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Palette className="h-6 w-6 text-violet-500" />}
        title={t("studentWhiteboards.title")}
        subtitle={
          items.length > 0
            ? t("studentWhiteboards.subtitle", { count: items.length })
            : t("studentWhiteboards.subtitleStatic")
        }
      />

      {items.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatTile
            label={t("studentWhiteboards.statTotal")}
            value={stats.total}
            color="text-violet-600 dark:text-violet-400"
            bg="bg-violet-500/10"
          />
          <StatTile
            label={t("studentWhiteboards.statCourses")}
            value={stats.courses}
            color="text-sky-600 dark:text-sky-400"
            bg="bg-sky-500/10"
          />
        </div>
      )}

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="flex-1 min-w-0">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t("studentWhiteboards.searchPlaceholder")}
              />
            </div>
            {courses.length > 1 && (
              <Select value={courseFilter} onValueChange={setCourseFilter}>
                <SelectTrigger className="h-9 w-full sm:w-56 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">
                    {t("studentWhiteboards.allCourses")}
                  </SelectItem>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id} className="text-xs">
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
              <Spinner size="sm" /> {t("studentWhiteboards.loading")}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Palette}
              text={
                search.trim() || courseFilter !== "all"
                  ? t("studentWhiteboards.emptyFiltered")
                  : t("studentWhiteboards.emptyAll")
              }
              hint={
                search.trim() || courseFilter !== "all"
                  ? t("studentWhiteboards.emptyFilteredHint")
                  : t("studentWhiteboards.emptyAllHint")
              }
            />
          ) : (
            <>
              {/* Grid de cards — 1 col mobile / 2 sm / 3 lg. Mismo
                  patrón que /app/student/courses, exams, workshops,
                  projects, certificates, polls. */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {pagination.paginatedItems.map((w) => (
                  <Link
                    key={w.id}
                    to="/app/student/whiteboards/$id"
                    params={{ id: w.id }}
                    className="group rounded-lg border bg-card hover:bg-muted/40 hover:border-primary/40 transition-colors p-4 flex flex-col gap-2 min-h-[8rem]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <Palette className="h-4 w-4 text-violet-500 shrink-0" />
                        <h3
                          className="font-semibold text-base leading-tight truncate"
                          title={w.name}
                        >
                          {w.name}
                        </h3>
                      </div>
                    </div>
                    {w.description && (
                      <p className="text-xs text-muted-foreground line-clamp-2">{w.description}</p>
                    )}
                    {w.course_name && (
                      <Badge
                        variant="outline"
                        className="text-[10px] self-start inline-flex items-center gap-1"
                      >
                        <BookOpen className="h-2.5 w-2.5" />
                        {w.course_name}
                      </Badge>
                    )}
                    <div className="mt-auto pt-2 text-[11px] text-muted-foreground tabular-nums flex items-center gap-1">
                      <span>{t("studentWhiteboards.lastEdited")}</span>
                      <DateCell value={w.updated_at} variant="datetime" />
                    </div>
                  </Link>
                ))}
              </div>
              <DataPagination state={pagination} entityNamePlural={t("studentWhiteboards.paginationEntity")} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
