/**
 * ¿Un cambio de contraseña que falla es un ERROR del sistema, o el usuario tecleando?
 *
 * Los dos diálogos de cambio de contraseña registraban `severity: "error"` para cualquier
 * rechazo de Auth. Medido en producción (auditoría del 2026-09-04): los únicos eventos
 * `user.password_change_failed` del último mes decían «New password should be different from
 * the old password», o sea alguien que puso la contraseña que ya tenía. Eso no es una falla:
 * es la validación funcionando, y en el panel de Errores compite por atención con cosas que
 * sí hay que arreglar.
 *
 * Se clasifica por el mensaje porque es lo único que Auth devuelve: `AuthError` no trae un
 * código estable para estos casos.
 */

/** Rechazos que son del USUARIO, no del sistema. Todo lo demás es un error de verdad. */
const RECHAZOS_DE_ENTRADA = [
  /should be different from the old password/i,
  /new password should be different/i,
  /password should be at least/i,
  /password is (?:too weak|known to be weak)/i,
  /weak.?password/i,
];

export type SeveridadCambioContrasena = "warning" | "error";

/**
 * `warning` cuando el rechazo lo causó lo que la persona escribió; `error` cuando fue
 * cualquier otra cosa (la sesión caducada, la red, un 5xx de Auth), que sí hay que mirar.
 */
export function severidadCambioContrasena(mensaje: string | null | undefined): SeveridadCambioContrasena {
  const m = (mensaje ?? "").trim();
  if (!m) return "error";
  return RECHAZOS_DE_ENTRADA.some((re) => re.test(m)) ? "warning" : "error";
}
