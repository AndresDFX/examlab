/**
 * Calificación DETERMINISTA en el CLIENTE — las preguntas que no necesitan
 * modelo (cerrada, opción múltiple, red).
 *
 * ── Por qué existe ────────────────────────────────────────────────────
 * El re-grade del docente ("Calificar todo con IA") NO manda `submissionId`
 * al edge, así que el servidor no escribe nada: la nota la calcula y la
 * persiste el navegador. Ese camino tenía la nota de las cerradas puesta a
 * mano en `earned: 0` con el comentario "correct_index match" — y la
 * comparación NUNCA existió. Resultado medido en producción: una respuesta
 * correcta (`selected_option="2"` con `correct_index=2`) quedaba en 0 cada
 * vez que el docente recalificaba, mientras el camino del alumno —que sí
 * pasa por el servidor— le daba el puntaje completo. La misma entrega valía
 * distinto según quién apretara el botón.
 *
 * Este módulo NO reimplementa ninguna fórmula: dispatcha a las que ya
 * existen (`scoreCerradaSingle`, `scoreCerradaMulti`, `gradeNetwork`) y
 * aporta lo que faltaba — de DÓNDE sale la respuesta del alumno y cómo se
 * interpreta el índice.
 *
 * ── INVARIANTE CROSS-FILE ─────────────────────────────────────────────
 * Espeja `supabase/functions/_shared/deterministic-scoring.ts` (Deno no
 * importa de `src/`, por eso son dos archivos). Si cambia la fórmula o el
 * set de tipos deterministas en uno, cambiar el otro: si divergen, la misma
 * entrega recibe una nota distinta según si la calificó el servidor (camino
 * del alumno / la cola) o el navegador del docente — que es exactamente el
 * bug que este módulo vino a cerrar.
 *
 * El TEXTO del feedback no vive acá a propósito: el edge lo emite en es/en
 * con un par hardcodeado porque no puede leer los locales, pero el cliente
 * sí puede, así que este módulo devuelve un `outcome` estructurado y la
 * pantalla lo traduce con `t(...)`. Las cadenas resultantes deben coincidir
 * con las del edge para que el alumno no lea dos redacciones del mismo
 * resultado.
 */
import { scoreCerradaMulti, scoreCerradaSingle } from "@/modules/exams/question-scoring";
import { gradeNetwork } from "@/modules/network/grading";
import { parseNetworkAnswer, parseScenario } from "@/modules/network/scenario";

export type TipoDeterminista = "cerrada" | "cerrada_multi" | "red_consola" | "red_gui";

const TIPOS_DETERMINISTAS: readonly string[] = [
  "cerrada",
  "cerrada_multi",
  "red_consola",
  "red_gui",
];

/** ¿Este tipo se califica sin IA? Mismo set que el edge. */
export function esDeterminista(type: string): boolean {
  return TIPOS_DETERMINISTAS.includes(type);
}

/**
 * Índice de opción "utilizable". Acepta number y string numérica porque las
 * DOS formas viven en producción: el examen guarda `answers` en JSONB
 * (números) y el taller guarda `selected_option` como TEXT (`String(raw)`).
 *
 * Éste es el detalle exacto que hace que NO se pueda llamar a
 * `scoreCerradaSingle` con el valor crudo del taller: esa función exige
 * `typeof === "number"` en los dos lados (guard deliberado contra el
 * `undefined === undefined` que regalaba el puntaje completo), así que con
 * el `"2"` del taller devuelve 0 para TODAS las cerradas. Se normaliza acá y
 * se le pasan números.
 */
export function parseOptionIndex(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Lista de índices marcados, desde un array o desde su JSON serializado. */
export function parseOptionIndices(v: unknown): number[] {
  let arr: unknown = v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return [];
    try {
      arr = JSON.parse(s);
    } catch {
      // No es JSON: puede ser un índice suelto ("2") de una fila legacy.
      const one = parseOptionIndex(s);
      return one === null ? [] : [one];
    }
  }
  if (!Array.isArray(arr)) {
    const one = parseOptionIndex(arr);
    return one === null ? [] : [one];
  }
  const out: number[] = [];
  for (const raw of arr) {
    const n = parseOptionIndex(raw);
    if (n !== null) out.push(n);
  }
  return Array.from(new Set(out));
}

/** Columnas de respuesta de `workshop_submission_answers`. */
export interface FilaRespuestaTaller {
  answer_text?: string | null;
  selected_option?: string | null;
  code_content?: string | null;
  diagram_code?: string | null;
}

/**
 * De DÓNDE sale la respuesta del alumno según el tipo de pregunta.
 *
 * INVARIANTE con el submit del alumno (`WorkshopQuestions.tsx`, el `payload`
 * por tipo): `cerrada` se guarda en `selected_option`, pero `cerrada_multi`
 * se guarda en **`answer_text`** como JSON. Leer `selected_option` para las
 * dos —el error natural, porque el nombre de la columna lo sugiere— deja la
 * opción múltiple SIEMPRE vacía y por lo tanto SIEMPRE en 0. Se aceptan las
 * dos columnas en ambos sentidos para tolerar filas viejas.
 */
export function respuestaCrudaDeTaller(type: string, fila: FilaRespuestaTaller | undefined): unknown {
  if (!fila) return null;
  if (type === "cerrada") return fila.selected_option ?? fila.answer_text ?? null;
  if (type === "cerrada_multi") return fila.answer_text ?? fila.selected_option ?? null;
  if (type === "red_consola" || type === "red_gui") return fila.answer_text ?? null;
  return fila.code_content ?? fila.diagram_code ?? fila.answer_text ?? null;
}

export interface PreguntaDeterminista {
  type: string;
  points: number | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: any;
}

/**
 * Resultado estructurado: `earned` es la nota y `outcome` dice POR QUÉ, para
 * que la pantalla arme el texto con i18n en vez de recibirlo hardcodeado.
 */
export type ResultadoDeterminista = { earned: number } & (
  | { outcome: "correcta" }
  | { outcome: "incorrecta" }
  | { outcome: "sin_respuesta" }
  | { outcome: "supera_maximo"; max: number }
  | { outcome: "bajo_minimo"; min: number }
  | { outcome: "parcial"; total: number }
  // `detalle` es `null` cuando el escenario no trae aserciones (raro, pero
  // posible: el docente armó una red sin nada que verificar) — sin este
  // caso, `join("\n")` de una lista vacía da `""` y una cadena vacía se lee
  // como "no hay feedback", cuando en realidad SÍ hubo calificación de red.
  | { outcome: "red"; detalle: string | null }
);

/**
 * Califica una pregunta determinista. Espejo de `scoreDeterministic` del
 * edge; un tipo no determinista devuelve 0 / `sin_respuesta`.
 */
export function scoreDeterministaCliente(
  q: PreguntaDeterminista,
  rawAnswer: unknown,
): ResultadoDeterminista {
  const pts = Math.max(0, Number(q.points) || 0);

  if (q.type === "cerrada") {
    const given = parseOptionIndex(rawAnswer);
    if (given === null) return { earned: 0, outcome: "sin_respuesta" };
    const correctIdx = parseOptionIndex(q.options?.correct_index);
    // Se delega la fórmula (todo-o-nada + guards) a la función existente; acá
    // solo se normalizan los índices para que su guard de tipo no la descarte.
    const earned = scoreCerradaSingle(given, correctIdx, pts);
    // `earned > 0` no alcanza como criterio de "acertó": una pregunta que vale
    // 0 puntos acierta y suma 0. Se compara contra el índice correcto.
    const acerto = correctIdx !== null && given === correctIdx;
    return acerto ? { earned, outcome: "correcta" } : { earned: 0, outcome: "incorrecta" };
  }

  if (q.type === "cerrada_multi") {
    const selected = parseOptionIndices(rawAnswer);
    if (selected.length === 0) return { earned: 0, outcome: "sin_respuesta" };
    const correctIndices = Array.isArray(q.options?.correct_indices)
      ? parseOptionIndices(q.options.correct_indices)
      : [];
    const minSel =
      typeof q.options?.min_selections === "number" ? q.options.min_selections : undefined;
    const maxSel =
      typeof q.options?.max_selections === "number" ? q.options.max_selections : undefined;
    const r = scoreCerradaMulti({
      selected,
      correctIndices,
      totalPoints: pts,
      minSelections: minSel,
      maxSelections: maxSel,
    });
    if (r.exceededMax) return { earned: 0, outcome: "supera_maximo", max: maxSel ?? 0 };
    if (r.belowMin) return { earned: 0, outcome: "bajo_minimo", min: minSel ?? 0 };
    return { earned: r.earned, outcome: "parcial", total: pts };
  }

  if (q.type === "red_consola" || q.type === "red_gui") {
    const scenario = parseScenario(q.options);
    const answer = parseNetworkAnswer(rawAnswer);
    if (!scenario || !answer) return { earned: 0, outcome: "sin_respuesta" };
    try {
      const result = gradeNetwork(
        { topology: answer.topology, histories: answer.histories },
        scenario.assertions,
      );
      const earned = Math.round(result.ratio * pts * 100) / 100;
      // MIRROR: el edge usa el mismo `|| null` (allá, `|| txt(...)` con el
      // texto ya resuelto porque no tiene i18n; acá se resuelve en la
      // pantalla) para el caso de un escenario sin aserciones.
      const detalle =
        result.items
          .map((it) => `${it.passed ? "✓" : "✗"} ${it.label}${it.detail ? ` — ${it.detail}` : ""}`)
          .join("\n") || null;
      return { earned, outcome: "red", detalle };
    } catch {
      // Una respuesta de red malformada de UNA pregunta no puede abortar la
      // calificación de toda la entrega — mismo aislamiento que el edge.
      return { earned: 0, outcome: "sin_respuesta" };
    }
  }

  return { earned: 0, outcome: "sin_respuesta" };
}
