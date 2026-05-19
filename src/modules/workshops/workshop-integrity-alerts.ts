/**
 * Helpers puros para calcular el resumen de integridad de UNA entrega
 * de taller (workshop submission): cuántas sospechas de IA y de copia
 * tiene, y cuántas siguen pendientes de revisar.
 *
 * Vivían como derivaciones inline dentro del modal de talleres. Las
 * extraje al promover el resumen agregado al header de cada estudiante
 * (badge "X pendientes" + color destacado de la card).
 */

/** Una sospecha de IA por pregunta. */
export interface AiSignalLike {
  /** Probabilidad 0..1 de que la respuesta sea generada por IA. */
  score: number;
  /** Timestamp ISO si el docente ya la marcó como revisada. */
  reviewedAt: string | null;
}

/** Un par de copia detectado para una pregunta del estudiante. */
export interface CopyPairLike {
  /** Score 0..1 de similitud con el peer. */
  score: number;
  /** Timestamp ISO si el docente ya lo marcó como revisado. */
  reviewedAt: string | null;
}

/** Umbral mínimo para considerar una señal "fuerte" (mostrar el badge).
 *  Por debajo lo tratamos como ruido y no entra al conteo. Coincide con
 *  el threshold que usa el monitor de exámenes y el render por pregunta
 *  de talleres. */
export const INTEGRITY_SIGNAL_THRESHOLD = 0.6;

export interface IntegrityAlertCounts {
  /** Sospechas de IA con score ≥ threshold. */
  aiTotal: number;
  /** Sospechas de IA NO revisadas (todavía no decidió el docente). */
  aiPending: number;
  /** Pares de copia con score ≥ threshold. */
  copyTotal: number;
  /** Pares de copia NO revisados. */
  copyPending: number;
  /** Total de alertas pendientes (aiPending + copyPending). Cuando >0,
   *  la UI marca al estudiante en rojo/ámbar para llamar la atención. */
  totalPending: number;
  /** True si HAY alguna alerta (revisada o no) — útil para decidir si
   *  mostrar un badge informativo "ya revisaste todo". */
  hasAny: boolean;
}

/**
 * Cuenta y clasifica las alertas de integridad de UNA submission a
 * partir de sus señales IA (por pregunta) y pares de copia.
 *
 * Solo cuenta señales que superen `INTEGRITY_SIGNAL_THRESHOLD` — un
 * score de IA de 0.3 no es relevante y no debería disparar el badge.
 */
export function computeWorkshopAlerts(
  aiSignals: Iterable<AiSignalLike>,
  copyPairs: Iterable<CopyPairLike>,
): IntegrityAlertCounts {
  let aiTotal = 0;
  let aiPending = 0;
  for (const sig of aiSignals) {
    if (sig.score < INTEGRITY_SIGNAL_THRESHOLD) continue;
    aiTotal += 1;
    if (sig.reviewedAt == null) aiPending += 1;
  }
  let copyTotal = 0;
  let copyPending = 0;
  for (const p of copyPairs) {
    if (p.score < INTEGRITY_SIGNAL_THRESHOLD) continue;
    copyTotal += 1;
    if (p.reviewedAt == null) copyPending += 1;
  }
  return {
    aiTotal,
    aiPending,
    copyTotal,
    copyPending,
    totalPending: aiPending + copyPending,
    hasAny: aiTotal + copyTotal > 0,
  };
}
