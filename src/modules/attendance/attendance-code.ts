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

/**
 * Techo real de la rotación: la columna y el parámetro del RPC son `int` (int4).
 * Un valor mayor rebota con `22003` de Postgres antes de entrar a la función, con
 * un mensaje crudo en inglés que no está en `friendlyError`. Por eso el input
 * clampea acá: "ilimitado" significa, en la práctica, int4 (~68 años).
 */
export const ATTENDANCE_CODE_ROTATION_MAX = 2147483647;

/**
 * ¿Una rotación >= la ventana? Entonces el servidor la normaliza a código FIJO.
 *
 * Espeja el guard de `teacher_open_attendance_check_in`
 * (mig 20262120000000): una rotación que no alcanza a cumplirse dentro de la
 * ventana no "casi no cambia" — cambia en un múltiplo ABSOLUTO del epoch, en un
 * instante que el docente no puede prever. El servidor es la autoridad; esto
 * existe solo para anticipárselo ANTES de abrir.
 *
 * Devuelve `false` cuando ya era fijo (`<= 0`): no hay nada que normalizar.
 */
export function attendanceRotationBecomesFixed(
  rotationSeconds: number | null | undefined,
  windowSeconds: number | null | undefined,
): boolean {
  const rot = Number(rotationSeconds);
  const win = Number(windowSeconds);
  if (!Number.isFinite(rot) || rot <= 0) return false;
  if (!Number.isFinite(win) || win <= 0) return false;
  return rot >= win;
}

/**
 * `rotationSeconds = 0` ⇒ CÓDIGO FIJO durante toda la ventana.
 *
 * No alcanza con poner una rotación muy grande: el período es
 * `floor(epoch / rotación)`, así que el código cambia en los múltiplos de esa
 * rotación — con rotación de un día cambiaría a la medianoche UTC, en mitad de
 * una ventana de tres días. Para que valga "todo el tiempo" el período tiene que
 * ser CONSTANTE, y por eso el modo fijo usa período 0.
 *
 * Tiene que coincidir con `attendance_code_period` en SQL (mig 20261820000000).
 */
export function attendanceCodeIsStatic(rotationSeconds: number | null | undefined): boolean {
  return !rotationSeconds || rotationSeconds <= 0;
}

/** Período actual a partir de un timestamp (default: ahora) y un tamaño de ventana. */
export function attendancePeriod(rotationSeconds: number, nowMs: number = Date.now()): number {
  if (attendanceCodeIsStatic(rotationSeconds)) return 0;
  return Math.floor(nowMs / 1000 / rotationSeconds);
}

/**
 * Segundos restantes hasta la próxima rotación (1..rotationSeconds).
 *
 * En modo fijo devuelve `null`: no hay próxima rotación. Devolver 0 habría hecho
 * que la barra de progreso del proyector se viera siempre vacía y el contador
 * dijera "rota en 0s" para siempre, que es peor que no mostrar nada.
 */
export function attendanceSecondsToNextRotation(
  rotationSeconds: number,
  nowMs: number = Date.now(),
): number | null {
  if (attendanceCodeIsStatic(rotationSeconds)) return null;
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

/**
 * Construye la URL del QR de check-in de asistencia.
 *
 * Apunta a la ruta PÚBLICA `/asistencia` (fuera de `/app/*`) para que el
 * alumno pueda marcar asistencia SIN estar logueado (escanea el QR o abre el
 * link que comparte el docente) — mismo concepto que `/reto/$pin` del Reto en
 * vivo. `session` y `code` van como query params (no en el path) para que el
 * scanner in-app (`AttendanceQRScanner.parsePayload`) siga extrayéndolos igual.
 * El `session` fija la sesión/curso/tenant exacto; el check-in valida matrícula.
 */
export function buildAttendanceCheckInUrl(origin: string, sessionId: string, code: string): string {
  const url = new URL("/asistencia", origin);
  url.searchParams.set("session", sessionId);
  url.searchParams.set("code", code);
  return url.toString();
}
