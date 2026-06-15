/**
 * Edge Function: ai-generate-report
 *
 * Genera/redacta el contenido de un informe (módulo Informes) con IA,
 * combinando los valores de la plataforma y del curso. El frontend arma los
 * mensajes `{ system, user }` con `buildAiReportPrompt` (que ya inyecta el
 * contexto real del curso vía `buildReportContext` + `summarizeContextForAi`
 * y el catálogo de variables {{...}}). Este edge solo CORRE la IA y devuelve
 * el texto/HTML resultante para insertarlo en el editor de plantillas.
 *
 * Por qué un edge y no llamar la IA desde el front: la API key del proveedor
 * vive como secret server-side (LOVABLE/OPENAI/GEMINI_API_KEY) — nunca se
 * expone al cliente. Mismo patrón que tutor-chat / generate-contents.
 *
 * Auth: verify_jwt=true (default) — solo usuarios logueados. El modelo +
 * keys se resuelven por tenant con `getActiveAiModel({ courseId, authHeader })`.
 *
 * Body:  { system: string, user: string, courseId?: string }
 * Resp:  { ok: true, content: string }
 */
import {
  adminClient as admin,
  corsHeaders,
  jsonError,
  jsonResponse,
  userClientFromRequest,
} from "../_shared/admin.ts";
import { getActiveAiModel } from "../_shared/ai-model.ts";

// System prompt por defecto de la Generación IA de informes. DEBE quedar
// byte-idéntico con DEFAULT_REPORT_GENERATION_PROMPT (src/modules/reports/
// template-engine.ts), el seed de la mig 20260976000000 y el defaultPrompt del
// AdminPromptsPanel (use_case report_generation).
const FALLBACK_REPORT_PROMPT = [
  "Eres un asistente que redacta secciones de informes académicos para un docente.",
  "Escribe en español (es-CO), tono formal e institucional, claro y conciso.",
  "El texto que produces es una PLANTILLA: cuando un dato provenga de las variables",
  "disponibles, inserta el placeholder con doble llave (por ejemplo {{estudiante.nombre}})",
  "EN LUGAR del valor concreto, para que el sistema lo reemplace luego por cada",
  "estudiante o curso. Usa los valores concretos solo como referencia de contexto.",
  "Devuelve únicamente el texto/HTML de la sección, sin explicaciones ni comentarios,",
  "sin envolver en bloques de código.",
].join("\n");

/**
 * Resuelve el system prompt de `report_generation` desde `ai_prompts` con la
 * jerarquía estándar (course override > tenant global > platform default) y
 * cae al FALLBACK hardcodeado. Mismo patrón que `resolveTutorTemplate`.
 */
async function resolveReportSystemPrompt(courseId: string | null): Promise<string> {
  const isUuid = (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  let q = admin
    .from("ai_prompts")
    .select("system_prompt, course_id, tenant_id")
    .eq("use_case", "report_generation");
  if (courseId && isUuid(courseId)) {
    q = q.or(`course_id.eq.${courseId},course_id.is.null`);
  } else {
    q = q.is("course_id", null);
  }
  const { data, error } = await q;
  if (error || !data || data.length === 0) return FALLBACK_REPORT_PROMPT;
  const rank = (row: { course_id: string | null; tenant_id: string | null }): number => {
    if (row.course_id) return 3;
    if (row.tenant_id) return 2;
    return 1;
  };
  const sorted = [...data].sort((a, b) => rank(b) - rank(a));
  return sorted[0]?.system_prompt || FALLBACK_REPORT_PROMPT;
}

const MAX_AI_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isRetryableAiBody(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('"status":"internal"') ||
    lower.includes('"status":"unavailable"') ||
    lower.includes('"status":"resource_exhausted"') ||
    lower.includes("rate limit") ||
    lower.includes("overloaded")
  );
}

/**
 * Llama al proveedor de IA (OpenAI o Gemini via gateway OpenAI-compatible)
 * con retry exponencial en transientes. Mismo contrato chat-completions que
 * el resto de los edges IA del repo.
 */
async function callAi(
  messages: Array<{ role: string; content: string }>,
  hint: { courseId?: string | null; authHeader?: string | null },
): Promise<string> {
  const m = await getActiveAiModel(hint);
  let url: string;
  let key: string | undefined;
  if (m.provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    key = m.openai_api_key ?? Deno.env.get("OPENAI_API_KEY");
  } else {
    url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    key = m.gemini_api_key ?? Deno.env.get("GEMINI_API_KEY");
  }
  if (!key) throw new Error(`API key del provider ${m.provider} no configurada`);

  let lastErr: { status: number; text: string } | null = null;
  for (let attempt = 1; attempt <= MAX_AI_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: m.model, messages }),
    });
    if (res.ok) {
      const json = await res.json();
      return json.choices?.[0]?.message?.content ?? "";
    }
    const errText = await res.text();
    lastErr = { status: res.status, text: errText };

    const isKeyInvalid =
      res.status === 401 ||
      res.status === 403 ||
      errText.includes("API_KEY_INVALID") ||
      errText.includes("invalid_api_key") ||
      errText.toLowerCase().includes("invalid api key");
    if (isKeyInvalid) {
      throw new Error(
        `La API key del proveedor de IA (${m.provider}) está inválida o expirada. ` +
          `Pídele al administrador que actualice el secret o cambie el proveedor activo ` +
          `desde Admin → IA → Modelo.`,
      );
    }

    const shouldRetry =
      attempt < MAX_AI_RETRIES && (RETRYABLE_STATUS.has(res.status) || isRetryableAiBody(errText));
    if (!shouldRetry) break;
    await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt - 1)));
  }

  if (lastErr) {
    const isOverload = RETRYABLE_STATUS.has(lastErr.status) || isRetryableAiBody(lastErr.text);
    if (isOverload) {
      throw new Error(
        "El proveedor de IA está saturado en este momento. Intenta de nuevo en unos segundos.",
      );
    }
    throw new Error(`AI error ${lastErr.status}: ${lastErr.text.slice(0, 500)}`);
  }
  throw new Error("AI sin respuesta tras 3 intentos.");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method_not_allowed", 405);

  // Auth: aunque verify_jwt=true ya enforza un JWT válido en el gateway,
  // confirmamos el user (defensa + para tener un actor claro).
  const userClient = userClientFromRequest(req);
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user?.id) return jsonError("no_autenticado", 401);

  let body: { system?: string; user?: string; courseId?: string | null };
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }

  const userMsg = (body.user ?? "").trim();
  if (!userMsg) return jsonError("missing_prompt", 400);

  // El SYSTEM prompt es configurable: se resuelve desde `ai_prompts`
  // (use_case report_generation) con la jerarquía course/tenant/platform.
  // Se ignora cualquier `system` que mande el cliente (los datos dinámicos van
  // en `user`). Si el cliente manda system (compat con deploys viejos del
  // front), lo usamos solo como último recurso si el resolver no trae nada.
  const resolved = await resolveReportSystemPrompt(body.courseId ?? null);
  const system = (resolved || (body.system ?? "")).trim();

  // Tope defensivo de tamaño del prompt (el contexto del curso ya viene
  // truncado por buildAiReportPrompt, pero por si acaso).
  const totalLen = system.length + userMsg.length;
  if (totalLen > 200_000) return jsonError("prompt_too_large", 413);

  try {
    const messages = [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: userMsg },
    ];
    const content = await callAi(messages, {
      courseId: body.courseId ?? null,
      authHeader: req.headers.get("Authorization"),
    });
    return jsonResponse({ ok: true, content });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Error generando el informe con IA";
    return jsonError(msg, 500);
  }
});
