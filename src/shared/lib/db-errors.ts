/**
 * Helpers para traducir errores de Postgres / Supabase a mensajes
 * amigables que el usuario entiende. Hoy el toast genérico dice:
 *
 *   "duplicate key value violates unique constraint
 *    "exams_course_title_lower_uidx""
 *
 * que es ruido técnico. Acá interpretamos el código `23505`
 * (unique_violation) + el nombre del índice y devolvemos un texto
 * claro: "Ya existe un examen con ese título en este curso."
 *
 * Si el error no es un unique_violation conocido, devolvemos `null`
 * para que el caller use el mensaje original (con `error.message`).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyError = any;

/** Mapeo nombre-de-índice → mensaje humano. Si en el futuro agregas
 *  más unique indexes, añade su entrada acá. */
const UNIQUE_INDEX_MESSAGES: Record<string, string> = {
  // Emails
  profiles_institutional_email_lower_idx: "Ya existe un usuario con ese correo institucional.",
  profiles_personal_email_lower_idx: "Ya existe un usuario con ese correo personal.",
  // Títulos por curso
  exams_course_title_lower_uidx: "Ya existe un examen con ese título en este curso.",
  workshops_course_title_lower_uidx: "Ya existe un taller con ese título en este curso.",
  projects_course_title_lower_uidx: "Ya existe un proyecto con ese título en este curso.",
  grade_cuts_course_name_lower_uidx: "Ya existe un corte con ese nombre en este curso.",
  // Sesiones / grupos — índices LOWER (la nueva migración los reescribió).
  // Mantenemos los nombres legacy también como fallback por si alguien
  // re-aplica una DB sin la migración nueva.
  attendance_sessions_course_date_title_lower_uidx:
    "Ya hay una sesión con ese título en esa fecha.",
  attendance_sessions_course_id_session_date_title_key:
    "Ya hay una sesión con ese título en esa fecha.",
  workshop_groups_workshop_name_lower_uidx: "Ya existe un grupo con ese nombre en este taller.",
  workshop_groups_workshop_id_name_key: "Ya existe un grupo con ese nombre en este taller.",
  project_groups_project_name_lower_uidx: "Ya existe un grupo con ese nombre en este proyecto.",
  project_groups_project_id_name_key: "Ya existe un grupo con ese nombre en este proyecto.",
};

/**
 * Devuelve un mensaje humano si el error es un `unique_violation`
 * reconocido. Si no, retorna `null` y el caller debería usar el
 * `error.message` original.
 *
 * El error puede venir de `@supabase/supabase-js` (objeto con `code`
 * + `message` + `details`) o de un fetch directo a PostgREST. Probamos
 * ambos.
 */
export function friendlyUniqueViolation(error: AnyError): string | null {
  if (!error) return null;
  // Supabase devuelve `code: "23505"` y el nombre del constraint en
  // `details` o `message`.
  const code = error.code ?? error.cause?.code ?? null;
  if (code !== "23505") return null;
  const haystack = `${error.message ?? ""} ${error.details ?? ""}`;
  for (const [indexName, message] of Object.entries(UNIQUE_INDEX_MESSAGES)) {
    if (haystack.includes(indexName)) return message;
  }
  // Fallback genérico si no matcheamos un índice conocido.
  return "Ya existe un registro con esos datos.";
}
