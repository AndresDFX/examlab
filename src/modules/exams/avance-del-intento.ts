import { countAnswered, type QuestionForAnswered } from "./answered";

/**
 * Cuánto lleva un estudiante en su intento, para la columna «Respondidas» del
 * monitor.
 *
 * Lo que mide el avance es cuántas RESPONDIÓ, no en qué posición está parado:
 * con «mezclar preguntas» cada estudiante tiene su propio orden, y en
 * navegación libre puede ir y volver. Quien está en la 2 pudo haberlas
 * contestado todas; quien está en la 10, solo tres. Por eso la posición es un
 * dato secundario, y cuando el orden es propio del estudiante se dice: su
 * «pregunta 12» no es la 12 del docente.
 *
 * `respondidas` usa el mismo predicado que el aviso de entrega en blanco
 * (`countAnswered`), así que no depende del orden. Durante el intento cuenta lo
 * último que llegó a la base: el examen guarda al cambiar de pregunta (y cada
 * minuto si hay cambios), así que puede ir algo atrás de la pantalla del alumno.
 */
export interface AvanceDelIntento {
  respondidas: number;
  total: number;
  enBlanco: number;
  /** Pregunta en la que está parado (1-based), en SU orden. Null si el intento
   *  no está en curso o no hay dato. */
  posicion: number | null;
  /** La posición es del orden propio del estudiante (mezcla activada), no la
   *  numeración que ve el docente. */
  ordenPropio: boolean;
}

export function avanceDelIntento(
  questions: QuestionForAnswered[],
  answers: Record<string, unknown> | null | undefined,
  opciones: { enCurso: boolean; mezcla: boolean },
): AvanceDelIntento {
  const total = questions.length;
  const respondidas = countAnswered(questions, answers ?? null);
  const idx = answers?.__current_idx;
  const posicion =
    opciones.enCurso && total > 0 && typeof idx === "number" && Number.isFinite(idx) && idx >= 0
      ? Math.min(Math.floor(idx) + 1, total)
      : null;
  return {
    respondidas,
    total,
    enBlanco: Math.max(0, total - respondidas),
    posicion,
    ordenPropio: opciones.mezcla,
  };
}
