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
import type { ActivityStatusFilter } from "@/shared/lib/status-filter";

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
        <SelectItem value="activos">
          {t("activityStatus.activos", { defaultValue: "Activos y borradores" })}
        </SelectItem>
        <SelectItem value="cerrados">
          {t("activityStatus.cerrados", { defaultValue: "Cerrados" })}
        </SelectItem>
        <SelectItem value="todos">{t("common.all", { defaultValue: "Todos" })}</SelectItem>
      </SelectContent>
    </Select>
  );
}
