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
 * True si el error indica que el evento de Google Calendar al que
 * apuntamos ya no existe (fue borrado/movido). Esto cubre:
 *   - 404 Not Found (caso típico cuando el docente borró el evento
 *     manualmente).
 *   - 410 Gone (Google purga el evento permanentemente tras un tiempo).
 *
 * Acepta `Error`, string, o cualquier otro valor — útil para usar
 * dentro de catch() sin tener que castear.
 */
export function isGoogleEventGoneError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\[(404|410)\]/.test(msg);
}

/**
 * Extrae el status HTTP del mensaje de error de `callGoogle`. Devuelve
 * `null` si el formato no matchea (probablemente un error de red u
 * otra causa, no de la respuesta de Google).
 */
export function extractGoogleErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const m = msg.match(/\[(\d{3})\]/);
  return m ? Number(m[1]) : null;
}
