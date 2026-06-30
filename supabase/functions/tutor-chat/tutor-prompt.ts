// Copia del builder en src/lib/tutor-prompt.ts.
// Deno no puede importar de `src/`, mantener en sync manualmente.

export interface TutorPromptInput {
  template: string;
  courseName: string;
  courseDescription?: string | null;
  contentTopics?: readonly string[];
  maxTopicsChars?: number;
  /** Texto crudo del material del curso (md/pptx-source/txt) — ver src/. */
  courseMaterial?: string | null;
  maxMaterialChars?: number;
  /** Fecha/hora actual ya formateada (es-CO / America/Bogota) — ver src/. */
  currentDatetime?: string | null;
}

const DEFAULT_MAX_TOPICS_CHARS = 4000;
const DEFAULT_MAX_MATERIAL_CHARS = 16000;

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
    course_description: safeText(
      input.courseDescription,
      "(El docente no proporcionó descripción del curso.)",
    ),
    course_content_topics: topicsValue,
    course_content_material:
      materialBlock || "(El docente no ha cargado material con texto legible aún.)",
    current_datetime: safeText(input.currentDatetime, "(fecha no disponible)"),
  };

  return input.template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return replacements[key] ?? `{{${key}}}`;
  });
}

function truncateMaterial(text: string, maxChars: number): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).trimEnd() + "\n\n(… material truncado por longitud)";
}

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
  return messages.slice(-maxMessages);
}

function safeText(s: string | null | undefined, fallback: string): string {
  const t = (s ?? "").trim();
  return t.length > 0 ? t : fallback;
}

function formatTopics(topics: readonly string[], maxChars: number): string {
  const lines = topics
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => `- ${t}`);
  if (lines.length === 0) return "";
  let result = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (result.length + line.length + 1 > maxChars) {
      // Conteo sobre `lines` (ya sin blancos) y el índice actual. Antes usaba
      // topics.length (incluía títulos en blanco) menos result.split, lo que
      // sobrecontaba "N temas más".
      result += `\n- (… ${lines.length - i} temas más, truncados por longitud)`;
      break;
    }
    result += (result ? "\n" : "") + line;
  }
  return result;
}
