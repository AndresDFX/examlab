/**
 * Traductor OpenAI chat-completions ↔ Bedrock `InvokeModel` con el formato NATIVO de Anthropic
 * (Messages API), solo para modelos Claude y solo para llamadas que llevan imágenes o PDF.
 *
 * ── Por qué no Converse ───────────────────────────────────────────────────
 * El resto de las llamadas a Claude van por Converse (`bedrock-converse.ts`), pero Converse trata un
 * PDF como texto extraído: para que Claude VEA las páginas —un mockup exportado, un prototipo, un
 * diagrama— hay que activar citas, y no hay otra forma (lo documenta Anthropic: «Visual PDF analysis
 * requires citations to be enabled» en Converse; «InvokeModel API: full control over PDF processing
 * without forced citations»). Con InvokeModel y el formato de Anthropic, imágenes y PDF se mandan
 * como bloques `image` y `document`, y las páginas se leen como texto e imagen.
 *
 * ── Qué traduce ───────────────────────────────────────────────────────────
 * El mismo subconjunto acotado que Converse: `system` + mensajes de usuario/asistente, UN tool y
 * `tool_choice` forzado a ese tool. Las partes de contenido que entiende son las que arma
 * `adjuntos-zip.ts`: `text`, `image_url` con data URL y `file` con un PDF en data URL. La misma clave
 * de Bedrock (Bearer) sirve para InvokeModel y para Converse.
 *
 * Es TypeScript puro (solo `fetch`/`Response`): lo prueban los tests desde `src/`.
 */

// deno-lint-ignore no-explicit-any
type Payload = Record<string, any>;

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/is;
const IMAGEN_ANTHROPIC = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** ¿El payload lleva imágenes o archivos? Solo esas llamadas cambian de API. */
export function tieneContenidoMultimodal(payload: Payload): boolean {
  for (const m of (payload?.messages ?? []) as Array<{ content?: unknown }>) {
    if (!Array.isArray(m?.content)) continue;
    for (const p of m.content as Array<{ type?: string }>) {
      if (p?.type === "image_url" || p?.type === "file") return true;
    }
  }
  return false;
}

// deno-lint-ignore no-explicit-any
function bloqueDeParte(p: any): Record<string, unknown> | null {
  if (p?.type === "text") {
    const t = typeof p.text === "string" ? p.text : "";
    // Anthropic rechaza un bloque de texto vacío.
    return t.trim() ? { type: "text", text: t } : null;
  }
  if (p?.type === "image_url") {
    const m = DATA_URL.exec(String(p.image_url?.url ?? ""));
    if (m && IMAGEN_ANTHROPIC.has(m[1].toLowerCase())) {
      return { type: "image", source: { type: "base64", media_type: m[1].toLowerCase(), data: m[2] } };
    }
    return null;
  }
  if (p?.type === "file") {
    const m = DATA_URL.exec(String(p.file?.file_data ?? ""));
    if (m && m[1].toLowerCase() === "application/pdf") {
      const titulo = typeof p.file?.filename === "string" ? p.file.filename.slice(0, 200) : undefined;
      return {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: m[2] },
        ...(titulo ? { title: titulo } : {}),
      };
    }
    return null;
  }
  return { type: "text", text: JSON.stringify(p ?? "") };
}

/** OpenAI → cuerpo de InvokeModel para Claude. */
export function traducirAMensajesAnthropic(payload: Payload): Record<string, unknown> {
  const system: string[] = [];
  const messages: Array<{ role: string; content: Array<Record<string, unknown>> }> = [];
  for (const m of (payload.messages ?? []) as Array<{ role: string; content: unknown }>) {
    if (m.role === "system") {
      system.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""));
      continue;
    }
    const content = Array.isArray(m.content)
      ? (m.content.map(bloqueDeParte).filter(Boolean) as Array<Record<string, unknown>>)
      : [{ type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") }];
    if (content.length === 0) continue;
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content });
  }

  const body: Record<string, unknown> = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: typeof payload.max_tokens === "number" ? payload.max_tokens : 4096,
    messages,
  };
  if (system.length > 0) body.system = system.join("\n\n");
  if (typeof payload.temperature === "number") body.temperature = payload.temperature;

  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.length > 0) {
    body.tools = tools.map((t: { function: { name: string; description?: string; parameters?: unknown } }) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    }));
    body.tool_choice = traducirToolChoice(payload.tool_choice);
  }
  return body;
}

// deno-lint-ignore no-explicit-any
function traducirToolChoice(tc: any): Record<string, unknown> {
  if (tc && typeof tc === "object" && tc.type === "function" && tc.function?.name) {
    return { type: "tool", name: tc.function.name };
  }
  if (tc === "required") return { type: "any" };
  return { type: "auto" };
}

/** Respuesta de Anthropic → forma de chat-completions (la misma que devuelve `bedrock-converse.ts`). */
// deno-lint-ignore no-explicit-any
export function traducirRespuestaAnthropic(json: any): Record<string, unknown> {
  let texto = "";
  // deno-lint-ignore no-explicit-any
  const toolCalls: any[] = [];
  for (const b of json?.content ?? []) {
    if (b?.type === "text" && typeof b.text === "string") texto += b.text;
    if (b?.type === "tool_use") {
      toolCalls.push({
        id: b.id ?? `call_${toolCalls.length}`,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: texto || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: json?.stop_reason ?? "stop",
      },
    ],
  };
}

/**
 * Reemplazo de `fetch` para una llamada multimodal a Claude en Bedrock. Misma forma de retorno que un
 * `fetch`, así encaja en `runKeyFailover` igual que `bedrockConverseFetch`. Un error del proveedor se
 * devuelve tal cual, sin traducir.
 */
export async function bedrockAnthropicInvokeFetch(
  apiKey: string,
  region: string | null | undefined,
  payload: Payload,
): Promise<Response> {
  const r = (region ?? "").trim() || "us-east-1";
  const modelId = String(payload.model ?? "");
  const res = await fetch(
    `https://bedrock-runtime.${r}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(traducirAMensajesAnthropic(payload)),
    },
  );
  if (!res.ok) return res;
  const json = await res.json();
  return new Response(JSON.stringify(traducirRespuestaAnthropic(json)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
