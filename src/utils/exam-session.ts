/**
 * Utilidades puras para el ciclo de vida de una sesión de examen estudiantil.
 * Extraídas del componente TakeExam para que sean testeables sin renderizar.
 */

type TimerControl = {
  action: string;
  extra_seconds: number | null;
  target_user_id: string | null;
};

/**
 * Suma los segundos extra concedidos a un estudiante desde exam_timer_controls.
 * Solo cuenta filas con action="add_time". Las filas de pausa/reanudación se ignoran.
 */
export function computeExtraSeconds(controls: TimerControl[]): number {
  return controls
    .filter((c) => c.action === "add_time")
    .reduce((sum, c) => sum + (Number(c.extra_seconds) || 0), 0);
}

/**
 * Extiende un ISO end_time por extraSeconds segundos.
 * Si extraSeconds <= 0, devuelve el endTime original sin modificar.
 */
export function applyExtraTime(endTime: string, extraSeconds: number): string {
  if (extraSeconds <= 0) return endTime;
  return new Date(new Date(endTime).getTime() + extraSeconds * 1000).toISOString();
}

/**
 * Devuelve el índice de pregunta persistido en answers.__current_idx,
 * o 0 si no existe, no es número, o es negativo.
 */
export function restoreQuestionIndex(answers: Record<string, unknown>): number {
  const idx = answers.__current_idx;
  if (typeof idx !== "number" || idx < 0) return 0;
  return idx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Borrado de advertencias (usado por el monitor docente). Cuando se borra una
// advertencia y el conteo cae bajo el umbral, restauramos la submission a
// "en_progreso" + submitted_at=null para que el estudiante pueda reingresar.
// ─────────────────────────────────────────────────────────────────────────────

export type WarningEventLike = {
  type?: string;
  at?: string | number;
  ts?: number;
  questionIdx?: number | null;
};

export interface ClearWarningInput {
  status: string;
  focusWarnings: number;
  events: WarningEventLike[];
  examMaxWarnings: number;
}

export interface ClearWarningResult {
  status: string;
  focusWarnings: number;
  events: WarningEventLike[];
  /** Si pasa a true, hay que limpiar `submitted_at` en la DB para reanudar. */
  clearSubmittedAt: boolean;
  /** True si la submission pasó de "sospechoso" → "en_progreso" en esta operación. */
  restoredToInProgress: boolean;
}

/**
 * Resultado de borrar UNA advertencia puntual del array (índice idx).
 * No muta el input; devuelve el nuevo estado a persistir.
 */
export function applyClearOneWarning(
  input: ClearWarningInput,
  idx: number,
): ClearWarningResult {
  const safe = clampWarningInput(input);
  if (idx < 0 || idx >= safe.events.length) {
    return {
      status: safe.status,
      focusWarnings: safe.focusWarnings,
      events: safe.events,
      clearSubmittedAt: false,
      restoredToInProgress: false,
    };
  }
  const nextEvents = safe.events.filter((_, i) => i !== idx);
  const nextWarnings = Math.max(0, safe.focusWarnings - 1);
  const restoring = safe.status === "sospechoso" && nextWarnings < safe.examMaxWarnings;
  return {
    status: restoring ? "en_progreso" : safe.status,
    focusWarnings: nextWarnings,
    events: nextEvents,
    clearSubmittedAt: restoring,
    restoredToInProgress: restoring,
  };
}

/**
 * Resultado de borrar TODAS las advertencias.
 */
export function applyClearAllWarnings(input: ClearWarningInput): ClearWarningResult {
  const safe = clampWarningInput(input);
  const restoring = safe.status === "sospechoso";
  return {
    status: restoring ? "en_progreso" : safe.status,
    focusWarnings: 0,
    events: [],
    clearSubmittedAt: restoring,
    restoredToInProgress: restoring,
  };
}

function clampWarningInput(input: ClearWarningInput): ClearWarningInput {
  return {
    status: input.status,
    focusWarnings: Math.max(0, Number(input.focusWarnings) || 0),
    events: Array.isArray(input.events) ? input.events : [],
    examMaxWarnings: Math.max(1, Number(input.examMaxWarnings) || 3),
  };
}
