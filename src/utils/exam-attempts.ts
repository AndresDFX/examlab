/**
 * Cálculo de la nota efectiva de un examen cuando el estudiante hizo
 * múltiples intentos. El modo se decide en `exams.retry_mode`:
 *
 *  - "last":     toma el intento más reciente (comportamiento histórico)
 *  - "average":  promedia las notas de todos los intentos finalizados
 *  - "highest":  toma la mejor nota entre los intentos
 *
 * Convenciones:
 *  - "Intentos finalizados" = status `completado` o `sospechoso`.
 *    Los `en_progreso` se ignoran para la nota efectiva.
 *  - Para cada intento se prefiere `final_override_grade` sobre `ai_grade`.
 *  - Si no hay ningún intento con nota, devuelve `null`.
 */

export type RetryMode = "last" | "average" | "highest";

export interface AttemptForGrade {
  status?: string | null;
  ai_grade: number | null;
  final_override_grade: number | null;
  created_at: string;
}

const FINAL_STATUSES = new Set(["completado", "sospechoso"]);

const effective = (a: AttemptForGrade): number | null =>
  a.final_override_grade ?? a.ai_grade ?? null;

export function computeAttemptGrade(
  attempts: AttemptForGrade[],
  mode: RetryMode,
): number | null {
  if (!attempts?.length) return null;

  const finished = attempts.filter((a) =>
    a.status == null ? true : FINAL_STATUSES.has(a.status),
  );
  if (!finished.length) return null;

  const withGrade = finished.filter((a) => effective(a) != null);
  if (!withGrade.length) return null;

  if (mode === "average") {
    const sum = withGrade.reduce((acc, a) => acc + (effective(a) as number), 0);
    return Math.round((sum / withGrade.length) * 100) / 100;
  }

  if (mode === "highest") {
    return withGrade.reduce(
      (best, a) => Math.max(best, effective(a) as number),
      Number.NEGATIVE_INFINITY,
    );
  }

  // "last": el más reciente por created_at
  const sorted = [...withGrade].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  return effective(sorted[0]);
}

export function retryModeLabel(mode: RetryMode): string {
  switch (mode) {
    case "average":
      return "Promedio";
    case "highest":
      return "Más alto";
    case "last":
    default:
      return "Último intento";
  }
}
