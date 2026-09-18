/**
 * Filtro por estado del CURSO (selección MÚLTIPLE) para los grids de material
 * del docente (contenidos, videos) y la vista de material del estudiante. Se
 * pasa al slot `extra` de `ListFilters` o se renderiza junto al `SearchInput`.
 *
 * Default = "Activos" (material de cursos no finalizados; oculta cerrados). El
 * estado del material se DERIVA del curso — ver
 * [material-status.ts](src/shared/lib/material-status.ts) para la regla del
 * default no-vacío.
 */
import { useTranslation } from "react-i18next";
import { MultiSelectFilter } from "@/components/ui/multi-select-filter";
import {
  MATERIAL_STATUS_VALUES,
  type MaterialStatusValue,
} from "@/shared/lib/material-status";

export function MaterialStatusSelect({
  value,
  onChange,
  className,
}: {
  value: readonly MaterialStatusValue[];
  onChange: (v: MaterialStatusValue[]) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const labelByValue: Record<MaterialStatusValue, { key: string; es: string }> = {
    activos: { key: "materialStatus.activos", es: "Activos" },
    cerrados: { key: "materialStatus.cerrados", es: "Cerrados" },
  };
  return (
    <MultiSelectFilter
      opciones={MATERIAL_STATUS_VALUES.map((v) => ({
        value: v,
        label: t(labelByValue[v].key, { defaultValue: labelByValue[v].es }),
      }))}
      seleccion={value}
      onChange={(v) => onChange(v as MaterialStatusValue[])}
      etiquetaTodos={t("materialStatus.filtroTodos", { defaultValue: "Todos los estados" })}
      entidadPlural={t("filtros.nounStatuses")}
      triggerClassName={className ?? "w-full sm:w-44"}
    />
  );
}
