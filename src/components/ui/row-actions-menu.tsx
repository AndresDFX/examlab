import { type ComponentType, type ReactNode } from "react";
import { MoreVertical } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * RowActionsMenu — botón "tres puntos" para acciones de fila en grids.
 *
 * Reemplaza la fila de `<RowAction>` (botones icon-only en línea) por
 * un único trigger que abre un menú con todas las opciones nombradas.
 * Pros vs. la fila de íconos:
 *  - Acciones siempre legibles (label + icono).
 *  - Una sola columna de "Acciones" sin importar cuántas haya.
 *  - Funciona mejor en mobile (no se salta de fila ni truncan los íconos).
 *
 * `<RowAction>` sigue vivo para casos donde sólo hay 1-2 acciones muy
 * directas (ej. una toolbar arriba de una card). En tablas con 3+
 * acciones por fila, usar `<RowActionsMenu>`.
 *
 * Convenciones de orden de acciones:
 *  1. Acciones de gestión de relaciones (estudiantes, docentes, grupos).
 *  2. Acciones de contenido (preguntas, archivos, calificación).
 *  3. Editar.
 *  4. Duplicar.
 *  5. Separator + Eliminar (al final, con `tone="destructive"`).
 *
 * Cada item puede ser:
 *  - onClick handler normal,
 *  - o `to` (TanStack Router Link) — el item hace navegación,
 *  - o `href` (anchor externo).
 */

export type RowActionItem = {
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** Acción al hacer click. Mutuamente excluyente con `to` y `href`. */
  onClick?: () => void;
  /** Ruta interna TanStack Router. Mutuamente excluyente con `onClick`/`href`.
   *  Para rutas dinámicas (`/foo/$id`), pasar también `params`. */
  to?: string;
  /** Params para rutas dinámicas (ej: `{ examId: e.id }`). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any>;
  /** Search params opcionales para `<Link>`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  search?: Record<string, any>;
  /** URL externa. Mutuamente excluyente con `onClick`/`to`. */
  href?: string;
  /** Pinta rojo el item, para acciones destructivas (eliminar). */
  tone?: "default" | "destructive";
  disabled?: boolean;
  /** Inserta un separador horizontal ANTES de este item (típicamente
   *  antes de "Eliminar" para separar lo destructivo del resto). */
  separatorBefore?: boolean;
  /** Tooltip / hint si aplica (ej: "no disponible para externos"). */
  hint?: string;
};

interface RowActionsMenuProps {
  /** Lista de acciones; los nullish se filtran (útil para mostrar
   *  acciones condicionales sin tener que envolver en if). */
  actions: Array<RowActionItem | null | undefined | false>;
  /** Texto del aria-label / tooltip del botón trigger. */
  label?: string;
  /** Slot alternativo para casos en que el padre quiere meter contenido
   *  custom en lugar (o además) del listado declarativo. */
  children?: ReactNode;
  className?: string;
  /** Alineación del menú respecto al trigger. Default `end` = se abre
   *  hacia la izquierda, lo que evita que se salga de la tabla cuando
   *  el trigger está pegado al borde derecho. */
  align?: "start" | "center" | "end";
}

export function RowActionsMenu({
  actions,
  label = "Acciones",
  children,
  className,
  align = "end",
}: Readonly<RowActionsMenuProps>) {
  const visibleActions = actions.filter((a): a is RowActionItem => !!a && typeof a === "object");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          className={cn("h-8 w-8", className)}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="w-56">
        {visibleActions.map((action, idx) => {
          const ItemIcon = action.icon;
          const itemClass = cn(
            "cursor-pointer",
            action.tone === "destructive" &&
              "text-destructive focus:text-destructive focus:bg-destructive/10",
          );
          const inner = (
            <>
              <ItemIcon className="h-4 w-4" aria-hidden />
              <span className="flex-1">{action.label}</span>
            </>
          );
          // Caso navegación interna: usamos asChild + Link. Evita que el
          // click de la fila (cursor-pointer) capture el evento.
          let item: ReactNode;
          if (action.to) {
            item = (
              <DropdownMenuItem
                asChild
                disabled={action.disabled}
                title={action.hint}
                className={itemClass}
              >
                <Link
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  to={action.to as any}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  params={action.params as any}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  search={action.search as any}
                  onClick={(e) => e.stopPropagation()}
                >
                  {inner}
                </Link>
              </DropdownMenuItem>
            );
          } else if (action.href) {
            item = (
              <DropdownMenuItem
                asChild
                disabled={action.disabled}
                title={action.hint}
                className={itemClass}
              >
                <a
                  href={action.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  {inner}
                </a>
              </DropdownMenuItem>
            );
          } else {
            item = (
              <DropdownMenuItem
                disabled={action.disabled}
                title={action.hint}
                onClick={(e) => {
                  e.stopPropagation();
                  action.onClick?.();
                }}
                className={itemClass}
              >
                {inner}
              </DropdownMenuItem>
            );
          }
          return (
            <span key={idx}>
              {action.separatorBefore && idx > 0 && <DropdownMenuSeparator />}
              {item}
            </span>
          );
        })}
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
