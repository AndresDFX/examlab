/**
 * Un curso en BORRADOR no publica material.
 *
 * La regla la impone la base (mig 20262690000000): pasar un curso a borrador
 * pasa a borrador su material, y mientras siga así no se puede publicar nada
 * cuyos cursos estén TODOS en borrador. Lo compartido con otro curso activo sí
 * se puede publicar: ese otro curso lo usa.
 *
 * Acá vive la misma regla del lado de las pantallas, para que ofrezcan lo que la
 * base va a aceptar —deshabilitar «Publicar» con el motivo a la vista es mejor
 * que dejar pulsarlo y mostrar un error después—. La base sigue siendo la que
 * decide: si algo de acá falla, lo peor que pasa es un rechazo con un mensaje.
 */

/**
 * `courses.status` de cada curso que la pantalla conoce, por id (ver
 * `CourseStatus` en course-status.ts). `null` es un curso heredado, que cuenta
 * como en curso.
 */
export type EstadosDeCursos = ReadonlyMap<string, string | null>;

export function mapaDeEstados(
  cursos: readonly { id: string; status?: string | null }[],
): Map<string, string | null> {
  return new Map(cursos.map((c) => [c.id, c.status ?? null]));
}

/** Cuántos cursos distintos hay en la lista (para los textos en singular/plural). */
export function cuantosCursos(cursoIds: readonly (string | null | undefined)[]): number {
  return new Set(cursoIds.filter((id): id is string => !!id)).size;
}

/**
 * ¿Todos los cursos del material están en borrador?
 *
 * Mismo criterio que `_solo_cursos_en_borrador` en SQL, con una diferencia a
 * propósito: un curso que la pantalla NO conoce (de otro docente, o fuera de la
 * lista cargada) no se da por borrador. Ante la duda no se bloquea en la
 * pantalla; la base decide. Sin ningún curso (material personal) da `false`.
 */
export function soloCursosEnBorrador(
  cursoIds: readonly (string | null | undefined)[],
  estados: EstadosDeCursos,
): boolean {
  const unicos = [...new Set(cursoIds.filter((id): id is string => !!id))];
  if (unicos.length === 0) return false;
  return unicos.every((id) => estados.has(id) && estados.get(id) === "borrador");
}

/**
 * Pone primero un curso que NO está en borrador, si hay alguno.
 *
 * Al crear material multi-curso, el primer curso de la lista es el ancla
 * (`course_id`) y la base mira el ancla en el INSERT, antes de que existan las
 * filas de unión: con un ancla en borrador, un taller para «un curso en
 * preparación + uno activo» se rechazaría aunque la pantalla, con razón, dejara
 * publicarlo. El resto conserva su orden.
 */
export function conAnclaActiva<T extends string>(cursoIds: readonly T[], estados: EstadosDeCursos): T[] {
  const i = cursoIds.findIndex((id) => estados.has(id) && estados.get(id) !== "borrador");
  if (i <= 0) return [...cursoIds];
  return [cursoIds[i], ...cursoIds.slice(0, i), ...cursoIds.slice(i + 1)];
}
