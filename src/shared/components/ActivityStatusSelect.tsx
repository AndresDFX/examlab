/**
 * Select de filtro por estado para los grids de actividades del docente
 * (exámenes, talleres, proyectos). Se pasa al slot `extra` de `ListFilters`.
 *
 * Default = "Activos" (activos + borradores; oculta cerrados). Ver
 * [status-filter.ts](src/shared/lib/status-filter.ts) para la regla.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ActivityStatusFilter } from "@/shared/lib/status-filter";

export function ActivityStatusSelect({
  value,
  onChange,
}: {
  value: ActivityStatusFilter;
  onChange: (v: ActivityStatusFilter) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ActivityStatusFilter)}>
      <SelectTrigger className="w-full sm:w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="activos">Activos y borradores</SelectItem>
        <SelectItem value="cerrados">Cerrados</SelectItem>
        <SelectItem value="todos">Todos</SelectItem>
      </SelectContent>
    </Select>
  );
}
