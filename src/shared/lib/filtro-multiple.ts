/**
 * Semántica de un filtro de selección MÚLTIPLE en un grid.
 *
 * ── El punto entero: vacío significa TODOS ────────────────────────────
 * Un filtro sin nada marcado no filtra; no es «ningún resultado». Es el mismo
 * error que este repo ya pagó dos veces con `[]`: `course-scope.ts` documenta
 * que un `.in(col, [])` de PostgREST devuelve TODAS las filas en vez de
 * ninguna, y `course-filter-scope.ts` que `null` no es lo mismo que el conjunto
 * vacío. Al pasar los filtros de uno a varios valores reaparece exactamente esa
 * confusión, así que la regla vive en UN lugar con tests en vez de repetirse
 * como un `length === 0 ||` en cada pantalla.
 *
 * Se eligió «arreglo vacío = sin filtro» y no un `null` aparte porque el
 * componente de selección múltiple siempre tiene una lista: obligar a cada
 * pantalla a distinguir `null` de `[]` sería justamente el bug que se quiere
 * evitar.
 */

/** ¿Este valor pasa el filtro? Sin nada marcado, pasa todo. */
export function coincideFiltro(
  seleccion: readonly string[],
  valor: string | null | undefined,
): boolean {
  if (seleccion.length === 0) return true;
  return !!valor && seleccion.includes(valor);
}

/**
 * Variante M:N: pasa si CUALQUIERA de sus valores está marcado.
 *
 * Talleres y proyectos se comparten entre cursos, así que exigir que todos
 * coincidan escondería un taller compartido con un curso seleccionado — el
 * mismo criterio que `anyCourseInScope` y `visibleForScopedCourses`.
 */
export function coincideAlgunFiltro(
  seleccion: readonly string[],
  valores: readonly (string | null | undefined)[],
): boolean {
  if (seleccion.length === 0) return true;
  return valores.some((v) => !!v && seleccion.includes(v));
}

/** Marca o desmarca un valor, devolviendo una lista nueva. */
export function alternarSeleccion(seleccion: readonly string[], valor: string): string[] {
  return seleccion.includes(valor)
    ? seleccion.filter((v) => v !== valor)
    : [...seleccion, valor];
}

/**
 * Qué se lee en el botón del filtro.
 *
 * Con UNO marcado se muestra su nombre —que es la información útil— y recién
 * con dos o más se cuenta, porque a partir de ahí los nombres no entran y una
 * lista truncada («Programación II, Semina…») se lee peor que un número.
 */
export function etiquetaSeleccion(
  seleccion: readonly string[],
  nombrePorValor: (valor: string) => string | undefined,
  textos: { todos: string; varios: (n: number) => string },
): string {
  if (seleccion.length === 0) return textos.todos;
  if (seleccion.length === 1) return nombrePorValor(seleccion[0]) ?? textos.varios(1);
  return textos.varios(seleccion.length);
}

/**
 * Quita de la selección lo que ya no existe entre las opciones.
 *
 * Hace falta porque los filtros se encadenan: al acotar por periodo, el Select
 * de curso deja de ofrecer los de otros periodos, y un curso que quedó marcado
 * seguiría filtrando la tabla SIN aparecer en el botón — el usuario ve una
 * tabla recortada y ningún filtro que lo explique.
 *
 * Devuelve la MISMA referencia cuando no hay nada que quitar, para no disparar
 * un render (ni un efecto) en cada pasada.
 */
export function limpiarSeleccionInvalida(
  seleccion: readonly string[],
  valoresValidos: Iterable<string>,
): readonly string[] {
  const validos = new Set(valoresValidos);
  if (seleccion.every((v) => validos.has(v))) return seleccion;
  return seleccion.filter((v) => validos.has(v));
}
