/**
 * Helpers para horarios de curso. Lógica pura — sin DB.
 *
 * El día de la semana se modela como 0..6 con 0=domingo (igual que
 * JS Date.getDay() y EXTRACT(DOW FROM ...) de Postgres). Esto evita
 * conversiones al cruzar la frontera browser ↔ SQL.
 */

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Modalidad = "presencial" | "virtual" | "hibrida";

export interface CourseScheduleBlock {
  id?: string;
  day_of_week: DayOfWeek;
  /** Formato "HH:MM" o "HH:MM:SS" (Postgres time). */
  start_time: string;
  end_time: string;
  aula: string | null;
  modalidad: Modalidad;
  notes: string | null;
}

/** Nombres ordenados de lunes a domingo — el orden NATURAL para
 *  pantallas de horario (lunes primero, sábado y domingo al final).
 *  El índice del array es 0..6 pero ese 0 representa LUNES en este
 *  contexto, NO domingo (cuidado al mapear contra day_of_week).
 *  Por eso exportamos también `DAY_LABELS` indexado por day_of_week. */
export const DAY_LABELS: Record<DayOfWeek, string> = {
  0: "Domingo",
  1: "Lunes",
  2: "Martes",
  3: "Miércoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sábado",
};

export const DAY_LABELS_SHORT: Record<DayOfWeek, string> = {
  0: "Dom",
  1: "Lun",
  2: "Mar",
  3: "Mié",
  4: "Jue",
  5: "Vie",
  6: "Sáb",
};

/** Orden semanal estándar — lunes primero, domingo al final. Útil
 *  para listar bloques semanalmente en la UI. */
export const WEEK_ORDER: DayOfWeek[] = [1, 2, 3, 4, 5, 6, 0];

/** Recorta "HH:MM:SS" → "HH:MM" para display. Postgres time devuelve
 *  el formato completo; el usuario solo quiere ver hora:minuto. */
export function trimTime(t: string): string {
  if (!t) return "";
  // Manejar "HH:MM:SS" o "HH:MM" sin caer si viene en otro formato.
  const m = t.match(/^(\d{2}:\d{2})/);
  return m ? m[1] : t;
}

/** Compara dos bloques para sort: primero por orden semanal
 *  (lunes→domingo), luego por hora de inicio. */
export function compareBlocks(a: CourseScheduleBlock, b: CourseScheduleBlock): number {
  const dayA = WEEK_ORDER.indexOf(a.day_of_week);
  const dayB = WEEK_ORDER.indexOf(b.day_of_week);
  if (dayA !== dayB) return dayA - dayB;
  return a.start_time.localeCompare(b.start_time);
}

/** Render compacto del bloque para badges/listas:
 *    "Lun 10:00–12:00 (Aula 301)"
 *  Omite aula si está vacía; omite modalidad si es presencial. */
export function formatBlockShort(b: CourseScheduleBlock): string {
  const day = DAY_LABELS_SHORT[b.day_of_week];
  const hours = `${trimTime(b.start_time)}–${trimTime(b.end_time)}`;
  const extras: string[] = [];
  if (b.aula?.trim()) extras.push(b.aula.trim());
  if (b.modalidad === "virtual") extras.push("virtual");
  if (b.modalidad === "hibrida") extras.push("híbrida");
  const tail = extras.length > 0 ? ` (${extras.join(", ")})` : "";
  return `${day} ${hours}${tail}`;
}

/** Render para texto plano (informe Acuerdo Pedagógico): bloques
 *  ordenados separados por " · ". Lista vacía → "". */
export function formatScheduleText(blocks: CourseScheduleBlock[]): string {
  return blocks
    .slice()
    .sort(compareBlocks)
    .map(formatBlockShort)
    .join(" · ");
}

/** Detecta si dos bloques del MISMO día se solapan en horario.
 *  Útil para warnings de overlap al editar. */
export function blocksOverlap(a: CourseScheduleBlock, b: CourseScheduleBlock): boolean {
  if (a.day_of_week !== b.day_of_week) return false;
  return a.start_time < b.end_time && b.start_time < a.end_time;
}
