/**
 * Helpers puros del módulo de gestión de errores (/app/admin/errors).
 *
 * El scoping + autorización vive en los RPCs SQL (migración
 * 20260713000000); acá solo va lógica de presentación testeable.
 */

export type ErrStatus = "nuevo" | "revisando" | "resuelto" | "ignorado";

/** Estados en orden de flujo. Útil para iterar tiles de conteo. */
export const ERROR_STATUSES: ErrStatus[] = ["nuevo", "revisando", "resuelto", "ignorado"];

/**
 * Extrae un mensaje corto del `metadata` de un audit_log de error.
 *
 * El metadata es JSON arbitrario (lo escribe quien audita: edges, crons,
 * triggers), así que tratamos la entrada como `unknown` y probamos las
 * claves más comunes en orden de preferencia. Devuelve `null` cuando no
 * hay ninguna string usable — la UI muestra solo la acción en ese caso.
 */
export function errorMessage(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  for (const k of ["error", "reason", "message", "detail"]) {
    if (typeof m[k] === "string" && m[k]) return m[k] as string;
  }
  return null;
}
