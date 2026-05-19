/**
 * Helpers de scoring para tipos de pregunta calificables sin IA.
 *
 * cerrada (single):
 *   correct_index: number → todo-o-nada.
 *
 * cerrada_multi (opción múltiple):
 *   correct_indices: number[] → proporcional positivo SIN penalización.
 *   El estudiante recibe (correctas_marcadas / total_correctas) * puntos.
 *   Las opciones incorrectas marcadas NO restan.
 *
 * Estos helpers viven en el cliente para preview y se replican en el
 * edge function `ai-grade-submission` (Deno no puede importar de src/).
 * Si cambias la lógica aquí, sincroniza con el branch correspondiente
 * en supabase/functions/ai-grade-submission/index.ts.
 */

export interface CerradaMultiOptions {
  /** Lista de opciones marcadas por el estudiante (índices 0..n). */
  selected: readonly number[];
  /** Lista de opciones correctas configuradas en la pregunta. */
  correctIndices: readonly number[];
  /** Puntaje máximo de la pregunta. */
  totalPoints: number;
  /** Mínimo de marcadas requerido para considerar respondida (opcional). */
  minSelections?: number;
  /** Máximo de marcadas permitido (opcional). */
  maxSelections?: number;
}

export interface CerradaMultiResult {
  /** Puntaje obtenido entre 0 y totalPoints, redondeado a 2 decimales. */
  earned: number;
  /** True si la respuesta cumple min/max y tiene al menos 1 correcta. */
  isAnswered: boolean;
  /** True si excedió maxSelections (puntaje = 0 en ese caso). */
  exceededMax: boolean;
  /** True si no llegó a minSelections (puntaje = 0 en ese caso). */
  belowMin: boolean;
}

/**
 * Calcula el puntaje de una pregunta de opción múltiple (cerrada_multi).
 *
 * Reglas:
 *   - Si `selected.length === 0`: earned=0, isAnswered=false.
 *   - Si excede maxSelections: earned=0, exceededMax=true (no se cuentan correctas).
 *   - Si está bajo minSelections: earned=0, belowMin=true.
 *   - Si correctIndices está vacío: earned=0 (config inválida del docente).
 *   - earned = (correctas_marcadas / total_correctas) * totalPoints, redondeado.
 *   - Las opciones incorrectas marcadas NO restan (proporcional positivo).
 */
export function scoreCerradaMulti(opts: CerradaMultiOptions): CerradaMultiResult {
  const selected = dedupNumbers(opts.selected);
  const correct = new Set(dedupNumbers(opts.correctIndices));
  const totalCorrect = correct.size;
  const totalPoints = Math.max(0, Number(opts.totalPoints) || 0);
  const minSel = opts.minSelections != null ? Math.max(0, Number(opts.minSelections)) : 0;
  const maxSel = opts.maxSelections != null ? Math.max(0, Number(opts.maxSelections)) : Infinity;

  const empty = selected.length === 0;
  const belowMin = !empty && selected.length < minSel;
  const exceededMax = selected.length > maxSel;
  const invalidConfig = totalCorrect === 0 || totalPoints === 0;

  if (empty || belowMin || exceededMax || invalidConfig) {
    return {
      earned: 0,
      isAnswered: !empty && !belowMin && !exceededMax,
      exceededMax,
      belowMin,
    };
  }

  let correctMatched = 0;
  for (const sel of selected) {
    if (correct.has(sel)) correctMatched++;
  }

  const ratio = correctMatched / totalCorrect;
  const earned = Number((ratio * totalPoints).toFixed(2));

  return {
    earned,
    isAnswered: true,
    exceededMax: false,
    belowMin: false,
  };
}

/**
 * Valida que las marcadas del estudiante respeten min/max.
 * Usado por la UI antes de "Siguiente" o "Entregar" para mostrar feedback.
 */
export function validateCerradaMultiSelection(
  selectedCount: number,
  minSelections: number | undefined,
  maxSelections: number | undefined,
): { ok: true } | { ok: false; reason: "below_min" | "above_max"; min?: number; max?: number } {
  if (minSelections != null && selectedCount < minSelections) {
    return { ok: false, reason: "below_min", min: minSelections };
  }
  if (maxSelections != null && selectedCount > maxSelections) {
    return { ok: false, reason: "above_max", max: maxSelections };
  }
  return { ok: true };
}

function dedupNumbers(arr: readonly number[]): number[] {
  return Array.from(new Set(arr.filter((n) => typeof n === "number" && !Number.isNaN(n))));
}
