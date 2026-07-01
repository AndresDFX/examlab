/**
 * Calendario de festivos de Colombia — helper PURO (sin React/DOM, sin
 * Date.now, sin llamadas de red: el CSP del app bloquea APIs externas, y
 * además queremos que sea determinista y testeable).
 *
 * Reglas:
 *   1. FIJOS (no se trasladan): Año Nuevo, Día del Trabajo, Independencia,
 *      Batalla de Boyacá, Inmaculada Concepción, Navidad.
 *   2. LEY EMILIANI → se trasladan al LUNES siguiente: Reyes Magos, San José,
 *      San Pedro y San Pablo, Asunción, Día de la Raza, Todos los Santos,
 *      Independencia de Cartagena.
 *   3. RELATIVOS A PASCUA: Jueves y Viernes Santo (exactos, NO se trasladan);
 *      Ascensión, Corpus Christi y Sagrado Corazón (base jueves/viernes,
 *      trasladados al lunes por Emiliani).
 *
 * Convención de día: 0=Domingo (JS getDay). Todas las fechas se construyen y
 * serializan en calendario LOCAL (toLocalIsoDate) para evitar el bug UTC-1día.
 */
import { toLocalIsoDate } from "@/modules/contents/session-dates";

/** Traslada una fecha al lunes siguiente (o la deja si ya es lunes) — Ley
 *  Emiliani. add = (8 - getDay()) % 7: lunes(1)→0, martes(2)→6, …, dom(0)→1. */
function moveToMonday(d: Date): Date {
  const add = (8 - d.getDay()) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + add);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Domingo de Pascua por el algoritmo Anonymous Gregorian (Butcher/Meeus). */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const _cache = new Map<number, Map<string, string>>();

/** Map iso('YYYY-MM-DD') → nombre del festivo, para un año. Cacheado por año. */
export function coHolidayMap(year: number): Map<string, string> {
  const cached = _cache.get(year);
  if (cached) return cached;
  const m = new Map<string, string>();
  const put = (d: Date, name: string) => m.set(toLocalIsoDate(d), name);

  // 1) Fijos.
  put(new Date(year, 0, 1), "Año Nuevo");
  put(new Date(year, 4, 1), "Día del Trabajo");
  put(new Date(year, 6, 20), "Día de la Independencia");
  put(new Date(year, 7, 7), "Batalla de Boyacá");
  put(new Date(year, 11, 8), "Inmaculada Concepción");
  put(new Date(year, 11, 25), "Navidad");

  // 2) Ley Emiliani → lunes siguiente.
  put(moveToMonday(new Date(year, 0, 6)), "Reyes Magos");
  put(moveToMonday(new Date(year, 2, 19)), "Día de San José");
  put(moveToMonday(new Date(year, 5, 29)), "San Pedro y San Pablo");
  put(moveToMonday(new Date(year, 7, 15)), "Asunción de la Virgen");
  put(moveToMonday(new Date(year, 9, 12)), "Día de la Raza");
  put(moveToMonday(new Date(year, 10, 1)), "Todos los Santos");
  put(moveToMonday(new Date(year, 10, 11)), "Independencia de Cartagena");

  // 3) Relativos a Pascua.
  const easter = easterSunday(year);
  put(addDays(easter, -3), "Jueves Santo");
  put(addDays(easter, -2), "Viernes Santo");
  put(moveToMonday(addDays(easter, 39)), "Ascensión del Señor"); // jueves → lunes
  put(moveToMonday(addDays(easter, 60)), "Corpus Christi"); // jueves → lunes
  put(moveToMonday(addDays(easter, 68)), "Sagrado Corazón"); // viernes → lunes

  _cache.set(year, m);
  return m;
}

/** Set de fechas festivas ('YYYY-MM-DD') de Colombia para un año. */
export function coHolidays(year: number): Set<string> {
  return new Set(coHolidayMap(year).keys());
}

/** Nombre del festivo para una fecha iso, o null si no es festivo. Toma el año
 *  del propio iso (soporta generaciones que cruzan fin de año). */
export function coHolidayName(iso: string): string | null {
  const y = Number(iso.slice(0, 4));
  if (!Number.isFinite(y)) return null;
  return coHolidayMap(y).get(iso) ?? null;
}

/** ¿La fecha (Date o iso) es festivo en Colombia? */
export function isCoHoliday(date: string | Date): boolean {
  const iso = typeof date === "string" ? date : toLocalIsoDate(date);
  const y = Number(iso.slice(0, 4));
  if (!Number.isFinite(y)) return false;
  return coHolidayMap(y).has(iso);
}

/** Siguiente día HÁBIL estrictamente posterior a `date` cuyo getDay() esté en
 *  `days` y que NO sea festivo. Usado por la política "mover festivos". */
export function nextBusinessDay(
  date: Date,
  days: Set<number>,
  isHoliday: (iso: string) => boolean,
): Date {
  const cur = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  for (let i = 0; i < 365 * 5; i++) {
    cur.setDate(cur.getDate() + 1);
    const iso = toLocalIsoDate(cur);
    if (days.has(cur.getDay()) && !isHoliday(iso)) return new Date(cur);
  }
  return new Date(date);
}
