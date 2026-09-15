/**
 * `useFullscreen` — el botón de pantalla completa de una vista, en un solo lugar.
 *
 * ── Por qué es un hook y no seis copias ───────────────────────────────
 * Las hojas de una pizarra (`dibujo`, `texto`, `código`, `SQL`, `diagrama`,
 * `consola`) son componentes distintos, pero el "ponete en pantalla completa"
 * es idéntico en todas: un estado, un toggle sobre un contenedor, y un listener
 * para enterarse de que el usuario salió con Esc. Estaba escrito dos veces (el
 * editor de dibujo y el de texto) y las otras cuatro hojas simplemente **no lo
 * tenían**.
 *
 * Copiarlo no es gratis, y las dos copias ya diferían en lo que importa: la del
 * editor de dibujo chequea si el navegador soporta la API antes de pintar el
 * botón, la de texto no. Ese chequeo es el que evita que en iPhone —donde la
 * pantalla completa de elementos NO EXISTE, ni con prefijo— el usuario toque un
 * botón que no puede hacer nada. Al unificar, gana el comportamiento robusto.
 *
 * Los prefijos de Safari y el "no lanzar si no hay soporte" NO viven acá: los
 * resuelve `@/shared/lib/fullscreen`, que es el único lugar del proyecto que
 * sabe de esas rarezas (y que el examen también usa).
 */
import { useCallback, useEffect, useRef, useState } from "react";

import {
  currentFullscreenElement,
  exitFullscreen as exitFullscreenCompat,
  fullscreenAllowed,
  onFullscreenChange,
  requestFullscreen as requestFullscreenCompat,
} from "@/shared/lib/fullscreen";

export interface UseFullscreen<T extends HTMLElement> {
  /** Ref al contenedor que se proyecta. Ponelo en el elemento raíz de la vista. */
  ref: React.RefObject<T | null>;
  /** ¿Hay algo en pantalla completa ahora? Sirve para el ícono y para el fondo. */
  isFullscreen: boolean;
  /** ¿El navegador lo permite acá? Si es `false`, NO pintes el botón. */
  supported: boolean;
  toggle: () => void;
}

/**
 * @param targetRef Contenedor ALTERNATIVO a proyectar. Por defecto se proyecta
 *   el elemento de `ref`; un padre puede pedir que la pantalla completa abarque
 *   un ancestro (ej. el editor de dibujo, cuando el canvas es transparente y la
 *   imagen de fondo es un hermano: proyectar solo el canvas muestra los trazos
 *   sobre negro).
 */
export function useFullscreen<T extends HTMLElement = HTMLDivElement>(
  targetRef?: { readonly current: HTMLElement | null },
): UseFullscreen<T> {
  const ref = useRef<T | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Determinístico en el primer render y corregido POST-MOUNT a propósito:
  // `document.fullscreenEnabled` no existe en el HTML pre-renderizado, y leerlo
  // en el initializer haría que el árbol del cliente difiera del servidor
  // (hidratación, React #418 — la misma regla que `useTheme`).
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(fullscreenAllowed());
  }, []);

  // El usuario puede salir con Esc o desde el menú del navegador, y eso no pasa
  // por nuestro `toggle`. Sin este listener el ícono queda al revés después de
  // salir. `onFullscreenChange` registra también el evento prefijado de Safari.
  useEffect(() => onFullscreenChange(() => setIsFullscreen(currentFullscreenElement() != null)), []);

  const toggle = useCallback(() => {
    const el = targetRef?.current ?? ref.current;
    if (!el) return;
    if (currentFullscreenElement() != null) void exitFullscreenCompat();
    else void requestFullscreenCompat(el);
  }, [targetRef]);

  return { ref, isFullscreen, supported, toggle };
}
