/**
 * Helpers PUROS para decidir si una sesión de asistencia sigue siendo
 * "próxima" según la fecha Y HORA actual (no solo la fecha).
 *
 * WHY: las columnas attendance_sessions.session_date son DATE (sin hora),
 * así que un filtro server-side `session_date >= hoy` deja pasar las
 * sesiones de HOY que ya terminaron (ej. una clase de las 8:00 seguía
 * apareciendo como "próxima" a las 15:00 hasta la medianoche). El corte
 * fino por hora se hace en JS contra el instante actual usando el
 * datetime real de la sesión = session_date + start_time + duración.
 *
 * Convención del repo (ver edge student-calendar-ics): si no hay
 * start_time, fallback 09:00; si no hay duration_minutes, fallback 90 min.
 *
 * Funciones puras (reciben `nowMs`) para poder testearlas sin reloj.
 */

export interface SessionLike {
  /** "YYYY-MM-DD" (columna DATE, sin TZ). */
  session_date: string;
  /** "HH:MM[:SS]" o null. */
  start_time?: string | null;
  /** Minutos de duración o null. */
  duration_minutes?: number | null;
}

const DEFAULT_START = "09:00";
const DEFAULT_DURATION_MIN = 90;

/**
 * Timestamp (ms, hora LOCAL) del FIN de la sesión:
 *   session_date + (start_time || "09:00") + (duration_minutes || 90)min.
 * Devuelve NaN si session_date no es una fecha válida.
 */
export function sessionEndsAtMs(s: SessionLike): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((s.session_date ?? "").slice(0, 10));
  if (!m) return NaN;
  const [, y, mo, d] = m;
  const rawTime = s.start_time && /^\d{1,2}:\d{2}/.test(s.start_time) ? s.start_time : DEFAULT_START;
  const [hh, mm] = rawTime.split(":");
  // Construimos en hora LOCAL (no string ISO) para comparar contra el
  // `now` local del navegador sin drift de zona horaria.
  const startMs = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    0,
    0,
  ).getTime();
  if (Number.isNaN(startMs)) return NaN;
  const dur =
    typeof s.duration_minutes === "number" && s.duration_minutes > 0
      ? s.duration_minutes
      : DEFAULT_DURATION_MIN;
  return startMs + dur * 60_000;
}

/**
 * ¿La sesión sigue siendo "próxima" (aún no terminó) respecto a `nowMs`?
 * Una clase en curso AHORA cuenta como próxima; una que ya terminó hoy, no.
 * Conservador: si la fecha no parsea, la consideramos próxima (no ocultar
 * por un dato malo).
 */
export function sessionIsUpcoming(s: SessionLike, nowMs: number): boolean {
  const end = sessionEndsAtMs(s);
  if (Number.isNaN(end)) return true;
  return end >= nowMs;
}
