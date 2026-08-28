/**
 * Reparto de las pizarras que ve un estudiante en las dos listas que la pantalla
 * muestra: las PROPIAS (las que creó él) y las COMPARTIDAS por el docente.
 *
 * Está en un módulo aparte y es puro porque las tres reglas de abajo no son
 * obvias y una ya se rompió en producción por estar embebida en el render.
 */

/**
 * Arma el payload de INSERT de una pizarra creada por el estudiante.
 *
 * Existe como función aparte, y con test, por UNA razón: que las dos columnas que
 * no son suyas —`is_shared_with_course` y `attendance_session_id`— no aparezcan
 * NUNCA en el payload. El trigger `trg_whiteboard_student_guard` las rechaza de
 * todos modos, pero que la interfaz las mande sería pedirle a la base que diga no,
 * y el día que alguien afloje el trigger el agujero se abre solo. Se OMITEN en vez
 * de mandarlas en `false`/`null`, siguiendo la convención de campos desactivados
 * del proyecto (mandar dummies rompe con "no existe la columna X" cuando el caché
 * de esquema está viejo).
 */
export function construirPizarraNueva(a: {
  ownerId: string;
  name: string;
  description?: string | null;
  /** `null` o vacío ⇒ pizarra sin curso, invisible para todos menos el dueño. */
  courseId?: string | null;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    owner_id: a.ownerId,
    name: a.name.trim(),
    description: (a.description ?? "").trim() || null,
  };
  if (a.courseId) payload.course_id = a.courseId;
  return payload;
}

export interface PizarraVisible {
  id: string;
  owner_id: string | null;
  course_id: string | null;
  is_shared_with_course: boolean | null;
  /** `closed` cuando el curso se finalizó (cascada). Nullish ⇒ publicada. */
  status?: string | null;
}

/** Una pizarra es propia si el estudiante es su dueño. */
export function esPropia(wb: Pick<PizarraVisible, "owner_id">, userId: string): boolean {
  return !!wb.owner_id && wb.owner_id === userId;
}

/**
 * Parte la lista que devolvió la base en las dos que la pantalla muestra.
 *
 * `cursosEnPapelera` son los ids de cursos del estudiante que están en la
 * papelera: un curso borrado deja de existir para él en todo flujo, así que sus
 * pizarras tampoco se muestran.
 *
 * Tres reglas que no se pueden deducir del render:
 *
 *  1. **La propiedad manda sobre lo compartido.** Un usuario multi-rol
 *     (Docente + Estudiante) que entra como estudiante es DUEÑO de las pizarras
 *     que creó dictando, y algunas están compartidas con el curso. Si el reparto
 *     se hiciera por `is_shared_with_course` primero, esas aparecerían en las dos
 *     listas: la misma pizarra dos veces en la misma pantalla se lee como un bug.
 *
 *  2. **A una pizarra PROPIA no se le aplica el filtro de `closed`.** La cascada
 *     de finalizar un curso (`close_whiteboards_for_course`) cierra las pizarras
 *     de ese curso, y una pizarra personal del estudiante atada a él también
 *     queda `closed`. Filtrarla le haría desaparecer SU trabajo el día que el
 *     docente cierra el semestre. El filtro de `closed` existe para lo que el
 *     docente publica —cerrado sale del listado activo—, no para lo propio.
 *
 *  3. **Lo propio no depende de que el curso siga vivo.** Si el curso se manda a
 *     la papelera, la pizarra personal sigue siendo del estudiante; lo que se
 *     oculta es el vínculo con el curso, no la pizarra. Por eso el filtro de
 *     cursos en papelera solo corre sobre las compartidas.
 */
export function partirPizarras<T extends PizarraVisible>(
  items: readonly T[],
  userId: string | null | undefined,
  cursosEnPapelera: ReadonlySet<string> = new Set(),
): { propias: T[]; compartidas: T[] } {
  const propias: T[] = [];
  const compartidas: T[] = [];
  for (const wb of items) {
    if (userId && esPropia(wb, userId)) {
      propias.push(wb);
      continue;
    }
    if (wb.course_id && cursosEnPapelera.has(wb.course_id)) continue;
    if ((wb.status ?? "published") === "closed") continue;
    compartidas.push(wb);
  }
  return { propias, compartidas };
}
