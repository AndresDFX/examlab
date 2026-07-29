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
import { useTranslation } from "react-i18next";
import {
  ACTIVITY_STATUS_OPTIONS,
  type ActivityStatusFilter,
} from "@/shared/lib/status-filter";

/** Etiqueta por opción. Se resuelven con `t()` dentro del componente. */
const LABEL_KEY: Record<ActivityStatusFilter, { key: string; es: string }> = {
  activos: { key: "activityStatus.activos", es: "Activos y borradores" },
  borradores: { key: "activityStatus.borradores", es: "Solo borradores" },
  publicados: { key: "activityStatus.publicados", es: "Solo publicados" },
  cerrados: { key: "activityStatus.cerrados", es: "Cerrados" },
  todos: { key: "activityStatus.todos", es: "Todos" },
};

export function ActivityStatusSelect({
  value,
  onChange,
}: {
  value: ActivityStatusFilter;
  onChange: (v: ActivityStatusFilter) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as ActivityStatusFilter)}>
      <SelectTrigger className="w-full sm:w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {/* Se generan desde ACTIVITY_STATUS_OPTIONS: agregar un estado es una
            línea en status-filter.ts, no tocar este componente ni los 4 grids. */}
        {ACTIVITY_STATUS_OPTIONS.map((opt) => (
          <SelectItem key={opt} value={opt}>
            {t(LABEL_KEY[opt].key, { defaultValue: LABEL_KEY[opt].es })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
