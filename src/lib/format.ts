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

// Configuración de hora:
//
// Queremos ciclo 00..23 (medianoche como "00:00", no "24:00"). En
// teoría `hourCycle: "h23"` lo logra, pero Node Linux/ICU con `es-CO`
// IGNORA `hourCycle` cuando coexiste con `hour12: false` y devuelve
// "24:00" para 0h, mientras Node Windows respeta `hourCycle` y devuelve
// "00:00". Resultado: misma app, dos formatos según el servidor.
//
// Solución portable: dejamos `hourCycle` por si el runtime lo respeta
// (mejor MX/Chrome/Firefox/Node Windows), Y post-procesamos el output
// con `fixMidnight` para tapar el caso Linux. El regex `\b24:` exige
// que "24" vaya seguido de ":" — descarta falsos positivos como
// "24 sep" en la parte de fecha.
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

const timeFmt = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

function fixMidnight(s: string): string {
  // "24:00" → "00:00", "24:30" → "00:30" (cualquier minuto). El \b
  // garantiza que NO matcheamos "024:" ni "224:" — solo "24" como
  // número entero seguido de ":".
  return s.replace(/\b24:/g, "00:");
}

const weekdayFmt = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long",
  day: "2-digit",
  month: "long",
});

/** Solo el nombre del día. "sábado". Útil cuando la fecha ya se muestra
 *  en un badge contiguo y no queremos repetirla. */
const weekdayNameFmt = new Intl.DateTimeFormat(LOCALE, {
  weekday: "long",
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
  return d ? fixMidnight(dateTimeFmt.format(d)) : fallback;
}

/** Solo hora. "14:30". */
export function formatTime(value: DateInput, fallback = "—"): string {
  const d = toDate(value);
  return d ? fixMidnight(timeFmt.format(d)) : fallback;
}

/** Día de la semana + fecha. "lunes, 30 de septiembre".
 *  Anchora "YYYY-MM-DD" a mediodía local para evitar el bug clásico
 *  de UTC -1 día (igual que `formatDateOnly`). */
export function formatWeekday(value: DateInput, fallback = "—"): string {
  const v =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const d = toDate(v);
  return d ? weekdayFmt.format(d) : fallback;
}

/** Solo el nombre del día ("sábado") con la misma protección UTC. Pensado
 *  para subtítulos donde la fecha completa ya está en un badge contiguo
 *  — evita duplicación visual. */
export function formatWeekdayName(value: DateInput, fallback = "—"): string {
  const v =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value;
  const d = toDate(v);
  return d ? weekdayNameFmt.format(d) : fallback;
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

/**
 * Formatea un porcentaje quitando ceros sobrantes y usando coma como
 * separador decimal (locale es-CO). "33,33", "30", "0".
 *
 * Pensado para mostrar pesos de items / cortes / buckets con decimales
 * que el docente entiende: 33,33% se ve como en pantalla, no 33.33%.
 */
export function formatPercent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0";
  return n.toLocaleString("es-CO", { maximumFractionDigits: 2 });
}
