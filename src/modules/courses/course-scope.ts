/**
 * Alcance de cursos por ROL ACTIVO.
 *
 * ── El problema que resuelve ───────────────────────────────────────────
 * La RLS de `courses` deja ver TODOS los cursos del tenant a cualquier
 * autenticado (`courses_select_in_tenant`: `tenant_id = current_tenant_id()`).
 * Eso es a propósito: matrícula, gestión y los selectores de Admin lo necesitan.
 *
 * Consecuencia: el scoping "un docente ve solo SUS cursos" **no lo puede dar la
 * base**. Y tampoco lo puede dar `has_role()`, porque los roles son POSEÍDOS: un
 * usuario que tiene Docente y Admin pasa la rama Admin de cualquier policy
 * aunque en la UI esté actuando como Docente. Por eso el gate vive en el cliente
 * y se decide por el rol ACTIVO del switcher.
 *
 * Reporte que lo originó: "desde el rol docente puede ver cursos de los que no es
 * docente". Estaba resuelto en el grid de cursos pero repetido —y omitido— en el
 * resto de las pantallas: Asistencia, Gradebook, Informes y el buscador ⌘K
 * cargaban el tenant completo. Por eso la regla ahora vive acá y no en cada
 * pantalla: la próxima pantalla que liste cursos la obtiene gratis.
 *
 * ── Semántica del retorno ─────────────────────────────────────────────
 * `null`  = sin scoping. Es Admin/SuperAdmin: la RLS ya acota al tenant.
 * `[]`    = docente SIN cursos asignados. **No es lo mismo que `null`**: hay que
 *           devolver lista vacía SIN pegarle a `courses`, porque un
 *           `.in("id", [])` en PostgREST devuelve TODAS las filas, no ninguna.
 * `[ids]` = docente con cursos: filtrar por esos ids.
 */

import type { PostgrestError } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

export type ActiveRoleLike = string | null | undefined;

/**
 * ¿Hay que acotar la lista de cursos a los que el usuario dicta?
 *
 * Solo cuando el rol ACTIVO es Docente. Un usuario multi-rol que mueve el
 * switcher a Admin ve todo su tenant a propósito — es la misma pantalla, y la
 * diferencia entre "gestionar la institución" y "dar mi clase" es justamente el
 * rol activo.
 *
 * El SuperAdmin queda excluido incluso si su rol activo dijera Docente: opera
 * cross-tenant para soporte y necesita ver todo.
 *
 * Cuando el rol activo TODAVÍA no resolvió (primer render, antes de que el
 * switcher publique su valor) se cae a los roles POSEÍDOS — el mismo patrón que
 * `isStaffActive`. Y ahí la respuesta segura NO es "no acotar": un docente puro
 * vería la institución completa durante ese render. Solo se deja sin acotar a
 * quien PUEDE ser Admin, porque para él ver todo es legítimo y el switcher
 * corregirá el caso contrario en cuanto resuelva.
 */
export function needsTeacherScope(
  activeRole: ActiveRoleLike,
  roles: readonly string[] | null | undefined,
): boolean {
  const owned = roles ?? [];
  if (owned.includes("SuperAdmin")) return false;
  if (activeRole) return activeRole === "Docente";
  return owned.includes("Docente") && !owned.includes("Admin");
}

/** Ids de los cursos donde el usuario figura en `course_teachers`. */
export async function fetchTeacherCourseIds(userId: string): Promise<string[]> {
  const { data } = await supabase
    .from("course_teachers")
    .select("course_id")
    .eq("user_id", userId);
  return [
    ...new Set(
      ((data ?? []) as Array<{ course_id: string }>).map((r) => r.course_id),
    ),
  ];
}

/**
 * Ids a los que hay que acotar, o `null` si no hace falta acotar.
 *
 * Uso canónico en una pantalla que lista cursos:
 *
 *     const ids = await scopedCourseIds(activeRole, roles, user?.id);
 *     if (ids && ids.length === 0) { setCourses([]); return; }   // <- NO consultar
 *     let q = supabase.from("courses").select(...).is("deleted_at", null);
 *     if (ids) q = q.in("id", ids);
 */
export async function scopedCourseIds(
  activeRole: ActiveRoleLike,
  roles: readonly string[] | null | undefined,
  userId: string | null | undefined,
): Promise<string[] | null> {
  if (!userId) return null;
  if (!needsTeacherScope(activeRole, roles)) return null;
  return fetchTeacherCourseIds(userId);
}

/**
 * Lista de cursos YA acotada, sin papelera y ordenada por nombre.
 *
 * Existe porque el patrón de arriba (pedir los ids, cortar si vienen vacíos,
 * aplicar `.in`) son cuatro pasos fáciles de hacer a medias, y casi todas las
 * pantallas del docente cargan sus cursos dentro de un `Promise.all` donde ese
 * `if` intermedio no cabe. Acá el corte de la lista vacía queda del lado del
 * helper, así que la pantalla solo elige la proyección.
 *
 * El `select` es lo único que varía entre pantallas (unas necesitan la escala de
 * notas, otras solo `id, name`). Si una necesita otro orden o filtros extra, que
 * use `scopedCourseIds` y arme su query.
 */
export async function fetchScopedCourses<T>(
  activeRole: ActiveRoleLike,
  roles: readonly string[] | null | undefined,
  userId: string | null | undefined,
  select: string,
): Promise<{ data: T[]; error: PostgrestError | null; scopedIds: string[] | null }> {
  const ids = await scopedCourseIds(activeRole, roles, userId);
  // Docente sin cursos: lista vacía SIN consultar. Es la diferencia entre `[]` y
  // `null` que documenta el encabezado — un `.in("id", [])` devolvería TODO.
  if (ids && ids.length === 0) return { data: [], error: null, scopedIds: ids };
  const base = supabase
    .from("courses")
    .select(select)
    .is("deleted_at", null)
    .order("name");
  const { data, error } = await (ids ? base.in("id", ids) : base);
  // `scopedIds` sale acá para que la pantalla filtre TAMBIÉN su lista de
  // contenido sin repetir la consulta a `course_teachers`. Sin eso, acotar solo
  // el Select deja una incoherencia peor que el bug: el filtro ofrece 2 cursos
  // y la tabla de al lado muestra el contenido de 12.
  return { data: (data ?? []) as unknown as T[], error, scopedIds: ids };
}

/**
 * Filtra contenido (exámenes, talleres, proyectos) a los cursos del docente.
 *
 * `scopedIds === null` devuelve la lista intacta: es Admin/SuperAdmin y la RLS ya
 * acotó al tenant.
 *
 * Talleres y proyectos son **M:N** (`workshop_courses` / `project_courses`): el
 * mismo taller puede estar compartido en varios cursos, y el `course_id` de la
 * fila es solo el ancla. Filtrar por el ancla escondería un taller compartido a
 * MI curso pero creado desde otro — por eso `sharedCourseIds` (que la pantalla ya
 * tiene cargado en memoria). Los exámenes no lo necesitan: son de un curso.
 */
export function visibleForScopedCourses<
  T extends { id: string; course_id?: string | null },
>(
  items: readonly T[],
  scopedIds: readonly string[] | null,
  sharedCourseIds?: ReadonlyMap<string, readonly string[]>,
): T[] {
  if (!scopedIds) return [...items];
  const mine = new Set(scopedIds);
  return items.filter((it) => {
    if (it.course_id && mine.has(it.course_id)) return true;
    const shared = sharedCourseIds?.get(it.id);
    if (shared?.some((cid) => mine.has(cid))) return true;
    // Contenido sin curso y sin comparticiones: se DEJA visible a propósito. No
    // se le puede atribuir el curso de otro docente, así que esconderlo sería el
    // error caro (el docente pierde su propio trabajo) frente a mostrarlo de más.
    return !it.course_id && !shared?.length;
  });
}
