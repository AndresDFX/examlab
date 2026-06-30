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
//   - Items sin score CUENTAN COMO CERO usando su peso original (NO se
//     reescalan). Eso refleja la realidad: lo que el estudiante DEBE y
//     todavía no entregó/no tiene nota es nota perdida hasta que aparezca.
//     Solo retornamos null (UI muestra "—") cuando NINGÚN item del set
//     tiene score — ahí no hay nada que mostrar.
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
 * Promedio ponderado: items con score null cuentan como 0 con su peso
 * original (no se reescalan). Sirve tanto para calcular la nota de UN
 * corte (pasando solo items del corte + entry de asistencia) como la
 * nota FINAL del curso (pasando todos los items + todas las asistencias).
 *
 * Retorna null cuando ningún item tiene score (UI muestra "—" en vez
 * de 0 — el estudiante todavía no tiene NADA calificado en el set).
 */
export function computeWeightedGrade(items: readonly GradedItem[]): number | null {
  const withWeight = items.filter((i) => Number(i.weight) > 0);
  if (withWeight.length === 0) return null;
  const hasAnyScore = withWeight.some((i) => i.score != null);
  if (!hasAnyScore) return null;
  const totalWeight = withWeight.reduce((a, i) => a + Number(i.weight), 0);
  if (totalWeight <= 0) return null;
  const sum = withWeight.reduce(
    (a, i) => a + (i.score != null ? Number(i.score) : 0) * Number(i.weight),
    0,
  );
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
 * y los pesos de ese corte.
 *
 * - Componentes con score `null` cuentan como 0 con su peso original (NO
 *   se reescalan). Eso refleja la realidad del estudiante.
 * - Si TODOS los componentes son null, retorna null (no hay nada que mostrar).
 */
export function computeCutGrade(
  scores: CutComponentScores,
  weights: CutWeights,
): number | null {
  const entries: { score: number | null; weight: number }[] = [
    { score: scores.workshop, weight: Number(weights.workshop) },
    { score: scores.exam, weight: Number(weights.exam) },
    { score: scores.project, weight: Number(weights.project) },
    { score: scores.attendance, weight: Number(weights.attendance) },
  ].filter((e) => e.weight > 0);
  if (entries.length === 0) return null;
  const hasAnyScore = entries.some((e) => e.score != null);
  if (!hasAnyScore) return null;
  const totalWeight = entries.reduce((a, e) => a + e.weight, 0);
  if (totalWeight <= 0) return null;
  const weighted = entries.reduce(
    (a, e) => a + (e.score != null ? Number(e.score) : 0) * e.weight,
    0,
  );
  return Number((weighted / totalWeight).toFixed(2));
}

/**
 * Calcula la nota final del curso sumando ponderadamente los cortes.
 * Cortes con `grade` null cuentan como 0 con su peso original (no se
 * reescalan). Cortes con weight 0 se ignoran. Retorna null solo si NINGÚN
 * corte tiene grade.
 */
export function computeCourseFinalGrade(cuts: CutResult[]): number | null {
  const withWeight = cuts.filter((c) => Number(c.weight) > 0);
  if (withWeight.length === 0) return null;
  const hasAnyGrade = withWeight.some((c) => c.grade != null);
  if (!hasAnyGrade) return null;
  const totalWeight = withWeight.reduce((a, c) => a + Number(c.weight), 0);
  if (totalWeight <= 0) return null;
  const weighted = withWeight.reduce(
    (a, c) => a + (c.grade != null ? Number(c.grade) : 0) * Number(c.weight),
    0,
  );
  return Number((weighted / totalWeight).toFixed(2));
}

/**
 * ¿Un `status` de attendance_records cuenta como "presente" para la nota de
 * asistencia? Decisión de producto (2026-06-30): una llegada 'tarde' SÍ cuenta
 * (el alumno asistió). INVARIANTE cross-file: debe coincidir con el filtro del
 * acta SQL (`generate_course_acta`: status IN ('presente','tarde')) y con
 * report-context.ts (boletín). Usar este helper en TODA cuenta de asistencia
 * del front (gradebook consolidado + por-corte, vista del estudiante) para no
 * volver a divergir.
 */
export function countsAsPresent(status: string | null | undefined): boolean {
  return status === "presente" || status === "tarde";
}

/**
 * Escala un porcentaje de asistencia [0..1] al rango de la escala del curso
 * [min..max]: `min + pct*(max-min)`. INVARIANTE cross-file: el acta SQL y
 * report-context DEBEN usar la misma fórmula (antes usaban `pct*max`, que
 * ignora el min y subestima la asistencia en escalas que no empiezan en 0).
 */
export function scaleAttendance(pct: number, scaleMin: number, scaleMax: number): number {
  return scaleMin + pct * (scaleMax - scaleMin);
}

