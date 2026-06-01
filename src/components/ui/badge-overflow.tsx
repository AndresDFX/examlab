/**
 * BadgeOverflow — renderiza una lista de badges con tope visual.
 *
 * Problema que resuelve: en grids con columnas de "etiquetas" (roles,
 * tags, categorías, programas) una fila con muchos items hace que el
 * grid sea más ancho que el resto y rompe la columna fija. Ej: un user
 * con 4 roles (Admin/Docente/Estudiante/SuperAdmin) ocupa ~3x el ancho
 * del promedio.
 *
 * Comportamiento:
 *   - Muestra los primeros `max` items inline.
 *   - Si hay más, agrega un badge `+N` con tooltip que lista el resto.
 *   - Si solo hay 1 extra, el +N sigue ahí (UX consistente). Para
 *     "siempre mostrar todos si caben", el caller usa <Badge> directo.
 *
 * Una sola línea: usa `flex-nowrap` para evitar que un usuario con 3+
 * badges rompa la altura uniforme del grid (cuando wrappeaba, esa fila
 * quedaba ~2x más alta que sus vecinas). El contenedor además aplica
 * `overflow-hidden` para que si los items NO caben en el ancho del
 * cell, se clipean en el borde — preferible a desbordar y empujar la
 * tabla a un layout incoherente.
 *
 * API mínima:
 *   <BadgeOverflow items={["Admin", "Docente", "Estudiante"]} max={2} />
 *
 * Con render custom por item:
 *   <BadgeOverflow
 *     items={users}
 *     max={3}
 *     getKey={(u) => u.id}
 *     renderItem={(u) => <Badge>{u.name}</Badge>}
 *     renderTooltipItem={(u) => u.name}
 *   />
 */
import { type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";

interface BadgeOverflowProps<T> {
  items: readonly T[];
  /** Cuántos mostrar inline antes de empezar a colapsar al +N. */
  max?: number;
  /** Variante visual del Badge para los items inline + el +N.
   *  Default "secondary". */
  variant?: "default" | "secondary" | "outline" | "destructive";
  /** Clase extra para cada badge. Útil para text-[10px] / colores. */
  badgeClassName?: string;
  /** Render custom de cada item. Si no se pasa, usa `toString()`. */
  renderItem?: (item: T) => ReactNode;
  /** Render del item dentro del tooltip (texto plano). Si no se pasa,
   *  usa `String(item)`. */
  renderTooltipItem?: (item: T) => string;
  /** Key del item. Si T es string, no es necesario. */
  getKey?: (item: T, idx: number) => string;
  /** Mensaje cuando items está vacío. Default "—". */
  emptyText?: string;
  /** Clase del contenedor (flex row con gap). */
  className?: string;
}

export function BadgeOverflow<T>({
  items,
  max = 2,
  variant = "secondary",
  badgeClassName = "text-[10px]",
  renderItem,
  renderTooltipItem,
  getKey,
  emptyText = "—",
  className,
}: BadgeOverflowProps<T>) {
  if (items.length === 0) {
    return <span className="text-muted-foreground text-xs">{emptyText}</span>;
  }

  const visible = items.slice(0, max);
  const overflow = items.slice(max);
  const renderInline = (item: T): ReactNode =>
    renderItem ? renderItem(item) : (item as unknown as ReactNode);
  const renderTip = (item: T): string =>
    renderTooltipItem ? renderTooltipItem(item) : String(item);

  return (
    <div
      className={cn(
        // `flex-nowrap`: badges siempre en UNA línea para mantener
        // altura uniforme del grid. `min-w-0`: permite que el contenedor
        // se encoja dentro de su flex/cell padre sin forzar overflow.
        // `overflow-hidden`: si los badges no caben, se clipean en el
        // borde del cell (mejor que romper la altura de la fila).
        "flex flex-nowrap items-center gap-1 min-w-0 overflow-hidden",
        className,
      )}
    >
      {visible.map((item, i) => {
        const key = getKey ? getKey(item, i) : String(item);
        // Si el caller pasa renderItem, asumimos que devuelve un nodo
        // listo (puede ser Badge o cualquier cosa). Si no, envolvemos
        // el toString en un Badge default.
        if (renderItem) {
          return <span key={key}>{renderInline(item)}</span>;
        }
        return (
          <Badge key={key} variant={variant} className={badgeClassName}>
            {String(item)}
          </Badge>
        );
      })}
      {overflow.length > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge
                variant="outline"
                className={cn(badgeClassName, "cursor-default")}
                aria-label={`Y ${overflow.length} más`}
              >
                +{overflow.length}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="max-w-xs">
              <ul className="text-xs space-y-0.5">
                {overflow.map((item, i) => (
                  <li key={getKey ? getKey(item, i) : String(item)}>{renderTip(item)}</li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}
