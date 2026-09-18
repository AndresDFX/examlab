/**
 * Celda compacta para mostrar 1..N cursos asociados a una entidad
 * (taller / proyecto / examen). Cuando hay un único curso, lo muestra
 * inline. Cuando hay varios, muestra el primero + un Badge "+N" que
 * abre un Popover con la lista completa — evita que el grid principal
 * se ensanche al sumar todos los Badges en línea (problema reportado
 * en Proyectos con `linked_course_ids`).
 *
 * Es presentacional: el caller decide qué cursos pasar; aquí solo
 * cuidamos overflow y consistencia visual.
 */
import { useTranslation } from "react-i18next";
import { Badge } from "./badge";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface CourseListItem {
  id: string;
  name: string;
  /** Sufijo opcional ("2025-II", etc.) que aparece después de ` · ` en el badge. */
  period?: string | null;
}

interface CourseListCellProps {
  courses: CourseListItem[];
  /** Cuántos cursos mostrar inline antes del "+N". Default 1. */
  inlineLimit?: number;
  /** Texto del Popover header. */
  popoverTitle?: string;
  /** Mensaje cuando no hay cursos (raro pero defensivo). */
  emptyLabel?: string;
}

export function CourseListCell({
  courses,
  inlineLimit = 1,
  popoverTitle,
  emptyLabel = "—",
}: CourseListCellProps) {
  const { t } = useTranslation();
  if (courses.length === 0) {
    return <span className="text-xs text-muted-foreground">{emptyLabel}</span>;
  }

  const inline = courses.slice(0, inlineLimit);
  const overflow = courses.slice(inlineLimit);

  return (
    // `min-w-0` y NO `flex-wrap`: la celda vive en una tabla `table-fixed`, así
    // que su ancho ya está dado. Sin `min-w-0` un hijo flex no puede encogerse
    // por debajo de su contenido y se sale de la columna; con `flex-wrap`, el
    // «+N» caía a una segunda línea y esa fila quedaba más alta que las demás.
    <div className="flex items-center gap-1 min-w-0">
      {inline.map((c) => (
        <Badge
          key={c.id}
          variant="outline"
          // El tope lo pone la CELDA (`max-w-full`), no un valor en rem: el
          // anterior era `max-w-[10rem]` (160px) dentro de columnas de `w-32`
          // (128px), así que el badge desbordaba por diseño — era el síntoma
          // reportado. `min-w-0` es lo que habilita truncar dentro de un flex.
          className="text-3xs min-w-0 max-w-full truncate"
          title={`${c.name}${c.period ? ` · ${c.period}` : ""}`}
        >
          {c.name}
          {c.period ? ` · ${c.period}` : ""}
        </Badge>
      ))}
      {overflow.length > 0 && (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              // `shrink-0`: son dos o tres caracteres y es el único indicio de
              // que hay más cursos. Lo que cede espacio es el nombre, que ya
              // trunca y conserva el texto completo en su `title`.
              className="shrink-0 inline-flex items-center rounded-full border bg-muted/40 hover:bg-muted px-1.5 py-0.5 text-3xs font-medium text-muted-foreground transition-colors"
              title={t("hc_componentsUiCourseListCell.moreCourses", {
                count: overflow.length,
                defaultValue_one: "+{{count}} curso más",
                defaultValue_other: "+{{count}} cursos más",
              })}
            >
              +{overflow.length}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-3" align="start">
            {popoverTitle && <div className="text-xs font-medium mb-2">{popoverTitle}</div>}
            <div className="flex flex-wrap gap-1">
              {courses.map((c) => (
                <Badge
                  key={c.id}
                  variant="outline"
                  className="text-3xs max-w-[14rem] truncate"
                  title={`${c.name}${c.period ? ` · ${c.period}` : ""}`}
                >
                  {c.name}
                  {c.period ? ` · ${c.period}` : ""}
                </Badge>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
