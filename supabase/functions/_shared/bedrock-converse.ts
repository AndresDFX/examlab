/**
 * Traductor OpenAI chat-completions ↔ Bedrock Converse API — SOLO para modelos
 * Anthropic en Bedrock.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────
 * `bedrockChatUrl` (en `ai-model.ts`) pega al endpoint COMPATIBLE CON OPENAI de
 * Bedrock, y ese endpoint sirve únicamente la familia `openai.gpt-oss-*` —
 * Anthropic responde 404 ahí ("doesn't support this API"). Los modelos Claude
 * viven en la API NATIVA de Bedrock (`/converse`), que habla un formato de
 * mensajes/herramientas distinto. Sin este traductor, elegir un modelo Claude
 * en el panel lo dejaría seleccionable pero roto: la calificación con IA
 * fallaría con ese mismo 404 en cuanto un estudiante entregara algo.
 *
 * ── Por qué SÍ es viable sin reescribir todo el pipeline de IA ───────────
 * Los 11 puntos de llamada de `aiChatCompletionFailover` en producción arman
 * el payload SIEMPRE con la misma forma acotada (verificado grepeando el
 * repo, no supuesto): `messages` con `role` system/user/assistant y `content`
 * de texto plano (ningún bloque multimodal llega hasta acá — la única llamada
 * con imagen, `ai-read-groups-image`, se sustituye a Gemini ANTES si el
 * proveedor activo es Bedrock; ver `ai-vision.ts`, sin cambios), UN tool
 * fijo, y `tool_choice` SIEMPRE forzado a ESE tool (`{type:"function",
 * function:{name}}`) — nunca "auto"/"required"/"none". Traducir ESE
 * subconjunto exacto —no un traductor genérico de todo lo que la API
 * Converse soporta— es lo que mantiene el riesgo acotado sobre un camino que
 * califica entregas reales.
 *
 * ── Autenticación ─────────────────────────────────────────────────────────
 * Igual que el endpoint compatible con OpenAI: `Authorization: Bearer <API
 * key de Bedrock>`. Verificado que la Converse API acepta el mismo Bearer
 * token (acción IAM `bedrock:CallWithBearerToken`) — no hace falta firma
 * SigV4 con access key + secret.
 */

/** ¿Es un modelo de Anthropic en Bedrock? Cubre el ID base y los prefijos de
 *  inference profile cross-region (`us.`, `eu.`, `apac.`, `global.`, …) que
 *  AWS exige para uso on-demand de la mayoría de los modelos Claude. */
export function esModeloAnthropicEnBedrock(modelId: string): boolean {
  return /^(?:[a-z]{2,10}\.)?anthropic\.claude-/i.test((modelId ?? "").trim());
}

function converseUrl(region: string | null | undefined, modelId: string): string {
  const r = (region ?? "").trim() || "us-east-1";
  return `https://bedrock-runtime.${r}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
}

// deno-lint-ignore no-explicit-any
type Mensaje = { role: string; content: any };

/**
 * OpenAI → Converse. `system` sale de `messages` a un array propio (Converse
 * lo exige aparte, no como un mensaje más). `tool_choice` forzado
 * `{type:"function", function:{name}}` → `{tool:{name}}`; es el ÚNICO caso
 * que los 11 call sites usan, así que "auto"/"required"/"none" se traducen
 * defensivamente pero no están probados contra tráfico real.
 */
// deno-lint-ignore no-explicit-any
function traducirRequestAConverse(payload: Record<string, any>) {
  const systemBlocks: Array<{ text: string }> = [];
  const messages: Array<{ role: string; content: Array<{ text: string }> }> = [];
  for (const m of (payload.messages ?? []) as Mensaje[]) {
    const texto = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
    if (m.role === "system") {
      systemBlocks.push({ text: texto });
      continue;
    }
    messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: [{ text: texto }] });
  }

  // deno-lint-ignore no-explicit-any
  const body: Record<string, any> = {
    messages,
    inferenceConfig: {
      maxTokens: typeof payload.max_tokens === "number" ? payload.max_tokens : 4096,
    },
  };
  if (systemBlocks.length > 0) body.system = systemBlocks;

  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  if (tools.length > 0) {
    body.toolConfig = {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.function.name,
          description: t.function.description ?? "",
          inputSchema: { json: t.function.parameters ?? { type: "object", properties: {} } },
        },
      })),
      toolChoice: traducirToolChoice(payload.tool_choice),
    };
  }
  return body;
}

// deno-lint-ignore no-explicit-any
function traducirToolChoice(tc: any): Record<string, unknown> {
  if (tc && typeof tc === "object" && tc.type === "function" && tc.function?.name) {
    return { tool: { name: tc.function.name } };
  }
  if (tc === "required") return { any: {} };
  // "auto", "none" (Converse no tiene "none" real — degradar a auto es más
  // seguro que reventar la llamada) y cualquier otra forma no reconocida.
  return { auto: {} };
}

/**
 * Converse → OpenAI chat-completions. Los callers leen SIEMPRE
 * `choices[0].message.tool_calls[0].function.arguments` (un STRING JSON,
 * que ellos mismos parsean) o `.content` (texto) — nunca ambos a la vez en
 * el uso real, pero se devuelven los dos por si acaso.
 */
// deno-lint-ignore no-explicit-any
function traducirResponseDeConverse(json: any) {
  const bloques = json?.output?.message?.content ?? [];
  let texto = "";
  // deno-lint-ignore no-explicit-any
  const toolCalls: any[] = [];
  for (const b of bloques) {
    if (typeof b?.text === "string") texto += b.text;
    if (b?.toolUse) {
      toolCalls.push({
        id: b.toolUse.toolUseId ?? `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: b.toolUse.name,
          arguments: JSON.stringify(b.toolUse.input ?? {}),
        },
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
        finish_reason: json?.stopReason ?? "stop",
      },
    ],
  };
}

/**
 * Reemplazo de `fetch(bedrockChatUrl, ...)` para cuando el modelo es
 * Anthropic. Misma firma de retorno (`Promise<Response>`) que un `fetch`
 * normal, así que encaja tal cual en `runKeyFailover` — el resto del
 * failover/retry/rotación de keys no se entera de que hubo traducción.
 *
 * En error (status no-2xx) devuelve la Response de Converse TAL CUAL, sin
 * traducir: `describeAiError` ya sabe leer cualquier body de error de forma
 * genérica (status + snippet), y traducir un shape de error que no se
 * consume estructuralmente en ningún lado sería trabajo sin beneficio.
 */
export async function bedrockConverseFetch(
  apiKey: string,
  region: string | null | undefined,
  // deno-lint-ignore no-explicit-any
  payload: Record<string, any>,
): Promise<Response> {
  const modelId = String(payload.model ?? "");
  const url = converseUrl(region, modelId);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(traducirRequestAConverse(payload)),
  });
  if (!res.ok) return res;
  const json = await res.json();
  return new Response(JSON.stringify(traducirResponseDeConverse(json)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
