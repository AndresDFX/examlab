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
