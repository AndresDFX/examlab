/**
 * ListFilters — barra estandar de búsqueda + filtro por curso para los
 * grids del docente (talleres, proyectos, exámenes). Pensado para vivir
 * arriba del Card de la tabla.
 *
 * El componente es presentacional: emite cambios al padre y el padre
 * decide cómo filtrar (especialmente útil para proyectos, donde un
 * item está vinculado a N cursos vía linked_course_ids).
 *
 * Curso, periodo y asignatura son de selección MÚLTIPLE (menú de casillas):
 * **vacío = sin filtrar**, semántica de `filtro-multiple.ts`. Solo el CORTE
 * sigue siendo de un valor: un corte pertenece a un curso concreto.
 *
 * Uso:
 *   const [search, setSearch] = useState("");
 *   const [courseIds, setCourseIds] = useState<string[]>([]);
 *   const filtered = items.filter((it) => {
 *     if (courseIds.length && !courseIds.includes(it.course_id)) return false;
 *     if (search && !it.title.toLowerCase().includes(search.toLowerCase()))
 *       return false;
 *     return true;
 *   });
 *
 *   <ListFilters
 *     search={search}
 *     onSearchChange={setSearch}
 *     courseIds={courseIds}
 *     onCourseIdsChange={setCourseIds}
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";
import { partitionCoursesByLifecycle } from "@/modules/courses/course-status";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import { limpiarSeleccionInvalida } from "@/shared/lib/filtro-multiple";

const ALL_CUTS = "__all_cuts__";

interface ListFiltersProps {
  search: string;
  onSearchChange: (v: string) => void;
  searchPlaceholder?: string;
  /**
   * Cursos seleccionados. **Vacío = todos**, no «ninguno» — la semántica la fija
   * `filtro-multiple.ts`, que existe justamente para que esa distinción no se
   * reescriba mal en cada pantalla.
   */
  courseIds: readonly string[];
  onCourseIdsChange: (v: string[]) => void;
  /** `status` (opcional) habilita el agrupado "Cursos activos"/"Cerrados" con
   *  los abiertos primero. Si no viene, degrada a una lista plana alfabética. */
  courses: Array<{
    id: string;
    name: string;
    status?: string | null;
    /** Periodo académico del curso (ej. "2026-2"). Si al menos un curso lo
     *  trae, aparece el filtro de periodo. */
    period?: string | null;
    /** Nombre de la asignatura. Si al menos un curso lo trae, aparece el
     *  filtro de asignatura. */
    subject?: string | null;
  }>;
  /** Etiqueta para el item "todos" — default "Todos los cursos". */
  allLabel?: string;
  /**
   * Lista completa de cuts (cualquier curso). Si está presente y hay un
   * UN solo curso seleccionado, se renderiza un segundo Select con los cuts de
   * ese curso. Con varios cursos no aparece: los cortes son de un curso
   * concreto y mezclarlos no se podría distinguir.
   */
  cuts?: Array<{ id: string; course_id: string; name: string }>;
  /** ID del corte seleccionado, o null para "Todos los cortes". */
  cutId?: string | null;
  onCutChange?: (v: string | null) => void;
  /** Etiqueta para "todos los cortes" — default "Todos los cortes". */
  allCutsLabel?: string;
  /**
   * Periodos y asignaturas seleccionados (**vacío = todos**). Son OPT-IN: el
   * filtro solo aparece si el padre pasa el handler Y los cursos traen ese dato
   * con más de un valor distinto. Un filtro con una sola opción no filtra nada y
   * ocupa lugar.
   *
   * No hacen falta consultas nuevas: las listas se derivan de `courses`, así
   * que las opciones que se ofrecen son exactamente las que el docente tiene.
   * Ofrecer un periodo sin cursos sería prometer un filtro que da vacío.
   */
  periods?: readonly string[];
  onPeriodsChange?: (v: string[]) => void;
  subjects?: readonly string[];
  onSubjectsChange?: (v: string[]) => void;
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
  courseIds,
  onCourseIdsChange,
  courses,
  allLabel,
  cuts,
  cutId,
  onCutChange,
  allCutsLabel,
  periods,
  onPeriodsChange,
  subjects,
  onSubjectsChange,
  extra,
  onClearExtra,
}: ListFiltersProps) {
  const { t } = useTranslation();
  const selectedPeriods = periods ?? [];
  const selectedSubjects = subjects ?? [];
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
  const periodOptions = Array.from(
    new Set(courses.map((c) => c.period).filter((p): p is string => !!p)),
  ).sort((a, b) => b.localeCompare(a, "es-CO", { numeric: true }));
  const subjectOptions = Array.from(
    new Set(courses.map((c) => c.subject).filter((sj): sj is string => !!sj)),
  ).sort((a, b) => a.localeCompare(b, "es-CO", { sensitivity: "base" }));
  // Con un solo valor el filtro no filtra: se oculta en vez de ocupar lugar.
  const showPeriod = !!onPeriodsChange && periodOptions.length > 1;
  const showSubject = !!onSubjectsChange && subjectOptions.length > 1;

  const enPeriodo = (c: { period?: string | null }, ps: readonly string[]) =>
    ps.length === 0 || (c.period != null && ps.includes(c.period));
  const enAsignatura = (c: { subject?: string | null }, ss: readonly string[]) =>
    ss.length === 0 || (c.subject != null && ss.includes(c.subject));

  // CASCADA: el Select de curso solo ofrece los que cumplen periodo+asignatura.
  // Sin esto el docente puede elegir "2026-2" y un curso de 2026-1 y quedarse
  // con la tabla vacía sin entender por qué.
  const coursesInScope = courses.filter(
    (c) => enPeriodo(c, selectedPeriods) && enAsignatura(c, selectedSubjects),
  );
  // Prioridad UX: cursos ABIERTOS primero. `keepIds` mantiene el curso
  // seleccionado en el grupo activo aunque esté finalizado (no lo esconde abajo).
  const { open: openCourses, closed: closedCourses } = partitionCoursesByLifecycle(
    coursesInScope,
    courseIds.length > 0 ? [...courseIds] : undefined,
  );

  /** Al cambiar periodo o asignatura, los cursos elegidos que dejan de estar en
   *  el alcance se quitan. Dejarlos seleccionados filtraría la tabla por un
   *  curso que ya no aparece en la lista — el usuario vería un filtro que no
   *  puede deshacer. */
  const limpiarCursosFueraDeAlcance = (ps: readonly string[], ss: readonly string[]) => {
    if (courseIds.length === 0) return;
    const validos = courses.filter((c) => enPeriodo(c, ps) && enAsignatura(c, ss)).map((c) => c.id);
    const limpio = limpiarSeleccionInvalida(courseIds, validos);
    if (limpio !== courseIds) onCourseIdsChange([...limpio]);
  };
  const aplicarPeriodos = (nuevos: string[]) => {
    onPeriodsChange?.(nuevos);
    limpiarCursosFueraDeAlcance(nuevos, selectedSubjects);
  };
  const aplicarAsignaturas = (nuevas: string[]) => {
    onSubjectsChange?.(nuevas);
    limpiarCursosFueraDeAlcance(selectedPeriods, nuevas);
  };
  // El filtro de CORTE sigue siendo de un solo curso: los cortes pertenecen a
  // un curso concreto, así que con dos seleccionados la lista mezclaría cortes
  // homónimos de cursos distintos sin forma de distinguirlos. Con varios cursos
  // marcados, el selector de corte simplemente no aparece.
  const unicoCurso = courseIds.length === 1 ? courseIds[0] : null;
  const cutsForCourse = unicoCurso ? (cuts ?? []).filter((c) => c.course_id === unicoCurso) : [];
  const showCutSelect = !!unicoCurso && cutsForCourse.length > 0 && !!onCutChange;
  const hasFilters =
    !!search ||
    courseIds.length > 0 ||
    cutId != null ||
    selectedPeriods.length > 0 ||
    selectedSubjects.length > 0;
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
        <MultiSelectFilter
          opciones={subjectOptions.map((sj) => ({ value: sj, label: sj }))}
          seleccion={selectedSubjects}
          onChange={aplicarAsignaturas}
          etiquetaTodos={t("listFilters.allSubjects", { defaultValue: "Todas las asignaturas" })}
          entidadPlural={t("filtros.nounSubjects")}
          triggerClassName="w-full sm:w-52"
        />
      )}
      {showPeriod && (
        <MultiSelectFilter
          opciones={periodOptions.map((p) => ({ value: p, label: p }))}
          seleccion={selectedPeriods}
          onChange={aplicarPeriodos}
          etiquetaTodos={t("listFilters.allPeriods", { defaultValue: "Todos los periodos" })}
          entidadPlural={t("filtros.nounPeriods")}
          // «Todos los periodos» no entraba en `w-36` y se leía «Todos los …»,
          // que es justo lo que hay que evitar en un filtro: el usuario tiene
          // que poder saber QUÉ filtra sin abrirlo.
          triggerClassName="w-full sm:w-44"
        />
      )}
      <MultiSelectFilter
        opciones={[
          ...openCourses.map((c) => ({
            value: c.id,
            label: c.name,
            grupo:
              closedCourses.length > 0
                ? t("course.groupActive", { defaultValue: "Cursos activos" })
                : undefined,
          })),
          ...closedCourses.map((c) => ({
            value: c.id,
            label: c.name,
            grupo: t("course.groupClosed", { defaultValue: "Cursos cerrados" }),
          })),
        ]}
        seleccion={courseIds}
        onChange={onCourseIdsChange}
        etiquetaTodos={resolvedAllLabel}
        entidadPlural={t("filtros.nounCourses")}
        triggerClassName="w-full sm:w-56"
      />
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
            onCourseIdsChange([]);
            onCutChange?.(null);
            onPeriodsChange?.([]);
            onSubjectsChange?.([]);
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
