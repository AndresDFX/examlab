/**
 * Helpers puros para programar sesiones de asistencia.
 *
 * Vivían inline en `app.teacher.contents.tsx`. Se extrajeron cuando la
 * funcionalidad "Programar sesiones" se reusó también en el tablero
 * (`app.teacher.attendance.tsx`).
 */

/** Días de la semana en es-CO. Map de getDay() (0..6 con 0=Domingo) a
 *  etiquetas cortas y largas. Listamos lunes primero (idx 1) porque la
 *  UI muestra el toggle de días en orden L-M-X-J-V-S-D. */
export const WEEKDAYS_ES: { idx: number; short: string; long: string }[] = [
  { idx: 1, short: "Lun", long: "Lunes" },
  { idx: 2, short: "Mar", long: "Martes" },
  { idx: 3, short: "Mié", long: "Miércoles" },
  { idx: 4, short: "Jue", long: "Jueves" },
  { idx: 5, short: "Vie", long: "Viernes" },
  { idx: 6, short: "Sáb", long: "Sábado" },
  { idx: 0, short: "Dom", long: "Domingo" },
];

/**
 * Calcula N fechas a partir de `start` avanzando día a día y aceptando
 * solo aquellos cuyo `getDay()` esté en `days`. Incluye `start` si su
 * día matchea.
 *
 * El cap `MAX_ITER` previene loops infinitos defensivamente — no debería
 * dispararse porque `days.size === 0` se valida arriba, pero la
 * seguridad es barata.
 */
export function computeSessionDates(start: Date, days: Set<number>, n: number): Date[] {
  if (n <= 0 || days.size === 0) return [];
  const dates: Date[] = [];
  const cur = new Date(start);
  const MAX_ITER = 365 * 5;
  for (let i = 0; i < MAX_ITER && dates.length < n; i++) {
    if (days.has(cur.getDay())) {
      dates.push(new Date(cur));
    }
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

/**
 * Convierte una `Date` a ISO date-only (`YYYY-MM-DD`) usando el
 * calendario LOCAL del navegador. Esto evita el bug clásico de
 * `Date.toISOString()` que aplica UTC y desplaza la fecha un día en
 * zonas horarias negativas (ej. Bogotá UTC-5 a las 22:00 → 03:00 del
 * día siguiente en UTC).
 */
export function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * Parsea un string `YYYY-MM-DD` como fecha LOCAL (no UTC). Útil cuando
 * leemos `attendance_sessions.session_date` (columna DATE sin TZ) y
 * queremos manipularla sin que `new Date("2026-05-13")` la interprete
 * como medianoche UTC y la corra un día en zonas negativas.
 */
export function parseLocalIsoDate(s: string): Date {
  const [y, m, dd] = s.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, dd ?? 1);
}
