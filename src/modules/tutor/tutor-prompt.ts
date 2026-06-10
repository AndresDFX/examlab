/**
 * Composición del system prompt + contexto para el Tutor IA.
 *
 * Pure function — sin acceso a red, sin Date.now(). Toda la entrada
 * es explícita para que sea testeable y reutilizable entre el cliente
 * (preview en debug) y el edge function (Deno).
 *
 * Sintaxis de placeholders en el template:
 *   {{course_name}}            — nombre del curso
 *   {{course_description}}     — descripción
 *   {{course_content_topics}}  — lista de temas (uno por línea, con guión)
 *   {{course_content_material}} — extractos del TEXTO real del material
 *   {{current_datetime}}       — fecha/hora actual (conciencia temporal)
 */

export interface TutorPromptInput {
  /** Template del system prompt (de ai_prompts.system_prompt con use_case='tutor_chat'). */
  template: string;
  courseName: string;
  courseDescription?: string | null;
  /** Títulos de contenidos generados disponibles. Se serializan como lista. */
  contentTopics?: readonly string[];
  /** Máximo de caracteres para el bloque de topics (truncado seguro). */
  maxTopicsChars?: number;
  /**
   * Texto crudo del material del curso (extractos de los archivos md /
   * pptx-source / txt de generated_contents). Permite al tutor responder
   * citando el CONTENIDO real, no solo los títulos. El edge lo arma
   * concatenando los `files[].body` por documento.
   */
  courseMaterial?: string | null;
  /** Máximo de caracteres para el bloque de material (truncado seguro). */
  maxMaterialChars?: number;
  /**
   * Fecha/hora actual ya formateada (es-CO / America/Bogota). El edge la
   * calcula con `Intl.DateTimeFormat` y la pasa acá para dar CONCIENCIA
   * TEMPORAL al tutor (responder "cuándo es el examen", "cuántos días
   * faltan", etc.). Pure function: NO usamos `new Date()` aquí — el caller
   * inyecta el valor para que sea testeable y determinístico.
   */
  currentDatetime?: string | null;
}

const DEFAULT_MAX_TOPICS_CHARS = 4000;
const DEFAULT_MAX_MATERIAL_CHARS = 16000;

/**
 * Sustituye placeholders en el template y devuelve el system prompt final.
 * Si el template no incluye un placeholder, simplemente no se inserta —
 * el docente personalizó y quiere otro orden. Si incluye uno que no
 * tenemos data para, queda como "(sin información)" para no romper.
 *
 * Material del curso: el placeholder dedicado es `{{course_content_material}}`.
 * Pero los templates ya sembrados (ai_prompts) y los overrides del docente
 * solo conocen `{{course_content_topics}}`. Para que el CONTENIDO siempre
 * llegue al modelo sin re-sembrar la DB, cuando el template NO contiene el
 * placeholder de material lo plegamos dentro del bloque de topics.
 */
export function buildTutorSystemPrompt(input: TutorPromptInput): string {
  const maxChars = input.maxTopicsChars ?? DEFAULT_MAX_TOPICS_CHARS;
  const topicsBlock = formatTopics(input.contentTopics ?? [], maxChars);
  const maxMat = input.maxMaterialChars ?? DEFAULT_MAX_MATERIAL_CHARS;
  const materialBlock = truncateMaterial(input.courseMaterial ?? "", maxMat);

  const hasMaterialPlaceholder = /\{\{course_content_material\}\}/.test(input.template);

  let topicsValue = topicsBlock || "(Aún no hay material generado.)";
  if (materialBlock && !hasMaterialPlaceholder) {
    topicsValue =
      (topicsBlock || "(Sin títulos de contenido.)") +
      "\n\n## Extractos del material del curso\n" +
      materialBlock;
  }

  const replacements: Record<string, string> = {
    course_name: safeText(input.courseName, "el curso"),
    course_description: safeText(input.courseDescription, "(El docente no proporcionó descripción del curso.)"),
    course_content_topics: topicsValue,
    course_content_material: materialBlock || "(El docente no ha cargado material con texto legible aún.)",
    current_datetime: safeText(input.currentDatetime, "(fecha no disponible)"),
  };

  return input.template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return replacements[key] ?? `{{${key}}}`;
  });
}

/** Trunca el bloque de material a un budget de chars con marca de corte. */
function truncateMaterial(text: string, maxChars: number): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).trimEnd() + "\n\n(… material truncado por longitud)";
}

/**
 * Trunca el historial a los últimos N mensajes para no exceder el
 * context window. Mantiene el primer mensaje user (suele ser el más
 * informativo) + los últimos N-1 para preservar la coherencia local.
 *
 * El system prompt NO va aquí — se inyecta aparte.
 */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function truncateHistory(
  messages: readonly ChatMessage[],
  maxMessages: number,
): ChatMessage[] {
  if (maxMessages <= 0 || messages.length <= maxMessages) {
    return messages.slice();
  }
  // Conservamos los últimos N. No tratamos de preservar el primero
  // explícitamente — la IA ve el system prompt en cada turno, eso es
  // suficiente para mantener el rol.
  return messages.slice(-maxMessages);
}

/**
 * Estima los tokens aproximados de un texto (heurística: ~4 chars/token).
 * NO es exacto — sirve para validar antes de mandar a la IA y evitar
 * llamadas que claramente excederán el límite.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Helpers internos ──────────────────────────────────────────────

function safeText(s: string | null | undefined, fallback: string): string {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : fallback;
}

function formatTopics(topics: readonly string[], maxChars: number): string {
  if (topics.length === 0) return "";
  const lines = topics
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `- ${t}`);
  let result = "";
  for (const line of lines) {
    if (result.length + line.length + 1 > maxChars) {
      result += `\n- (… ${topics.length - result.split("\n").length} temas más, truncados por longitud)`;
      break;
    }
    result += (result ? "\n" : "") + line;
  }
  return result;
}
