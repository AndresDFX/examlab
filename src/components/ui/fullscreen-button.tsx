/**
 * `FullscreenButton` — la afordancia de PANTALLA COMPLETA, y la única fuente de
 * su ícono y su etiqueta.
 *
 * Va siempre con `useFullscreen()` (`@/hooks/use-fullscreen`), que aporta el
 * estado y el toggle; este componente solo pinta. Regla: si `supported` del
 * hook es `false`, no lo renderices — un botón que no puede hacer nada (iPhone)
 * es peor que ninguno.
 *
 * `floating` es la ubicación estándar dentro de una vista que se proyecta:
 * abajo a la derecha, sobre el contenido. Es una prop y no una clase que cada
 * pantalla retipea para que las seis hojas de una pizarra lo tengan EN EL MISMO
 * LUGAR — que era el punto de unificarlas. Ojo: el ancestro tiene que ser
 * `relative`, y NO puede ser el mismo elemento que scrollea, o el botón se va
 * con el scroll.
 *
 * El alto/ancho fijo de 32px no es decorativo: es el piso de área táctil del
 * proyecto. El patrón anterior (`p-1.5` sobre un ícono de 16px) daba 28px.
 */
import type { MouseEvent } from "react";

import { Maximize2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/utils";

interface Props {
  /** Estado actual, de `useFullscreen()`. Decide el ícono y la etiqueta. */
  isFullscreen: boolean;
  onToggle: () => void;
  /** Posicionado absoluto abajo a la derecha del contenedor proyectado. */
  floating?: boolean;
  /**
   * Para vistas que no deben perder el foco al tocar el botón (el editor de
   * dibujo pierde su manejador de pegado si el foco se va del canvas).
   */
  onMouseDown?: (e: MouseEvent) => void;
  className?: string;
}

export function FullscreenButton({
  isFullscreen,
  onToggle,
  floating,
  onMouseDown,
  className,
}: Props) {
  const { t } = useTranslation();
  const label = isFullscreen
    ? t("common.exitFullscreen", { defaultValue: "Salir de pantalla completa" })
    : t("common.fullscreen", { defaultValue: "Pantalla completa" });

  return (
    <button
      type="button"
      onMouseDown={onMouseDown}
      onClick={onToggle}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-foreground",
        floating && "absolute bottom-2 right-2 z-10",
        className,
      )}
    >
      {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
    </button>
  );
}
