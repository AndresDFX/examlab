/**
 * Lista de cursos con casillas, para elegir VARIOS dentro de un formulario.
 *
 * ── Por qué casillas y no un Select múltiple ───────────────────────────
 * Con un Select hay que abrirlo para saber qué quedó elegido, y en estos
 * formularios lo elegido es justamente lo que hay que revisar antes de guardar
 * (en qué cursos va a quedar matriculada una cuenta, a qué cursos se difunde un
 * mensaje). Por lo mismo tampoco sirve un menú desplegable con casillas: esconde
 * la selección detrás de un clic y la deja reducida a un contador.
 *
 * ── Por qué es un componente y no markup por pantalla ──────────────────
 * Este bloque estaba copiado, byte por byte, en el diálogo de usuarios del Admin
 * y en el del docente, y con cuatro variantes divergentes más en el repo (cada
 * una con su propio `max-h`, unas con `divide-y`, otras con `space-y`). La regla
 * del proyecto es explícita: si el patrón no existe como componente pero se va a
 * repetir, se crea el componente. Acá ya se había repetido.
 *
 * Scrollea dentro de su caja a propósito: los diálogos que lo usan son
 * `sm:max-w-md` y un docente con nueve cursos los estiraría hasta desbordar a
 * 375px.
 */
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/utils";

export interface CourseCheckboxOption {
  id: string;
  name: string;
  /** Periodo académico, si lo hay. Se muestra atenuado al lado del nombre. */
  period?: string | null;
}

export function CourseCheckboxList({
  courses,
  selectedIds,
  onChange,
  /** Alto máximo de la caja antes de scrollear. */
  maxHeightClass = "max-h-40",
  /**
   * Muestra "Seleccionar todos" / "Quitar todos". Opt-in: en el diálogo del
   * Admin la lista es de una institución entera y elegirla completa casi nunca es
   * lo que se quiere; en las pantallas del docente, sobre SUS cursos, sí.
   */
  showSelectAll = false,
  className,
}: {
  courses: readonly CourseCheckboxOption[];
  selectedIds: readonly string[];
  onChange: (ids: string[]) => void;
  maxHeightClass?: string;
  showSelectAll?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  if (courses.length === 0) return null;

  const todosMarcados = courses.every((c) => selectedIds.includes(c.id));

  return (
    <div className={cn("space-y-1", className)}>
      {/* Solo con más de uno: con un único curso el botón no ahorra nada. */}
      {showSelectAll && courses.length > 1 && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-2xs"
            onClick={() => onChange(todosMarcados ? [] : courses.map((c) => c.id))}
          >
            {todosMarcados ? t("common.deselectAll") : t("common.selectAll")}
          </Button>
        </div>
      )}
      <div className={cn("rounded-md border p-2 overflow-y-auto space-y-1.5", maxHeightClass)}>
        {courses.map((c) => {
          const marcado = selectedIds.includes(c.id);
          return (
            <label key={c.id} className="flex items-start gap-2 text-xs cursor-pointer">
              <Checkbox
                checked={marcado}
                onCheckedChange={(v) =>
                  onChange(
                    v === true ? [...selectedIds, c.id] : selectedIds.filter((x) => x !== c.id),
                  )
                }
                className="mt-0.5 shrink-0"
              />
              <span className="min-w-0">
                {c.name}
                {c.period ? (
                  <span className="text-muted-foreground">{` · ${c.period}`}</span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
