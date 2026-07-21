/**
 * Resolución del modelo IA activo — multi-tenant safe.
 *
 * Antes cada edge function tenía su propio `getActiveAiModel()` que
 * hacía `.from("ai_model_settings").eq("is_active", true).maybeSingle()`.
 * Con multi-tenant (Fase 5) eso rompe: hay UNA fila is_active=true POR
 * tenant, y `maybeSingle()` lanza si encuentra > 1.
 *
 * Este helper recibe un hint de tenant (cualquiera de los disponibles):
 *   - `tenantId` directo si el caller lo conoce.
 *   - `courseId` → derivamos tenant via courses.tenant_id.
 *   - Authorization header → derivamos via auth.uid() → profiles.tenant_id.
 *
 * Cache: una vez resuelto el modelo activo para un tenant, lo memoizamos
 * por la vida del worker (~minutos en Deno Deploy). El cliente puede
 * forzar refresh si el admin acaba de cambiar provider — pero típicamente
 * el cold start del worker se encarga.
 */

import { adminClient } from "./admin.ts";
import { type AiProvider, normalizeProvider, normalizeModel } from "./ai-model-normalize.ts";
import { dedupeNonEmpty, runKeyFailover } from "./ai-failover.ts";

// "lovable" se DEPRECÓ (mig 20260824000000) — el Lovable AI Gateway
// usaba una key compartida que ya no se mantiene. Los providers
// activos son Gemini directo (default) y OpenAI.
export type { AiProvider };
export { normalizeProvider, normalizeModel };

export interface ActiveModel {
  provider: AiProvider;
  model: string;
  /** API key PRINCIPAL per-tenant. NULL → la edge cae al env legacy. */
  gemini_api_key: string | null;
  openai_api_key: string | null;
  /** Lista ORDENADA de candidatos por provider = [principal, ...respaldo].
   *  El failover (`aiChatCompletionFailover`) las intenta en orden y, al
   *  final, agrega la env key legacy como último recurso. NO incluye la env. */
  gemini_api_keys: string[];
  openai_api_keys: string[];
  /** Tenant resolved (null si fallback hardcoded). Útil para logging. */
  tenant_id: string | null;
}

// Fallback hardcoded — Gemini directo, sin key (cae al env GEMINI_API_KEY
// en la edge si no hay platform default configurado).
const DEFAULT_MODEL: ActiveModel = {
  provider: "gemini",
  model: "gemini-2.5-flash",
  gemini_api_key: null,
  openai_api_key: null,
  gemini_api_keys: [],
  openai_api_keys: [],
  tenant_id: null,
};

// Cache por tenant_id. Una entrada `null` cachea el "no tenant resolved".
const cache = new Map<string | null, ActiveModel>();

export interface ResolveOptions {
  tenantId?: string | null;
  courseId?: string | null;
  /** Authorization header completo, ej. "Bearer xxx". Si llega y no hay
   *  tenant_id/course_id, resolvemos via auth.uid() → profile. */
  authHeader?: string | null;
}

/**
 * Resuelve el tenant_id según las pistas disponibles. Devuelve null si
 * no se pudo determinar (caller anónimo + sin courseId/tenantId).
 */
async function resolveTenantId(opts: ResolveOptions): Promise<string | null> {
  if (opts.tenantId) return opts.tenantId;

  if (opts.courseId) {
    const { data } = await adminClient
      .from("courses")
      .select("tenant_id")
      .eq("id", opts.courseId)
      .maybeSingle();
    const tid = (data as { tenant_id?: string } | null)?.tenant_id ?? null;
    if (tid) return tid;
  }

  if (opts.authHeader) {
    // Resolver via JWT: el JWT trae sub = auth.uid().
    // Hacemos un cliente con el JWT y leemos profile.tenant_id.
    // Más simple que decodificar manualmente.
    try {
      const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
      const anonKey =
        Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
      const { createClient } = await import("npm:@supabase/supabase-js@2.45.0");
      const userClient = createClient(SUPABASE_URL, anonKey, {
        global: { headers: { Authorization: opts.authHeader } },
      });
      const { data: u } = await userClient.auth.getUser();
      const uid = u?.user?.id;
      if (uid) {
        const { data: p } = await adminClient
          .from("profiles")
          .select("tenant_id")
          .eq("id", uid)
          .maybeSingle();
        return (p as { tenant_id?: string } | null)?.tenant_id ?? null;
      }
    } catch (e) {
      console.warn("[ai-model] resolveTenantId via authHeader failed:", e);
    }
  }

  return null;
}

/**
 * Devuelve el modelo activo para el tenant resuelto. Si no se puede
 * resolver el tenant O no hay fila activa, devuelve el fallback
 * hardcoded (Gemini directo + gemini-2.5-flash).
 */
export async function getActiveAiModel(opts: ResolveOptions = {}): Promise<ActiveModel> {
  const tenantId = await resolveTenantId(opts);

  if (cache.has(tenantId)) return cache.get(tenantId)!;

  type Row = {
    provider: string;
    model: string;
    gemini_api_key: string | null;
    openai_api_key: string | null;
    gemini_fallback_keys: string[] | null;
    openai_fallback_keys: string[] | null;
  };
  const toActive = (row: Row, scope: "tenant" | "platform"): ActiveModel => {
    const p = normalizeProvider(row.provider);
    return {
      provider: p,
      model: normalizeModel(row.model, p),
      gemini_api_key: row.gemini_api_key,
      openai_api_key: row.openai_api_key,
      // Lista ordenada [principal, ...respaldo] sin vacíos ni duplicados.
      gemini_api_keys: dedupeNonEmpty([row.gemini_api_key, ...(row.gemini_fallback_keys ?? [])]),
      openai_api_keys: dedupeNonEmpty([row.openai_api_key, ...(row.openai_fallback_keys ?? [])]),
      tenant_id: scope === "tenant" ? tenantId : null,
    };
  };

  // Modelo COMPARTIDO de la plataforma: la fila activa del SuperAdmin
  // (tenant_id IS NULL) o, si no existe, el fallback hardcodeado (Gemini
  // directo, key NULL → cae al env GEMINI_API_KEY de la edge).
  const platformShared = async (): Promise<ActiveModel> => {
    const { data } = await adminClient
      .from("ai_model_settings")
      .select(
        "provider, model, gemini_api_key, openai_api_key, gemini_fallback_keys, openai_fallback_keys",
      )
      .eq("is_active", true)
      .is("tenant_id", null)
      .maybeSingle();
    return data ? toActive(data as Row, "platform") : DEFAULT_MODEL;
  };

  // 1) Caller CON tenant → decide según `tenants.ai_mode` (módulo comercial,
  // mig 20261340000000). Default 'shared'.
  //   - 'shared'  (default): usa la IA COMPARTIDA de la plataforma. El tenant
  //                NO necesita configurar su propia key — es el modo por
  //                defecto al crear una institución.
  //   - 'own'    : el tenant trae su propia API key → usa SU fila de
  //                ai_model_settings; sin key = error accionable (para que NO
  //                consuma silenciosamente la cuota compartida).
  //   - 'managed': igual que 'shared' a nivel runtime (key de plataforma); la
  //                medición/cobro del consumo es aparte (comercial).
  if (tenantId) {
    let aiMode = "shared";
    try {
      const { data: trow } = await adminClient
        .from("tenants")
        .select("ai_mode")
        .eq("id", tenantId)
        .maybeSingle();
      aiMode = (trow as { ai_mode?: string } | null)?.ai_mode ?? "shared";
    } catch {
      // Columna ai_mode aún no publicada → tratamos como 'shared'.
      aiMode = "shared";
    }

    if (aiMode === "own") {
      const { data } = await adminClient
        .from("ai_model_settings")
        .select(
          "provider, model, gemini_api_key, openai_api_key, gemini_fallback_keys, openai_fallback_keys",
        )
        .eq("is_active", true)
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (data) {
        const resolved = toActive(data as Row, "tenant");
        cache.set(tenantId, resolved);
        return resolved;
      }
      // Sin row del tenant en modo 'own' → DEFAULT_MODEL con keys NULL.
      // El wrapper de cada edge detecta la falta de key y tira el error
      // accionable ("Configúrala en Admin → IA → Modelo").
      const stub: ActiveModel = { ...DEFAULT_MODEL, tenant_id: tenantId };
      cache.set(tenantId, stub);
      console.warn(
        `[ai-model] tenant ${tenantId} ai_mode=own sin fila en ai_model_settings; ` +
          `el caller verá error pidiendo configurar la API key.`,
      );
      return stub;
    }

    // 'shared' | 'managed' → IA compartida de la plataforma. Las keys salen del
    // platform default (fila tenant_id IS NULL) + env. PERO, como fallback,
    // anexamos la key PROPIA del tenant si la tiene: así los tenants que ya
    // traían su key ANTES de la IA compartida (o el tenant demo) no se quedan
    // sin IA si aún no existe la fila platform-default. Orden de intento
    // (failover): platform → key propia → env. Cacheado bajo el tenantId.
    const shared = await platformShared();
    const { data: ownRow } = await adminClient
      .from("ai_model_settings")
      .select(
        "provider, model, gemini_api_key, openai_api_key, gemini_fallback_keys, openai_fallback_keys",
      )
      .eq("is_active", true)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    const own = ownRow ? toActive(ownRow as Row, "tenant") : null;
    const resolved: ActiveModel = {
      ...shared,
      gemini_api_keys: dedupeNonEmpty([
        ...shared.gemini_api_keys,
        ...(own?.gemini_api_keys ?? []),
      ]),
      openai_api_keys: dedupeNonEmpty([
        ...shared.openai_api_keys,
        ...(own?.openai_api_keys ?? []),
      ]),
      tenant_id: tenantId,
    };
    cache.set(tenantId, resolved);
    return resolved;
  }

  // 2) Caller sin tenant resolvable (jobs internos, cron, etc.) → IA
  // compartida de la plataforma.
  const resolved = await platformShared();
  cache.set(null, resolved);
  return resolved;
}

/** Limpia el cache. Útil cuando el admin cambia el provider del tenant. */
export function clearAiModelCache(): void {
  cache.clear();
}

// ──────────────────────────────────────────────────────────────────────
// Chat completion con FAILOVER de API keys.
//
// Todos los providers hablan el formato OpenAI chat-completions, así que el
// `payload` (que ya incluye `model`) viaja idéntico — solo cambian endpoint
// + Authorization. Esta función intenta cada key candidata en orden:
//   1. principal del tenant (gemini_api_key / openai_api_key)
//   2. las de respaldo (gemini_fallback_keys / openai_fallback_keys)
//   3. la env legacy (GEMINI_API_KEY / OPENAI_API_KEY) como último recurso
// Si una key falla con un status "rotable" (la falla es de esa key/cuenta o
// transitoria del provider) y quedan más keys, rota a la siguiente. En la
// ÚLTIMA key aplica el retry-with-backoff transitorio clásico (absorbe blips).
// ──────────────────────────────────────────────────────────────────────

const GEMINI_CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

/**
 * Lista de candidatos de key para el provider del modelo: principal +
 * respaldo (de DB) + env legacy, deduplicada y sin vacíos.
 */
export function candidateKeysFor(model: ActiveModel): string[] {
  const fromDb = model.provider === "openai" ? model.openai_api_keys : model.gemini_api_keys;
  const envKey = Deno.env.get(model.provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY");
  return dedupeNonEmpty([...fromDb, envKey]);
}

/**
 * Ejecuta un chat-completion con failover de keys. `payload` ya debe incluir
 * `model` (y messages/tools/tool_choice). Devuelve la primera respuesta OK o,
 * si todas las keys fallan, la última respuesta (para que el caller muestre el
 * error real). Lanza solo si NO hay ninguna key configurada, o si la última
 * key produce un error de red. La política de rotación vive en `ai-failover.ts`
 * (pura, testeable); acá solo se inyectan el fetch real y el sleep.
 */
export async function aiChatCompletionFailover(
  model: ActiveModel,
  // deno-lint-ignore no-explicit-any
  payload: Record<string, any>,
): Promise<Response> {
  const url = model.provider === "openai" ? OPENAI_CHAT_URL : GEMINI_CHAT_URL;
  const keys = candidateKeysFor(model);
  if (keys.length === 0) {
    const name = model.provider === "openai" ? "OpenAI" : "Gemini";
    throw new Error(`Falta la API key de ${name}. Configúrala en Configuración → Modelo IA.`);
  }
  const body = JSON.stringify(payload);
  return runKeyFailover<Response>(keys, {
    fetchWithKey: (key) =>
      fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
      }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onEvent: (ev) => {
      if (ev.kind === "rotate")
        console.warn(
          `[ai-model] key #${ev.index + 1}/${ev.total} falló (status ${ev.status}); rotando.`,
        );
      else if (ev.kind === "network-error")
        console.warn(`[ai-model] key #${ev.index + 1}/${ev.total} error de red.`);
      else if (ev.kind === "resolved" && ev.index > 0)
        console.log(`[ai-model] failover: resuelto con key #${ev.index + 1}/${ev.total}.`);
    },
  });
}
