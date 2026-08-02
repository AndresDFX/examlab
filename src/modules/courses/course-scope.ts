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
 */
export function needsTeacherScope(
  activeRole: ActiveRoleLike,
  roles: readonly string[] | null | undefined,
): boolean {
  if (activeRole !== "Docente") return false;
  if ((roles ?? []).includes("SuperAdmin")) return false;
  return true;
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
