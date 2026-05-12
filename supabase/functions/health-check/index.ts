// Edge function: health-check
//
// Endpoint de diagnostico llamado desde la pagina /app/admin/system.
// Reporta el estado de los componentes "externos" o de configuracion
// que la app frontend no puede inspeccionar por si misma:
//
//   - Versiones de runtime (Deno, region).
//   - Presencia (NO valor) de los secrets criticos de edge functions:
//     LOVABLE_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, VAPID_*,
//     GOOGLE_OAUTH_*, PUSH_TRIGGER_SECRET.
//   - Provider de IA activo en ai_model_settings (leyendo desde
//     PostgREST con la service_role).
//
// Solo reporta presencia de secrets (boolean) — NUNCA el valor. Asi el
// admin puede ver desde la UI si falta algun secret sin tener que
// entrar al dashboard.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type SecretCheck = {
  name: string;
  present: boolean;
  // Pista util sin exponer el secret: solo el prefijo esperado, asi
  // el admin puede detectar "puse el secret incorrecto" desde la UI.
  expected_prefix?: string;
};

function checkSecrets(): SecretCheck[] {
  const defs: Array<{ name: string; expected_prefix?: string }> = [
    { name: "LOVABLE_API_KEY", expected_prefix: "sk_" },
    { name: "OPENAI_API_KEY", expected_prefix: "sk-" },
    { name: "GEMINI_API_KEY", expected_prefix: "AIza" },
    { name: "VAPID_PUBLIC_KEY", expected_prefix: "B" },
    { name: "VAPID_PRIVATE_KEY" },
    { name: "VAPID_SUBJECT", expected_prefix: "mailto:" },
    { name: "GOOGLE_OAUTH_CLIENT_ID" },
    { name: "GOOGLE_OAUTH_CLIENT_SECRET" },
    { name: "PUSH_TRIGGER_SECRET" },
  ];
  return defs.map((d) => ({
    name: d.name,
    present: Boolean(Deno.env.get(d.name)),
    expected_prefix: d.expected_prefix,
  }));
}

type AiSettings = { provider: string | null; model: string | null; updated_at: string | null };

async function fetchAiSettings(): Promise<AiSettings | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const supa = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await supa
      .from("ai_model_settings")
      .select("provider, model, updated_at")
      .eq("is_active", true)
      .maybeSingle();
    return (data as AiSettings) ?? null;
  } catch {
    return null;
  }
}

async function fetchPushConfig(): Promise<{ send_push_url: string | null } | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const supa = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await supa
      .from("push_config")
      .select("send_push_url")
      .eq("id", 1)
      .maybeSingle();
    return data as { send_push_url: string | null } | null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let payload: unknown = null;
  if (req.method === "POST") {
    try {
      payload = await req.json();
    } catch {
      payload = null;
    }
  }

  const [aiSettings, pushConfig] = await Promise.all([fetchAiSettings(), fetchPushConfig()]);
  const secrets = checkSecrets();

  // El secret de IA "requerido" depende del provider activo. Si el
  // provider es 'gemini' y GEMINI_API_KEY no esta seteado, eso es un
  // problema concreto. Marcamos eso explicito para la UI.
  let requiredAiSecretMissing = false;
  let requiredAiSecretName: string | null = null;
  if (aiSettings?.provider) {
    const map: Record<string, string> = {
      lovable: "LOVABLE_API_KEY",
      openai: "OPENAI_API_KEY",
      gemini: "GEMINI_API_KEY",
    };
    requiredAiSecretName = map[aiSettings.provider] ?? null;
    if (requiredAiSecretName) {
      const s = secrets.find((x) => x.name === requiredAiSecretName);
      requiredAiSecretMissing = !s?.present;
    }
  }

  const body = {
    status: "ok",
    message: "Edge functions del nuevo Supabase funcionando correctamente.",
    timestamp: new Date().toISOString(),
    runtime: {
      deno_version: Deno.version.deno,
      region: Deno.env.get("SB_REGION") ?? Deno.env.get("DENO_REGION") ?? "unknown",
    },
    ai: {
      active_provider: aiSettings?.provider ?? null,
      active_model: aiSettings?.model ?? null,
      updated_at: aiSettings?.updated_at ?? null,
      required_secret: requiredAiSecretName,
      required_secret_missing: requiredAiSecretMissing,
    },
    push: {
      send_push_url: pushConfig?.send_push_url ?? null,
      // Util para detectar que tras la migracion la URL sigue apuntando
      // al Supabase viejo (problema clasico despues del restore).
      points_to_current_project: pushConfig?.send_push_url
        ? pushConfig.send_push_url.includes(Deno.env.get("SUPABASE_URL") ?? "__nope__")
        : null,
    },
    secrets,
    received_payload: payload,
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
