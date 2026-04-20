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
  return Number(((earned / totalPoints) * 10).toFixed(2));
}
