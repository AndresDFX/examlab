/**
 * Códigos de error del check-in que ve el DOCENTE → clave i18n.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────
 * Las RPC del check-in devuelven `{ok:false, error:'<codigo>'}`. La pantalla del
 * estudiante ya traducía los suyos; la del docente no tenía mapa, así que hacía
 * `toast.error(result?.error ?? "…")` y el código salía tal cual: en pantalla decía
 * `closes_in_past`, `invalid_rotation`, `requirement_unavailable`.
 *
 * Eso ya se vio en producción con otro código: un estudiante leyó
 * `requirement_pending` en clase. La causa de fondo es la misma —un código sin
 * mensaje llega crudo— y por eso el mapa vive en un módulo con test, en vez de
 * repetido en cada pantalla.
 *
 * ── Al agregar un `error` nuevo a una RPC del check-in ────────────────────
 * Sumalo acá. Un código sin entrada no rompe nada —compila, renderiza— y el único
 * síntoma es una persona leyendo un identificador en inglés con guiones bajos.
 * `checkin-errors.test.ts` compara este mapa contra los códigos que las migraciones
 * emiten de verdad y falla si falta alguno.
 */
export const CHECKIN_TEACHER_ERRORS: Record<string, string> = {
  no_auth: "teacherAttendance.errNoAuth",
  unauthorized: "teacherAttendance.errUnauthorized",
  session_not_found: "teacherAttendance.errSessionNotFound",
  // Ventana
  invalid_range: "teacherAttendance.errInvalidRange",
  range_too_long: "teacherAttendance.errRangeTooLong",
  closes_in_past: "teacherAttendance.errClosesInPast",
  invalid_duration: "teacherAttendance.errInvalidDuration",
  invalid_rotation: "teacherAttendance.errInvalidRotation",
  invalid_extra: "teacherAttendance.errInvalidExtra",
  max_window: "teacherAttendance.errMaxWindow",
  not_open: "teacherAttendance.errNotOpen",
  // Requisitos
  invalid_requirement: "teacherAttendance.errInvalidRequirement",
  requirement_not_in_course: "teacherAttendance.errRequirementNotInCourse",
  requirement_unavailable: "teacherAttendance.errRequirementUnavailable",
};

/**
 * La clave i18n de un código, o `null` si no se conoce.
 *
 * Devuelve `null` y NO el código: quien llama tiene que poner un mensaje propio.
 * Si devolviera el código, volveríamos a tener identificadores técnicos en
 * pantalla, que es justo lo que este módulo existe para evitar.
 */
export function claveDeErrorCheckIn(codigo: string | null | undefined): string | null {
  if (!codigo) return null;
  return CHECKIN_TEACHER_ERRORS[codigo] ?? null;
}
