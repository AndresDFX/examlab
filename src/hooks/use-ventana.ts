import { useEffect, useState } from "react";

import type { MedidasDeVentana } from "@/modules/code/editor-opciones";

/**
 * Ancho y alto REALES de la ventana, para los componentes que no pueden
 * resolver su tamaño solo con CSS.
 *
 * El caso que lo trajo: los editores de código pasan su alto a Monaco como una
 * cadena (`height="250px"`), y Monaco la escribe tal cual en el contenedor. No
 * hay media query que llegue ahí, así que el alto del editor en un teléfono hay
 * que calcularlo. Ver `altoDeEditorEnPantalla`.
 *
 * ── Por qué no es `useIsMobile` ───────────────────────────────────────
 * Ese devuelve un booleano y su umbral es 768 px, el ancho al que el sidebar se
 * vuelve cajón. Acá hace falta el ALTO (para calcular el del editor) y el corte
 * es el breakpoint `sm` (640), que es el que usa el resto del contenido. Cambiar
 * `useIsMobile` para servir a los dos movería el cajón del menú.
 *
 * ── Hidratación (React #418) ──────────────────────────────────────────
 * Arranca en `null` a propósito: el HTML pre-renderizado no tiene `window`, así
 * que leerlo en el initializer de `useState` haría que el primer render del
 * cliente difiera del prerenderizado. Quien lo consuma tiene que tratar `null`
 * como «todavía no sé» y comportarse como en escritorio — nunca como «pantalla
 * de 0 px».
 *
 * ── Por qué compara antes de guardar ──────────────────────────────────
 * En iOS la barra de direcciones se encoge al desplazarse y eso dispara
 * `resize` muchas veces por segundo. Guardar un objeto nuevo en cada evento
 * volvería a renderizar el editor aunque las medidas no hayan cambiado.
 */
export function useVentana(): MedidasDeVentana | null {
  const [ventana, setVentana] = useState<MedidasDeVentana | null>(null);

  useEffect(() => {
    const medir = () => {
      const ancho = window.innerWidth;
      const alto = window.innerHeight;
      setVentana((previo) =>
        previo && previo.ancho === ancho && previo.alto === alto ? previo : { ancho, alto },
      );
    };
    medir();
    window.addEventListener("resize", medir);
    return () => window.removeEventListener("resize", medir);
  }, []);

  return ventana;
}
