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
import { Input } from "./input";
import { Button } from "./button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";

const ALL_COURSES = "__all__";

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
}

export function ListFilters({
  search,
  onSearchChange,
  searchPlaceholder = "Buscar por título…",
  courseId,
  onCourseChange,
  courses,
  allLabel = "Todos los cursos",
}: ListFiltersProps) {
  const hasFilters = !!search || courseId != null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative flex-1 min-w-[180px] sm:max-w-xs">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="pl-8"
        />
      </div>
      <Select
        value={courseId ?? ALL_COURSES}
        onValueChange={(v) => onCourseChange(v === ALL_COURSES ? null : v)}
      >
        <SelectTrigger className="w-full sm:w-56">
          <SelectValue placeholder={allLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL_COURSES}>{allLabel}</SelectItem>
          {courses.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onSearchChange("");
            onCourseChange(null);
          }}
          title="Limpiar filtros"
        >
          <X className="h-4 w-4 mr-1" />
          Limpiar
        </Button>
      )}
    </div>
  );
}
