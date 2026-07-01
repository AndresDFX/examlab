/**
 * Helper PURO que compone el "plan de sesiones" para GenerateSessionsDialog:
 * fechas + horario (prefijado desde course_schedules) + política de festivos
 * de Colombia. Sin React/DOM/Date.now — testeable.
 */
import { computeSessionDates, toLocalIsoDate } from "@/modules/contents/session-dates";
import { trimTime, type CourseScheduleBlock } from "@/modules/schedules/course-schedule";
import { parseHHMMToMinutes } from "@/modules/sessions/csv";
import { coHolidays, coHolidayName, nextBusinessDay } from "@/modules/schedules/co-holidays";

export type HolidayPolicy = "include" | "skip" | "move";

export interface SessionPlanRow {
  /** Clave estable para preservar ediciones manuales al recomputar. */
  key: string;
  iso: string; // YYYY-MM-DD (local)
  title: string;
  /** "HH:MM" para el input; al persistir se agrega ":00". null = sin hora. */
  startTime: string | null;
  /** minutos, clamp [15,480]. null = sin duración (cuando no hay hora). */
  durationMin: number | null;
  isHoliday: boolean;
  holidayName: string | null;
  /** getDay() del que salió (0=Dom). Informativo. */
  weekday: number;
}

export interface BuildSessionPlanOpts {
  start: Date;
  days: Set<number>;
  count: number;
  /** Bloques del horario del curso; se usa el más temprano por día para
   *  prefijar hora de inicio y duración (end-start). */
  schedules?: CourseScheduleBlock[];
  policy?: HolidayPolicy;
  /** Título por índice (default "Sesión N"). */
  titleFor?: (i: number) => string;
}

const isHolidayIso = (iso: string): boolean =>
  coHolidays(Number(iso.slice(0, 4))).has(iso);

/** Duración (min) de un bloque, clamp [15,480]; 90 por defecto si el rango es
 *  inválido pero hay hora de inicio (coherente con createSession). */
function blockDuration(b: CourseScheduleBlock): number {
  const s = parseHHMMToMinutes(b.start_time);
  const e = parseHHMMToMinutes(b.end_time);
  if (s != null && e != null && e > s) return Math.min(480, Math.max(15, e - s));
  return 90;
}

export function buildSessionPlan(opts: BuildSessionPlanOpts): SessionPlanRow[] {
  const { start, days, count, schedules = [], policy = "skip", titleFor } = opts;
  if (count <= 0 || days.size === 0) return [];

  // Bloque más temprano por día de semana (una sesión por día matcheado).
  const blockByDay = new Map<number, CourseScheduleBlock>();
  for (const b of [...schedules].sort((a, z) => a.start_time.localeCompare(z.start_time))) {
    if (!blockByDay.has(b.day_of_week)) blockByDay.set(b.day_of_week, b);
  }

  let chosen: Date[];
  if (policy === "skip") {
    // Sobre-generamos y filtramos festivos hasta juntar `count`.
    const pool = computeSessionDates(start, days, count * 4 + 60);
    chosen = [];
    for (const d of pool) {
      if (chosen.length >= count) break;
      if (!isHolidayIso(toLocalIsoDate(d))) chosen.push(d);
    }
  } else if (policy === "move") {
    const base = computeSessionDates(start, days, count);
    const used = new Set<string>();
    chosen = [];
    for (let d of base) {
      let iso = toLocalIsoDate(d);
      let guard = 0;
      // Si es festivo o ya está usada (por un movimiento previo), avanzar al
      // siguiente día hábil que matchee el patrón.
      while ((isHolidayIso(iso) || used.has(iso)) && guard < 365 * 5) {
        d = nextBusinessDay(d, days, isHolidayIso);
        iso = toLocalIsoDate(d);
        guard++;
      }
      used.add(iso);
      chosen.push(d);
    }
  } else {
    chosen = computeSessionDates(start, days, count);
  }

  return chosen.map((d, i) => {
    const iso = toLocalIsoDate(d);
    const block = blockByDay.get(d.getDay());
    const startTime = block ? trimTime(block.start_time) : null;
    const durationMin = block ? blockDuration(block) : null;
    const isHol = isHolidayIso(iso);
    return {
      key: `${i}:${iso}`,
      iso,
      title: titleFor ? titleFor(i) : `Sesión ${i + 1}`,
      startTime,
      durationMin,
      isHoliday: isHol,
      holidayName: isHol ? coHolidayName(iso) : null,
      weekday: d.getDay(),
    };
  });
}
