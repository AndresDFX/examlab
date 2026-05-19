/**
 * Helpers para interpretar errores de la edge function `calendar` que
 * envuelve llamadas a Google Calendar API.
 *
 * Formato del mensaje (ver `supabase/functions/_shared/calendar-google.ts`
 * función `callGoogle`):
 *   `Google API <path> falló [<status>]: <body>`
 *
 * Ejemplo real:
 *   "Google API /calendar/v3/calendars/...../events/abc?... falló [404]:
 *    { error: { code: 404, message: 'Not Found' } }"
 *
 * NOTA: La edge function tiene una copia exacta del regex
 * `/\[(404|410)\]/`. Si cambias el formato del error de `callGoogle`,
 * actualiza AMBOS lados.
 */

/**
 * Type-guard para objetos con propiedad `status` numérica (forma nueva
 * que arroja `GoogleApiError` de la edge function de calendar).
 */
function hasNumericStatus(err: unknown): err is { status: number } {
  return (
    err != null &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  );
}

/**
 * True si el error indica que el evento de Google Calendar al que
 * apuntamos ya no existe (fue borrado/movido). Esto cubre:
 *   - 404 Not Found (caso típico cuando el docente borró el evento
 *     manualmente).
 *   - 410 Gone (Google purga el evento permanentemente tras un tiempo).
 *
 * Detecta DOS formas del error:
 *   1. Objeto con `.status` numérico (nueva `GoogleApiError`).
 *   2. Error/string con `[<status>]` en el mensaje (formato legacy —
 *      backwards-compatible mientras conviven versiones de la edge
 *      function distintas).
 */
export function isGoogleEventGoneError(err: unknown): boolean {
  if (hasNumericStatus(err)) {
    return err.status === 404 || err.status === 410;
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\[(404|410)\]/.test(msg);
}

/**
 * Extrae el status HTTP del error. Devuelve `null` si no se pudo
 * determinar (sin propiedad `.status` y sin formato `[<status>]` en el
 * mensaje — probablemente un error de red, no de respuesta Google).
 */
export function extractGoogleErrorStatus(err: unknown): number | null {
  if (hasNumericStatus(err)) return err.status;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const m = msg.match(/\[(\d{3})\]/);
  return m ? Number(m[1]) : null;
}
