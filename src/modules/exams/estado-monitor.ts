/**
 * El estado que el monitor MUESTRA para un estudiante.
 *
 * ── Por qué es una función y no el ternario de la celda ───────────────
 * Ese estado no sale de una columna: se compone. Un intento en curso manda
 * sobre todo lo demás; y una entrega marcada `sospechoso` se muestra como
 * «chequeado» cuando el docente ya revisó lo que la disparó —la sospecha de IA
 * y todos los pares de copia en los que aparece—, aunque en la base siga
 * diciendo `sospechoso`.
 *
 * Mientras eso vivía solo dentro de la celda, filtrar por estado obligaba a
 * reescribir la misma composición en el filtro. Dos copias de una regla de tres
 * ramas divergen: el docente filtraría por «chequeado» y vería filas rojas, o
 * al revés. Es el mismo criterio por el que `desgloseEfectivo` se extrajo
 * cuando lo mostrado y lo guardado podían discrepar.
 */

export type EstadoMonitor =
  | "en_progreso"
  | "chequeado"
  | "sospechoso"
  | "completado"
  | (string & {});

export interface EntregaParaEstado {
  status: string;
  ai_review_at?: string | null;
  ai_detected_score?: number | null;
}

export interface ParDeCopia {
  user_a: string;
  user_b: string;
  reviewed_at?: string | null;
}

/** El umbral con el que una entrega queda marcada por sospecha de IA. */
export const UMBRAL_SOSPECHA_IA = 0.6;

export function estadoDeFila(opts: {
  userId: string;
  /** Intento en curso, si lo hay. Manda sobre cualquier otro estado. */
  enProgreso: boolean;
  /** El último intento finalizado. Sin él, la fila no tiene estado. */
  ultima: EntregaParaEstado | null | undefined;
  pares: readonly ParDeCopia[];
}): EstadoMonitor | null {
  if (opts.enProgreso) return "en_progreso";
  const u = opts.ultima;
  if (!u) return null;

  if (u.status === "sospechoso") {
    const misPares = opts.pares.filter(
      (p) => p.user_a === opts.userId || p.user_b === opts.userId,
    );
    const paresRevisados = misPares.every((p) => p.reviewed_at != null);
    // Si nunca hubo señal de IA no se exige su revisión: pedirla dejaría en
    // rojo para siempre a quien solo fue marcado por un par de copia.
    const sospechaIA = (u.ai_detected_score ?? 0) >= UMBRAL_SOSPECHA_IA;
    const iaRevisada = !sospechaIA || u.ai_review_at != null;
    if (iaRevisada && paresRevisados) return "chequeado";
  }
  return u.status;
}
