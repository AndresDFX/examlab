/**
 * soft-delete — helpers para convertir DELETE físicos en soft-delete
 * (UPDATE deleted_at = now()). Centraliza la lógica para que cada route
 * solo cambie 1 línea (de `supabase.from(X).delete().eq("id", id)` a
 * `softDelete("X", id)`).
 *
 * Tablas soportadas (alineadas con la migración 20260816000000):
 *   courses, exams, workshops, projects, attendance_sessions,
 *   whiteboards, generated_contents, polls.
 *
 * El usuario que borra queda registrado en `deleted_by` para auditoría
 * y para el filtro "borrado por mí" del módulo Papelera.
 */
import { supabase } from "@/integrations/supabase/client";

/** Tablas que soportan papelera. Mantener sincronizado con la migración
 *  20260816000000 (`allowed TEXT[]` dentro de las RPCs) y con la
 *  trash page. `tenants` se agrega en 20260818000000 pero usa RPCs
 *  dedicadas (soft_delete_tenant / restore_tenant) por su cascada
 *  especial; no pasa por trash_restore_item ni trash_hard_delete_item. */
export type TrashTable =
  | "courses"
  | "exams"
  | "workshops"
  | "projects"
  | "attendance_sessions"
  | "whiteboards"
  | "generated_contents"
  | "polls"
  | "tenants";

/** Label humano por tabla — usado en el módulo Papelera para los tabs. */
export const TRASH_TABLE_LABEL: Record<TrashTable, string> = {
  courses: "Cursos",
  exams: "Exámenes",
  workshops: "Talleres",
  projects: "Proyectos",
  attendance_sessions: "Sesiones",
  whiteboards: "Pizarras",
  generated_contents: "Contenidos",
  polls: "Encuestas",
  tenants: "Instituciones",
};

/** Columna que la UI muestra como "nombre del item" en la papelera.
 *  Cuando la tabla no tiene columna `name`, mapeamos al campo más
 *  parecido (title / topic / display_name). */
export const TRASH_NAME_COL: Record<TrashTable, string> = {
  courses: "name",
  exams: "title",
  workshops: "title",
  projects: "title",
  attendance_sessions: "title",
  whiteboards: "name",
  generated_contents: "topic",
  polls: "title",
  tenants: "name",
};

/**
 * Error de Supabase/Postgres preservando `code`/`details`/`hint` — NO solo el
 * `message`. Sin el `code`, `friendlyError()` no puede mapear el SQLSTATE
 * (RLS 42501, FK 23503, RAISE P0001…) y cae al fallback genérico
 * "Error desconocido" — bug reportado en el bulk hard-delete de la Papelera del
 * SuperAdmin. Preservar el `code` deja que el mensaje salga traducido al español.
 */
export interface DbErr {
  message: string;
  code?: string;
  details?: string;
  hint?: string;
}

function toResultError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined,
): DbErr | null {
  if (!error) return null;
  return {
    message: error.message ?? "Error",
    ...(error.code ? { code: error.code } : {}),
    ...(error.details ? { details: error.details } : {}),
    ...(error.hint ? { hint: error.hint } : {}),
  };
}

interface SoftDeleteResult {
  error: DbErr | null;
}

/** Conteo del contenido asociado a un curso — para advertir antes de borrarlo.
 *  Lo sirve la RPC course_content_summary (SECURITY DEFINER, autz docente/admin). */
export interface CourseContentSummary {
  exams: number;
  workshops: number;
  projects: number;
  sessions: number;
  whiteboards: number;
  contents: number;
  polls: number;
  enrollments: number;
  forums: number;
}

export async function courseContentSummary(
  courseId: string,
): Promise<{ data: CourseContentSummary | null; error: DbErr | null }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { data, error } = await db.rpc("course_content_summary", { _course_id: courseId });
  return {
    data: (data as CourseContentSummary) ?? null,
    error: toResultError(error),
  };
}

/** ¿Hay algún contenido (no solo matrículas) que quedaría huérfano? */
export function courseHasContent(s: CourseContentSummary | null): boolean {
  if (!s) return false;
  return (
    s.exams + s.workshops + s.projects + s.sessions + s.whiteboards + s.contents + s.polls > 0
  );
}

/**
 * Soft-delete del curso con cascada OPCIONAL. `cascade=true` manda el curso y
 * todo su contenido (exámenes/talleres/proyectos/sesiones/pizarras/contenidos/
 * encuestas) a la papelera con el MISMO timestamp (restaurable en bloque con
 * restore_course_cascade). `cascade=false` borra solo el curso (el contenido
 * queda huérfano pero oculto por las RLS de abuelo-curso).
 */
export async function softDeleteCourseCascade(
  courseId: string,
  cascade: boolean,
): Promise<SoftDeleteResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { error } = await db.rpc("soft_delete_course_cascade", {
    _course_id: courseId,
    _cascade: cascade,
  });
  return { error: toResultError(error) };
}

/**
 * Marca una fila como borrada (soft-delete). Setea `deleted_at = now()`
 * y `deleted_by = auth.uid()`. La fila queda invisible para las queries
 * normales (que filtran `is('deleted_at', null)`) pero accesible desde
 * la papelera.
 *
 * RLS aplica directamente: solo el dueño/docente/admin con permiso
 * UPDATE sobre la fila puede soft-deletear. Si la RLS lo rechaza,
 * devolvemos `error` igual que un DELETE rechazado.
 *
 * userId es opcional — si no se pasa, leemos del auth client local.
 * Pasarlo es preferible cuando el caller ya tiene el id (evita un
 * round-trip al auth.users).
 */
export async function softDelete(
  table: TrashTable,
  id: string,
  userId?: string | null,
): Promise<SoftDeleteResult> {
  let actorId = userId ?? null;
  if (!actorId) {
    const { data } = await supabase.auth.getUser();
    actorId = data.user?.id ?? null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { error } = await db
    .from(table)
    .update({ deleted_at: new Date().toISOString(), deleted_by: actorId })
    .eq("id", id);
  return { error: toResultError(error) };
}

/** Versión bulk: marca N filas como borradas de un solo UPDATE. Usada
 *  por los grids con multi-select + BulkDeleteDialog. */
export async function softDeleteMany(
  table: TrashTable,
  ids: string[],
  userId?: string | null,
): Promise<SoftDeleteResult> {
  if (ids.length === 0) return { error: null };
  let actorId = userId ?? null;
  if (!actorId) {
    const { data } = await supabase.auth.getUser();
    actorId = data.user?.id ?? null;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { error } = await db
    .from(table)
    .update({ deleted_at: new Date().toISOString(), deleted_by: actorId })
    .in("id", ids);
  return { error: toResultError(error) };
}

/**
 * Restaura una fila de la papelera. Para las 8 entidades genéricas usa
 * la RPC `trash_restore_item` (SECURITY INVOKER, RLS del caller). Para
 * tenants delega en `restore_tenant` (SECURITY DEFINER, requiere
 * SuperAdmin) que cascadea la restauración a los children borrados con
 * el mismo timestamp.
 */
export async function restoreItem(table: TrashTable, id: string): Promise<SoftDeleteResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  if (table === "tenants") {
    const { error } = await db.rpc("restore_tenant", { _tenant_id: id });
    return { error: toResultError(error) };
  }
  // Cursos: restore_course_cascade desempaca los children borrados en la misma
  // operación de cascada (mismo deleted_at). Restaurar el curso vuelve a traer
  // su contenido. Los borrados individuales previos quedan en papelera.
  if (table === "courses") {
    const { error } = await db.rpc("restore_course_cascade", { _course_id: id });
    return { error: toResultError(error) };
  }
  const { error } = await db.rpc("trash_restore_item", { _table: table, _id: id });
  return { error: toResultError(error) };
}

/**
 * Borra DEFINITIVAMENTE una fila (DELETE físico). Para las 8 entidades
 * genéricas usa `trash_hard_delete_item` (exige que la fila esté en
 * papelera). Para tenants usa `hard_delete_tenant` (también valida que
 * esté en papelera + valida SuperAdmin server-side).
 *
 * Dispara el cascade ON DELETE de los hijos — irreversible.
 */
export async function hardDeleteItem(table: TrashTable, id: string): Promise<SoftDeleteResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  if (table === "tenants") {
    const { error } = await db.rpc("hard_delete_tenant", { _tenant_id: id });
    return { error: toResultError(error) };
  }
  const { error } = await db.rpc("trash_hard_delete_item", { _table: table, _id: id });
  return { error: toResultError(error) };
}

/**
 * Soft-delete cascadeado de un tenant. Marca el tenant + cascadea a las
 * 8 entidades trashables (cursos, exámenes, talleres, proyectos,
 * sesiones, pizarras, contenidos, polls) con el MISMO deleted_at, lo
 * que permite que `restoreItem("tenants", id)` desempaque la cascada.
 *
 * Solo SuperAdmin (validado server-side en la RPC). Profiles del tenant
 * NO se tocan — mantienen su tenant_id pero quedan sin acceso porque el
 * Select de institución en /auth filtra `deleted_at IS NULL`.
 */
export async function softDeleteTenant(tenantId: string): Promise<SoftDeleteResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { error } = await db.rpc("soft_delete_tenant", { _tenant_id: tenantId });
  return { error: toResultError(error) };
}
