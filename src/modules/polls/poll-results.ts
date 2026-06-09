/**
 * Helper PURO para el render de resultados de encuesta (ResultsDialog del
 * docente). Extraído para poder testear la regla del porcentaje/barra sin
 * montar el componente (que hace fetch a Supabase).
 *
 * Regla clave (bug reportado): en encuestas de CUPO (`slot`) la barra/% deben
 * medir el LLENADO DEL CUPO de la opción (responses_count / max_responses),
 * NO la cuota sobre el total de votos. Así una opción con cupo lleno (ej.
 * 1/1) se ve al 100% (completa, barra llena), no al 20%. En `single` /
 * `multiple` sí medimos la cuota sobre el total de respuestas.
 */
export type PollTypeForResults = "single" | "multiple" | "slot";

export interface OptionFillArgs {
  pollType: PollTypeForResults;
  responsesCount: number;
  /** Cupo de la opción (solo aplica a slot). null en single/multiple. */
  maxResponses: number | null;
  /** Total de respuestas de la encuesta (para la cuota en single/multiple). */
  totalResponses: number;
}

export interface OptionFill {
  /** Porcentaje para la barra + etiqueta (0..100). */
  pct: number;
  /** Solo slot: el cupo está lleno (responses_count >= max_responses). */
  full: boolean;
  /** Si mostrar el "· N%" (en slot requiere cupo > 0; en otros, total > 0). */
  showPct: boolean;
}

export function optionFillPercent(args: OptionFillArgs): OptionFill {
  const { pollType, responsesCount, maxResponses, totalResponses } = args;
  if (pollType === "slot") {
    const cap = maxResponses ?? 0;
    const pct = cap > 0 ? Math.min(100, Math.round((responsesCount / cap) * 100)) : 0;
    return { pct, full: cap > 0 && responsesCount >= cap, showPct: cap > 0 };
  }
  const pct = totalResponses > 0 ? Math.round((responsesCount / totalResponses) * 100) : 0;
  return { pct, full: false, showPct: totalResponses > 0 };
}
