/**
 * Composición del system prompt + contexto para el Asistente IA de
 * plataforma (ayuda de uso de ExamLab para el Admin).
 *
 * Pure function — sin acceso a red, sin Date.now(). Toda la entrada es
 * explícita para que sea testeable y reutilizable entre el cliente
 * (panel de prompts / preview) y el edge function (Deno).
 *
 * IMPORTANTE: este archivo debe mantenerse BYTE-IDÉNTICO en lógica con
 * `supabase/functions/platform-support-chat/support-prompt.ts` (Deno no
 * importa de `src/`). Si cambias uno, sincroniza el otro.
 *
 * Placeholders del template:
 *   {{platform_kb}}       — documentación de uso de la plataforma
 *   {{current_datetime}}  — fecha/hora actual (conciencia temporal)
 *   {{tenant_name}}       — nombre de la institución del Admin
 *   {{admin_name}}        — nombre del administrador
 */

export interface SupportPromptInput {
  /** Template del system prompt (ai_prompts.system_prompt, use_case='platform_support'). */
  template: string;
  /** Documentación de uso de la plataforma (extractos de platform_kb_docs). */
  platformKb: string;
  /** Máximo de caracteres para el bloque de KB (truncado seguro). */
  maxKbChars?: number;
  /** Fecha/hora actual ya formateada (es-CO / America/Bogota). */
  currentDatetime?: string | null;
  /** Nombre de la institución del Admin. */
  tenantName?: string | null;
  /** Nombre del administrador. */
  adminName?: string | null;
}

const DEFAULT_MAX_KB_CHARS = 22000;

/**
 * Sustituye placeholders en el template y devuelve el system prompt final.
 * Si el template no incluye un placeholder, simplemente no se inserta.
 * Si incluye uno que no tenemos data para, cae a un fallback textual.
 */
export function buildSupportSystemPrompt(input: SupportPromptInput): string {
  const maxKb = input.maxKbChars ?? DEFAULT_MAX_KB_CHARS;
  const kbBlock = truncateKb(input.platformKb ?? "", maxKb);

  const replacements: Record<string, string> = {
    platform_kb:
      kbBlock || "(No hay documentación de la plataforma disponible en este momento.)",
    current_datetime: safeText(input.currentDatetime, "(fecha no disponible)"),
    tenant_name: safeText(input.tenantName, "tu institución"),
    admin_name: safeText(input.adminName, "administrador"),
  };

  return input.template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return replacements[key] ?? `{{${key}}}`;
  });
}

/** Trunca el bloque de KB a un budget de chars con marca de corte. */
function truncateKb(text: string, maxChars: number): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).trimEnd() + "\n\n(… documentación truncada por longitud)";
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Trunca el historial a los últimos N mensajes para no exceder el
 * context window. El system prompt NO va aquí — se inyecta aparte.
 */
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

// Fallback usado solo si `ai_prompts` con use_case='platform_support' no
// tiene fila en NINGUNA capa (tenant global / platform default). No
// debería pasar — la migración 20261063000020 siembra el platform default
// + per-tenant. El texto se mantiene BYTE-IDÉNTICO con la fila sembrada,
// con el defaultPrompt del AdminPromptsPanel y con la copia del edge.
export const PLATFORM_SUPPORT_FALLBACK = `Eres el Asistente de Plataforma de ExamLab, experto en administrar y configurar la plataforma educativa ExamLab. Ayudas a {{admin_name}}, administrador de la institución {{tenant_name}}, a resolver dudas sobre cómo usar y configurar la plataforma: usuarios y roles, cursos con cortes y pesos de evaluación, exámenes, talleres, proyectos, encuestas y retos en vivo, asistencia y check-in por QR, contenidos, inteligencia artificial (calificación, generación, prompts, modelo y cola), certificados, reportes, auditoría, papelera, mensajería y soporte.

Reglas:
- Responde en español (es-CO), claro y conciso. Cuando expliques un flujo, usa pasos numerados y accionables.
- Básate ESTRICTAMENTE en la documentación de la plataforma que aparece más abajo. Si algo no está en la documentación, dilo con honestidad y sugiere abrir un ticket en el módulo Soporte al equipo de plataforma, en lugar de inventar.
- No inventes rutas, botones ni nombres de módulos que no aparezcan en la documentación.
- Cuando menciones una acción, indica en qué módulo del menú lateral se encuentra.
- Nunca pidas ni manejes contraseñas, tokens ni secretos.

Fecha y hora actual: {{current_datetime}}.

Documentación de la plataforma:
{{platform_kb}}`;
