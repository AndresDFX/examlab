/**
 * Centralized helpers for exam time calculations and access windows.
 *
 * The exam window is absolute: regardless of when a student enters, the timer
 * always counts down to `exam.end_time`. A late student gets less time — the
 * intent is that a 5pm→6pm exam window leaves 50 minutes at 5:10pm, not 60.
 */

export type ExamAccessState = "upcoming" | "open" | "closed";

export interface ExamWindow {
  start_time: string | Date;
  end_time: string | Date;
}

const toMs = (v: string | Date): number =>
  typeof v === "string" ? new Date(v).getTime() : v.getTime();

/**
 * Seconds remaining until `endTime`, clamped at 0.
 * Returns 0 if the exam window is absent or already closed.
 */
export function computeSecondsLeft(
  endTime: string | Date | null | undefined,
  now: number = Date.now(),
): number {
  if (!endTime) return 0;
  const end = toMs(endTime);
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.floor((end - now) / 1000));
}

/**
 * Para exámenes con programación "relativa": el estudiante tiene
 * `timeLimitMinutes` minutos desde que arrancó el intento (`startedAt`),
 * pero nunca puede pasar de `endTime` (cierre de la ventana de
 * disponibilidad). Devuelve el mínimo de ambos en segundos.
 */
export function computeSecondsLeftRelative(
  startedAt: string | Date | null | undefined,
  timeLimitMinutes: number,
  endTime: string | Date | null | undefined,
  now: number = Date.now(),
  // Tiempo extra concedido por el docente (segundos). Debe extender la deadline
  // PERSONAL (started + límite) — en exámenes relativos con ventana amplia esa
  // es la restricción vinculante, NO end_time. El caller ya extiende `endTime`
  // (applyExtraTime), así que el extra NO se re-suma a windowEnd (evita
  // doble-conteo). Resultado = min(started+límite, end_time_original) + extra,
  // idéntico a computeAttemptEnd del monitor. Sin este parámetro el +5m del
  // docente se perdía al recargar en exámenes relativos.
  extraSeconds: number = 0,
): number {
  if (!startedAt) return 0;
  const started = toMs(startedAt);
  if (Number.isNaN(started)) return 0;
  const extraMs = Math.max(0, extraSeconds) * 1000;
  const personal = started + Math.max(0, timeLimitMinutes) * 60_000 + extraMs;
  const windowEnd = endTime ? toMs(endTime) : personal;
  const target = Math.min(personal, Number.isNaN(windowEnd) ? personal : windowEnd);
  return Math.max(0, Math.floor((target - now) / 1000));
}

/** True when `now` falls inside [start_time, end_time] (inclusive). */
export function isExamOpen(window: ExamWindow, now: number = Date.now()): boolean {
  const start = toMs(window.start_time);
  const end = toMs(window.end_time);
  if (Number.isNaN(start) || Number.isNaN(end)) return false;
  return now >= start && now <= end;
}

/**
 * Discrete state used to drive the "Iniciar examen" button and badges.
 * - `upcoming`: start hasn't arrived — disable start button
 * - `open`: window is active — enable start button
 * - `closed`: window has passed — disable start button
 */
export function getExamAccessState(window: ExamWindow, now: number = Date.now()): ExamAccessState {
  const start = toMs(window.start_time);
  const end = toMs(window.end_time);
  if (Number.isNaN(start) || Number.isNaN(end)) return "closed";
  if (now < start) return "upcoming";
  if (now > end) return "closed";
  return "open";
}

/** "MM:SS" format used by the exam timer header. */
export function formatTimerMMSS(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}
