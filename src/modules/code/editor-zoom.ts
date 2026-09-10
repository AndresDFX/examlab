/**
 * Helper PURO del zoom de los editores de código.
 *
 * Vive aparte de los componentes porque lo usan los TRES editores (el
 * compilador de examen/taller y los de Java y Python con interfaz gráfica) y
 * porque el caso que importa —una unidad CSS que no es px— solo se puede fijar
 * con un test.
 */

/**
 * Escala el alto del editor junto con la fuente. Sin esto, subir el zoom no
 * agranda nada: solo deja menos líneas a la vista dentro del mismo recuadro.
 *
 * `height` llega como string CSS desde el caller (`"20rem"`, `"400px"`,
 * `"60vh"`…), así que se escala el NÚMERO y se conserva la UNIDAD. Si no se
 * puede leer un número —`"auto"`, `"calc(100% - 2rem)"`, vacío— se devuelve el
 * valor tal cual en vez de inventar un alto: un editor de 0px es peor que uno
 * que no creció.
 */
export function escalarAltoEditor(height: string, zoom: number): string {
  if (zoom === 1) return height;
  const m = /^([\d.]+)([a-z%]*)$/i.exec(height.trim());
  if (!m) return height;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return height;
  return `${+(n * zoom).toFixed(2)}${m[2]}`;
}
