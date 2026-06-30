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
 *
 * `questionCount` (opcional) acota el índice a [0, questionCount-1]: si el
 * docente eliminó preguntas entre dos sesiones del alumno, un índice persistido
 * fuera de rango dejaría la pantalla sin pregunta visible (y en modo secuencial,
 * sin forma de volver atrás). Pasarlo siempre que se conozca el total.
 */
export function restoreQuestionIndex(
  answers: Record<string, unknown>,
  questionCount?: number,
): number {
  const idx = answers.__current_idx;
  if (typeof idx !== "number" || idx < 0) return 0;
  if (typeof questionCount === "number" && questionCount > 0) {
    return Math.min(idx, questionCount - 1);
  }
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
  /**
   * Si el examen sigue abierto (now ∈ [start_time, end_time]).
   * - true:  sospechoso bajo el umbral → en_progreso (estudiante puede reingresar)
   * - false: sospechoso bajo el umbral → completado (la ventana cerró, no hay reingreso)
   */
  examIsOpen: boolean;
}

export interface ClearWarningResult {
  status: string;
  focusWarnings: number;
  events: WarningEventLike[];
  /** Si pasa a true, hay que limpiar `submitted_at` en la DB para reanudar. */
  clearSubmittedAt: boolean;
  /** True si la submission pasó de "sospechoso" → "en_progreso" en esta operación. */
  restoredToInProgress: boolean;
  /** True si la submission pasó de "sospechoso" → "completado" (examen ya cerró). */
  closedAsCompletado: boolean;
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
      closedAsCompletado: false,
    };
  }
  const nextEvents = safe.events.filter((_, i) => i !== idx);
  const nextWarnings = Math.max(0, safe.focusWarnings - 1);
  const belowThreshold = safe.status === "sospechoso" && nextWarnings < safe.examMaxWarnings;
  return finalizeResult(safe, belowThreshold, nextWarnings, nextEvents);
}

/**
 * Resultado de borrar TODAS las advertencias.
 */
export function applyClearAllWarnings(input: ClearWarningInput): ClearWarningResult {
  const safe = clampWarningInput(input);
  const wasSospechoso = safe.status === "sospechoso";
  return finalizeResult(safe, wasSospechoso, 0, []);
}

function finalizeResult(
  safe: ClearWarningInput,
  shouldRestore: boolean,
  nextWarnings: number,
  nextEvents: WarningEventLike[],
): ClearWarningResult {
  if (!shouldRestore) {
    return {
      status: safe.status,
      focusWarnings: nextWarnings,
      events: nextEvents,
      clearSubmittedAt: false,
      restoredToInProgress: false,
      closedAsCompletado: false,
    };
  }
  if (safe.examIsOpen) {
    return {
      status: "en_progreso",
      focusWarnings: nextWarnings,
      events: nextEvents,
      clearSubmittedAt: true,
      restoredToInProgress: true,
      closedAsCompletado: false,
    };
  }
  // Ventana cerrada: no podemos reabrir el examen, dejamos como completado limpio.
  return {
    status: "completado",
    focusWarnings: nextWarnings,
    events: nextEvents,
    clearSubmittedAt: false,
    restoredToInProgress: false,
    closedAsCompletado: true,
  };
}

function clampWarningInput(input: ClearWarningInput): ClearWarningInput {
  return {
    status: input.status,
    focusWarnings: Math.max(0, Number(input.focusWarnings) || 0),
    events: Array.isArray(input.events) ? input.events : [],
    examMaxWarnings: Math.max(1, Number(input.examMaxWarnings) || 3),
    examIsOpen: Boolean(input.examIsOpen),
  };
}
