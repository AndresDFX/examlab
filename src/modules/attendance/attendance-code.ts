/**
 * Cálculo determinístico del código de check-in de asistencia (TOTP-like).
 *
 * DEBE coincidir bit-a-bit con la función SQL `compute_attendance_code(seed, period)`
 * en la migración 20260507100000_attendance_check_in.sql:
 *   sha256(seed + ":" + period) → primeros 7 hex chars (28 bits, siempre positivo)
 *   → módulo 1.000.000 → padding a 6 dígitos.
 *
 * El cliente del docente lo usa para mostrar el código en pantalla sin
 * llamar al server cada rotación. La validación del código del estudiante
 * la hace el server (SECURITY DEFINER) leyendo la seed protegida.
 */

const ROTATION_DEFAULT_SECONDS = 60;

export const ATTENDANCE_CODE_ROTATION_DEFAULT = ROTATION_DEFAULT_SECONDS;
export const ATTENDANCE_CHECK_IN_DEFAULT_MINUTES = 10;

/** Período actual a partir de un timestamp (default: ahora) y un tamaño de ventana. */
export function attendancePeriod(rotationSeconds: number, nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / rotationSeconds);
}

/** Segundos restantes hasta la próxima rotación (1..rotationSeconds). */
export function attendanceSecondsToNextRotation(
  rotationSeconds: number,
  nowMs: number = Date.now(),
): number {
  const epochSec = Math.floor(nowMs / 1000);
  const rem = rotationSeconds - (epochSec % rotationSeconds);
  return rem === 0 ? rotationSeconds : rem;
}

/** Calcula el código de 6 dígitos para una semilla y un período. Async por SubtleCrypto. */
export async function computeAttendanceCode(seed: string, period: number): Promise<string> {
  const data = new TextEncoder().encode(`${seed}:${period}`);
  const hashBuf = await crypto.subtle.digest("SHA-256", data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  const hex = hashArr.map((b) => b.toString(16).padStart(2, "0")).join("");
  // 7 hex chars = 28 bits = siempre positivo cuando se interpreta como int.
  const num = parseInt(hex.slice(0, 7), 16) % 1000000;
  return String(num).padStart(6, "0");
}

/** Construye la URL del QR (deep-link a la app del estudiante). */
export function buildAttendanceCheckInUrl(
  origin: string,
  sessionId: string,
  code: string,
): string {
  const url = new URL("/app/student/attendance", origin);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("code", code);
  return url.toString();
}
