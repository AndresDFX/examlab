/**
 * ConsolePageEditor — hoja de CONSOLA de una pizarra
 * (`whiteboard_pages.page_type='console'`).
 *
 * Envoltorio delgado sobre `V86Console` (Linux real por WASM), con el mismo
 * papel que `SqlPageEditor` cumple para `SqlRunner`: el motor no se toca, se le
 * da el marco que la HOJA necesita.
 *
 * ── Por qué el botón de pantalla completa va acá y no en `V86Console` ──
 * `V86Console` tiene DOS usos: esta hoja y la pregunta `so_consola` del taller
 * ([WorkshopQuestions](../workshops/WorkshopQuestions.tsx)). Meterle el botón
 * adentro se lo agregaría también a la pantalla donde el alumno RINDE, que es
 * una decisión de producto distinta y que nadie pidió — así que la pantalla
 * completa es del marco de la hoja, no del terminal.
 *
 * ── Y por qué el scroll se movió adentro ──────────────────────────────
 * La consola es el único tipo de hoja cuyo contenido tiene alto INTRÍNSECO
 * (xterm se renderiza con filas y columnas fijas), así que necesita scroll
 * propio o las últimas filas quedan recortadas e inalcanzables. Antes ese
 * scroll lo ponía el contenedor común de `MultiPageWhiteboard` con un
 * condicional por tipo de hoja; ahora vive acá, porque el botón flotante tiene
 * que ser HERMANO del área que scrollea (si es hijo, se va con el contenido) y
 * porque el condicional en el padre existía solo para esta hoja.
 */
import { useEffect, useRef } from "react";

import { FullscreenButton } from "@/components/ui/fullscreen-button";
import { useFullscreen } from "@/hooks/use-fullscreen";
import { V86Console } from "@/modules/serverconsole/V86Console";
import { cn } from "@/shared/lib/utils";

interface Props {
  /** Sesión guardada (comandos + salida) de la fila. */
  transcript: string | null;
  readOnly?: boolean;
  /** El padre persiste el patch en `whiteboard_pages` + actualiza su state. */
  onPersist: (patch: Record<string, unknown>) => void;
  className?: string;
}

export function ConsolePageEditor({ transcript, readOnly, onPersist, className }: Props) {
  const { ref: containerRef, isFullscreen, supported: fullscreenSupported, toggle: toggleFullscreen } =
    useFullscreen<HTMLDivElement>();

  // Espejo de la prop: `V86Console` captura `onChange` en el closure de un
  // efecto y lo conserva (ver su `emit`), así que pasarle la prop directa
  // dejaría clavada la versión del primer render. El arrow que le damos lee el
  // ref en el momento de LLAMAR, no al capturarse. Mismo patrón que el resto de
  // las hojas con sus `onPersistRef`.
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative min-h-0",
        // Sin fondo propio, en pantalla completa la hoja se ve transparente
        // sobre el negro que pinta el navegador.
        isFullscreen && "bg-background",
        className,
      )}
    >
      <div className="h-full overflow-auto">
        <V86Console
          value={transcript}
          onChange={(v) => onPersistRef.current({ console_transcript: v })}
          readOnly={readOnly}
          className={cn(
            // `min-h-full` en vez de `h-full`: llena la hoja cuando sobra alto,
            // pero deja CRECER al bloque cuando el terminal es más alto que el
            // track — así el scroll alcanza la última fila en vez de que quede
            // cortada a la mitad.
            "min-h-full",
            // Piso de ancho ≈ las columnas fijas de xterm: sin él el terminal
            // desborda su propio bloque (overflow-hidden) y la mitad derecha
            // queda inalcanzable, porque el contenedor no tiene nada que
            // scrollear. En modo revisión no hay terminal (solo el transcript,
            // que hace wrap) → no forzamos ancho para no meter scroll inútil.
            !readOnly && "min-w-[52rem]",
          )}
        />
      </div>
      {fullscreenSupported && (
        <FullscreenButton floating isFullscreen={isFullscreen} onToggle={toggleFullscreen} />
      )}
    </div>
  );
}
