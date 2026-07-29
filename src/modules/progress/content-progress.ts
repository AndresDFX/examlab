/**
 * Progreso de consumo de material del tablero — helpers PUROS.
 *
 * ── Por qué acá NO hay un porcentaje ──────────────────────────────────
 * La tentación es devolver `pct` y pintar una barra de avance. Se descartó a
 * propósito, por dos razones verificadas en el código:
 *
 *  1. El denominador CRECE durante el semestre. El tablero muestra el material
 *     de TODAS las sesiones (pasadas y futuras) y el único gate de fecha
 *     (`release_after_session_date`) no lo usa ningún contenido en producción.
 *     O sea: cada archivo que sube el docente BAJA el porcentaje de todos los
 *     alumnos. Un alumno al día vería 100% en marzo y 60% en abril sin haber
 *     hecho nada — un número que retrocede solo se lee como bug.
 *
 *  2. Un archivo REEMPLAZADO sigue contando como visto. Todos los flujos de
 *     "nueva versión" hacen upsert al MISMO path (es justamente lo que hace
 *     que la clave sea estable), así que quien abrió el PDF viejo queda
 *     marcado aunque nunca haya leído la corrección.
 *
 * Con esas dos, llamar "avance del curso" a este número sería afirmar algo
 * falso. Lo que SÍ es literalmente cierto es cuántos archivos abrió el alumno
 * de los que hoy tiene disponibles — y eso es lo que se expone: un CONTEO,
 * no un porcentaje. Si algún día se quiere un % honesto, primero hay que
 * definir el denominador (¿material liberado a la fecha?) y versionar los
 * archivos; recién entonces agregar el campo acá.
 */

/** Un archivo tal como el tablero lo está renderizando hoy. */
export type RenderedFile = {
  contentId: string;
  filePath: string;
};

export type MaterialProgress = {
  /** Archivos disponibles HOY que el alumno abrió o descargó. */
  viewed: number;
  /** Archivos distintos que el tablero le muestra hoy. */
  total: number;
};

/**
 * Clave de una fila de progreso. Debe coincidir con la identidad de la tabla
 * `content_file_progress` (user_id, course_id, content_id, file_path): el
 * user y el course ya están fijados por la query, así que acá alcanza el par
 * (contenido, archivo).
 *
 * El separador es `|` porque un UUID no lo contiene y un path tampoco.
 */
export function progressKey(contentId: string, filePath: string): string {
  return `${contentId}|${filePath}`;
}

/**
 * Conteo de material consumido.
 *
 * El denominador sale de lo que el tablero está renderizando (`rendered`), que
 * es la ÚNICA fuente exacta: el filtro de visibilidad del alumno combina
 * archivos solo-docente, el subconjunto explícito de la sesión y el número de
 * clase, con un fallback que decide sobre el conjunto completo. Replicar eso
 * en SQL sería un invariante frágil, así que el cálculo vive acá.
 *
 * Dos garantías que los tests fijan:
 *  - **Dedupe**: el mismo (contenido, archivo) puede renderizarse bajo varias
 *    sesiones. Sin deduplicar, el total se infla y el conteo podría superar
 *    al denominador.
 *  - **Intersección**: solo se cuentan las claves vistas que EXISTEN hoy. Un
 *    regen completo con IA reescribe `files[]` con paths nuevos y deja filas
 *    huérfanas; se ignoran en silencio en vez de inflar el número.
 */
export function computeMaterialProgress(
  rendered: readonly RenderedFile[],
  viewedKeys: ReadonlySet<string>,
): MaterialProgress {
  const unique = new Set<string>();
  for (const f of rendered) {
    if (!f.contentId || !f.filePath) continue;
    unique.add(progressKey(f.contentId, f.filePath));
  }
  let viewed = 0;
  for (const key of unique) {
    if (viewedKeys.has(key)) viewed++;
  }
  return { viewed, total: unique.size };
}
