import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/shared/lib/utils";
import { alternarSeleccion, etiquetaSeleccion } from "@/shared/lib/filtro-multiple";

/**
 * Filtro de grid con selección MÚLTIPLE.
 *
 * ── Por qué reemplaza al `<Select>` ───────────────────────────────────
 * Un `<Select>` obliga a elegir UNA opción o «Todos». Para ver dos cursos a la
 * vez —el caso que se pidió— no había forma: o mirabas uno, o los mirabas
 * todos. Acá se marcan los que se quieran y el resto de la semántica la fija
 * `filtro-multiple.ts`: **sin nada marcado, no se filtra**.
 *
 * ── Por qué un menú con casillas y no un Select múltiple nativo ───────
 * Mismo criterio que `CourseCheckboxList`, que ya existe en el repo para elegir
 * varios cursos dentro de un formulario: con un Select hay que abrirlo para
 * saber qué quedó elegido. Acá lo elegido se lee en el propio botón (el nombre
 * cuando es uno, el conteo cuando son varios), que es lo que el docente
 * necesita ver de un vistazo sobre una tabla ya filtrada.
 *
 * Los grupos son opcionales y sirven para lo mismo que en `CourseSelect`:
 * separar cursos activos de cerrados sin esconder ninguno.
 */

export interface OpcionFiltro {
  value: string;
  label: string;
  /** Encabezado bajo el que se agrupa. Sin esto, va en la lista llana. */
  grupo?: string;
}

export function MultiSelectFilter({
  opciones,
  seleccion,
  onChange,
  etiquetaTodos,
  className,
  triggerClassName,
  disabled = false,
  ariaLabel,
}: Readonly<{
  opciones: readonly OpcionFiltro[];
  /** Vacío = sin filtrar. Ver `filtro-multiple.ts`. */
  seleccion: readonly string[];
  onChange: (seleccion: string[]) => void;
  /** Lo que se lee cuando no hay nada marcado, p. ej. «Todos los cursos». */
  etiquetaTodos: string;
  className?: string;
  triggerClassName?: string;
  disabled?: boolean;
  ariaLabel?: string;
}>) {
  const { t } = useTranslation();

  const nombrePorValor = useMemo(() => {
    const m = new Map(opciones.map((o) => [o.value, o.label]));
    return (v: string) => m.get(v);
  }, [opciones]);

  const etiqueta = etiquetaSeleccion(seleccion, nombrePorValor, {
    todos: etiquetaTodos,
    varios: (n) => t("filtros.seleccionados", { count: n }),
  });

  // Se conserva el orden en que llegan las opciones; solo se agrupan las que
  // declaran `grupo`, para no reordenar listas que ya vienen ordenadas.
  const grupos = useMemo(() => {
    const orden: string[] = [];
    const porGrupo = new Map<string, OpcionFiltro[]>();
    for (const o of opciones) {
      const g = o.grupo ?? "";
      if (!porGrupo.has(g)) {
        porGrupo.set(g, []);
        orden.push(g);
      }
      porGrupo.get(g)!.push(o);
    }
    return orden.map((g) => ({ nombre: g, items: porGrupo.get(g)! }));
  }, [opciones]);

  const hayFiltro = seleccion.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          className={cn(
            "justify-between font-normal",
            hayFiltro && "border-primary/40 bg-primary/5",
            triggerClassName,
            className,
          )}
          aria-label={ariaLabel}
        >
          <span className="truncate">{etiqueta}</span>
          <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto w-[--radix-dropdown-menu-trigger-width] min-w-[11rem] sm:min-w-56">
        {/* «Todos» no es una opción más: es vaciar la selección. Ponerlo como
            casilla haría creer que se puede marcar junto con un curso. */}
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            onChange([]);
          }}
          className="gap-2"
        >
          <Check className={cn("h-4 w-4", hayFiltro ? "opacity-0" : "opacity-100")} />
          <span className={cn(!hayFiltro && "font-medium")}>{etiquetaTodos}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {grupos.map((g, i) => (
          <div key={g.nombre || `g${i}`}>
            {g.nombre && <DropdownMenuLabel className="text-2xs">{g.nombre}</DropdownMenuLabel>}
            {g.items.map((o) => {
              const marcado = seleccion.includes(o.value);
              return (
                <DropdownMenuItem
                  key={o.value}
                  // `preventDefault` mantiene el menú abierto: marcar varios es
                  // el punto, y cerrarlo en cada clic obliga a reabrirlo una vez
                  // por curso.
                  onSelect={(e) => {
                    e.preventDefault();
                    onChange(alternarSeleccion(seleccion, o.value));
                  }}
                  className="gap-2"
                >
                  <Check className={cn("h-4 w-4", marcado ? "opacity-100" : "opacity-0")} />
                  <span className={cn("truncate", marcado && "font-medium")}>{o.label}</span>
                </DropdownMenuItem>
              );
            })}
          </div>
        ))}
        {opciones.length === 0 && (
          <div className="px-2 py-3 text-xs text-muted-foreground">{t("filtros.sinOpciones")}</div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
