import { Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";

/**
 * Spinner — wrapper sobre Loader2 de lucide con variantes de tamaño
 * fijas y semánticas. Antes cada `<Loader2>` decidía su tamaño con
 * tailwind crudo (h-3, h-3.5, h-4, h-5, h-6 mezclados sin lógica
 * clara), lo que terminaba en spinners de 5 tamaños diferentes en la
 * misma pantalla.
 *
 * Mapa de tamaños:
 *   xs (h-3): inline con `text-sm` o dentro de Badges
 *   sm (h-3.5): dentro de `<Button size="sm">` (la altura del botón
 *     es h-8, h-3.5 cuadra con el texto)
 *   md (h-4): default — buttons normales y page-level inline
 *   lg (h-5): page/section loaders en hero o cards grandes
 *   xl (h-6+): full-screen loaders (raros)
 *
 * Margen: por defecto sin margen. Si lo usas dentro de un botón
 * con texto, pon `className="mr-1"` o `className="mr-2"` según
 * cuán suelto quieras el spacing.
 */

type SpinnerSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE_CLASS: Record<SpinnerSize, string> = {
  xs: "h-3 w-3",
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
  lg: "h-5 w-5",
  xl: "h-6 w-6",
};

interface SpinnerProps {
  size?: SpinnerSize;
  /** Aplica `inline` para que el spinner siga el flujo de texto y no salte de baseline. */
  inline?: boolean;
  className?: string;
  /** aria-label cuando el spinner es la única señal de "está cargando". */
  label?: string;
}

export function Spinner({
  size = "md",
  inline,
  className,
  label = "Cargando",
}: Readonly<SpinnerProps>) {
  return (
    <Loader2
      role="status"
      aria-label={label}
      className={cn(
        "animate-spin",
        SIZE_CLASS[size],
        inline ? "inline" : undefined,
        className,
      )}
    />
  );
}
