import * as React from "react";
import { HelpCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/shared/lib/utils";

/**
 * Pequeño icono "?" que muestra un texto de ayuda al pulsarlo.
 *
 * Pensado para reemplazar las parentéticas inline tipo
 *   <Label>Foo <span className="text-xs ...">(explicación larga)</span></Label>
 * por
 *   <Label>Foo <HelpHint>explicación larga</HelpHint></Label>
 *
 * Implementación: usa Popover (click) en lugar de Tooltip (hover) porque
 * en mobile/tablet los hovers no disparan en touch — el `?` quedaba como
 * decorativo. Click funciona igual en desktop (mouse) que en mobile
 * (tap), y la UX es la misma: pulsa para abrir, pulsa fuera o Esc para
 * cerrar. Hereda `collisionPadding` + `max-w-[calc(100vw-1rem)]` del
 * PopoverContent base, así que el panel respeta el viewport en mobile.
 */
export function HelpHint({
  children,
  className,
  side = "top",
  align = "center",
}: {
  children: React.ReactNode;
  className?: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          tabIndex={0}
          aria-label="Más información"
          // stopPropagation: si el HelpHint vive dentro de un <Label
          // htmlFor=…>, el click "burbujea" hasta el input asociado y
          // hace toggle (caso típico: HelpHint en Label de Switch — al
          // pulsar el `?` se cambiaba el switch además de abrir el
          // popover). preventDefault no basta para los <Label htmlFor>.
          onClick={(e) => e.stopPropagation()}
          className={cn(
            // align-middle + relative offset alinea el centro vertical
            // del icono con la línea base del texto. `align-text-bottom`
            // dejaba el icono caído debajo del baseline en mobile
            // (con line-height grande de Labels el bottom queda lejos
            // del centro visual del texto).
            "inline-flex h-4 w-4 shrink-0 items-center justify-center align-middle relative -top-px",
            "text-muted-foreground hover:text-foreground focus:text-foreground",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full",
            "transition-colors cursor-help",
            className,
          )}
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="w-auto max-w-xs text-xs leading-relaxed whitespace-normal p-3"
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
