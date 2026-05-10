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
  if (courses.length === 0) {
    return <span className="text-xs text-muted-foreground">{emptyLabel}</span>;
  }

  const inline = courses.slice(0, inlineLimit);
  const overflow = courses.slice(inlineLimit);

  return (
    <div className="flex flex-wrap items-center gap-1">
      {inline.map((c) => (
        <Badge
          key={c.id}
          variant="outline"
          className="text-[10px] max-w-[10rem] truncate"
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
              className="inline-flex items-center rounded-full border bg-muted/40 hover:bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors"
              title={`+${overflow.length} curso${overflow.length === 1 ? "" : "s"} más`}
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
                  className="text-[10px] max-w-[14rem] truncate"
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
