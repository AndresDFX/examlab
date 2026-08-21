import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTableSort } from "@/hooks/use-table-sort";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import { Card, CardContent } from "@/components/ui/card";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { ListFilters } from "@/components/ui/list-filters";
import { courseIdsInScope } from "@/modules/courses/course-filter-scope";
import { ModuleGuard } from "@/shared/components/ModuleGuard";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Eye, Users, KeyRound } from "lucide-react";
import { startImpersonate } from "@/modules/admin/impersonation";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
} from "@/components/ui/multi-select";
import { BulkPasswordDialog } from "@/shared/components/BulkPasswordDialog";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

export const Route = createFileRoute("/app/teacher/students")({ component: TeacherStudents });

type Student = {
  id: string;
  full_name: string;
  institutional_email: string;
  codigo: string | null;
  courses: string[];
};

// `period`/`subject`/`status` alimentan los filtros de ListFilters. Se piden en
// la MISMA consulta que ya traía los cursos del docente: sin ellos el docente
// solo podía filtrar curso por curso, y con 9 cursos de varios periodos eso
// obliga a saber de memoria cuál es de este semestre.
type Course = {
  id: string;
  name: string;
  period: string | null;
  subject: string | null;
  status: string | null;
};

function TeacherStudents() {
  return (
    <ModuleGuard module="teacher_students">
      <TeacherStudentsInner />
    </ModuleGuard>
  );
}

function TeacherStudentsInner() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [students, setStudents] = useState<Student[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [periodFilter, setPeriodFilter] = useState<string | null>(null);
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);
  const [courseFilter, setCourseFilter] = useState<string>("all");
  const [impersonating, setImpersonating] = useState<string | null>(null);
  const [bulkPasswordOpen, setBulkPasswordOpen] = useState(false);
  // Reset de contraseña individual (acción de fila). Reusa el mismo diálogo/edge
  // que el bulk (bulk-set-passwords ya autoriza al docente por sus cursos).
  const [resetPasswordFor, setResetPasswordFor] = useState<Student | null>(null);

  // `isActive` deja al effect abortar los setState si el usuario navega
  // antes de que resuelvan los awaits (patrón `let cancelled = false` del
  // repo). El retry la llama sin argumento → siempre activa.
  const load = async (isActive: () => boolean = () => true) => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);

    // 1. Cursos del docente
    const { data: teacherCourses, error: tcErr } = await supabase
      .from("course_teachers")
      .select("course_id, courses(id, name, deleted_at, period, status, academic_subjects:subject_id(name))")
      .eq("user_id", user.id);
    if (!isActive()) return;
    if (tcErr) {
      setLoadError(friendlyError(tcErr, "No pudimos cargar tus cursos."));
      setLoading(false);
      return;
    }
    // PostgREST no filtra embeds anidados: saltar cursos en papelera en JS
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const myCourses: Course[] = (teacherCourses ?? [])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((r: any) => !r.courses?.deleted_at)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((r: any) => ({
        id: r.courses?.id ?? r.course_id,
        name: r.courses?.name ?? r.course_id,
        period: r.courses?.period ?? null,
        // `subject_id` → academic_subjects es una FK normal, así que el embed
        // sí funciona acá (a diferencia de los `*.user_id → auth.users`).
        subject: r.courses?.academic_subjects?.name ?? null,
        status: r.courses?.status ?? null,
      }));
    setCourses(myCourses);
    const courseIds = myCourses.map((c) => c.id);
    if (courseIds.length === 0) {
      setStudents([]);
      setLoading(false);
      return;
    }

    // 2. Matriculados en esos cursos (con perfil)
    const { data: enrollments, error: enrErr } = await supabase
      .from("course_enrollments")
      .select("user_id, course_id")
      .in("course_id", courseIds);
    if (!isActive()) return;
    if (enrErr) {
      setLoadError(friendlyError(enrErr, "No pudimos cargar los estudiantes."));
      setLoading(false);
      return;
    }
    const userIds = [...new Set((enrollments ?? []).map((e: any) => e.user_id))];
    if (userIds.length === 0) {
      setStudents([]);
      setLoading(false);
      return;
    }

    // 3. Perfiles (incluye código estudiantil para mostrar en grid)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: profiles, error: profErr } = await (supabase as any)
      .from("profiles")
      .select("id, full_name, institutional_email, codigo")
      .in("id", userIds)
      .order("full_name");
    if (!isActive()) return;
    if (profErr) {
      setLoadError(friendlyError(profErr, "No pudimos cargar los perfiles."));
      setLoading(false);
      return;
    }

    // 4. Agrupar cursos por estudiante
    const courseNameById = new Map(myCourses.map((c) => [c.id, c.name]));
    const coursesByStudent = new Map<string, string[]>();
    for (const e of enrollments ?? []) {
      const existing = coursesByStudent.get(e.user_id) ?? [];
      const cName = courseNameById.get(e.course_id);
      if (cName) existing.push(cName);
      coursesByStudent.set(e.user_id, existing);
    }

    setStudents(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (profiles ?? []).map((p: any) => ({
        id: p.id,
        full_name: p.full_name ?? p.institutional_email,
        institutional_email: p.institutional_email,
        codigo: p.codigo ?? null,
        courses: coursesByStudent.get(p.id) ?? [],
      })),
    );
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    void load(() => !cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce]);

  const filtered = useMemo(() => {
    let result = students;
    // Periodo y asignatura filtran la TABLA, no solo el Select de curso: sin
    // esto elegir "2026-2" acotaba la lista de cursos pero seguía mostrando a
    // los 75 usuarios, que se lee como que el filtro no sirve.
    // Se comparan por NOMBRE de curso porque es lo que `Student.courses` trae
    // (la fila del alumno no guarda course_id).
    // El alcance se calcula con el helper compartido (misma regla que los otros
    // grids), pero acá hay que traducir ids → NOMBRES: la fila del alumno guarda
    // los nombres de sus cursos, no los course_id.
    const scope = courseIdsInScope(courses, periodFilter, subjectFilter);
    if (scope !== null) {
      const nombresEnAlcance = new Set(
        courses.filter((c) => scope.has(c.id)).map((c) => c.name),
      );
      result = result.filter((s) => s.courses.some((n) => nombresEnAlcance.has(n)));
    }
    if (courseFilter !== "all") {
      const courseName = courses.find((c) => c.id === courseFilter)?.name;
      if (courseName) result = result.filter((s) => s.courses.includes(courseName));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.full_name.toLowerCase().includes(q) ||
          s.institutional_email.toLowerCase().includes(q) ||
          (s.codigo?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }, [students, search, courseFilter, courses, periodFilter, subjectFilter]);

  // Flujo obligatorio del design system: filtrar → ORDENAR → paginar.
  const sort = useTableSort(filtered, {
    columns: {
      name: (s) => s.full_name,
      codigo: (s) => s.codigo ?? "",
      email: (s) => s.institutional_email,
    },
    defaultSort: { key: "name", dir: "asc" },
    storageKey: "examlab_sort:teacher_students",
  });

  // Multi-selección para acciones en bloque (cambio masivo de contraseña).
  // Opera sobre TODA la lista filtrada+ordenada (no solo la página visible),
  // para que "seleccionar todos" abarque todas las páginas del filtro activo.
  const sel = useMultiSelect(sort.sorted);

  // Paginación: un docente con cientos de matriculados renderizaba TODAS las
  // filas de una sola vez.
  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:teacher_students",
    resetKey: `${search}|${courseFilter}|${periodFilter ?? ""}|${subjectFilter ?? ""}|${sort.resetKey}`,
  });

  const handleImpersonate = async (s: Student) => {
    if (impersonating) return;
    const ok = await confirm({
      title: i18n.t("teacherStudents.impersonateConfirmTitle", { name: s.full_name }),
      description: i18n.t("teacherStudents.impersonateConfirmDesc"),
      confirmLabel: i18n.t("teacherStudents.impersonateConfirmLabel"),
      tone: "warning",
    });
    if (!ok) return;
    setImpersonating(s.id);
    // `startImpersonate` hace varios round-trips de auth y termina en un hard
    // reload: el menú de fila ya se cerró, así que el único feedback posible
    // es un toast de carga (se va solo con la recarga).
    const progressId = toast.loading(
      i18n.t("teacherStudents.impersonateStarting", {
        defaultValue: "Iniciando sesión como {{name}}…",
        name: s.full_name,
      }),
    );
    try {
      await startImpersonate(s.id);
    } catch (e) {
      toast.error(friendlyError(e, i18n.t("teacherStudents.impersonateError")));
      setImpersonating(null);
    } finally {
      toast.dismiss(progressId);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("teacherStudents.title")}
        subtitle={loading ? undefined : t("teacherStudents.subtitle", { count: students.length })}
        icon={<Users className="h-6 w-6" />}
      />

      {/* Filtros: búsqueda + curso estandarizados (ListFilters), igual que los
          demás grids docentes. */}
      <ListFilters
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={t("teacherStudents.searchPlaceholder")}
        courseId={courseFilter === "all" ? null : courseFilter}
        onCourseChange={(v) => setCourseFilter(v ?? "all")}
        courses={courses}
        allLabel={t("teacherStudents.allCourses")}
        period={periodFilter}
        onPeriodChange={setPeriodFilter}
        subject={subjectFilter}
        onSubjectChange={setSubjectFilter}
      />

      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        entityNameSingular={t("teacherStudents.bulkEntity", { defaultValue: "estudiante" })}
        entityNamePlural={t("teacherStudents.bulkEntityPlural", { defaultValue: "estudiantes" })}
        clearLabel={t("common.clearSelection", { defaultValue: "Limpiar selección" })}
        extraActions={[
          {
            key: "bulk-password",
            label: t("teacherStudents.bulkPasswordAction", { defaultValue: "Cambiar contraseña" }),
            icon: KeyRound,
            onClick: () => setBulkPasswordOpen(true),
          },
        ]}
      />

      <BulkPasswordDialog
        open={bulkPasswordOpen}
        onOpenChange={setBulkPasswordOpen}
        userIds={[...sel.selectedIds]}
        onDone={sel.clear}
      />

      {/* Reset individual desde la acción de fila (mismo edge + autz por curso).
          Si el estudiante es SSO-only, la edge lo reporta en `failed`. */}
      <BulkPasswordDialog
        open={!!resetPasswordFor}
        onOpenChange={(o) => {
          if (!o) setResetPasswordFor(null);
        }}
        userIds={resetPasswordFor ? [resetPasswordFor.id] : []}
        onDone={() => setResetPasswordFor(null)}
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          {/* Tabla */}
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            {loading ? (
              <TableSkeleton cols={3} rows={6} />
            ) : loadError ? (
              <ErrorState
                message={t("teacherStudents.loadError")}
                hint={loadError}
                onRetry={() => setRetryNonce((n) => n + 1)}
              />
            ) : (
              <Table fixed resizable>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <MultiSelectHeaderCheckbox state={sel} />
                    </TableHead>
                    <SortableHead sortKey="name" sort={sort} className="min-w-[180px]">{t("teacherStudents.colName")}</SortableHead>
                    <SortableHead sortKey="codigo" sort={sort} className="hidden sm:table-cell w-32">{t("teacherStudents.colCode")}</SortableHead>
                    <SortableHead sortKey="email" sort={sort} className="hidden sm:table-cell w-[260px]">{t("teacherStudents.colEmail")}</SortableHead>
                    <TableHead className="hidden md:table-cell w-[240px]">{t("teacherStudents.colCourses")}</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sort.sorted.length === 0 ? (
                    <TableEmpty colSpan={6} text={t("teacherStudents.empty")} />
                  ) : (
                    pagination.paginatedItems.map((s) => (
                      <TableRow key={s.id} data-state={sel.isSelected(s.id) ? "selected" : undefined}>
                        <TableCell className="w-10">
                          <MultiSelectCheckbox id={s.id} state={sel} />
                        </TableCell>
                        <TableCell>
                          <div className="font-medium truncate" title={s.full_name}>
                            {s.full_name}
                          </div>
                          <div className="text-xs text-muted-foreground sm:hidden">
                            {s.codigo ? `${s.codigo} · ` : ""}
                            {s.institutional_email}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-xs text-muted-foreground tabular-nums">
                          {s.codigo ?? "—"}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                          <div className="truncate" title={s.institutional_email}>
                            {s.institutional_email}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {s.courses.length === 0 ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            // Un solo badge (truncado a 160px) + chip '+N' cuando hay más
                            // cursos. Patrón compacto que mantiene la columna ~200px
                            // máx en lugar de expandirse con cada curso adicional.
                            // El tooltip del chip revela los nombres restantes.
                            <div className="flex items-center gap-1 max-w-[220px]">
                              <Badge
                                variant="outline"
                                className="text-xs max-w-[160px] truncate inline-block"
                                title={s.courses[0]}
                              >
                                {s.courses[0]}
                              </Badge>
                              {s.courses.length > 1 && (
                                <Badge
                                  variant="secondary"
                                  className="text-xs shrink-0"
                                  title={s.courses.slice(1).join(", ")}
                                >
                                  +{s.courses.length - 1}
                                </Badge>
                              )}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            actions={[
                              {
                                label: t("teacherStudents.actionImpersonate"),
                                icon: Eye,
                                hint: t("teacherStudents.impersonateHint", { name: s.full_name }),
                                onClick: () => void handleImpersonate(s),
                                // Bloquea TODAS las filas mientras se abre una
                                // suplantación (redirige al cargar): antes solo
                                // se deshabilitaba la fila clickeada y se podía
                                // disparar otra en paralelo.
                                disabled: impersonating !== null,
                              },
                              {
                                label: t("teacherStudents.actionResetPassword", {
                                  defaultValue: "Resetear contraseña",
                                }),
                                icon: KeyRound,
                                hint: t("teacherStudents.resetPasswordHint", {
                                  name: s.full_name,
                                  defaultValue: "Asignar una nueva contraseña a {{name}}",
                                }),
                                onClick: () => setResetPasswordFor(s),
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
          </div>
          {!loading && !loadError && sort.sorted.length > 0 && (
            <DataPagination state={pagination} entityNamePlural={t("teacherStudents.title")} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
