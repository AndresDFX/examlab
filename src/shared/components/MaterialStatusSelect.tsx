/**
 * Select de filtro por estado del CURSO para los grids de material del
 * docente (contenidos, videos) y la vista de material del estudiante. Se pasa
 * al slot `extra` de `ListFilters` o se renderiza junto al `SearchInput`.
 *
 * Default = "Activos" (material de cursos no finalizados; oculta cerrados). El
 * estado del material se DERIVA del curso — ver
 * [material-status.ts](src/shared/lib/material-status.ts) para la regla.
 */
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";
import type { MaterialStatusFilter } from "@/shared/lib/material-status";

export function MaterialStatusSelect({
  value,
  onChange,
  className,
}: {
  value: MaterialStatusFilter;
  onChange: (v: MaterialStatusFilter) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as MaterialStatusFilter)}>
      <SelectTrigger className={className ?? "w-full sm:w-44"}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="activos">
          {t("materialStatus.activos", { defaultValue: "Activos" })}
        </SelectItem>
        <SelectItem value="cerrados">
          {t("materialStatus.cerrados", { defaultValue: "Cerrados" })}
        </SelectItem>
        <SelectItem value="todos">{t("common.all", { defaultValue: "Todos" })}</SelectItem>
      </SelectContent>
    </Select>
  );
}
