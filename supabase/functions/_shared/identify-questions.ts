// Identificación de preguntas desde un texto pegado por el docente.
//
// Lógica PURA (sin Deno, sin red, sin DB): la usa el modo
// `questionIdentification` de `ai-generate-questions`. Decide qué tipos se le
// pueden PROPONER al modelo según el destino, arma el tool schema, y normaliza
// lo que el modelo devolvió.
//
// INVARIANTE CROSS-FILE: `TIPOS_PROPONIBLES_POR_DESTINO` tiene una copia del
// lado del cliente en `src/modules/questions/identify-types.ts`
// (`TIPOS_ACEPTADOS_POR_DESTINO`, que es un SUPERSET porque el docente puede
// promover a mano tipos que la IA no propone). Deno no importa de `src/`, así
// que la constante se duplica; el test `src/modules/questions/identify-types.test.ts`
// IMPORTA esta constante por path relativo y falla si divergen. Si divergen, el
// edge propone un tipo que el cliente bloquea, o el cliente ofrece uno que el
// CHECK del destino rechaza → 23514 después de que el docente revisó todo.

export type IdentifyTarget = "exam" | "workshop" | "project" | "bank";
export type IdentifyLang = "es" | "en";
export type IdentifyCodeLanguage = "java" | "python" | "javascript";
export type IdentifyConfidence = "alta" | "media" | "baja";

/** Los 6 tipos que la IA puede proponer a partir de prosa. */
export type IdentifiedType =
  "abierta" | "cerrada" | "cerrada_multi" | "codigo" | "diagrama" | "bd_sql";

/**
 * Qué tipos se le OFRECEN al modelo por destino. Es también el `enum` del campo
 * `type` del tool schema: un tipo prohibido no se le ofrece.
 *
 * `project` NO lleva `bd_sql`: el taker de proyectos (`StudentProjectTaker` en
 * `src/modules/projects/ProjectFiles.tsx`) es una cadena de bloques por tipo SIN
 * fallback y sin rama `bd_sql`, así que el alumno vería el enunciado y NADA con
 * qué responder.
 *
 * Los otros 6 tipos de la plataforma quedan fuera a propósito:
 *   - `red_consola` / `red_gui`: el escenario ES la rúbrica y el repo los genera
 *     deterministamente con `generateNetworkQuestions`, sin modelo.
 *   - `codigo_zip`: PROHIBIDO en `questions` (su CHECK tiene 11 tipos) y es un
 *     entregable de proyecto entero, no una pregunta de tres líneas.
 *   - `so_consola`: no está en NINGÚN selector de autoría del producto y depende
 *     de que el operador hostee la imagen v86.
 *   - `java_gui` / `python_gui`: proponerlos desde prosa genérica es alucinación
 *     con dependencia de runner. El cliente SÍ los ofrece en su Select para que
 *     el docente promueva a mano.
 */
export const TIPOS_PROPONIBLES_POR_DESTINO = {
  exam: ["abierta", "cerrada", "cerrada_multi", "codigo", "diagrama", "bd_sql"],
  workshop: ["abierta", "cerrada", "cerrada_multi", "codigo", "diagrama", "bd_sql"],
  project: ["abierta", "cerrada", "cerrada_multi", "codigo", "diagrama"],
  bank: ["abierta", "cerrada", "cerrada_multi", "codigo", "diagrama", "bd_sql"],
} as const;

export const IDENTIFY_TARGETS: readonly IdentifyTarget[] = ["exam", "workshop", "project", "bank"];

/**
 * Guard del `target` del request. Se valida contra la lista y NO con
 * `target in TIPOS_PROPONIBLES_POR_DESTINO`: ese operador recorre el prototipo,
 * así que un `target: "toString"` pasaría el chequeo y reventaría después.
 */
export function isIdentifyTarget(v: unknown): v is IdentifyTarget {
  return typeof v === "string" && (IDENTIFY_TARGETS as readonly string[]).includes(v);
}

export const MAX_TEXT_CHARS = 20000;
export const MAX_ITEMS = 12;

const MAX_STATEMENT_CHARS = 4000;
const MIN_STATEMENT_CHARS = 10;
const MAX_REASON_CHARS = 200;
const MAX_EXCERPT_CHARS = 600;

const CODE_LANGUAGES: readonly IdentifyCodeLanguage[] = ["java", "python", "javascript"];
const CONFIDENCES: readonly IdentifyConfidence[] = ["alta", "media", "baja"];

/** `options` con la forma EXACTA de la columna `options` de la base. */
export type IdentifiedOptions =
  | { choices: string[]; correct_index: number }
  | {
      choices: string[];
      correct_indices: number[];
      min_selections?: number;
      max_selections?: number;
    }
  | { db: { setupSql: string } };

export interface IdentifiedQuestion {
  type: IdentifiedType;
  statement: string;
  rubric: string | null;
  options: IdentifiedOptions | null;
  language: IdentifyCodeLanguage | null;
  points: number;
  confidence: IdentifyConfidence;
  reason: string;
  source_excerpt: string;
  /** Presente SOLO si hubo degradación: lo que el modelo había propuesto. */
  degraded_from?: string;
}

export interface IdentifyResult {
  questions: IdentifiedQuestion[];
  discarded: { reason: string }[];
  truncated: boolean;
}

export interface NormalizeOptions {
  target: IdentifyTarget;
  codeLanguage?: IdentifyCodeLanguage;
  maxItems?: number;
  lang?: IdentifyLang;
}

// ── Mensajes al docente ────────────────────────────────────────────────────
// Van redactados en el idioma del curso porque el cliente los muestra tal cual
// (el borrador vive en memoria y no pasa por el i18n del edge).
const MSG = {
  es: {
    descartado: "Se descartó un fragmento demasiado corto para ser una pregunta.",
    tipoNoAplica:
      "El tipo propuesto no aplica a esta actividad; queda como abierta para que lo revises.",
    sinOpciones: "La IA no entregó opciones válidas; queda como abierta.",
    sinCorrectas: "La IA no marcó ninguna respuesta correcta; queda como abierta.",
    unaSolaCorrecta: "Solo había una respuesta correcta; queda como selección única.",
    sinEsquema: "La IA no entregó el esquema de partida (CREATE TABLE); queda como abierta.",
  },
  en: {
    descartado: "Discarded a fragment too short to be a question.",
    tipoNoAplica:
      "The suggested type does not apply to this activity; kept as open-ended for you to review.",
    sinOpciones: "The AI did not return valid choices; kept as open-ended.",
    sinCorrectas: "The AI did not mark any correct answer; kept as open-ended.",
    unaSolaCorrecta: "Only one correct answer was marked; kept as single choice.",
    sinEsquema: "The AI did not return the starting schema (CREATE TABLE); kept as open-ended.",
  },
} as const;

// ── Utilidades internas ────────────────────────────────────────────────────

function asString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Quita el rótulo con el que el docente numeró la pregunta cuando el modelo lo
 * arrastra al enunciado ("Pregunta 3 ¿Qué es un ADR?"). Defensivo y acotado al
 * ARRANQUE del texto: NO es el normalizador de segmentación del cliente
 * (`normalizarEnunciado`), que resuelve otro problema (emparejar bloques).
 */
function stripLeadingLabel(s: string): string {
  return s
    .replace(/^\s*(?:pregunta|question)\s*(?:n[.º°]?\s*)?\d{1,3}\s*[.:)–-]?\s*/i, "")
    .replace(/^\s*\d{1,3}\s*[.)]\s+/, "")
    .replace(/^\s*[-–•*]\s+/, "")
    .trim();
}

/**
 * Entero estricto: acepta un number o un string numérico (el modelo a veces
 * devuelve "1"), y RECHAZA todo lo demás. No usar `Number(v)` pelado para los
 * índices de opciones: `Number(null)`, `Number("")` y `Number(false)` dan 0, un
 * índice válido — se marcaría como correcta la PRIMERA opción, inventando una
 * respuesta que el modelo nunca dio.
 */
function toInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isInteger(n) ? n : null;
  }
  return null;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

/** Clamp del `maxItems` que llega por el body del request. */
export function clampMaxItems(v: unknown): number {
  return clampInt(v, 1, MAX_ITEMS, MAX_ITEMS);
}

function cleanChoices(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((c) => asString(c).trim()).filter((c) => c.length > 0);
}

function proponibles(target: IdentifyTarget): readonly string[] {
  return isIdentifyTarget(target)
    ? TIPOS_PROPONIBLES_POR_DESTINO[target]
    : TIPOS_PROPONIBLES_POR_DESTINO.exam;
}

// ── Tool schema ────────────────────────────────────────────────────────────

/**
 * Tool `identify_questions`. El `enum` de `type` se arma con el set del destino
 * (molde: `build_project_questions` de este mismo edge).
 *
 * `options` declara la UNIÓN de propiedades de todas las formas posibles a
 * propósito. Con `properties: {}` —lo que hace el tool genérico del edge— el
 * modelo no tiene dónde escribir y devuelve `{}`: ese es exactamente el bug
 * medido en producción (preguntas cerradas generadas con `options = {}`, que se
 * pintan como textarea y puntúan 0 siempre). Qué forma es válida para cada tipo
 * lo impone `normalizeIdentifiedItems`, no el schema.
 */
export function buildIdentifyTool(target: IdentifyTarget) {
  const tipos = proponibles(target);
  return {
    type: "function",
    function: {
      name: "identify_questions",
      description:
        "Devuelve una entrada por cada pregunta encontrada en el texto del docente, con el tipo de pregunta que le corresponde y lo que ese tipo necesita.",
      parameters: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: [...tipos],
                  description: "Tipo de pregunta que corresponde a este enunciado.",
                },
                statement: {
                  type: "string",
                  description:
                    "Enunciado limpio y autocontenido, sin el rótulo de numeración del texto original.",
                },
                rubric: {
                  type: "string",
                  description:
                    "Criterios concretos para considerar correcta la respuesta. Nunca vacía.",
                },
                options: {
                  type: "object",
                  description:
                    "cerrada: choices + correct_index. cerrada_multi: choices + correct_indices (y opcionalmente min_selections/max_selections). bd_sql: db.setupSql con los CREATE TABLE e INSERT de partida. abierta, codigo y diagrama: omitir.",
                  properties: {
                    choices: {
                      type: "array",
                      items: { type: "string" },
                      description: "Alternativas plausibles y mutuamente excluyentes.",
                    },
                    correct_index: {
                      type: "integer",
                      minimum: 0,
                      description: "Índice 0-based de la única opción correcta.",
                    },
                    correct_indices: {
                      type: "array",
                      items: { type: "integer", minimum: 0 },
                      description: "Índices 0-based de TODAS las opciones correctas.",
                    },
                    min_selections: { type: "integer", minimum: 1 },
                    max_selections: { type: "integer", minimum: 1 },
                    db: {
                      type: "object",
                      properties: {
                        setupSql: {
                          type: "string",
                          description:
                            "Esquema y datos de partida: los CREATE TABLE e INSERT que la base necesita antes de la consulta del estudiante.",
                        },
                      },
                      required: ["setupSql"],
                    },
                  },
                },
                language: {
                  type: "string",
                  enum: [...CODE_LANGUAGES],
                  description: "Solo para type='codigo': lenguaje en que se resuelve.",
                },
                points: {
                  type: "integer",
                  minimum: 1,
                  maximum: 100,
                  description: "Puntaje sugerido. Si el texto no lo dice, 1.",
                },
                confidence: {
                  type: "string",
                  enum: [...CONFIDENCES],
                  description:
                    "alta: el texto es inequívoco. media: hay más de una lectura razonable. baja: estás adivinando.",
                },
                reason: {
                  type: "string",
                  description:
                    "Una frase corta dirigida al docente explicando POR QUÉ ese tipo. Máximo 200 caracteres.",
                },
                source_excerpt: {
                  type: "string",
                  description: "El trozo LITERAL del texto pegado del que salió esta pregunta.",
                },
              },
              required: ["type", "statement", "rubric", "confidence", "reason", "source_excerpt"],
            },
          },
        },
        required: ["questions"],
      },
    },
  };
}

// ── System prompt ──────────────────────────────────────────────────────────

/**
 * System prompt INLINE, no un `use_case` de `ai_prompts`: el camino genérico de
 * preguntas de este mismo edge también hardcodea el suyo, así que inline es lo
 * consistente. Agregar un use_case costaría migración con la lista completa del
 * CHECK + seed platform-default + backfill per-tenant + texto byte-idéntico en
 * tres lugares + test que lee el disco.
 */
export function identifySystemPrompt(lang: IdentifyLang = "es"): string {
  if (lang === "en") {
    return [
      "You are an assessment design assistant. A teacher pastes the text of an exam, a worksheet or a set of questions, in any format, and you identify each question and which question type of the platform fits it.",
      "",
      "HARD RULES:",
      "1. One entry per question that is ACTUALLY in the text. Never invent questions the text does not contain, and never split one question into several entries. Ignore headers, titles, general instructions and any prose that is not a question.",
      "2. The text has no guaranteed format: numbering (Question 1, 1., 1), a), dashes), blank lines, multi-line statements and stray headings are all expected. Segment by meaning, not by line breaks.",
      "3. statement: a clean, self-contained statement, without the numbering label of the original text. Keep the teacher's wording and intent; fix only obvious typos.",
      "4. rubric: NEVER empty. List the concrete points a correct answer must contain. If the question has two parts (when yes / when no), the rubric covers both.",
      "5. source_excerpt: the LITERAL fragment of the pasted text this question came from, so the teacher can check it.",
      "6. reason: one short sentence for the teacher explaining why that type. Max 200 characters.",
      "",
      "HOW TO CHOOSE THE TYPE:",
      "- cerrada (single choice): the answer is ONE known, bounded item of the domain (a term, an acronym, a model, a classification). PREFER IT over open-ended in those cases, and write 3 to 5 plausible choices, real distractors from the same domain, with the correct one in correct_index. A single-choice question without choices is useless: if you cannot write plausible distractors, use abierta instead.",
      "- cerrada_multi (multiple choice): several choices are correct at the same time. Mark ALL of them in correct_indices, and never mark every choice as correct.",
      "- abierta (open-ended): the question asks to argue, compare, justify, or define with development. It is also the fallback type when no other one clearly fits.",
      "- codigo (code): the question asks to write, complete or fix source code. Set language.",
      "- diagrama (diagram): the question asks to draw or model a structure, a flow or an architecture.",
      "- bd_sql (database): the question asks for a SQL query or statement. MANDATORY: options.db.setupSql with the CREATE TABLE and INSERT statements the database needs beforehand, consistent with the question. Without that schema the exercise is useless, so if you cannot write it, use abierta.",
      "",
      "Use only the types allowed by the tool schema. Answer in English: every statement, choice and rubric in English.",
    ].join("\n");
  }
  return [
    "Eres un asistente de diseño de evaluaciones. Un docente pega el texto de un parcial, un taller o un conjunto de preguntas, en cualquier formato, y vos identificás cada pregunta y cuál de los tipos de pregunta de la plataforma le corresponde.",
    "",
    "REGLAS DURAS:",
    "1. Una entrada por cada pregunta que REALMENTE esté en el texto. Nunca inventes preguntas que el texto no contiene, y nunca partas una pregunta en varias entradas. Ignorá encabezados, títulos, instrucciones generales y cualquier prosa que no sea una pregunta.",
    "2. El texto no tiene formato garantizado: numeraciones (Pregunta 1, 1., 1), a), guiones), líneas en blanco, enunciados de varias líneas y encabezados sueltos son todos casos esperados. Segmentá por sentido, no por saltos de línea.",
    "3. statement: enunciado limpio y autocontenido, sin el rótulo de numeración del texto original. Conservá la redacción y la intención del docente; corregí solo erratas obvias.",
    "4. rubric: NUNCA vacía. Enumerá los puntos concretos que una respuesta correcta tiene que contener. Si la pregunta tiene dos partes (cuándo sí / cuándo no), la rúbrica cubre las dos.",
    "5. source_excerpt: el fragmento LITERAL del texto pegado del que salió esta pregunta, para que el docente pueda verificarlo.",
    "6. reason: una frase corta dirigida al docente explicando por qué ese tipo. Máximo 200 caracteres.",
    "",
    "CÓMO ELEGIR EL TIPO:",
    "- cerrada (selección única): la respuesta es UNA sola entre alternativas conocidas y acotadas del dominio (un término, una sigla, un modelo, una clasificación). PREFERILA sobre abierta en esos casos, y escribí de 3 a 5 opciones plausibles, distractores reales del mismo dominio, con la correcta en correct_index. Una cerrada sin opciones no sirve para nada: si no podés escribir distractores plausibles, usá abierta.",
    "- cerrada_multi (opción múltiple): varias opciones son correctas a la vez. Marcá TODAS en correct_indices, y nunca marques como correctas todas las opciones.",
    "- abierta: la pregunta pide argumentar, comparar, justificar o definir con desarrollo. Es también el tipo de respaldo cuando ningún otro encaja claramente.",
    "- codigo: la pregunta pide escribir, completar o corregir código fuente. Indicá language.",
    "- diagrama: la pregunta pide dibujar o modelar una estructura, un flujo o una arquitectura.",
    "- bd_sql (base de datos): la pregunta pide una consulta o sentencia SQL. OBLIGATORIO: options.db.setupSql con los CREATE TABLE e INSERT que la base necesita de partida, coherentes con la pregunta. Sin ese esquema el ejercicio es inútil, así que si no podés escribirlo, usá abierta.",
    "",
    "Usá solamente los tipos que permite el esquema del tool. Respondé en español: todos los enunciados, opciones y rúbricas en español.",
  ].join("\n");
}

/** Mensaje de usuario con el texto pegado (el lote ya viene recortado por el cliente). */
export function identifyUserPrompt(text: string, lang: IdentifyLang = "es"): string {
  const t = text.slice(0, MAX_TEXT_CHARS);
  if (lang === "en") {
    return [
      "Text pasted by the teacher:",
      "<text>",
      t,
      "</text>",
      "",
      "Identify every question in that text and return one entry per question.",
    ].join("\n");
  }
  return [
    "Texto pegado por el docente:",
    "<texto>",
    t,
    "</texto>",
    "",
    "Identificá todas las preguntas de ese texto y devolvé una entrada por pregunta.",
  ].join("\n");
}

// ── Escalera de validación ─────────────────────────────────────────────────

/**
 * Normaliza lo que devolvió el modelo. Regla rectora: DEGRADAR, no descartar —
 * perder el texto del docente es el peor resultado. Precedente en el mismo
 * edge: los `codigo_zip` extra de `build_project_questions` se degradan a
 * `abierta` en vez de descartarse.
 *
 * NUNCA lanza: un item basura degrada o se descarta, no revienta el lote.
 */
export function normalizeIdentifiedItems(
  rawItems: unknown,
  opts: NormalizeOptions,
): IdentifyResult {
  const lang: IdentifyLang = opts.lang === "en" ? "en" : "es";
  const msg = MSG[lang];
  const maxItems = clampMaxItems(opts.maxItems ?? MAX_ITEMS);
  const permitidos = proponibles(opts.target);
  const fallbackLanguage: IdentifyCodeLanguage = CODE_LANGUAGES.includes(
    opts.codeLanguage as IdentifyCodeLanguage,
  )
    ? (opts.codeLanguage as IdentifyCodeLanguage)
    : "java";

  const items = Array.isArray(rawItems) ? rawItems : [];
  const questions: IdentifiedQuestion[] = [];
  const discarded: { reason: string }[] = [];

  for (const rawItem of items) {
    const item = isPlainObject(rawItem) ? rawItem : {};

    // 1. statement: un fragmento demasiado corto es artefacto de segmentación,
    // no una pregunta.
    const statement = stripLeadingLabel(asString(item.statement).trim());
    if (statement.length < MIN_STATEMENT_CHARS) {
      discarded.push({ reason: msg.descartado });
      continue;
    }

    const rawType = asString(item.type).trim();
    const rawOptions = isPlainObject(item.options) ? item.options : null;
    const rawConfidence = asString(item.confidence).trim() as IdentifyConfidence;

    let type: IdentifiedType = rawType as IdentifiedType;
    let options: IdentifiedOptions | null = null;
    let language: IdentifyCodeLanguage | null = null;
    let confidence: IdentifyConfidence = CONFIDENCES.includes(rawConfidence)
      ? rawConfidence
      : "media";
    let reason = asString(item.reason).trim();
    let degradedFrom: string | undefined;

    const degradar = (desde: string, motivo: string) => {
      type = "abierta";
      options = null;
      language = null;
      degradedFrom = desde;
      confidence = "baja";
      reason = motivo;
    };

    // 2. Tipo inventado, o válido pero no proponible en este destino.
    if (!permitidos.includes(type)) {
      degradar(rawType, msg.tipoNoAplica);
    } else if (type === "cerrada") {
      // 3. Una cerrada con `options` inválido no pinta opciones, cae al textarea
      // y puntúa 0 SIEMPRE (el scoring de cerrada es determinista).
      const choices = cleanChoices(rawOptions?.choices);
      const idx = toInt(rawOptions?.correct_index);
      const idxOk = idx !== null && idx >= 0 && idx < choices.length;
      if (choices.length >= 2 && choices.length <= 6 && idxOk) {
        options = { choices, correct_index: idx };
      } else {
        degradar("cerrada", msg.sinOpciones);
      }
    } else if (type === "cerrada_multi") {
      const choices = cleanChoices(rawOptions?.choices);
      const rawIdx = Array.isArray(rawOptions?.correct_indices)
        ? (rawOptions.correct_indices as unknown[])
        : [];
      const indices: number[] = [];
      for (const v of rawIdx) {
        const n = toInt(v);
        if (n !== null && n >= 0 && n < choices.length && !indices.includes(n)) {
          indices.push(n);
        }
      }
      indices.sort((a, b) => a - b);
      const choicesOk = choices.length >= 3 && choices.length <= 8;
      if (choicesOk && indices.length >= 2 && indices.length < choices.length) {
        const base: {
          choices: string[];
          correct_indices: number[];
          min_selections?: number;
          max_selections?: number;
        } = { choices, correct_indices: indices };
        const min = toInt(rawOptions?.min_selections);
        const max = toInt(rawOptions?.max_selections);
        // min/max se conservan solo si son coherentes; NO se inventan.
        if (min !== null && max !== null && min >= 1 && min <= max && max <= choices.length) {
          base.min_selections = min;
          base.max_selections = max;
        }
        options = base;
      } else if (choicesOk && indices.length === 1) {
        // 4. Con una sola correcta es una `cerrada`, no una múltiple.
        type = "cerrada";
        options = { choices, correct_index: indices[0] };
        degradedFrom = "cerrada_multi";
        reason = msg.unaSolaCorrecta;
      } else {
        degradar("cerrada_multi", msg.sinCorrectas);
      }
    } else if (type === "bd_sql") {
      // 5. Sin `setupSql` la base PGlite arranca vacía y el ejercicio es inútil.
      const db = isPlainObject(rawOptions?.db) ? rawOptions.db : null;
      const setupSql = asString(db?.setupSql).trim();
      if (setupSql && /create\s+table/i.test(setupSql)) {
        options = { db: { setupSql } };
      } else {
        degradar("bd_sql", msg.sinEsquema);
      }
    } else if (type === "codigo") {
      // 6. El Select de lenguaje del cliente es un clic; degradar el tipo
      // perdería la intención del docente.
      const lng = asString(item.language).trim().toLowerCase() as IdentifyCodeLanguage;
      if (CODE_LANGUAGES.includes(lng)) {
        language = lng;
      } else {
        language = fallbackLanguage;
        confidence = "baja";
      }
    }

    // 7. abierta / diagrama no llevan options ni language.
    if (type === "abierta" || type === "diagrama") {
      options = null;
      language = null;
    }

    const rubric = asString(item.rubric).trim();
    const q: IdentifiedQuestion = {
      type,
      statement: statement.slice(0, MAX_STATEMENT_CHARS),
      rubric: rubric ? rubric : null,
      options,
      language,
      points: clampInt(item.points, 1, 100, 1),
      confidence,
      reason: reason.slice(0, MAX_REASON_CHARS),
      source_excerpt: asString(item.source_excerpt).trim().slice(0, MAX_EXCERPT_CHARS),
    };
    // Se recorta como los demas campos de texto (statement 4000, reason 200,
    // source_excerpt 600): cuando el modelo inventa un tipo, este string es lo
    // que el modelo quiso decir y puede venir de cualquier largo.
    if (degradedFrom !== undefined) q.degraded_from = String(degradedFrom).slice(0, 40);
    questions.push(q);
  }

  // 10. El excedente NO va a `discarded`: el cliente ya lo sabe por `truncated`.
  //     Se compara contra lo que efectivamente se deja afuera y NO contra
  //     `items.length`, que incluye los descartados por enunciado corto: con 13
  //     items donde 1 era basura quedan 12 preguntas —no se trunco nada— y el
  //     cliente mostraba igual el aviso ambar, con un numero que se contradecia.
  return {
    questions: questions.slice(0, maxItems),
    discarded,
    truncated: questions.length > maxItems,
  };
}
