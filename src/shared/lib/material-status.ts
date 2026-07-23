/**
 * Filtro de estado para el MATERIAL (contenidos + videos), cuyo estado NO
 * es propio: se DERIVA del curso al que pertenece. Un item de material está
 * "cerrado" cuando su curso relacionado está FINALIZADO
 * (`deriveCourseDisplayState(...) === "finalizado"`).
 *
 * Regla de UX (paralela a status-filter.ts para actividades): por DEFECTO
 * ("activos") se ve el material de cursos NO finalizados (borradores, próximos
 * y en curso); el material de cursos finalizados no se ve hasta que el usuario
 * cambia el filtro a "Cerrados" o "Todos".
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

export type MaterialStatusFilter = "activos" | "cerrados" | "todos";

/** Estado inicial del filtro: material de cursos no finalizados (oculta cerrados). */
export const DEFAULT_MATERIAL_STATUS_FILTER: MaterialStatusFilter = "activos";

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

/**
 * `true` si un item de material atado a `courseId` debe verse bajo `filter`.
 *   • `activos`  → material de cursos NO finalizados (+ global) — DEFAULT.
 *   • `cerrados` → solo material de cursos finalizados.
 *   • `todos`    → todo.
 */
export function matchesMaterialStatus(
  courseId: string | null | undefined,
  courseStatusById: Map<string, CourseLifecycleShape>,
  filter: MaterialStatusFilter,
  now: number,
): boolean {
  if (filter === "todos") return true;
  const closed = isMaterialClosed(courseId, courseStatusById, now);
  return filter === "cerrados" ? closed : !closed;
}
