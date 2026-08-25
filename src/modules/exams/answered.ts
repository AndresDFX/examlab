/**
 * ¿El estudiante respondió esta pregunta? Fuente ÚNICA, pura y testeable.
 *
 * ── Por qué existe: había DOS predicados y se contradecían ────────────
 * El mismo concepto estaba implementado dos veces, con reglas OPUESTAS:
 *
 *   · `isQuestionAnswered` dentro de `app.student.take.$examId.tsx` (examen)
 *   · `getUnansweredNumbers` dentro de `WorkshopQuestions.tsx` (taller)
 *
 * En una pregunta de CÓDIGO cuyo contenido es exactamente la plantilla:
 * el examen la contaba como **respondida**; el taller, como **en blanco**. Y el
 * comentario del taller explica por qué su regla es la correcta: sin esa
 * detección, un alumno que pulsa Entregar **sin tocar el editor** pasaba el
 * chequeo (la plantilla es truthy) y entregaba en 0 **sin ninguna advertencia**.
 * O sea: el taller ya había arreglado un bug que el examen todavía tenía.
 *
 * Este módulo unifica las dos, quedándose con la regla mejor de cada tipo. Las
 * elecciones no obvias, y por qué:
 *
 *   · `codigo` / `java_gui` / `python_gui` → gana el TALLER: contenido igual a
 *     la plantilla es NO respondida. Arregla el examen.
 *   · `bd_sql` → gana el TALLER (`isSqlAnswerBlank`). El examen caía al chequeo
 *     genérico de string, y como la respuesta SQL se serializa a un JSON que
 *     nunca queda vacío, un alumno que escribió y borró contaba como respondida.
 *   · `so_consola` → gana el TALLER (`isV86AnswerBlank`). El examen ni lo
 *     contemplaba, aunque es un tipo válido de examen desde la mig 20261280000000.
 *   · `cerrada` → gana el EXAMEN (`typeof v === "number" && v >= 0`). La
 *     respuesta es el ÍNDICE de la opción; el chequeo del taller acepta
 *     cualquier cosa que no sea vacío, así que un string suelto pasaría.
 *   · `red_consola` → gana el EXAMEN: exige historial de comandos, no solo una
 *     topología parseable. En una pregunta de CONSOLA, no haber tecleado ningún
 *     comando es no haber respondido.
 *
 * ── Qué NO hace ───────────────────────────────────────────────────────
 * No mira las claves de metadatos de `answers` (`__session_id`, `__current_idx`,
 * `__warning_events`, `__breakdown`, `__manual_overrides`…): recorre las
 * PREGUNTAS y busca cada `q.id`. Contar sobre `Object.keys(answers)` daría de
 * más desde el primer render, porque `__session_id` se inyecta al abrir el
 * examen, antes de que el alumno responda nada.
 *
 * ── Nota sobre el orden ───────────────────────────────────────────────
 * El examen baraja las preguntas por alumno (`seededShuffle`), así que los
 * ÍNDICES que devuelve `getUnansweredIndices` son posiciones del array barajado
 * de ESE alumno y no sirven para cruzar con el orden del docente. El CONTEO sí
 * es independiente del orden — por eso el monitor usa `countAnswered`, nunca los
 * índices.
 */
import { parseNetworkAnswer } from "@/modules/network/scenario";
import { isSqlAnswerBlank } from "@/modules/database/sql-answer";
import { isV86AnswerBlank } from "@/modules/serverconsole/v86-answer";
import {
  getStarterCode,
  JAVA_GUI_STARTER,
  JAVAFX_STARTER,
  PYTHON_GUI_STARTER,
} from "@/modules/code/starters";

/** Lo mínimo que el predicado necesita de una pregunta. */
export interface QuestionForAnswered {
  id: string;
  type: string;
  options?: unknown;
  starter_code?: string | null;
  language?: string | null;
}

/**
 * Plantilla que el alumno VE en el editor cuando la pregunta no trae
 * `starter_code`. Tiene que coincidir con lo que el editor pinta, o una
 * pregunta sin tocar se leería como respondida.
 */
export function defaultStarterFor(q: QuestionForAnswered): string {
  // `?? "java"` para coincidir con lo que el editor PINTA cuando la pregunta no
  // tiene lenguaje (`app.student.take.$examId.tsx`: `q.language ?? "java"`).
  // Sin esto, en una pregunta legacy con `language` NULL el alumno ve la
  // plantilla de Java, el predicado compara contra "" y la plantilla intacta
  // vuelve a contar como respondida — la regla quedaba sin efecto justo ahí.
  if (q.type === "codigo") return getStarterCode(q.language ?? "java") || "";
  if (q.type === "python_gui") return PYTHON_GUI_STARTER;
  if (q.type === "java_gui") {
    const fw =
      (q.options as { java_framework?: "swing" | "javafx" } | null)?.java_framework ?? "swing";
    return fw === "javafx" ? JAVAFX_STARTER : JAVA_GUI_STARTER;
  }
  return "";
}

/** ¿Hay contenido de código que el alumno haya escrito de verdad? */
function codigoRespondido(q: QuestionForAnswered, v: unknown): boolean {
  const escrito = (typeof v === "string" ? v : "").trim();
  if (!escrito) return false;
  // La plantilla intacta NO cuenta. Es la regla del taller, y la que arregla el
  // caso del alumno que entrega sin abrir el editor.
  const plantilla = (q.starter_code ?? "").trim() || defaultStarterFor(q).trim();
  return plantilla === "" || escrito !== plantilla;
}

/** ¿La pregunta `q` está respondida dentro del objeto `answers`? */
export function isQuestionAnswered(
  q: QuestionForAnswered,
  answers: Record<string, unknown>,
): boolean {
  const v = answers[q.id];
  switch (q.type) {
    case "cerrada":
      return typeof v === "number" && v >= 0;
    case "cerrada_multi": {
      if (!Array.isArray(v) || v.length === 0) return false;
      const min = Number((q.options as { min_selections?: unknown } | null)?.min_selections);
      if (Number.isFinite(min) && min > 0 && v.length < min) return false;
      return true;
    }
    case "codigo":
    case "java_gui":
    case "python_gui":
      return codigoRespondido(q, v);
    case "codigo_zip":
      // Solo aparece en proyectos, pero se contempla para que el predicado sirva
      // a cualquier consumidor sin caer al chequeo genérico de string.
      if (Array.isArray(v)) return v.length > 0;
      if (v && typeof v === "object" && "size" in (v as Record<string, unknown>)) {
        return Number((v as { size?: unknown }).size) > 0;
      }
      return false;
    case "bd_sql":
      return !isSqlAnswerBlank(v);
    case "so_consola":
      // El sobre v86 (`{"v86":1,…}`) es lo que guarda el TALLER, que sí tiene el
      // componente de consola. La pantalla de EXAMEN no lo renderiza —cae al
      // textarea genérico— así que ahí la respuesta es un string plano que
      // `isV86AnswerBlank` no parsea y daría por en blanco, invirtiendo una
      // respuesta correcta. Se acepta cualquiera de las dos formas.
      if (typeof v === "string" && v.trim().length > 0) return true;
      return !isV86AnswerBlank(v);
    case "red_consola": {
      const parsed = parseNetworkAnswer(v);
      return (
        !!parsed && Object.values(parsed.histories).some((h) => Array.isArray(h) && h.length > 0)
      );
    }
    case "red_gui":
      // GUI: respondida cuando hay una topología parseable (el alumno la editó).
      return !!parseNetworkAnswer(v);
    default:
      return typeof v === "string" && v.trim().length > 0;
  }
}

/** Posiciones (0-based) de las preguntas SIN responder, en el orden recibido. */
export function getUnansweredIndices(
  questions: QuestionForAnswered[],
  answers: Record<string, unknown>,
): number[] {
  const out: number[] = [];
  questions.forEach((q, i) => {
    if (!isQuestionAnswered(q, answers)) out.push(i);
  });
  return out;
}

/** Cuántas respondió. Independiente del orden — lo que el monitor necesita. */
export function countAnswered(
  questions: QuestionForAnswered[],
  answers: Record<string, unknown> | null | undefined,
): number {
  if (!answers || typeof answers !== "object") return 0;
  return questions.reduce((n, q) => n + (isQuestionAnswered(q, answers) ? 1 : 0), 0);
}
