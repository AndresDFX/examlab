/**
 * Filtro por estado (selección MÚLTIPLE) para los grids de actividades del
 * docente (exámenes, talleres, proyectos, pizarras). Se pasa al slot `extra`
 * de `ListFilters`.
 *
 * Default = borradores + publicados (oculta cerrados). Ver
 * [status-filter.ts](src/shared/lib/status-filter.ts) para la regla del
 * default no-vacío y la semántica de "Todos".
 */
import { useTranslation } from "react-i18next";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import {
  ACTIVITY_STATUS_VALUES,
  type ActivityStatusValue,
} from "@/shared/lib/status-filter";

export function ActivityStatusSelect({
  value,
  onChange,
}: {
  value: readonly ActivityStatusValue[];
  onChange: (v: ActivityStatusValue[]) => void;
}) {
  const { t } = useTranslation();
  const labelByValue: Record<ActivityStatusValue, { key: string; es: string }> = {
    borradores: { key: "activityStatus.optBorradores", es: "Borradores" },
    publicados: { key: "activityStatus.optPublicados", es: "Publicados" },
    cerrados: { key: "activityStatus.cerrados", es: "Cerrados" },
  };
  return (
    <MultiSelectFilter
      opciones={ACTIVITY_STATUS_VALUES.map((v) => ({
        value: v,
        label: t(labelByValue[v].key, { defaultValue: labelByValue[v].es }),
      }))}
      seleccion={value}
      onChange={(v) => onChange(v as ActivityStatusValue[])}
      etiquetaTodos={t("activityStatus.filtroTodos", { defaultValue: "Todos los estados" })}
      entidadPlural={t("filtros.nounStatuses")}
      triggerClassName="w-full sm:w-44"
    />
  );
}
