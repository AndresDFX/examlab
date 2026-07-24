/**
 * Estado de ciclo de vida del curso — helpers PUROS.
 *
 * La columna `courses.status` (borrador | en_curso | finalizado) es la
 * fuente de verdad del ciclo de vida. La distinción Próximo / En curso
 * (derivada de la fecha de inicio) vive DENTRO de `en_curso` y se computa
 * en el cliente — no se persiste.
 *
 * `deriveCourseDisplayState` colapsa "status persistido + fecha" en uno de
 * 4 valores de DISPLAY que el grid / las StatCards usan:
 *   - borrador:   explícito; nunca aparece como activo/próximo/terminado.
 *   - finalizado: explícito y terminal; la fecha es irrelevante.
 *   - proximo:    en_curso + start_date en el futuro (publicado, sin empezar).
 *   - en_curso:   en_curso ya empezado (o sin start_date).
 *
 * Importante: un curso 'en_curso' con end_date YA pasada sigue mostrándose
 * 'en_curso' hasta que el cron (o un docente) lo finalice. Eso es lo deseado
 * — "automático por fecha O manual" coexisten; el cierre nunca es solo-lectura.
 *
 * Sin React, sin Date.now() interno, sin toast → testeable.
 */

/** Valores persistidos en `courses.status`. */
export const COURSE_STATUS_VALUES = ["borrador", "en_curso", "finalizado"] as const;
export type CourseStatus = (typeof COURSE_STATUS_VALUES)[number];

/** Valores de DISPLAY (incluye el derivado 'proximo'). */
export type CourseDisplayState = "borrador" | "proximo" | "en_curso" | "finalizado";

/** Forma mínima del curso que necesitan los helpers. */
export interface CourseLifecycleShape {
  status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

/**
 * Resuelve el estado de DISPLAY de un curso a partir de su `status`
 * persistido + la fecha de inicio.
 *
 * @param course curso con `status` / `start_date`.
 * @param now    epoch ms de referencia (inyectado para testeabilidad).
 */
export function deriveCourseDisplayState(
  course: CourseLifecycleShape,
  now: number,
): CourseDisplayState {
  const status = course.status ?? null;

  // Terminal explícito: la fecha es irrelevante.
  if (status === "finalizado") return "finalizado";

  // Borrador explícito: nunca activo/próximo/terminado.
  if (status === "borrador") return "borrador";

  // status === 'en_curso' (o cualquier valor legacy / null → lo tratamos
  // como en_curso para no esconder cursos operativos pre-migración).
  // Próximo: publicado pero aún sin empezar (start_date en el futuro).
  if (course.start_date) {
    // Ancla DATE-only ('YYYY-MM-DD') a mediodía LOCAL antes de parsear. Sin
    // esto `new Date('2026-06-15')` se interpreta como medianoche UTC → en
    // es-CO (UTC-5) cae el día anterior 19:00 local y el curso se clasifica
    // 'proximo' por unas horas el día de inicio (mismo bug UTC-1 que evita
    // formatDateOnly). Con hora explícita (timestamptz) se respeta tal cual.
    const raw = course.start_date;
    const startMs = new Date(raw.length === 10 ? `${raw}T12:00:00` : raw).getTime();
    if (Number.isFinite(startMs) && startMs > now) return "proximo";
  }
  // Empezado o sin fecha de inicio.
  return "en_curso";
}

/** Forma mínima para ordenar/particionar un curso en un selector. */
export interface CoursePickShape extends CourseLifecycleShape {
  id: string;
  name: string;
}

/** Collation es-CO estable (numérico + insensible a mayúsculas/acentos),
 *  mismo criterio que useTableSort — vacíos van al final. */
function byNameEsCo<T extends { name?: string | null }>(a: T, b: T): number {
  const an = (a.name ?? "").trim();
  const bn = (b.name ?? "").trim();
  if (!an && !bn) return 0;
  if (!an) return 1;
  if (!bn) return -1;
  return an.localeCompare(bn, "es-CO", { numeric: true, sensitivity: "base" });
}

/**
 * Parte una lista de cursos en { open, closed } para priorizar los ABIERTOS
 * en los selectores/filtros de curso (UX: el docente con 1 curso activo + N
 * finalizados ve primero el activo). `open` = todo lo que NO está finalizado
 * (borrador + en_curso + próximo); `closed` = finalizado. Cada grupo se ordena
 * alfabético es-CO. `keepIds` fuerza a `open` los cursos seleccionados aunque
 * estén finalizados (el curso que se está editando/filtrando no debe esconderse).
 *
 * Es la ÚNICA fuente de orden de cursos en los selectores — no duplicar el
 * criterio inline. Render agrupado (SelectGroup "Cursos activos"/"Cerrados") o
 * plano (sortCoursesByPriority) según el contenedor.
 */
export function partitionCoursesByLifecycle<T extends CoursePickShape>(
  courses: readonly T[],
  keepIds?: ReadonlySet<string> | readonly string[],
): { open: T[]; closed: T[] } {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds ?? []);
  const open: T[] = [];
  const closed: T[] = [];
  for (const c of courses) {
    if (c.status === "finalizado" && !keep.has(c.id)) closed.push(c);
    else open.push(c);
  }
  open.sort(byNameEsCo);
  closed.sort(byNameEsCo);
  return { open, closed };
}

/** Lista PLANA con los abiertos primero (para selectores que no agrupan). */
export function sortCoursesByPriority<T extends CoursePickShape>(
  courses: readonly T[],
  keepIds?: ReadonlySet<string> | readonly string[],
): T[] {
  const { open, closed } = partitionCoursesByLifecycle(courses, keepIds);
  return [...open, ...closed];
}

/** Conteos por estado de display para las StatCards del grid. */
export interface CoursesSummary {
  total: number;
  draft: number;
  active: number;
  upcoming: number;
  finalized: number;
}

/**
 * Tabula un conjunto de cursos por su estado de display.
 * `active` = display 'en_curso'; `finalized` = display 'finalizado'.
 */
export function summarizeCourses(
  courses: CourseLifecycleShape[],
  now: number,
): CoursesSummary {
  const summary: CoursesSummary = {
    total: courses.length,
    draft: 0,
    active: 0,
    upcoming: 0,
    finalized: 0,
  };
  for (const c of courses) {
    switch (deriveCourseDisplayState(c, now)) {
      case "borrador":
        summary.draft += 1;
        break;
      case "proximo":
        summary.upcoming += 1;
        break;
      case "en_curso":
        summary.active += 1;
        break;
      case "finalizado":
        summary.finalized += 1;
        break;
    }
  }
  return summary;
}
