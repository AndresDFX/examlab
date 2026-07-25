import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { partitionCoursesByLifecycle } from "./course-status";

/**
 * Selector de UN curso que prioriza los cursos ABIERTOS: los activos
 * (no-finalizados) van primero bajo "Cursos activos" y los finalizados debajo
 * de un separador bajo "Cursos cerrados" (no se ocultan). Misma UX que el filtro
 * de `ListFilters`, pero para los `<Select>` propios de las pantallas que NO usan
 * ListFilters (asistencia, gradebook, banco de preguntas, etc.).
 *
 * Requiere que los `courses` traigan `status` para agrupar; si no, degrada a una
 * lista plana alfabética. `value` (el curso actual) queda siempre en el grupo
 * activo aunque esté finalizado (no se esconde el que estás viendo).
 */
const ALL = "__all__";

export interface CourseSelectCourse {
  id: string;
  name: string;
  status?: string | null;
  period?: string | null;
}

export function CourseSelect({
  courses,
  value,
  onChange,
  includeAll = false,
  allLabel,
  placeholder,
  showPeriod = false,
  disabled = false,
  className,
  triggerClassName,
}: Readonly<{
  courses: CourseSelectCourse[];
  /** id del curso, o null/"" para "todos" (solo si includeAll). */
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  includeAll?: boolean;
  allLabel?: string;
  placeholder?: string;
  showPeriod?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
}>) {
  const { t } = useTranslation();
  const { open, closed } = partitionCoursesByLifecycle(courses, value ? [value] : undefined);
  const label = (c: CourseSelectCourse) =>
    showPeriod && c.period ? `${c.name} (${c.period})` : c.name;
  const items = (list: CourseSelectCourse[]) =>
    list.map((c) => (
      <SelectItem key={c.id} value={c.id}>
        {label(c)}
      </SelectItem>
    ));

  return (
    <Select
      value={value ?? (includeAll ? ALL : undefined)}
      onValueChange={(v) => onChange(v === ALL ? null : v)}
      disabled={disabled}
    >
      <SelectTrigger className={triggerClassName ?? className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {includeAll && (
          <SelectItem value={ALL}>
            {allLabel ?? t("hc_componentsUiListFilters.allCourses", { defaultValue: "Todos los cursos" })}
          </SelectItem>
        )}
        {closed.length > 0 ? (
          <>
            <SelectGroup>
              <SelectLabel>{t("course.groupActive", { defaultValue: "Cursos activos" })}</SelectLabel>
              {items(open)}
            </SelectGroup>
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>{t("course.groupClosed", { defaultValue: "Cursos cerrados" })}</SelectLabel>
              {items(closed)}
            </SelectGroup>
          </>
        ) : (
          items(open)
        )}
      </SelectContent>
    </Select>
  );
}
