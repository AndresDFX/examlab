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
 *  trash page. */
export type TrashTable =
  | "courses"
  | "exams"
  | "workshops"
  | "projects"
  | "attendance_sessions"
  | "whiteboards"
  | "generated_contents"
  | "polls";

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
};

interface SoftDeleteResult {
  error: { message: string } | null;
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
  return { error: error ? { message: error.message } : null };
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
  return { error: error ? { message: error.message } : null };
}

/**
 * Restaura una fila de la papelera (UPDATE deleted_at = NULL). Se llama
 * desde la trash page. La RPC `trash_restore_item` valida la tabla y
 * delega el UPDATE bajo RLS del caller (SECURITY INVOKER).
 */
export async function restoreItem(table: TrashTable, id: string): Promise<SoftDeleteResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { error } = await db.rpc("trash_restore_item", { _table: table, _id: id });
  return { error: error ? { message: error.message } : null };
}

/**
 * Borra DEFINITIVAMENTE una fila (DELETE físico). La RPC
 * `trash_hard_delete_item` exige que la fila esté en papelera
 * (deleted_at IS NOT NULL) para evitar bypass del flujo de soft-delete.
 *
 * Disparar también el cascade ON DELETE de los hijos — irreversible.
 */
export async function hardDeleteItem(table: TrashTable, id: string): Promise<SoftDeleteResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  const { error } = await db.rpc("trash_hard_delete_item", { _table: table, _id: id });
  return { error: error ? { message: error.message } : null };
}
