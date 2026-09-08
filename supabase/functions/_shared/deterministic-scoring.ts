// Calificación DETERMINISTA de preguntas — sin IA.
//
// Este módulo existe para que el SERVIDOR sea el único que decide la nota de
// las preguntas que no necesitan modelo (cerradas, opción múltiple, red). Antes
// vivía inline en el modo examen de `ai-grade-submission` y duplicado en el
// navegador del alumno (`WorkshopQuestions.tsx`), que es justo lo que hacía
// posible que el alumno se pusiera la nota: el candado nuevo de
// `workshop_submission_answers` le prohíbe escribir `ai_grade`, así que la nota
// determinista también tiene que salir de acá.
//
// INVARIANTE: espeja `src/modules/exams/question-scoring.ts` (cliente). Si
// cambia la fórmula de una de las dos, cambiar la otra.
import { gradeNetwork } from "./network/grading.ts";
import { parseScenario, parseNetworkAnswer } from "./network/scenario.ts";

export type TipoDeterminista = "cerrada" | "cerrada_multi" | "red_consola" | "red_gui";

const TIPOS_DETERMINISTAS: readonly string[] = [
  "cerrada",
  "cerrada_multi",
  "red_consola",
  "red_gui",
];

export function esDeterminista(type: string): boolean {
  return TIPOS_DETERMINISTAS.includes(type);
}

export interface PreguntaDeterminista {
  id: string;
  type: string;
  points: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: any;
  starter_code?: string | null;
}

export interface ResultadoDeterminista {
  earned: number;
  feedback: string;
}

/**
 * Índice de opción "utilizable". Acepta number y string numérica porque las
 * dos formas viven en producción: el examen guarda `answers` en JSONB (números)
 * y el taller guarda `selected_option` como TEXT (`String(raw)`). Un helper que
 * solo aceptara `number` pondría 0 a TODAS las cerradas de todos los talleres
 * sin que nada se queje.
 */
function indiceFinito(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Respuesta "vacía": nada, whitespace, o el starter_code intacto del docente. */
export function esRespuestaVacia(
  q: { starter_code?: string | null },
  userAnswer: unknown,
): boolean {
  const trimmedAnswer = typeof userAnswer === "string" ? userAnswer.trim() : "";
  const trimmedStarter = typeof q.starter_code === "string" ? q.starter_code.trim() : "";
  if (typeof userAnswer === "string") {
    if (trimmedAnswer === "") return true;
    return trimmedStarter !== "" && trimmedAnswer === trimmedStarter;
  }
  if (userAnswer === null || userAnswer === undefined) return true;
  if (Array.isArray(userAnswer)) return userAnswer.length === 0;
  return false;
}

function txt(lang: "es" | "en", es: string, en: string): string {
  return lang === "en" ? en : es;
}

export function scoreDeterministic(
  q: PreguntaDeterminista,
  userAnswer: unknown,
  lang: "es" | "en" = "es",
): ResultadoDeterminista {
  const pts = Math.max(0, Number(q.points) || 0);

  if (q.type === "cerrada") {
    // GUARD (fix auditoría): exigir que AMBOS lados sean índices finitos. Sin
    // esto, una `cerrada` con correct_index ausente + sin responder daba
    // `undefined === undefined` → puntaje completo por una pregunta en blanco.
    const correctIdx = indiceFinito(q.options?.correct_index);
    const given = indiceFinito(userAnswer);
    const ok = correctIdx !== null && given !== null && given === correctIdx;
    return {
      earned: ok ? pts : 0,
      feedback: ok
        ? txt(lang, "Respuesta correcta", "Correct answer")
        : txt(lang, "Respuesta incorrecta", "Incorrect answer"),
    };
  }

  if (q.type === "cerrada_multi") {
    // Proporcional positivo SIN penalización: earned = (aciertos / correctas) * puntos.
    const correctIndices: number[] = Array.isArray(q.options?.correct_indices)
      ? q.options.correct_indices
          .map((n: unknown) => indiceFinito(n))
          .filter((n: number | null): n is number => n !== null)
      : [];
    const selectedRaw: number[] = Array.isArray(userAnswer)
      ? userAnswer
          .map((n: unknown) => indiceFinito(n))
          .filter((n: number | null): n is number => n !== null)
      : [];
    const selected = Array.from(new Set(selectedRaw));
    const correctSet = new Set(correctIndices);
    const minSel = typeof q.options?.min_selections === "number" ? q.options.min_selections : 0;
    const maxSel =
      typeof q.options?.max_selections === "number" ? q.options.max_selections : Infinity;

    if (selected.length === 0) {
      return { earned: 0, feedback: txt(lang, "Sin respuesta", "No answer") };
    }
    if (selected.length > maxSel) {
      return {
        earned: 0,
        feedback: txt(
          lang,
          `Marcaste más opciones de las permitidas (máximo ${maxSel}).`,
          `You selected more options than allowed (maximum ${maxSel}).`,
        ),
      };
    }
    if (selected.length < minSel) {
      return {
        earned: 0,
        feedback: txt(
          lang,
          `Marcaste menos opciones de las requeridas (mínimo ${minSel}).`,
          `You selected fewer options than required (minimum ${minSel}).`,
        ),
      };
    }
    let got = 0;
    if (correctSet.size > 0 && pts > 0) {
      let matched = 0;
      for (const s of selected) if (correctSet.has(s)) matched++;
      got = Number(((matched / correctSet.size) * pts).toFixed(2));
    }
    return {
      earned: got,
      feedback: txt(lang, `Obtuviste ${got} de ${pts} puntos.`, `You earned ${got} of ${pts} points.`),
    };
  }

  if (q.type === "red_consola" || q.type === "red_gui") {
    const scenario = parseScenario(q.options);
    const answer = parseNetworkAnswer(userAnswer);
    if (!scenario || !answer) {
      return { earned: 0, feedback: txt(lang, "Sin respuesta", "No answer") };
    }
    // Aislar el grading: una respuesta malformada de UNA pregunta de red no
    // debe abortar la calificación de toda la entrega.
    try {
      const result = gradeNetwork(
        { topology: answer.topology, histories: answer.histories },
        scenario.assertions,
      );
      const got = Math.round(result.ratio * pts * 100) / 100;
      const fb =
        result.items
          .map((it) => `${it.passed ? "✓" : "✗"} ${it.label}${it.detail ? ` — ${it.detail}` : ""}`)
          .join("\n") || txt(lang, "Calificación de red", "Network grading");
      return { earned: got, feedback: fb };
    } catch (netErr) {
      const detail = netErr instanceof Error ? netErr.message : String(netErr);
      return {
        earned: 0,
        feedback: txt(
          lang,
          `Error al evaluar la respuesta de red: ${detail}`,
          `Error while evaluating the network answer: ${detail}`,
        ),
      };
    }
  }

  return { earned: 0, feedback: txt(lang, "Sin respuesta", "No answer") };
}
