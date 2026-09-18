/**
 * Alcance de los filtros de PERIODO y ASIGNATURA de `ListFilters`.
 *
 * ── Por qué existe ────────────────────────────────────────────────────
 * `ListFilters` usa periodo/asignatura para acotar el Select de curso, pero eso
 * solo cambia las OPCIONES; la tabla la filtra cada pantalla. Sin este paso,
 * elegir "2026-2" recorta la lista de cursos y la tabla sigue mostrando todo —
 * que se lee como que el filtro está roto. Y el bug es fácil de repetir en cada
 * grid, así que la regla vive en un solo lugar.
 *
 * ── Dos formas: múltiple (grids) y de valor único (vistas de detalle) ──
 * Los grids del docente filtran por VARIOS periodos/asignaturas a la vez
 * (`courseIdsInScopeMulti`). Los selectores de vista de detalle (estadísticas,
 * gradebook, banco de preguntas, asistencia) siguen eligiendo UN periodo y UNA
 * asignatura para acotar el curso que se está mirando: para esos está
 * `courseIdsInScope`, que es un azúcar de valor único sobre la múltiple.
 *
 * Es una función PURA para poder testear el caso que importa (`null` ≠ conjunto
 * vacío) sin montar la pantalla.
 */

export interface CourseScopeRow {
  id: string;
  period?: string | null;
  subject?: string | null;
}

/**
 * Ids de los cursos que cumplen ALGUNO de los periodos y ALGUNA de las
 * asignaturas seleccionados. Cada dimensión filtra por separado (periodo AND
 * asignatura), pero dentro de una dimensión basta con coincidir con cualquiera
 * de los valores marcados.
 *
 * Devuelve **`null` cuando no hay ningún filtro activo** (ambas listas vacías), y
 * eso NO es lo mismo que un conjunto vacío: `null` significa "no acotes nada" y
 * el conjunto vacío significa "ningún curso cumple, la tabla va vacía".
 * Confundirlos es el mismo error que documenta `course-scope.ts` con los `[]` de
 * PostgREST. Por eso el caller debe chequear `!== null` antes de usarlo.
 */
export function courseIdsInScopeMulti(
  courses: readonly CourseScopeRow[],
  periods: readonly string[],
  subjects: readonly string[],
): Set<string> | null {
  const periodSet = periods.length > 0 ? new Set(periods) : null;
  const subjectSet = subjects.length > 0 ? new Set(subjects) : null;
  if (!periodSet && !subjectSet) return null;
  const out = new Set<string>();
  for (const c of courses) {
    if (periodSet && !(c.period != null && periodSet.has(c.period))) continue;
    if (subjectSet && !(c.subject != null && subjectSet.has(c.subject))) continue;
    out.add(c.id);
  }
  return out;
}

/**
 * Variante de VALOR ÚNICO (un periodo, una asignatura), para los selectores de
 * vista de detalle que siguen eligiendo uno de cada. Es azúcar sobre la
 * múltiple: `null`/`""`/`undefined` = esa dimensión no filtra.
 */
export function courseIdsInScope(
  courses: readonly CourseScopeRow[],
  period: string | null | undefined,
  subject: string | null | undefined,
): Set<string> | null {
  return courseIdsInScopeMulti(courses, period ? [period] : [], subject ? [subject] : []);
}

/**
 * ¿Este item entra en el alcance? Azúcar para el caso de un item con UN curso.
 *
 * `courseId` nullable a propósito: hay entidades que no cuelgan de un curso
 * (pizarras y contenidos personales del docente). Con un filtro de periodo o
 * asignatura activo se ocultan, porque no se les puede atribuir un periodo —
 * afirmar que pertenecen al que está seleccionado sería inventar el dato.
 */
export function itemInScope(scope: Set<string> | null, courseId: string | null | undefined): boolean {
  if (scope === null) return true;
  return !!courseId && scope.has(courseId);
}

/**
 * Variante M:N: el item entra si CUALQUIERA de sus cursos cumple. Talleres y
 * proyectos se comparten entre cursos (`workshop_courses`/`project_courses`),
 * así que exigir que todos cumplan esconderia un taller compartido a un curso
 * del periodo elegido — el mismo criterio que `visibleForScopedCourses`.
 */
export function anyCourseInScope(
  scope: Set<string> | null,
  courseIds: readonly (string | null | undefined)[],
): boolean {
  if (scope === null) return true;
  return courseIds.some((id) => !!id && scope.has(id));
}
