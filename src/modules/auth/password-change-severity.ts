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
 * ── Se clasifica por CÓDIGO, no por el texto ──────────────────────────────
 * `AuthError` de `@supabase/auth-js` trae un `code` estable, y entre sus valores están
 * `same_password` y `weak_password` (ver `ErrorCode` en `auth-js/dist/module/lib/error-codes`).
 * La primera versión de este helper decía en su docstring que ese código «no existe» y
 * clasificaba sólo por el mensaje en inglés — falso, y frágil: el texto cambia con la versión
 * del servidor y con el idioma, y `weak_password` ya tiene variantes de motivo («characters»,
 * «length») que ninguna de las frases previstas cubría.
 *
 * El texto queda como RESPALDO para los casos en que el `code` no venga: un servidor viejo,
 * o un error que no sea un `AuthError` (una falla de red envuelta, por ejemplo).
 */

/** Códigos de Auth que significan "lo que escribió la persona no sirve". */
const CODIGOS_DE_ENTRADA = new Set(["same_password", "weak_password"]);

/** Respaldo por texto, para cuando no llega `code`. */
const RECHAZOS_DE_ENTRADA = [
  /should be different from the old password/i,
  /new password should be different/i,
  /password should be at least/i,
  /password is (?:too weak|known to be weak)/i,
  /weak.?password/i,
];

export type SeveridadCambioContrasena = "warning" | "error";

/** Lo mínimo que este helper necesita de un error de Auth. */
export interface FalloDeContrasena {
  code?: string | null;
  message?: string | null;
}

/**
 * `warning` cuando el rechazo lo causó lo que la persona escribió; `error` cuando fue
 * cualquier otra cosa (la sesión caducada, la red, un 5xx de Auth), que sí hay que mirar.
 */
export function severidadCambioContrasena(
  fallo: FalloDeContrasena | string | null | undefined,
): SeveridadCambioContrasena {
  if (!fallo) return "error";
  const code = typeof fallo === "string" ? null : (fallo.code ?? null);
  const mensaje = (typeof fallo === "string" ? fallo : (fallo.message ?? "")).trim();

  if (code && CODIGOS_DE_ENTRADA.has(code)) return "warning";
  // Un código que NO está en la lista es un error de verdad, aunque el texto se parezca:
  // el código es más específico que la frase.
  if (code) return "error";

  if (!mensaje) return "error";
  return RECHAZOS_DE_ENTRADA.some((re) => re.test(mensaje)) ? "warning" : "error";
}
