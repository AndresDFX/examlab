/**
 * Helpers de formato de fechas/duraciones unificados.
 *
 * Antes la app mezclaba 3 formas de pintar fechas:
 *   - new Date(x).toLocaleString()           → depende del locale del navegador
 *   - new Date(x).toLocaleDateString()       → idem
 *   - new Date(x).toLocaleString("es-CO", {...}) → explícito pero escrito a mano
 *     en cada lugar
 * El resultado: el mismo `start_time` aparecía como "12/30/2024, 08:00 AM" para
 * un docente con OS en inglés y "30/12/2024, 08:00:00" para uno con OS en
 * español, en la misma pantalla. Centralizamos en es-CO con opciones fijas
 * para que la app se vea igual independientemente del navegador.
 *
 * Acepta `Date | string | number | null | undefined` para no obligar al
 * caller a parsear ISO antes de formatear.
 */

type DateInput = Date | string | number | null | undefined;

const LOCALE = "es-CO";

function toDate(value: DateInput): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dateFmt = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

/** Día + mes sin año, para tiles angostos. "30 sep". */
const dateShortFmt = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "2-digit",
});

const dateLongFmt = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "long",
  day: "2-digit",
});

const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const timeFmt = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const weekdayFmt = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long",
  day: "2-digit",
  month: "long",
});

/** Solo fecha. "30 sep 2026". */
export function formatDate(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  return d ? dateFmt.format(d) : fallback;
}

/** Día + mes sin año. "30 sep". Para tiles compactos donde el año
 * se asume del contexto (calendario semanal, columna de asistencia). */
export function formatDateShort(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  return d ? dateShortFmt.format(d) : fallback;
}

/** Fecha con mes completo. "30 de septiembre de 2026". */
export function formatDateLong(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  return d ? dateLongFmt.format(d) : fallback;
}

/** Fecha + hora. "30 sep 2026, 14:30". */
export function formatDateTime(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  return d ? dateTimeFmt.format(d) : fallback;
}

/** Solo hora. "14:30". */
export function formatTime(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  return d ? timeFmt.format(d) : fallback;
}

/** Día de la semana + fecha. "lunes, 30 de septiembre". */
export function formatWeekday(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  return d ? weekdayFmt.format(d) : fallback;
}

/**
 * Para columnas tipo `start_date` que vienen como "YYYY-MM-DD" (sin
 * timezone) y queremos pintarlas sin que el navegador las interprete
 * como UTC y descuente un día. Adjuntamos T12:00:00 para clavarlas
 * en mediodía local antes de formatear.
 */
export function formatDateOnly(value: string | null | undefined, fallback = "—"): string {
  if (!value) return fallback;
  // Si ya viene con tiempo (ISO completo) lo dejamos pasar tal cual.
  const iso = value.length === 10 ? `${value}T12:00:00` : value;
  return formatDate(iso, fallback);
}

/**
 * Duración en minutos a "1h 30m" o "45m". Para mostrar `time_limit_minutes`
 * y similares de manera legible.
 */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "—";
  const total = Math.floor(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
