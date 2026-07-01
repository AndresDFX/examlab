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
  // Actas: una sola por (curso, periodo). Regenerar exige borrar la anterior.
  idx_course_actas_unique:
    "Ya existe un acta para este curso y periodo. Bórrala desde la lista para generar una nueva.",
  // Supresión de correos: una dirección por scope.
  email_suppressions_email_tenant_uidx: "Esa dirección ya está en la lista de supresión.",
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

/**
 * Traductor general de errores Supabase/Postgres a mensajes en español
 * para el usuario final. Wrap el `error` que viene de `supabase.from()`,
 * RPCs o edge functions y úsalo en `toast.error(friendlyError(error))`.
 *
 * Orden de resolución:
 *  1. Si es `unique_violation` (23505) → usa `friendlyUniqueViolation`
 *     que conoce nombres de índices específicos.
 *  2. Match por `error.code` (Postgres SQLSTATE) → mensaje canónico.
 *  3. Match por patrones en `error.message` (red caída, auth, etc.).
 *  4. Fallback: el `fallback` provisto por el caller, o `error.message`
 *     original (último recurso — el usuario verá inglés técnico).
 *
 * Diseño defensivo: NUNCA retorna `null`/`undefined` — siempre un string
 * mostrable. Si el error no se reconoce, retorna `fallback` o un genérico.
 */
export function friendlyError(error: AnyError, fallback?: string): string {
  if (!error) return fallback ?? "Ocurrió un error inesperado";

  // 0) El error puede llegar como STRING plano — p.ej. edges que reportan
  //    fallos por-usuario en `failed[]` con `error: string` ("Cuenta SSO: …",
  //    "No autorizado para este usuario"). Sin esta rama, más abajo `error.code`
  //    y `error.message` son undefined → message="" → caía al genérico
  //    "Ocurrió un error inesperado", perdiendo el motivo real. Los mensajes de
  //    nuestras edges ya vienen en español, así que se muestran tal cual.
  if (typeof error === "string") {
    const trimmed = error.trim();
    if (!trimmed) return fallback ?? "Ocurrió un error inesperado";
    const lower = trimmed.toLowerCase();
    if (/\b(not authorized|unauthorized|not allowed|permission denied)\b/.test(lower)) {
      return "No tienes permisos para realizar esta acción.";
    }
    return trimmed;
  }

  // 1) unique violation con mensaje específico
  const unique = friendlyUniqueViolation(error);
  if (unique) return unique;

  const code = error.code ?? error.cause?.code ?? "";
  const message = String(error.message ?? "");
  const lowerMsg = message.toLowerCase();

  // 2) Códigos Postgres SQLSTATE comunes
  // Ver https://www.postgresql.org/docs/current/errcodes-appendix.html
  switch (code) {
    case "23503": // foreign_key_violation
      return "No se puede completar la operación porque hay datos relacionados.";
    case "23502": // not_null_violation
      return "Falta un campo obligatorio.";
    case "23514": // check_violation
      return "Uno de los valores no cumple con las reglas de validación.";
    case "42501": // insufficient_privilege (RLS denial)
      return "No tienes permisos para realizar esta acción.";
    case "P0001": // raise_exception (raised by SQL functions)
      // El mensaje SUELE estar en español porque viene de RAISE EXCEPTION
      // en funciones SQL nuestras. Algunos triggers legacy lo lanzan en
      // inglés ("not authorized") — traducimos los de autorización comunes;
      // el resto se muestra tal cual (ya está en español).
      if (/\b(not authorized|unauthorized|not allowed|permission denied)\b/i.test(lowerMsg)) {
        return "No tienes permisos para realizar esta acción.";
      }
      return message || "Operación rechazada por el servidor.";
    case "PGRST116": // PostgREST: not found / no rows
      return "No se encontró el registro.";
    case "PGRST301": // PostgREST: row-level security
      return "No tienes permisos para realizar esta acción.";
    case "57014": // query_canceled (statement_timeout)
      return "La operación tardó demasiado. Intenta de nuevo.";
  }

  // 3) Patrones en el mensaje — útiles cuando el error viene de fetch
  //    (sin code SQL) o de la capa de auth.
  if (lowerMsg.includes("failed to fetch") || lowerMsg.includes("network")) {
    return "Error de red. Verifica tu conexión e intenta de nuevo.";
  }
  if (lowerMsg.includes("permission denied") || lowerMsg.includes("rls")) {
    return "No tienes permisos para realizar esta acción.";
  }
  if (lowerMsg.includes("invalid login") || lowerMsg.includes("invalid credentials")) {
    return "Correo o contraseña inválidos.";
  }
  if (lowerMsg.includes("email not confirmed")) {
    return "Confirma tu correo antes de iniciar sesión.";
  }
  if (lowerMsg.includes("rate limit")) {
    return "Demasiados intentos. Espera unos minutos e intenta de nuevo.";
  }

  // 4) Fallback: lo que pidió el caller, o el mensaje original, o el
  // genérico. Paréntesis explícitos porque mezclar `??` y `||` sin
  // ellos es error de sintaxis.
  return fallback ?? (message || "Ocurrió un error inesperado");
}
