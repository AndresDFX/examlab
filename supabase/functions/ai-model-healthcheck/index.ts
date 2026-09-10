/**
 * Edge Function: ai-model-healthcheck
 *
 * "Probar conexión" del panel Configuración → Modelo IA. El admin está
 * armando la config (provider/modelo/key) ANTES de guardarla — este edge le
 * confirma si esa combinación funciona de verdad, sin tener que esperar a
 * que un estudiante entregue algo y descubrir recién ahí que la key estaba
 * mal o el modelo no existe.
 *
 * Por qué es un edge aparte y no un botón que reusa `getActiveAiModel()`:
 * la key que se está probando puede ser una que TODAVÍA no está guardada en
 * `ai_model_settings` (el admin la acaba de pegar en el input). No hay nada
 * que leer de la base — el cliente manda la key en el body.
 *
 * Reusa `chatCompletionUrlFor` (mismo módulo que usan los 7 edges de IA de
 * producción, `_shared/ai-model.ts`) para que la URL de cada proveedor —y
 * sus mismos matices ya resueltos ahí (el endpoint compatible con OpenAI de
 * Bedrock, el prefijo /openai/ de Gemini)— salga IDÉNTICA al camino real.
 * Lo que NO reusa a propósito: `aiChatCompletionFailover`/`candidateKeysFor`.
 * Esos SIEMPRE agregan la env key de la plataforma como último candidato de
 * failover —es lo que los vuelve resilientes en producción—, y acá sería
 * justo lo contrario de lo que hay que confirmar: una key inválida podría
 * "funcionar" respondiendo con el secret compartido, y el admin vería
 * "Funciona" para una key que en los hechos nunca se usó. Por eso este edge
 * hace un `fetch` directo con la key que llegó, sin rotar a ninguna otra.
 * Ningún dato se persiste: la key viaja en memoria durante este request y
 * no se loguea ni se audita.
 *
 * Body de prueba: { provider: 'openai'|'gemini'|'bedrock', model: string, apiKey: string, region?: string }
 * Response: { ok: true, ms, sample } | { ok: false, error, status? }
 *
 * ── Segunda acción: listar modelos REALES de Bedrock ───────────────────────
 * Body: { listBedrockModels: true, apiKey: string, region?: string }
 * Response: { ok: true, models: [{modelId, modelName, providerName, onDemand}] }
 *           | { ok: false, error }
 *
 * Existe para no tener que ADIVINAR IDs de modelo desde documentación que
 * cambia (AWS agrega/retira modelos de Bedrock constantemente, y los IDs no
 * son intuibles — "Claude Sonnet 5" en el catálogo puede ser
 * `anthropic.claude-sonnet-5-XXXXXXXX-v1:0` con una fecha que no se puede
 * adivinar). `ListFoundationModels` (`GET /foundation-models` en el host de
 * CONTROL PLANE `bedrock.<región>`, NO `bedrock-runtime`) devuelve la lista
 * exacta que la cuenta del admin puede usar. Mismo Bearer token que ya usa
 * el resto de esta integración — no verificado de antemano si el API key de
 * Bedrock alcanza para esta acción de control plane (la documentación de AWS
 * es ambigua al respecto); si no alcanza, el 403 de AWS llega tal cual al
 * admin y "Otro" + "Probar conexión" siguen sirviendo sin esto.
 */
import {
  adminClient as admin,
  userClientFromRequest,
  corsHeaders,
  jsonError,
  jsonResponse,
} from "../_shared/admin.ts";
import { enforceRateLimit } from "../_shared/rate-limit.ts";
import { chatCompletionUrlFor, type AiProvider } from "../_shared/ai-model.ts";
import { describeAiError } from "../_shared/ai-error.ts";
import { bedrockConverseFetch, esModeloAnthropicEnBedrock } from "../_shared/bedrock-converse.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method_not_allowed", 405);

  try {
    const userClient = userClientFromRequest(req);
    if (!userClient) return jsonError("No autenticado", 401);
    const { data: u } = await userClient.auth.getUser();
    const caller = u?.user;
    if (!caller) return jsonError("No autenticado", 401);

    // Mismo gate que el panel: solo quien puede TOCAR la config puede
    // gastar una llamada de prueba con la key de otro.
    const { data: callerRoles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id);
    const roleSet = new Set(((callerRoles ?? []) as { role: string }[]).map((r) => r.role));
    if (!roleSet.has("Admin") && !roleSet.has("SuperAdmin")) {
      return jsonError("Solo Admin o SuperAdmin pueden probar el modelo de IA", 403);
    }

    // Bajo (20/h): esto NO es un flujo de calificación de alto volumen, es
    // un botón que un humano aprieta a mano mientras configura.
    const rl = await enforceRateLimit(userClient, "ai.model_healthcheck", {
      max: 20,
      windowSeconds: 3600,
    });
    if (!rl.ok) return rl.response;

    let body: {
      provider?: string;
      model?: string;
      apiKey?: string;
      region?: string;
      listBedrockModels?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      return jsonError("Body inválido", 400);
    }

    // ── Rama: listar modelos reales de Bedrock (control plane) ───────────
    if (body.listBedrockModels) {
      const apiKeyBedrock = (body.apiKey ?? "").trim();
      if (!apiKeyBedrock) return jsonError("Pegá la API key de Bedrock antes de cargar modelos.", 400);
      const regionBedrock = (body.region ?? "").trim().toLowerCase() || "us-east-1";
      const urlModelos = `https://bedrock.${regionBedrock}.amazonaws.com/foundation-models?byOutputModality=TEXT`;
      let resModelos: Response;
      try {
        resModelos = await fetch(urlModelos, {
          headers: { Authorization: `Bearer ${apiKeyBedrock}` },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return jsonResponse({ ok: false, error: `Error de red: ${msg}` });
      }
      if (!resModelos.ok) {
        const detalle = await describeAiError(resModelos, "bedrock");
        return jsonResponse({ ok: false, status: resModelos.status, error: detalle });
      }
      let json: {
        modelSummaries?: Array<{
          modelId?: string;
          modelName?: string;
          providerName?: string;
          inferenceTypesSupported?: string[];
          outputModalities?: string[];
        }>;
      };
      try {
        json = await resModelos.json();
      } catch {
        return jsonResponse({ ok: false, error: "Respuesta de AWS no se pudo leer (no era JSON)." });
      }
      const modelos = (json.modelSummaries ?? [])
        // TEXT únicamente: es lo único que este panel puede usar hoy (nada
        // de imagen/embeddings — el traductor solo habla texto+tools).
        .filter((m) => (m.outputModalities ?? []).includes("TEXT"))
        .map((m) => ({
          modelId: m.modelId ?? "",
          modelName: m.modelName ?? m.modelId ?? "",
          providerName: m.providerName ?? "",
          // ON_DEMAND ausente = ese ID puntual no se puede invocar directo;
          // hace falta el ID con prefijo de inference profile
          // (us.<modelId>, etc). Se marca para que el admin no elija a
          // ciegas un ID que va a dar 404/ValidationException.
          onDemand: (m.inferenceTypesSupported ?? []).includes("ON_DEMAND"),
        }))
        .filter((m) => m.modelId)
        .sort((a, b) => (a.providerName + a.modelName).localeCompare(b.providerName + b.modelName));
      return jsonResponse({ ok: true, models: modelos });
    }

    const provider = body.provider;
    const model = (body.model ?? "").trim();
    const apiKey = (body.apiKey ?? "").trim();
    if (provider !== "openai" && provider !== "gemini" && provider !== "bedrock") {
      return jsonError("provider inválido (openai | gemini | bedrock)", 400);
    }
    if (!model) return jsonError("Elegí un modelo antes de probar.", 400);
    if (!apiKey) return jsonError("Pegá la API key antes de probar.", 400);

    const prov: AiProvider = provider;
    // Región normalizada IGUAL que `handleSave` del panel (trim + minúsculas):
    // sin esto, una región con espacios/mayúsculas construye una URL de host
    // inválida y el check falla para una config que, ya guardada, funcionaría.
    const region = (body.region ?? "").trim().toLowerCase() || undefined;

    // fetch DIRECTO con LA key que llegó — nada de `aiChatCompletionFailover`
    // / `candidateKeysFor`. Esas dos SIEMPRE agregan la env key de la
    // plataforma como último candidato (es lo que las hace resilientes en
    // producción); acá sería exactamente lo contrario de lo que hay que
    // confirmar: una key inválida podría "funcionar" respondiendo con el
    // secret compartido, y el admin vería "Funciona" para una key que en
    // realidad nunca se usó. Ver el comentario en `chatCompletionUrlFor`.
    const cuerpoPrueba = {
      model,
      messages: [
        {
          role: "user",
          content: "Responde solo con la palabra OK, sin nada más.",
        },
      ],
      max_tokens: 5,
    };
    const started = Date.now();
    let res: Response;
    try {
      res =
        prov === "bedrock" && esModeloAnthropicEnBedrock(model)
          ? await bedrockConverseFetch(apiKey, region, cuerpoPrueba)
          : await fetch(chatCompletionUrlFor(prov, region), {
              method: "POST",
              headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify(cuerpoPrueba),
            });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse({ ok: false, error: `Error de red: ${msg}` });
    }
    const ms = Date.now() - started;

    if (!res.ok) {
      const detail = await describeAiError(res, prov);
      return jsonResponse({ ok: false, status: res.status, error: detail, ms });
    }

    // 200 no basta solo: confirmar que de verdad vino contenido (un 200 con
    // el cuerpo vacío / sin choices sería un "funciona" falso).
    let sample = "";
    try {
      const json = await res.json();
      sample = String(json?.choices?.[0]?.message?.content ?? "").trim();
    } catch {
      /* si no parsea, sample queda vacío y el check igual reporta ok */
    }
    if (!sample) {
      return jsonResponse({
        ok: false,
        error:
          "El proveedor respondió 200 pero sin contenido — revisa el modelo (¿existe con ese id exacto?).",
        ms,
      });
    }

    return jsonResponse({ ok: true, ms, sample: sample.slice(0, 80) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return jsonError(msg, 500);
  }
});
