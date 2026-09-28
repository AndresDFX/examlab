/**
 * El código de asistencia que el docente ELIGE, en vez del que deriva el sistema.
 *
 * ── Por qué seis dígitos y no texto libre ─────────────────────────────
 *
 * El largo no es una preferencia: está fijado por lo que ya existe alrededor.
 * Las dos RPC de check-in rechazan cualquier cosa que no case `^[0-9]{6}$`
 * ANTES de comparar, el campo del estudiante acepta seis dígitos y el QR
 * codifica `?code=`. Un código con letras se veria perfecto en el proyector y
 * la base lo rechazaria — el peor resultado posible, porque el docente lo
 * descubre con el curso entero tecleándolo.
 *
 * Por eso la regla vive acá y no escrita a mano en la pantalla: está en TRES
 * lugares (la CHECK de la columna, el guard de la RPC y este campo), y
 * `codigo-manual.test.ts` lee la migración del disco para que no puedan
 * separarse.
 *
 * ── Texto, nunca número ───────────────────────────────────────────────
 *
 * `024681` es un código válido. Guardarlo como `number` se come el cero de
 * adelante: el docente lo dicta con seis dígitos y la pantalla muestra cinco.
 */

/** Cuántos dígitos tiene un código elegido. Lo fija la CHECK de la columna. */
export const LARGO_CODIGO_MANUAL = 6;

/**
 * Deja solo dígitos y recorta al largo. Es lo que se aplica MIENTRAS el docente
 * escribe: pegar «24-68-10» o un espacio de más no puede romper el campo.
 */
export function normalizarCodigoManual(valor: string): string {
  return valor.replace(/\D/g, "").slice(0, LARGO_CODIGO_MANUAL);
}

/**
 * ¿Está completo? Vacío es VÁLIDO y significa «que lo genere la plataforma» —
 * es el comportamiento de siempre, no un error que haya que señalar.
 */
export function codigoManualCompleto(valor: string): boolean {
  const v = valor.trim();
  return v === "" || new RegExp(`^\\d{${LARGO_CODIGO_MANUAL}}$`).test(v);
}

/** Lo que se le manda al servidor: `null` cuando el docente no eligió ninguno. */
export function codigoManualParaEnviar(valor: string): string | null {
  const v = valor.trim();
  return v === "" ? null : v;
}
