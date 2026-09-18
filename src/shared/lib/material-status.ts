/**
 * Filtro de estado para el MATERIAL (contenidos + videos), cuyo estado NO
 * es propio: se DERIVA del curso al que pertenece. Un item de material está
 * "cerrado" cuando su curso relacionado está FINALIZADO
 * (`deriveCourseDisplayState(...) === "finalizado"`).
 *
 * ── Selección MÚLTIPLE, con un default NO vacío ───────────────────────
 * Paralelo a status-filter.ts: el filtro es un menú de casillas y la semántica
 * central la fija `filtro-multiple.ts` (**vacío = sin filtrar = todo**). El
 * estado derivado es binario (activo / cerrado), así que las opciones marcables
 * son solo esas dos; marcar ambas equivale a "todos". El default es `["activos"]`
 * (oculta el material de cursos finalizados) y NO `[]`, porque vacío mostraría
 * también los cerrados. "Limpiar" restaura ese default; el item "Todos" del menú
 * es el "mostrar todo" explícito.
 *
 * Material sin curso relacionado (`course_id = null` — contenido/video global,
 * reutilizable, catálogo de plataforma) NUNCA se considera cerrado: siempre
 * activo. Un curso que no está en el map cargado (fuera del scope visible) se
 * trata como NO cerrado para no ocultar material por falta de datos.
 *
 * Sin React, sin Date.now() interno → testeable.
 */
import {
  deriveCourseDisplayState,
  type CourseLifecycleShape,
} from "@/modules/courses/course-status";
import { coincideFiltro } from "@/shared/lib/filtro-multiple";

/** Los dos estados atómicos derivados del curso. */
export type MaterialStatusValue = "activos" | "cerrados";

/** Opciones marcables, en orden de presentación. */
export const MATERIAL_STATUS_VALUES: readonly MaterialStatusValue[] = ["activos", "cerrados"];

/** Estado inicial: material de cursos no finalizados (oculta cerrados). NO `[]`. */
export const DEFAULT_MATERIAL_STATUS_FILTER: readonly MaterialStatusValue[] = ["activos"];

/**
 * `true` si el curso relacionado con este material está FINALIZADO → su
 * material se considera "cerrado".
 *   • `courseId` nullish (material global / sin curso) → nunca cerrado.
 *   • curso ausente del map (no cargado / fuera de scope) → nunca cerrado.
 */
export function isMaterialClosed(
  courseId: string | null | undefined,
  courseStatusById: Map<string, CourseLifecycleShape>,
  now: number,
): boolean {
  if (!courseId) return false;
  const course = courseStatusById.get(courseId);
  if (!course) return false;
  return deriveCourseDisplayState(course, now) === "finalizado";
}

/** A qué opción atómica pertenece el material de este curso. */
export function materialStatusValue(
  courseId: string | null | undefined,
  courseStatusById: Map<string, CourseLifecycleShape>,
  now: number,
): MaterialStatusValue {
  return isMaterialClosed(courseId, courseStatusById, now) ? "cerrados" : "activos";
}

/**
 * `true` si un item de material atado a `courseId` debe verse bajo la selección.
 * Sin nada marcado pasa todo (regla de `filtro-multiple.ts`).
 */
export function matchesMaterialStatus(
  courseId: string | null | undefined,
  courseStatusById: Map<string, CourseLifecycleShape>,
  seleccion: readonly MaterialStatusValue[],
  now: number,
): boolean {
  return coincideFiltro(seleccion, materialStatusValue(courseId, courseStatusById, now));
}
