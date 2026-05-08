import * as React from "react";
import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Pequeño icono "?" que muestra un tooltip con texto de ayuda. Pensado
 * para reemplazar las parentéticas inline tipo
 *   <Label>Foo <span className="text-xs ...">(explicación larga)</span></Label>
 * por
 *   <Label>Foo <HelpHint>explicación larga</HelpHint></Label>
 *
 * Funciona en click (mobile) y hover (desktop). Self-contained: incluye
 * su propio TooltipProvider para no requerir uno global.
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
    <TooltipProvider delayDuration={120} skipDelayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            tabIndex={0}
            aria-label="Más información"
            className={cn(
              "inline-flex h-4 w-4 shrink-0 items-center justify-center align-text-bottom",
              "text-muted-foreground hover:text-foreground focus:text-foreground",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-full",
              "transition-colors cursor-help",
              className,
            )}
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side={side}
          align={align}
          className="max-w-xs text-xs leading-relaxed whitespace-normal"
        >
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
