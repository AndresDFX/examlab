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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

const ALL_COURSES = "__all__";
const ALL_CUTS = "__all_cuts__";

interface ListFiltersProps {
  search: string;
  onSearchChange: (v: string) => void;
  searchPlaceholder?: string;
  /** ID del curso seleccionado, o null para "Todos los cursos". */
  courseId: string | null;
  onCourseChange: (v: string | null) => void;
  courses: Array<{ id: string; name: string }>;
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
  const cutsForCourse = courseId ? (cuts ?? []).filter((c) => c.course_id === courseId) : [];
  const showCutSelect = !!courseId && cutsForCourse.length > 0 && !!onCutChange;
  const hasFilters = !!search || courseId != null || cutId != null;
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
      <Select
        value={courseId ?? ALL_COURSES}
        onValueChange={(v) => onCourseChange(v === ALL_COURSES ? null : v)}
      >
        <SelectTrigger className="w-full sm:w-56">
          <SelectValue placeholder={resolvedAllLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_COURSES}>{resolvedAllLabel}</SelectItem>
          {courses.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
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
