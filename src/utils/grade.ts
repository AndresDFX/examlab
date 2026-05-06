/**
 * Grade aggregation helpers. Shared between the teacher monitor (which writes
 * per-question manual overrides) and the student review (which reads them).
 */

export interface QuestionPoints {
  id: string;
  points: number;
}

export interface BreakdownItem {
  qid: string;
  points: number;
  earned: number;
  feedback?: string;
}

export interface ManualOverride {
  score: number;
  feedback?: string;
}

/**
 * Computes the 0-10 final grade from question points, AI breakdown, and
 * teacher manual overrides. Overrides take precedence over AI scores per
 * question; missing per-question data is treated as 0.
 *
 * Returns `null` when no question has any known score so the UI can render
 * "—" instead of "0".
 */
export function computeFinalGrade(
  questions: QuestionPoints[],
  breakdown: BreakdownItem[],
  overrides: Record<string, ManualOverride>,
  gradeScaleMax: number = 10,
): number | null {
  if (!questions.length) return null;

  const breakdownById = new Map(breakdown.map((b) => [b.qid, b]));
  let totalPoints = 0;
  let earned = 0;
  let hasAny = false;

  for (const q of questions) {
    totalPoints += Number(q.points) || 0;
    const override = overrides[q.id];
    if (override) {
      earned += Number(override.score) || 0;
      hasAny = true;
      continue;
    }
    const b = breakdownById.get(q.id);
    if (b) {
      earned += Number(b.earned) || 0;
      hasAny = true;
    }
  }

  if (!hasAny || totalPoints <= 0) return null;
  return Number(((earned / totalPoints) * gradeScaleMax).toFixed(2));
}

// ─────────────────────────────────────────────────────────────────────────────
// Course-level hierarchy: Curso → Cortes → [Items, Asistencia]
//
// MODELO DE PESOS (post-migración 20260507100000):
//   - cut.weight = % de la nota final que aporta el corte (cortes suman 100).
//   - exam.weight, workshop.weight, project.weight = % de la nota final del
//     curso para ese item. La suma de items + attendance_weight de un corte
//     debe ser igual a cut.weight (validación soft).
//   - cut.attendance_weight = % de la nota final para la asistencia del corte.
//   - Items sin datos NO penalizan: sus pesos se reescalan entre los items
//     que sí tienen score, dentro de su corte y entre cortes.
//
// LEGACY: cut.exam_weight / workshop_weight / project_weight ya no se usan.
// Quedan en la DB como 0 tras la migración para no romper queries antiguas.
// ─────────────────────────────────────────────────────────────────────────────

export interface GradedItem {
  /** Peso del item como % de la nota final (0..100). */
  weight: number;
  /** Nota del item ya escalada al rango del curso, o null si no hay dato. */
  score: number | null;
}

/**
 * Promedio ponderado robusto: items con score null se omiten y sus
 * pesos se redistribuyen entre los items que sí tienen score. Sirve
 * tanto para calcular la nota de UN corte (pasando solo items del
 * corte + entry de asistencia) como la nota FINAL del curso (pasando
 * todos los items + todas las asistencias).
 *
 * Retorna null cuando no hay items con score (UI muestra "—" en vez de 0).
 */
export function computeWeightedGrade(items: readonly GradedItem[]): number | null {
  const usable = items.filter((i) => i.score != null && Number(i.weight) > 0);
  if (usable.length === 0) return null;
  const totalWeight = usable.reduce((a, i) => a + Number(i.weight), 0);
  if (totalWeight <= 0) return null;
  const sum = usable.reduce((a, i) => a + Number(i.score) * Number(i.weight), 0);
  return Number((sum / totalWeight).toFixed(2));
}

export interface CutWeights {
  workshop: number;
  exam: number;
  project: number;
  attendance: number;
}

export interface CutComponentScores {
  workshop: number | null;
  exam: number | null;
  project: number | null;
  attendance: number | null;
}

export interface CutResult {
  /** Peso del corte respecto a la nota final del curso (0..100). */
  weight: number;
  /** Nota del corte ya calculada (en la escala del curso) o null si sin datos. */
  grade: number | null;
}

/**
 * Calcula la nota de UN corte a partir de los promedios de cada componente
 * (ya escalados a la escala del curso) y los pesos de ese corte.
 *
 * - Componentes con score `null` se omiten y sus pesos se redistribuyen
 *   proporcionalmente entre los componentes que sí tienen score.
 * - Si todos los componentes son null o la suma de pesos efectiva es 0,
 *   retorna null.
 */
export function computeCutGrade(
  scores: CutComponentScores,
  weights: CutWeights,
): number | null {
  const entries: { score: number; weight: number }[] = [];
  if (scores.workshop != null && Number(weights.workshop) > 0) {
    entries.push({ score: Number(scores.workshop), weight: Number(weights.workshop) });
  }
  if (scores.exam != null && Number(weights.exam) > 0) {
    entries.push({ score: Number(scores.exam), weight: Number(weights.exam) });
  }
  if (scores.project != null && Number(weights.project) > 0) {
    entries.push({ score: Number(scores.project), weight: Number(weights.project) });
  }
  if (scores.attendance != null && Number(weights.attendance) > 0) {
    entries.push({ score: Number(scores.attendance), weight: Number(weights.attendance) });
  }
  if (entries.length === 0) return null;
  const totalWeight = entries.reduce((a, b) => a + b.weight, 0);
  if (totalWeight <= 0) return null;
  const weighted = entries.reduce((a, b) => a + b.score * b.weight, 0);
  return Number((weighted / totalWeight).toFixed(2));
}

/**
 * Calcula la nota final del curso sumando ponderadamente los cortes.
 * Cortes con `grade` null o `weight` 0 se ignoran (sus pesos se reescalan).
 * Retorna null si no hay cortes con datos.
 */
export function computeCourseFinalGrade(cuts: CutResult[]): number | null {
  const usable = cuts.filter((c) => c.grade != null && Number(c.weight) > 0);
  if (usable.length === 0) return null;
  const totalWeight = usable.reduce((a, c) => a + Number(c.weight), 0);
  if (totalWeight <= 0) return null;
  const weighted = usable.reduce((a, c) => a + Number(c.grade) * Number(c.weight), 0);
  return Number((weighted / totalWeight).toFixed(2));
}

