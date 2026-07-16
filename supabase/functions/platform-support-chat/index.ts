/**
 * Edge Function: platform-support-chat
 *
 * Endpoint para que un Admin (o SuperAdmin) converse con el Asistente IA
 * de plataforma: dudas sobre CÓMO usar y configurar ExamLab. Clon del
 * `tutor-chat` pero SIN curso: el contexto es la documentación de uso
 * (platform_kb_docs), no el material de un curso.
 *
 * Cada llamada:
 *  1. Valida que el usuario está logueado y es Admin o SuperAdmin.
 *  2. Valida que la sesión es suya.
 *  3. Carga el historial (truncado a últimos N).
 *  4. Construye el system prompt con la KB de la plataforma.
 *  5. Llama a la IA (failover de keys + retry transitorio, síncrono).
 *  6. Persiste el mensaje del usuario y la respuesta del asistente.
 *
 * Body: { sessionId: string, message: string }
 * Response: { ok: true, response: string, messageId: string }
 *
 * Hereda verify_jwt=true (default) — no lleva entrada en config.toml.
 */
import { adminClient as admin, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";
import {
  buildSupportSystemPrompt,
  truncateHistory,
  PLATFORM_SUPPORT_FALLBACK,
  type ChatMessage,
} from "./support-prompt.ts";
import {
  getActiveAiModel as resolveActiveModel,
  aiChatCompletionFailover,
} from "../_shared/ai-model.ts";
import { auditFromEdge } from "../_shared/audit.ts";

const MAX_HISTORY_MESSAGES = 30;
const MAX_USER_MESSAGE_LENGTH = 4000;

// Presupuesto de la documentación (KB) que va al prompt — mismo criterio
// que el material del tutor: tope por doc + tope global.
const KB_PER_DOC_CHARS = 6000;
const KB_TOTAL_CHARS = 22000;

// El fallback del template vive en support-prompt.ts (byte-idéntico con el
// seed SQL 20261063000020 y con el defaultPrompt del AdminPromptsPanel).
const FALLBACK_TEMPLATE = PLATFORM_SUPPORT_FALLBACK;

// ── AI gateway: reutiliza el patrón del tutor-chat ──
let requestModelHint: { authHeader?: string | null } = {};
function setRequestModelHint(h: { authHeader?: string | null }): void {
  requestModelHint = h;
}

// El retry transitorio + failover de keys vive en aiChatCompletionFailover;
// acá RETRYABLE_STATUS solo clasifica el status FINAL para el mensaje friendly.
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

async function callAi(messages: Array<{ role: string; content: string }>) {
  const m = await resolveActiveModel(requestModelHint);
  const res = await aiChatCompletionFailover(m, { model: m.model, messages });
  if (res.ok) {
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content ?? "";
    const usage = json.usage ?? {};
    return {
      content,
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
    };
  }
  const errText = await res.text();
  const isKeyInvalid =
    res.status === 401 ||
    res.status === 403 ||
    errText.includes("API_KEY_INVALID") ||
    errText.includes("invalid_api_key") ||
    errText.toLowerCase().includes("invalid api key");
  if (isKeyInvalid) {
    throw new Error(
      `La API key del proveedor de IA (${m.provider}) está inválida o expirada. ` +
        `Actualiza el secret correspondiente ` +
        `(${m.provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY"}) ` +
        `o cambia el proveedor activo desde Configuración → Modelo IA.`,
    );
  }
  const isOverload = RETRYABLE_STATUS.has(res.status) || isRetryableAiBody(errText);
  if (isOverload) {
    throw new Error(
      "El proveedor de IA está saturado en este momento. Intenta de nuevo en unos segundos.",
    );
  }
  throw new Error(`AI error ${res.status}: ${errText.slice(0, 500)}`);
}

// ── Resolver del system prompt del asistente ──
// 2 capas + fallback (SIN course override — este asistente no cuelga de
// un curso):
//   1. tenant global    (course_id IS NULL, tenant_id=<tenant>)
//   2. platform default  (course_id IS NULL, tenant_id IS NULL)
//   3. fallback hardcodeado (FALLBACK_TEMPLATE)
// `admin` bypasea RLS: traemos las filas globales y rankeamos en JS.
async function resolvePlatformSupportTemplate(tenantId: string | null): Promise<string> {
  const { data, error } = await admin
    .from("ai_prompts")
    .select("system_prompt, course_id, tenant_id")
    .eq("use_case", "platform_support")
    .is("course_id", null);
  if (error || !data || data.length === 0) return FALLBACK_TEMPLATE;
  // Scope de tenant: la capa "tenant global" (tenant_id != NULL) debe
  // matchear SOLO el tenant del Admin. La platform-default (tenant_id
  // NULL) sirve a todos.
  const scoped = data.filter(
    (r) => r.tenant_id === tenantId || r.tenant_id === null,
  );
  if (scoped.length === 0) return FALLBACK_TEMPLATE;
  const rank = (row: { tenant_id: string | null }): number => (row.tenant_id ? 2 : 1);
  const sorted = [...scoped].sort((a, b) => rank(b) - rank(a));
  return sorted[0]?.system_prompt || FALLBACK_TEMPLATE;
}

// ── KB de la plataforma → bloque de texto para el prompt ──
type KbRow = { title: string | null; body: string | null };

function buildPlatformKb(rows: KbRow[]): string {
  let acc = "";
  for (const r of rows) {
    if (acc.length >= KB_TOTAL_CHARS) break;
    const title = (r.title || "(sin título)").trim();
    const bodyText = (r.body || "").trim();
    if (!bodyText) continue;
    const excerpt =
      bodyText.length > KB_PER_DOC_CHARS
        ? bodyText.slice(0, KB_PER_DOC_CHARS).trimEnd() + " …"
        : bodyText;
    const header = `\n\n### ${title}\n`;
    const block = header + excerpt;
    if (acc.length + block.length > KB_TOTAL_CHARS) {
      acc += block.slice(0, KB_TOTAL_CHARS - acc.length);
      break;
    }
    acc += block;
  }
  return acc.trim();
}

// ── Videos de ayuda (platform_help_videos) → bloque para la KB ──
// El asistente REFERENCIA el video tutorial del módulo que el usuario consulta,
// con enlace (Markdown) si ya tiene URL de Zupaviz; si no, lo menciona como
// "en preparación". Se inyecta al inicio del bloque {{platform_kb}} del prompt.
function buildHelpVideoBlock(
  rows: Array<{ title: string | null; route: string | null; video_url: string | null }>,
): string {
  const lines = rows
    .map((r) => {
      const t = (r.title || "").trim();
      if (!t) return "";
      const link = r.video_url ? `[${t}](${r.video_url})` : `${t} (video en preparación)`;
      return `- ${link}${r.route ? ` — sección \`${r.route}\`` : ""}`;
    })
    .filter(Boolean);
  if (!lines.length) return "";
  return (
    "## Videos de ayuda de la plataforma\n" +
    'Cuando guíes al usuario sobre un módulo o pantalla, MENCIONA el video tutorial correspondiente de esta lista e incluye su enlace en Markdown si está disponible. Si figura como "(video en preparación)", menciona que existe pero aún sin enlace.\n' +
    lines.join("\n")
  );
}

// ── Handler ──
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const userClient = userClientFromRequest(req);
    if (!userClient) throw new Error("No autenticado");
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) throw new Error("No autenticado");
    const userId = u.user.id;

    // Autorización: CUALQUIER usuario autenticado puede usar el asistente de
    // plataforma (ayuda de uso de la app). El rol solo ADAPTA el contenido (KB
    // + prompt), no restringe el acceso.
    const { data: roleRows } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userId);
    const ownedRoles = ((roleRows ?? []) as Array<{ role?: string }>)
      .map((r) => r.role)
      .filter((r): r is string => !!r);

    const { sessionId, message, role: reqRole } = await req.json();
    if (!sessionId || typeof sessionId !== "string") {
      return new Response(JSON.stringify({ error: "sessionId requerido" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!message || typeof message !== "string") {
      return new Response(JSON.stringify({ error: "Mensaje vacío" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Validar sobre el valor YA recortado (lo que se persiste): un mensaje de solo
    // espacios que exceda el cap quedaría "" tras slice+trim y violaría el CHECK
    // char_length>=1 en el INSERT (500 tras gastar la llamada a IA).
    const trimmedMessage = message.slice(0, MAX_USER_MESSAGE_LENGTH).trim();
    if (!trimmedMessage) {
      return new Response(JSON.stringify({ error: "Mensaje vacío" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rol para ADAPTAR el asistente (KB + prompt). Usa el rol ACTIVO enviado por
    // el cliente si el usuario realmente lo posee; si no, el de mayor alcance.
    const roleRank: Record<string, number> = { SuperAdmin: 4, Admin: 3, Docente: 2, Estudiante: 1 };
    const highestOwned =
      [...ownedRoles].sort((a, b) => (roleRank[b] ?? 0) - (roleRank[a] ?? 0))[0] ?? "Estudiante";
    const promptRole =
      typeof reqRole === "string" && ownedRoles.includes(reqRole) ? reqRole : highestOwned;
    const kbAudience =
      promptRole === "Estudiante"
        ? ["estudiante", "all"]
        : promptRole === "Docente"
          ? ["docente", "all"]
          : ["admin", "all"];

    // Validar dueño de la sesión + obtener tenant_id.
    const { data: session, error: sErr } = await admin
      .from("platform_support_sessions")
      .select("id, user_id, tenant_id, title")
      .eq("id", sessionId)
      .maybeSingle();
    if (sErr || !session) throw new Error("Sesión no encontrada");
    if (session.user_id !== userId) throw new Error("No autorizado");

    const tenantId = (session as { tenant_id?: string | null }).tenant_id ?? null;

    // Multi-tenant: resolver modelo activo para el tenant del Admin.
    setRequestModelHint({ authHeader: req.headers.get("Authorization") });

    // Cargar historial existente (antes de insertar el nuevo).
    const { data: history } = await admin
      .from("platform_support_messages")
      .select("role, content")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });

    const historyMsgs = ((history ?? []) as ChatMessage[]).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // Nombre del Admin + de la institución (para el prompt).
    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, tenant_id")
      .eq("id", userId)
      .maybeSingle();
    const adminName = (profile as { full_name?: string | null } | null)?.full_name ?? null;
    const effectiveTenantId =
      tenantId ?? (profile as { tenant_id?: string | null } | null)?.tenant_id ?? null;

    let tenantName: string | null = null;
    if (effectiveTenantId) {
      const { data: tenant } = await admin
        .from("tenants")
        .select("name")
        .eq("id", effectiveTenantId)
        .maybeSingle();
      tenantName = (tenant as { name?: string | null } | null)?.name ?? null;
    }

    // Cargar la KB de uso (audience admin/all) ordenada por position.
    const { data: kbRows } = await admin
      .from("platform_kb_docs")
      .select("title, body, position, audience")
      .in("audience", kbAudience)
      .order("position", { ascending: true });

    // Videos de ayuda del rol activo (SuperAdmin usa los de Admin). Defensivo:
    // si la tabla aún no existe (entorno sin la migración), la query falla suave
    // (data=null) y no se inyecta nada — el asistente sigue funcionando.
    const roleForVideos = promptRole === "SuperAdmin" ? "Admin" : promptRole;
    const { data: videoRows } = await admin
      .from("platform_help_videos")
      .select("title, route, video_url, role, position, is_active")
      .eq("is_active", true)
      .order("position", { ascending: true });
    const relevantVideos = ((videoRows ?? []) as Array<{
      title: string | null;
      route: string | null;
      video_url: string | null;
      role: string | null;
    }>).filter((v) => v.role === roleForVideos || v.role == null);
    const videoBlock = buildHelpVideoBlock(relevantVideos);

    const docKb = buildPlatformKb((kbRows ?? []) as KbRow[]);
    // El bloque de videos va PRIMERO para que quepa aunque la KB de docs sea larga.
    const platformKb = videoBlock ? `${videoBlock}\n\n${docKb}` : docKb;

    // Conciencia temporal (es-CO / America/Bogota), calculada server-side.
    const currentDatetime = new Intl.DateTimeFormat("es-CO", {
      timeZone: "America/Bogota",
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date());

    // Construir prompt.
    const template = await resolvePlatformSupportTemplate(effectiveTenantId);
    const roleLabelEs: Record<string, string> = {
      SuperAdmin: "SuperAdministrador de la plataforma",
      Admin: "Administrador de la institución",
      Docente: "Docente",
      Estudiante: "Estudiante",
    };
    const systemPrompt =
      buildSupportSystemPrompt({
        template,
        platformKb,
        maxKbChars: KB_TOTAL_CHARS,
        currentDatetime,
        tenantName,
        adminName,
      }) +
      `\n\nEl usuario actual es **${roleLabelEs[promptRole] ?? "usuario"}**. Adapta tus explicaciones a lo que ESE rol puede hacer en ExamLab; usa "tú". No expliques funciones exclusivas de otros roles salvo que lo pregunte explícitamente.`;

    // Truncar historial y agregar el nuevo turno.
    const truncatedHistory = truncateHistory(historyMsgs, MAX_HISTORY_MESSAGES);
    const aiMessages = [
      { role: "system", content: systemPrompt },
      ...truncatedHistory,
      { role: "user", content: trimmedMessage },
    ];

    // Llamar IA.
    const result = await callAi(aiMessages);

    // Sanear el contenido del asistente contra el CHECK (length 1..20000).
    const MAX_ASSISTANT_CHARS = 20000;
    let assistantContent = (result.content ?? "").trim();
    if (!assistantContent) {
      assistantContent =
        "No pude generar una respuesta en este momento. Por favor reformula tu pregunta o inténtalo de nuevo.";
    } else if (assistantContent.length > MAX_ASSISTANT_CHARS) {
      assistantContent = assistantContent.slice(0, MAX_ASSISTANT_CHARS - 1) + "…";
    }

    // Persistir: mensaje del usuario + respuesta del asistente.
    const nowIso = new Date().toISOString();
    const { data: inserted, error: insErr } = await admin
      .from("platform_support_messages")
      .insert([
        {
          session_id: sessionId,
          role: "user",
          content: trimmedMessage,
          created_at: nowIso,
        },
        {
          session_id: sessionId,
          role: "assistant",
          content: assistantContent,
          prompt_tokens: result.promptTokens,
          completion_tokens: result.completionTokens,
          // +1ms para garantizar orden estable en el batch.
          created_at: new Date(Date.now() + 1).toISOString(),
        },
      ])
      .select("id, role, created_at");
    if (insErr) throw insErr;

    // Bumpear updated_at de la sesión.
    await admin
      .from("platform_support_sessions")
      .update({ updated_at: nowIso })
      .eq("id", sessionId);

    // Auditoría best-effort (no bloquea el flujo).
    void auditFromEdge(admin, {
      actorId: userId,
      action: "platform_support.chat",
      category: "system",
      severity: "info",
      entityType: "platform_support_session",
      entityId: sessionId,
      tenantId: effectiveTenantId,
      metadata: {
        prompt_tokens: result.promptTokens,
        completion_tokens: result.completionTokens,
      },
    });

    const assistantMsg = (inserted ?? []).find((m: { role: string }) => m.role === "assistant");

    return new Response(
      JSON.stringify({
        ok: true,
        response: assistantContent,
        messageId: assistantMsg?.id ?? null,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
