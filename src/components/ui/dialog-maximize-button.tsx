/**
 * Botón de «ampliar / restaurar» de un modal, alineado con su X de cierre.
 *
 * ── Por qué es un componente y no un `<Button>` en el header ──────────
 * Escrito a mano quedaba desalineado, y no por descuido: la X del diálogo es
 * `absolute right-3 top-3 sm:right-4 sm:top-4` con `h-9 w-9`, mientras que el
 * botón vivía DENTRO de `DialogHeader`, en flujo normal y con `h-8 w-8`. Dos
 * cajas de distinto tamaño, una posicionada contra el borde del modal y la otra
 * contra el texto del título: no hay forma de que sus centros coincidan, y
 * cualquier cambio de padding del header las vuelve a separar.
 *
 * Acá se posiciona con las MISMAS anclas que la X y el mismo alto, desplazado
 * exactamente su ancho más el margen. Si algún día se mueve la X, se mueve esto
 * en el mismo archivo de al lado.
 */
import { Maximize2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";

export function DialogMaximizeButton({
  maximized,
  onToggle,
  className,
}: Readonly<{
  maximized: boolean;
  onToggle: () => void;
  className?: string;
}>) {
  const { t } = useTranslation();
  const etiqueta = maximized ? t("common.restoreSize") : t("common.fullSize");
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onToggle}
      title={etiqueta}
      aria-label={etiqueta}
      className={cn(
        // Mismas anclas y mismo alto que `DialogPrimitive.Close` (ver
        // `dialog.tsx`), corrido hacia la izquierda el ancho de la X más el
        // margen: 12+36 = 48px (`right-12`) en móvil, 16+36+4 = 56px
        // (`right-14`) en sm+.
        "absolute right-12 top-3 sm:right-14 sm:top-4 h-9 w-9 opacity-70 hover:opacity-100",
        className,
      )}
    >
      {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
    </Button>
  );
}
