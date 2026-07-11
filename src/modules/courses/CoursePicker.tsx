import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";

/**
 * Selector multi-curso para los forms de crear/editar taller, proyecto y examen.
 *
 * Prioriza lo relevante: muestra por defecto el/los curso(s) ACTUAL(es) del ítem
 * (los ya seleccionados, aunque estén finalizados) y los cursos ABIERTOS
 * (no finalizados). Los cursos FINALIZADOS que no estén seleccionados quedan
 * ocultos tras un pequeño toggle "Mostrar cursos finalizados (N)" — así un
 * docente con muchos cursos cerrados de semestres pasados no tiene que
 * scrollear entre ellos, pero puede asignarlos si lo necesita.
 *
 * Agnóstico del contenedor de selección: acepta `selectedIds` como cualquier
 * Iterable<string> (Set o array), así sirve para forms que usan Set
 * (exámenes/talleres) y para los que usan array (proyectos).
 */
export type CoursePickerCourse = {
  id: string;
  name: string;
  period?: string | null;
  /** courses.status: 'borrador' | 'en_curso' | 'finalizado'. */
  status?: string | null;
};

export function CoursePicker({
  courses,
  selectedIds,
  onToggle,
  emptyText,
  maxHeightClass = "max-h-52",
}: {
  courses: CoursePickerCourse[];
  selectedIds: Iterable<string>;
  onToggle: (id: string) => void;
  emptyText?: string;
  maxHeightClass?: string;
}) {
  const { t } = useTranslation();
  const [showClosed, setShowClosed] = useState(false);
  const sel = new Set(selectedIds);
  const isClosed = (c: CoursePickerCourse) => c.status === "finalizado";

  // Prioridad: cursos NO finalizados, o ya seleccionados (incluye el curso
  // actual del ítem en edición aunque esté finalizado). Seleccionados primero.
  const priority = courses
    .filter((c) => !isClosed(c) || sel.has(c.id))
    .sort((a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)));
  // Finalizados sin seleccionar: ocultos tras el toggle.
  const closed = courses.filter((c) => isClosed(c) && !sel.has(c.id));

  const Item = ({ c }: { c: CoursePickerCourse }) => (
    <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer">
      <Checkbox checked={sel.has(c.id)} onCheckedChange={() => onToggle(c.id)} />
      <span className="flex-1">{c.name}</span>
      {isClosed(c) && (
        <Badge variant="outline" className="text-[9px] text-muted-foreground">
          {t("coursePicker.closedBadge", { defaultValue: "Finalizado" })}
        </Badge>
      )}
      {c.period && (
        <Badge variant="outline" className="text-[9px]">
          {c.period}
        </Badge>
      )}
    </label>
  );

  return (
    <div className={`mt-1.5 ${maxHeightClass} overflow-y-auto rounded-md border p-2 space-y-1`}>
      {courses.length === 0 && (
        <p className="text-xs text-muted-foreground px-2 py-1">
          {emptyText ?? t("coursePicker.empty", { defaultValue: "No hay cursos disponibles." })}
        </p>
      )}
      {priority.map((c) => (
        <Item key={c.id} c={c} />
      ))}
      {closed.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowClosed((v) => !v)}
            className="flex items-center gap-1 w-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {showClosed ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {showClosed
              ? t("coursePicker.hideClosed", { defaultValue: "Ocultar cursos finalizados" })
              : t("coursePicker.showClosed", {
                  count: closed.length,
                  defaultValue: "Mostrar cursos finalizados ({{count}})",
                })}
          </button>
          {showClosed && closed.map((c) => <Item key={c.id} c={c} />)}
        </>
      )}
    </div>
  );
}
