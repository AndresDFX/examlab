/**
 * ListFilters — barra estandar de búsqueda + filtro por curso para los
 * grids del docente (talleres, proyectos, exámenes). Pensado para vivir
 * arriba del Card de la tabla.
 *
 * El componente es presentacional: emite cambios al padre y el padre
 * decide cómo filtrar (especialmente útil para proyectos, donde un
 * item está vinculado a N cursos vía linked_course_ids).
 *
 * Uso:
 *   const [search, setSearch] = useState("");
 *   const [courseFilter, setCourseFilter] = useState<string | null>(null);
 *   const filtered = items.filter((it) => {
 *     if (courseFilter && it.course_id !== courseFilter) return false;
 *     if (search && !it.title.toLowerCase().includes(search.toLowerCase()))
 *       return false;
 *     return true;
 *   });
 *
 *   <ListFilters
 *     search={search}
 *     onSearchChange={setSearch}
 *     courseId={courseFilter}
 *     onCourseChange={setCourseFilter}
 *     courses={courses}
 *   />
 */
import { Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "./input";
import { Button } from "./button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";
import { partitionCoursesByLifecycle } from "@/modules/courses/course-status";

const ALL_COURSES = "__all__";
const ALL_CUTS = "__all_cuts__";
const ALL_PERIODS = "__all_periods__";
const ALL_SUBJECTS = "__all_subjects__";

interface ListFiltersProps {
  search: string;
  onSearchChange: (v: string) => void;
  searchPlaceholder?: string;
  /** ID del curso seleccionado, o null para "Todos los cursos". */
  courseId: string | null;
  onCourseChange: (v: string | null) => void;
  /** `status` (opcional) habilita el agrupado "Cursos activos"/"Cerrados" con
   *  los abiertos primero. Si no viene, degrada a una lista plana alfabética. */
  courses: Array<{
    id: string;
    name: string;
    status?: string | null;
    /** Periodo académico del curso (ej. "2026-2"). Si al menos un curso lo
     *  trae, aparece el Select de periodo. */
    period?: string | null;
    /** Nombre de la asignatura. Si al menos un curso lo trae, aparece el
     *  Select de asignatura. */
    subject?: string | null;
  }>;
  /** Etiqueta para el item "todos" — default "Todos los cursos". */
  allLabel?: string;
  /**
   * Lista completa de cuts (cualquier curso). Si está presente y hay un
   * `courseId` seleccionado, se renderiza un segundo Select con los
   * cuts de ese curso. Si el curso no tiene cuts, no se muestra nada.
   */
  cuts?: Array<{ id: string; course_id: string; name: string }>;
  /** ID del corte seleccionado, o null para "Todos los cortes". */
  cutId?: string | null;
  onCutChange?: (v: string | null) => void;
  /** Etiqueta para "todos los cortes" — default "Todos los cortes". */
  allCutsLabel?: string;
  /**
   * Periodo y asignatura seleccionados. Son OPT-IN: el Select solo aparece si
   * el padre pasa el handler Y los cursos traen ese dato con más de un valor
   * distinto. Un filtro con una sola opción no filtra nada y ocupa lugar.
   *
   * No hacen falta consultas nuevas: las listas se derivan de `courses`, así
   * que las opciones que se ofrecen son exactamente las que el docente tiene.
   * Ofrecer un periodo sin cursos sería prometer un filtro que da vacío.
   */
  period?: string | null;
  onPeriodChange?: (v: string | null) => void;
  subject?: string | null;
  onSubjectChange?: (v: string | null) => void;
  /** Slot opcional al lado de los selects internos. Útil para filtros
   *  específicos del contexto (ej. estado de entrega en listas del
   *  estudiante) sin tener que envolver `ListFilters` con un wrapper
   *  externo que romperia la alineación responsive. */
  extra?: ReactNode;
  /** Callback que `Limpiar` invoca además del reset interno. Permite
   *  resetear filtros custom que viven en el slot `extra`. */
  onClearExtra?: () => void;
}

export function ListFilters({
  search,
  onSearchChange,
  searchPlaceholder,
  courseId,
  onCourseChange,
  courses,
  allLabel,
  cuts,
  cutId,
  onCutChange,
  allCutsLabel,
  period,
  onPeriodChange,
  subject,
  onSubjectChange,
  extra,
  onClearExtra,
}: ListFiltersProps) {
  const { t } = useTranslation();
  const resolvedSearchPlaceholder =
    searchPlaceholder ??
    t("hc_componentsUiListFilters.searchPlaceholder", { defaultValue: "Buscar por título…" });
  const resolvedAllLabel =
    allLabel ?? t("hc_componentsUiListFilters.allCourses", { defaultValue: "Todos los cursos" });
  const resolvedAllCutsLabel =
    allCutsLabel ?? t("hc_componentsUiListFilters.allCuts", { defaultValue: "Todos los cortes" });
  // Periodos y asignaturas que EXISTEN en los cursos del usuario. Orden:
  // periodo descendente (el vigente arriba, que es lo que se busca casi
  // siempre) y asignatura alfabética.
  const periods = Array.from(
    new Set(courses.map((c) => c.period).filter((p): p is string => !!p)),
  ).sort((a, b) => b.localeCompare(a, "es-CO", { numeric: true }));
  const subjects = Array.from(
    new Set(courses.map((c) => c.subject).filter((sj): sj is string => !!sj)),
  ).sort((a, b) => a.localeCompare(b, "es-CO", { sensitivity: "base" }));
  // Con un solo valor el filtro no filtra: se oculta en vez de ocupar lugar.
  const showPeriod = !!onPeriodChange && periods.length > 1;
  const showSubject = !!onSubjectChange && subjects.length > 1;

  // CASCADA: el Select de curso solo ofrece los que cumplen periodo+asignatura.
  // Sin esto el docente puede elegir "2026-2" y un curso de 2026-1 y quedarse
  // con la tabla vacía sin entender por qué.
  const coursesInScope = courses.filter(
    (c) =>
      (!period || c.period === period) && (!subject || c.subject === subject),
  );
  // Prioridad UX: cursos ABIERTOS primero. `keepIds` mantiene el curso
  // seleccionado en el grupo activo aunque esté finalizado (no lo esconde abajo).
  const { open: openCourses, closed: closedCourses } = partitionCoursesByLifecycle(
    coursesInScope,
    courseId ? [courseId] : undefined,
  );

  /** Al cambiar periodo o asignatura, si el curso elegido deja de estar en el
   *  alcance se limpia. Dejarlo seleccionado mostraría un curso que ya no
   *  aparece en la lista — el usuario vería un filtro que no puede deshacer. */
  const cambiarAlcance = (nuevo: { period?: string | null; subject?: string | null }) => {
    const p = nuevo.period !== undefined ? nuevo.period : period;
    const sj = nuevo.subject !== undefined ? nuevo.subject : subject;
    if (nuevo.period !== undefined) onPeriodChange?.(nuevo.period);
    if (nuevo.subject !== undefined) onSubjectChange?.(nuevo.subject);
    if (courseId) {
      const sigue = courses.some(
        (c) => c.id === courseId && (!p || c.period === p) && (!sj || c.subject === sj),
      );
      if (!sigue) onCourseChange(null);
    }
  };
  const cutsForCourse = courseId ? (cuts ?? []).filter((c) => c.course_id === courseId) : [];
  const showCutSelect = !!courseId && cutsForCourse.length > 0 && !!onCutChange;
  const hasFilters =
    !!search || courseId != null || cutId != null || period != null || subject != null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[180px] sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={resolvedSearchPlaceholder}
          className="pl-8"
        />
      </div>
      {showSubject && (
        <Select
          value={subject ?? ALL_SUBJECTS}
          onValueChange={(v) => cambiarAlcance({ subject: v === ALL_SUBJECTS ? null : v })}
        >
          <SelectTrigger className="w-full sm:w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SUBJECTS}>
              {t("listFilters.allSubjects", { defaultValue: "Todas las asignaturas" })}
            </SelectItem>
            {subjects.map((sj) => (
              <SelectItem key={sj} value={sj}>
                {sj}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {showPeriod && (
        <Select
          value={period ?? ALL_PERIODS}
          onValueChange={(v) => cambiarAlcance({ period: v === ALL_PERIODS ? null : v })}
        >
          <SelectTrigger className="w-full sm:w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PERIODS}>
              {t("listFilters.allPeriods", { defaultValue: "Todos los periodos" })}
            </SelectItem>
            {periods.map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Select
        value={courseId ?? ALL_COURSES}
        onValueChange={(v) => onCourseChange(v === ALL_COURSES ? null : v)}
      >
        <SelectTrigger className="w-full sm:w-56">
          <SelectValue placeholder={resolvedAllLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_COURSES}>{resolvedAllLabel}</SelectItem>
          {closedCourses.length > 0 ? (
            <>
              <SelectGroup>
                <SelectLabel>
                  {t("course.groupActive", { defaultValue: "Cursos activos" })}
                </SelectLabel>
                {openCourses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectGroup>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>
                  {t("course.groupClosed", { defaultValue: "Cursos cerrados" })}
                </SelectLabel>
                {closedCourses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : (
            openCourses.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
      {showCutSelect && (
        <Select
          value={cutId ?? ALL_CUTS}
          onValueChange={(v) => onCutChange?.(v === ALL_CUTS ? null : v)}
        >
          <SelectTrigger className="w-full sm:w-44">
            <SelectValue placeholder={resolvedAllCutsLabel} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CUTS}>{resolvedAllCutsLabel}</SelectItem>
            {cutsForCourse.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {extra}
      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onSearchChange("");
            onCourseChange(null);
            onCutChange?.(null);
            onPeriodChange?.(null);
            onSubjectChange?.(null);
            onClearExtra?.();
          }}
          title={t("hc_componentsUiListFilters.clearFiltersTitle", { defaultValue: "Limpiar filtros" })}
        >
          <X className="h-4 w-4 mr-1" />
          {t("hc_componentsUiListFilters.clear", { defaultValue: "Limpiar" })}
        </Button>
      )}
    </div>
  );
}
