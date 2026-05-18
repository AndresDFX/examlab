// Copia del builder en src/lib/tutor-prompt.ts.
// Deno no puede importar de `src/`, mantener en sync manualmente.

export interface TutorPromptInput {
  template: string;
  courseName: string;
  courseDescription?: string | null;
  contentTopics?: readonly string[];
  maxTopicsChars?: number;
}

const DEFAULT_MAX_TOPICS_CHARS = 4000;

export function buildTutorSystemPrompt(input: TutorPromptInput): string {
  const maxChars = input.maxTopicsChars ?? DEFAULT_MAX_TOPICS_CHARS;
  const topicsBlock = formatTopics(input.contentTopics ?? [], maxChars);

  const replacements: Record<string, string> = {
    course_name: safeText(input.courseName, "el curso"),
    course_description: safeText(
      input.courseDescription,
      "(El docente no proporcionó descripción del curso.)",
    ),
    course_content_topics: topicsBlock || "(Aún no hay material generado.)",
  };

  return input.template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return replacements[key] ?? `{{${key}}}`;
  });
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
