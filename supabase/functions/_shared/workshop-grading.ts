// Consolidación de la nota de CABECERA de una entrega de taller — PURO.
//
// Vive acá y no inline en el edge por dos razones. La primera es que el
// navegador del alumno no puede escribir estas columnas (candado
// `tg_guard_workshop_submission_grade`), así que la fórmula tiene que ser del
// servidor. La segunda es que el trigger SQL
// `tg_workshop_answer_graded_recompute` calcula LO MISMO, y hasta ahora los dos
// producían resultados distintos (`ai_revisado` sin `final_grade` vs
// `calificado` con `final_grade`), o sea que el estado final de una entrega
// dependía de cuál corriera último.
//
// INVARIANTE: `patchCabeceraTaller` y el UPDATE de
// `supabase/migrations/20260956000000_workshop_grade_recompute_robust_and_backfill.sql`
// deben producir el MISMO resultado. Si cambia uno, cambia el otro.

export const ESCALA_POR_DEFECTO = 100;

/**
 * Escala del taller. `max_score` NULL o ≤ 0 cae a 100, igual que el
 * `COALESCE(_max, 100)` del trigger SQL.
 */
export function escalaDeTaller(maxScore: number | null | undefined): number {
  const raw = Number(maxScore) || 0;
  return raw > 0 ? raw : ESCALA_POR_DEFECTO;
}

export interface PreguntaParaConsolidar {
  id: string;
  type: string;
  points: number | null;
}

export interface ConsolidadoTaller {
  totalPoints: number;
  totalEarned: number;
  finalGrade: number;
  calificadas: number;
  faltanIA: number;
}

/**
 * Suma los puntos ganados sobre el TOTAL del taller (las preguntas sin nota
 * cuentan 0) y lo escala a `max_score`.
 *
 * `faltanIA` cuenta solo las preguntas que la IA DEBE calificar y todavía no
 * tienen nota — las deterministas nunca bloquean el cierre (mismo criterio que
 * el `_pending` del trigger SQL).
 */
export function consolidarNotaTaller(input: {
  questions: PreguntaParaConsolidar[];
  notasPorPregunta: Map<string, number | null>;
  maxScore: number | null | undefined;
}): ConsolidadoTaller {
  const { questions, notasPorPregunta } = input;
  let totalPoints = 0;
  let totalEarned = 0;
  let calificadas = 0;
  let faltanIA = 0;

  for (const q of questions) {
    const pts = Math.max(0, Number(q.points) || 0);
    totalPoints += pts;
    const nota = notasPorPregunta.get(q.id);
    if (nota === null || nota === undefined) {
      if (q.type !== "cerrada" && q.type !== "cerrada_multi") faltanIA++;
      continue;
    }
    calificadas++;
    totalEarned += Math.max(0, Math.min(pts, Number(nota) || 0));
  }

  const scale = escalaDeTaller(input.maxScore);
  const finalGrade =
    totalPoints > 0 ? Number(((totalEarned / totalPoints) * scale).toFixed(2)) : 0;

  return { totalPoints, totalEarned, finalGrade, calificadas, faltanIA };
}

/**
 * Patch para `workshop_submissions`. Reglas:
 *   - `ai_grade` / `ai_feedback` se refrescan siempre (son de la IA).
 *   - `final_grade` solo cuando no falta nada por calificar, y respetando el
 *     override manual del docente (final_grade ≠ ai_grade previo).
 *   - `status` nunca degrada una decisión humana (`calificado`) ni una marca de
 *     revisión (`requiere_revision`, `sospechoso`).
 */
export function patchCabeceraTaller(input: {
  finalGrade: number;
  faltanIA: number;
  calificadas: number;
  total: number;
  statusActual: string | null;
  aiGradeActual: number | null;
  finalGradeActual: number | null;
  lang: "es" | "en";
}): Record<string, unknown> {
  const { finalGrade, faltanIA, calificadas, total, statusActual, lang } = input;

  const summary =
    lang === "en"
      ? `AI graded ${calificadas} of ${total} question(s).`
      : `La IA calificó ${calificadas} de ${total} pregunta(s).`;

  const patch: Record<string, unknown> = { ai_grade: finalGrade, ai_feedback: summary };

  if (faltanIA === 0) {
    const previo = input.finalGradeActual;
    const aiPrevio = input.aiGradeActual;
    patch.final_grade =
      previo === null || previo === undefined
        ? finalGrade
        : aiPrevio !== null && aiPrevio !== undefined && Number(previo) === Number(aiPrevio)
          ? finalGrade
          : previo;
    if (statusActual === null || statusActual === "entregado" || statusActual === "ai_revisado") {
      patch.status = "calificado";
    }
  }

  return patch;
}
