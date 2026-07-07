/**
 * Edge Function: support-ai-suggest  (Feature B — advisory-only)
 *
 * Genera una SUGERENCIA de IA para que el equipo de soporte de plataforma
 * atienda un caso, en dos modos:
 *   - mode="ticket": redacta una respuesta lista para enviar al Admin +
 *     un diagnóstico breve, con el historial del ticket como contexto.
 *   - mode="error": diagnóstico de causa probable + pasos de remediación,
 *     distinguiendo acciones SEGURAS de las que requieren revisión manual.
 *
 * ADVISORY-ONLY (human-in-the-loop): esta edge SOLO devuelve texto
 * (`suggestion`). NUNCA ejecuta acciones ni muta datos del caso. Las
 * "safe-actions" (reintentar calificación, marcar como resuelto, etc.)
 * viven en el cliente y llaman RPCs existentes con su propia
 * autorización — este edge no las conoce ni las devuelve.
 *
 * One-shot y EFÍMERO: no persiste sesión ni mensajes (a diferencia de
 * platform-support-chat). Cada llamada arma su prompt, consulta la IA y
 * devuelve el texto.
 *
 * Body:
 *   { mode: "ticket", ticketId: string }
 *   { mode: "error", auditLogId?: string, errorMessage: string, errorAction?: string }
 * Response: { ok: true, suggestion: string }
 *
 * Autorización:
 *   - ticket: SuperAdmin, o el Admin creador del ticket.
 *   - error : SuperAdmin (los errores del sistema son competencia del SA).
 *
 * Hereda verify_jwt=true (default) — lo invoca un usuario con JWT, así que
 * NO lleva entrada en config.toml.
 */
import { adminClient as admin, corsHeaders, userClientFromRequest } from "../_shared/admin.ts";
import {
  getActiveAiModel as resolveActiveModel,
  aiChatCompletionFailover,
  type ActiveModel,
} from "../_shared/ai-model.ts";
import { auditFromEdge } from "../_shared/audit.ts";

// Presupuesto de la documentación (KB) que va al prompt — mismo criterio
// que platform-support-chat: tope por doc + tope global.
const KB_PER_DOC_CHARS = 6000;
const KB_TOTAL_CHARS = 22000;

// Contexto del caso — topes defensivos para no reventar el context window.
const MAX_TICKET_BODY_CHARS = 6000;
const MAX_TICKET_MESSAGES = 30;
const MAX_TICKET_MESSAGE_CHARS = 2000;
const MAX_ERROR_MESSAGE_CHARS = 6000;
const MAX_SUGGESTION_CHARS = 20000;

// FALLBACK del system prompt. BYTE-IDÉNTICO con el seed SQL
// 20261064000000_support_triage_prompt.sql (use_case='support_triage').
// Solo se usa si ai_prompts NO tiene fila en NINGUNA capa (no debería
// pasar — la migración siembra platform-default + per-tenant).
const SUPPORT_TRIAGE_CANONICO = `Eres un asistente de soporte técnico de la plataforma educativa ExamLab. Ayudas al equipo de soporte de plataforma a atender un caso: un ticket de soporte de un administrador de institución, o un error registrado del sistema.

Según el caso, produce en español (es-CO):
- Un diagnóstico breve y honesto de la causa probable.
- Para un ticket: una respuesta cordial y profesional, lista para enviar al administrador, con pasos numerados y accionables cuando aplique.
- Para un error: los pasos de remediación, distinguiendo claramente las acciones SEGURAS (reversibles o idempotentes, que el equipo puede aplicar) de las que requieren revisión manual.

Reglas:
- Básate ESTRICTAMENTE en la documentación de la plataforma y en los datos del caso que se te proveen. Si no tienes suficiente información, dilo y pide el dato que falta, en lugar de inventar.
- NUNCA propongas ejecutar automáticamente acciones destructivas, cambios de configuración, de seguridad, de roles ni manejo de secretos: descríbelas solo como pasos manuales que una persona debe revisar.
- No inventes rutas, botones ni nombres de módulos que no aparezcan en la documentación.
- Sé conciso y accionable.

Documentación de la plataforma:
{{platform_kb}}`;

// ── AI gateway (mismo patrón que platform-support-chat) ──
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

async function callAi(
  m: ActiveModel,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const res = await aiChatCompletionFailover(m, { model: m.model, messages });
  if (res.ok) {
    const json = await res.json();
    return json.choices?.[0]?.message?.content ?? "";
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

// ── Resolver del system prompt (2 capas + fallback, SIN course) ──
//   1. tenant global   (course_id IS NULL, tenant_id=<tenant>)
//   2. platform default (course_id IS NULL, tenant_id IS NULL)
//   3. fallback hardcodeado (SUPPORT_TRIAGE_CANONICO)
// `admin` bypasea RLS: traemos las filas globales y rankeamos en JS.
async function resolveTriageTemplate(tenantId: string | null): Promise<string> {
  const { data, error } = await admin
    .from("ai_prompts")
    .select("system_prompt, course_id, tenant_id")
    .eq("use_case", "support_triage")
    .is("course_id", null);
  if (error || !data || data.length === 0) return SUPPORT_TRIAGE_CANONICO;
  const scoped = data.filter((r) => r.tenant_id === tenantId || r.tenant_id === null);
  if (scoped.length === 0) return SUPPORT_TRIAGE_CANONICO;
  const rank = (row: { tenant_id: string | null }): number => (row.tenant_id ? 2 : 1);
  const sorted = [...scoped].sort((a, b) => rank(b) - rank(a));
  return sorted[0]?.system_prompt || SUPPORT_TRIAGE_CANONICO;
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

async function loadPlatformKb(): Promise<string> {
  const { data: kbRows } = await admin
    .from("platform_kb_docs")
    .select("title, body, position, audience")
    .in("audience", ["admin", "all"])
    .order("position", { ascending: true });
  return buildPlatformKb((kbRows ?? []) as KbRow[]);
}

/** Sustituye {{platform_kb}} en el template; deja intactos otros placeholders. */
function fillTemplate(template: string, platformKb: string): string {
  const kb = platformKb || "(No hay documentación de la plataforma disponible en este momento.)";
  return template.replace(/\{\{platform_kb\}\}/g, kb);
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
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

    const body = await req.json();
    const mode = body?.mode;
    if (mode !== "ticket" && mode !== "error") {
      return json({ error: "mode inválido (ticket|error)" }, 400);
    }

    // is_super_admin() vía userClient (RPC granted a authenticated).
    const { data: isSuperData } = await userClient.rpc("is_super_admin");
    const isSuper = isSuperData === true;

    const authHeader = req.headers.get("Authorization");

    // ── MODO TICKET ──
    if (mode === "ticket") {
      const ticketId = body?.ticketId;
      if (!ticketId || typeof ticketId !== "string") {
        return json({ error: "ticketId requerido" }, 400);
      }

      // Cargar el ticket con adminClient (service_role) — tras validar el
      // caller. La autorización se decide en JS, no confiamos en RLS acá.
      const { data: ticket, error: tErr } = await admin
        .from("support_tickets")
        .select(
          "id, tenant_id, created_by, category, priority, subject, body, status, deleted_at",
        )
        .eq("id", ticketId)
        .maybeSingle();
      if (tErr || !ticket) throw new Error("Ticket no encontrado");
      if ((ticket as { deleted_at?: string | null }).deleted_at) {
        throw new Error("Ticket no encontrado");
      }

      const isCreator = (ticket as { created_by?: string }).created_by === userId;
      if (!isSuper && !isCreator) throw new Error("No autorizado");

      const tenantId = (ticket as { tenant_id?: string | null }).tenant_id ?? null;

      // Historial del ticket (para dar contexto conversacional).
      const { data: msgs } = await admin
        .from("support_ticket_messages")
        .select("sender_id, body, created_at")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true });

      const messagesList = ((msgs ?? []) as Array<{
        sender_id: string;
        body: string;
      }>).slice(-MAX_TICKET_MESSAGES);

      // Modelo: usar el tenant del TICKET (el SA no tiene tenant propio;
      // el del ticket asegura resolver las API keys correctas).
      const model = await resolveActiveModel({ tenantId });
      const template = await resolveTriageTemplate(tenantId);
      const platformKb = await loadPlatformKb();
      const systemPrompt = fillTemplate(template, platformKb);

      // User message: datos del ticket + conversación previa.
      const parts: string[] = [
        "Atiende el siguiente ticket de soporte de un administrador de institución.",
        "",
        `Asunto: ${ticket.subject}`,
        `Categoría: ${ticket.category}`,
        `Prioridad: ${ticket.priority}`,
        `Estado actual: ${ticket.status}`,
        "",
        "Descripción del administrador:",
        String(ticket.body ?? "").slice(0, MAX_TICKET_BODY_CHARS),
      ];
      if (messagesList.length > 0) {
        parts.push("", "Conversación previa (más antiguo primero):");
        for (const m of messagesList) {
          const who = m.sender_id === (ticket as { created_by?: string }).created_by
            ? "Administrador"
            : "Soporte";
          parts.push(`- ${who}: ${String(m.body ?? "").slice(0, MAX_TICKET_MESSAGE_CHARS)}`);
        }
      }
      parts.push(
        "",
        "Redacta una respuesta cordial y profesional lista para enviar al administrador, " +
          "y agrega un diagnóstico breve de la causa probable. Distingue los pasos que el " +
          "administrador puede hacer por su cuenta de los que requieren acción del equipo de soporte.",
      );

      const suggestion = await callAi(model, [
        { role: "system", content: systemPrompt },
        { role: "user", content: parts.join("\n") },
      ]);

      void auditFromEdge(admin, {
        actorId: userId,
        action: "support.ai_suggested_reply",
        category: "system",
        severity: "info",
        entityType: "support_ticket",
        entityId: ticketId,
        tenantId,
      });

      return json({ ok: true, suggestion: sanitizeSuggestion(suggestion) });
    }

    // ── MODO ERROR ── (solo SuperAdmin)
    if (!isSuper) throw new Error("No autorizado");

    const errorMessage = body?.errorMessage;
    const errorAction = body?.errorAction;
    const auditLogId = body?.auditLogId;
    if (!errorMessage || typeof errorMessage !== "string" || errorMessage.trim().length === 0) {
      return json({ error: "errorMessage requerido" }, 400);
    }

    // Modelo platform-default (el SA no tiene tenant propio).
    const model = await resolveActiveModel({ authHeader });
    const template = await resolveTriageTemplate(null);
    const platformKb = await loadPlatformKb();
    const systemPrompt = fillTemplate(template, platformKb);

    // errorMessage llega YA NORMALIZADO desde el cliente (error-event.ts).
    // NO se re-normaliza acá (invariante de la feature).
    const parts: string[] = [
      "Analiza el siguiente error registrado del sistema.",
      "",
      errorAction && typeof errorAction === "string" ? `Acción / origen: ${errorAction}` : null,
      "Mensaje de error (normalizado):",
      errorMessage.slice(0, MAX_ERROR_MESSAGE_CHARS),
      "",
      "Da un diagnóstico de la causa probable y los pasos de remediación. Distingue " +
        "claramente las acciones SEGURAS (reversibles o idempotentes, que el equipo puede " +
        "aplicar) de las que requieren revisión manual antes de aplicarse.",
    ].filter((s): s is string => typeof s === "string");

    const suggestion = await callAi(model, [
      { role: "system", content: systemPrompt },
      { role: "user", content: parts.join("\n") },
    ]);

    void auditFromEdge(admin, {
      actorId: userId,
      action: "support.ai_suggested_remediation",
      category: "system",
      severity: "info",
      entityType: "audit_log",
      entityId: typeof auditLogId === "string" ? auditLogId : null,
      tenantId: null,
      metadata: { error_action: typeof errorAction === "string" ? errorAction : null },
    });

    return json({ ok: true, suggestion: sanitizeSuggestion(suggestion) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Error interno";
    return json({ error: msg }, 500);
  }
});

function sanitizeSuggestion(raw: string): string {
  const s = (raw ?? "").trim();
  // Vacío (contenido filtrado / tool-call sin texto) → devolvemos "" para que el
  // cliente dispare su propio guard `if (!suggestion)` y muestre un ERROR, en vez
  // de presentar una disculpa como sugerencia "lista" con toast de éxito.
  if (!s) return "";
  return s.length > MAX_SUGGESTION_CHARS ? s.slice(0, MAX_SUGGESTION_CHARS - 1) + "…" : s;
}
