/**
 * Mantener la sesión viva durante un examen largo.
 *
 * ── La causa raíz que esto ataca ──────────────────────────────────────
 * El parcial del 2026-09-23 dejó tres fallos de «No autenticado» sobre 340
 * ejecuciones de código, y el patrón no deja lugar a dudas: **todos ocurrieron
 * pasada la primera hora de sesión** (a los 64 y a los 83 minutos). El token
 * de acceso dura 60 minutos y el examen dura 120, así que cruzarlo no es un
 * caso raro: es inevitable.
 *
 * Lo que lo convierte en fallo es cómo renueva la librería de auth, que está
 * documentado en su propio código:
 *
 *   «On browsers the refresh process works only when the tab/window is in the
 *    FOREGROUND to conserve resources»
 *
 * Y la renovación solo se intenta dentro de una ventana estrecha: el ticker
 * corre cada 30 s y solo actúa cuando faltan ≤ 90 s para vencer. Juntando las
 * dos cosas: si el alumno está FUERA de la app durante ese minuto y medio
 * —algo que en un teléfono pasa todo el tiempo, y que los propios registros de
 * proctoring confirman—, nadie renueva nada. Al volver, el ticker se reanuda,
 * pero el primer «Ejecutar» puede salir antes con el token ya vencido, y el
 * edge lo rechaza.
 *
 * ── La regla ──────────────────────────────────────────────────────────
 * No se refresca «por si acaso» en cada acción: eso sería una llamada de red
 * extra en el camino crítico del examen, que es justo lo que queremos quitar.
 * Se refresca cuando al token le queda MENOS que el margen — o sea, cuando la
 * librería no va a llegar a tiempo por sí sola.
 */

/**
 * Margen de seguridad. Es holgado a propósito: lo que se paga por refrescar de
 * más es una llamada, y lo que se paga por refrescar de menos es que un alumno
 * pierda la ejecución de su código en un parcial.
 */
export const MARGEN_DE_REFRESCO_MS = 5 * 60 * 1000;

/**
 * ¿Hay que refrescar la sesión ahora?
 *
 * `expiresAt` viene en SEGUNDOS epoch (formato de `session.expires_at`). Sin
 * sesión no hay nada que refrescar. Un valor ilegible dispara el refresco:
 * ante la duda conviene tener un token nuevo, no descubrir que venció cuando
 * el alumno pulsa Ejecutar.
 */
export function necesitaRefresco(
  expiresAt: number | null | undefined,
  ahora: number,
  margenMs: number = MARGEN_DE_REFRESCO_MS,
): boolean {
  if (expiresAt == null) return false;
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt * 1000 - ahora <= margenMs;
}
