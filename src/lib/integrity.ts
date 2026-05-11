/**
 * Helpers de integridad académica compartidos entre el monitor de
 * exámenes y la grilla de calificación de talleres/proyectos. La idea
 * es que la "sugerencia de nota penalizada" se calcule con la misma
 * fórmula en todos los módulos, así un docente que ya entendió la
 * mecánica en exámenes no tiene que reaprender en talleres.
 */

/** Umbral por debajo del cual una señal de IA o copia se considera ruido
 * y no entra en la sugerencia. Mismo umbral que usa la edge function
 * `detect-plagiarism` y la calificación con IA para `ai_detected=true`. */
export const INTEGRITY_ALERT_THRESHOLD = 0.6;

/**
 * Calcula la sugerencia de nota PENALIZADA para una pregunta o entrega
 * cuando hay señales de IA o copia activas. La fórmula es:
 *   sugerencia = nota_actual × (1 − severidad)
 * donde severidad = max(prob IA, max similitud con otro estudiante). Solo
 * entra al cálculo cuando alguna señal supera el umbral 0.6.
 *
 * Ejemplos sobre nota actual = 4,5:
 *   IA 60%  → 4,5 × (1 − 0,60) = 1,8
 *   IA 85%  → 4,5 × (1 − 0,85) = 0,675
 *   IA 100% → 4,5 × (1 − 1,00) = 0
 *
 * El docente siempre puede ignorar la sugerencia y poner el valor que
 * quiera; este cálculo solo CARGA el input para que sea un click.
 */
export function computeIntegritySuggestion(
  currentGrade: number | null,
  aiScore: number | null,
  plagiarismMax: number | null,
): { severity: number; suggested: number; source: "ai" | "plagio" | "ambas" } | null {
  const ai = aiScore != null && aiScore >= INTEGRITY_ALERT_THRESHOLD ? aiScore : 0;
  const pl =
    plagiarismMax != null && plagiarismMax >= INTEGRITY_ALERT_THRESHOLD ? plagiarismMax : 0;
  if (ai === 0 && pl === 0) return null;
  if (currentGrade == null) return null;
  const severity = Math.max(ai, pl);
  const suggested = Math.max(0, Number((currentGrade * (1 - severity)).toFixed(2)));
  const source = ai > 0 && pl > 0 ? "ambas" : ai > 0 ? "ai" : "plagio";
  return { severity, suggested, source };
}
