// Edge function: health-check
//
// Endpoint de diagnostico llamado desde la pagina /app/admin/system.
// Reporta el estado de los componentes "externos" o de configuracion
// que la app frontend no puede inspeccionar por si misma:
//
//   - Versiones de runtime (Deno, region).
//   - Presencia (NO valor) de los secrets criticos de edge functions:
//     OPENAI_API_KEY, GEMINI_API_KEY, VAPID_*, GOOGLE_OAUTH_*,
//     PUSH_TRIGGER_SECRET.
//   - Provider de IA activo en ai_model_settings (leyendo desde
//     PostgREST con la service_role).
//
// Solo reporta presencia de secrets (boolean) — NUNCA el valor. Asi el
// admin puede ver desde la UI si falta algun secret sin tener que
// entrar al dashboard.

import { createClient } from "npm:@supabase/supabase-js@2.45.0";

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
    { name: "OPENAI_API_KEY", expected_prefix: "sk-" },
    { name: "GEMINI_API_KEY", expected_prefix: "AIza" },
    { name: "VAPID_PUBLIC_KEY", expected_prefix: "B" },
    { name: "VAPID_PRIVATE_KEY" },
    { name: "VAPID_SUBJECT", expected_prefix: "mailto:" },
    { name: "GOOGLE_OAUTH_CLIENT_ID" },
    { name: "GOOGLE_OAUTH_CLIENT_SECRET" },
    { name: "PUSH_TRIGGER_SECRET" },
    // SMTP — usados por la edge function send-email para correos de
    // notificación (calificación, mensaje nuevo, etc.). Si cualquiera
    // falta el correo falla con reason='smtp_env_missing'.
    { name: "SMTP_HOST" },
    { name: "SMTP_PORT" },
    { name: "SMTP_USER" },
    { name: "SMTP_PASSWORD" },
    { name: "EMAIL_FROM" },
    { name: "EMAIL_FROM_NAME" },
    { name: "APP_PUBLIC_URL", expected_prefix: "https://" },
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
    // Multi-tenant: con N tenants activos hay N filas is_active=true.
    // Health-check es diagnostico cross-tenant para el operador (SuperAdmin);
    // queremos saber "¿hay configuración en algún lado?". Usamos limit(1)
    // + order updated_at para mostrar la más reciente sin romper con
    // multiples filas.
    const { data } = await supa
      .from("ai_model_settings")
      .select("provider, model, updated_at")
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      .limit(1)
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

type DbExtensionInfo = { name: string; version: string; schema: string };

async function fetchDbExtensions(): Promise<DbExtensionInfo[] | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const supa = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supa as any).rpc("system_db_extensions");
    if (error) return null;
    return (data ?? []) as DbExtensionInfo[];
  } catch {
    return null;
  }
}

type EdgeFunctionStat = {
  function_name: string;
  last_invoked_at: string | null;
  last_action: string | null;
  last_severity: string | null;
};

async function fetchEdgeFunctionStats(): Promise<EdgeFunctionStat[] | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const supa = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supa as any).rpc("system_edge_function_stats");
    if (error) return null;
    return (data ?? []) as EdgeFunctionStat[];
  } catch {
    return null;
  }
}

type CronJobInfo = {
  jobname: string;
  schedule: string;
  command: string;
  active: boolean;
  last_run_at: string | null;
  last_status: string | null;
  last_message: string | null;
};

async function fetchCronJobs(): Promise<CronJobInfo[] | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const supa = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supa as any).rpc("system_cron_jobs");
    if (error) return null;
    return (data ?? []) as CronJobInfo[];
  } catch {
    return null;
  }
}

type StorageUsageInfo = {
  db_size_bytes: number;
  objects_size_bytes: number;
  objects_count: number;
  buckets_count: number;
  // Cuotas configuradas por admin en system_settings.
  db_quota_mb: number;
  storage_quota_mb: number;
  alert_threshold_pct: number;
};

async function fetchStorageUsage(): Promise<StorageUsageInfo | null> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const supa = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    // Combinamos RPC system_storage_usage() (bytes reales) + tabla
    // system_settings (cuotas + threshold). Si cualquiera falla,
    // retornamos null y el panel pinta "no disponible".
    const [usageRes, settingsRes] = await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supa as any).rpc("system_storage_usage"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (supa as any)
        .from("system_settings")
        .select("db_quota_mb, storage_quota_mb, alert_threshold_pct")
        .eq("id", 1)
        .maybeSingle(),
    ]);
    if (usageRes.error || !usageRes.data?.[0]) return null;
    const usage = usageRes.data[0];
    const settings = settingsRes.data ?? {
      db_quota_mb: 500,
      storage_quota_mb: 1024,
      alert_threshold_pct: 15,
    };
    return {
      db_size_bytes: Number(usage.db_size_bytes ?? 0),
      objects_size_bytes: Number(usage.objects_size_bytes ?? 0),
      objects_count: Number(usage.objects_count ?? 0),
      buckets_count: Number(usage.buckets_count ?? 0),
      db_quota_mb: settings.db_quota_mb,
      storage_quota_mb: settings.storage_quota_mb,
      alert_threshold_pct: settings.alert_threshold_pct,
    };
  } catch {
    return null;
  }
}

type StorageBucketInfo = { id: string; public: boolean; file_size_limit: number | null };

async function fetchStorageBuckets(): Promise<StorageBucketInfo[] | null> {
  // `supabase.storage.listBuckets()` desde el cliente del frontend
  // suele devolver 0 porque RLS de `storage.buckets` no permite SELECT
  // al rol `authenticated`. Usamos el service_role del edge function
  // para listar realmente lo que hay en el proyecto.
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  try {
    const supa = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await supa.storage.listBuckets();
    if (error) return null;
    return (data ?? []).map((b) => ({
      id: b.id,
      public: b.public,
      file_size_limit: b.file_size_limit,
    }));
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

  const [
    aiSettings,
    pushConfig,
    storageBuckets,
    dbExtensions,
    edgeFunctionStats,
    cronJobs,
    storageUsage,
  ] = await Promise.all([
    fetchAiSettings(),
    fetchPushConfig(),
    fetchStorageBuckets(),
    fetchDbExtensions(),
    fetchEdgeFunctionStats(),
    fetchCronJobs(),
    fetchStorageUsage(),
  ]);
  const secrets = checkSecrets();

  // El secret de IA "requerido" depende del provider activo. Si el
  // provider es 'gemini' y GEMINI_API_KEY no esta seteado, eso es un
  // problema concreto. Marcamos eso explicito para la UI.
  let requiredAiSecretMissing = false;
  let requiredAiSecretName: string | null = null;
  if (aiSettings?.provider) {
    const map: Record<string, string> = {
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
    storage: {
      // Devolvemos los buckets desde el server (service_role) porque
      // listBuckets() en el frontend con JWT de usuario suele devolver
      // 0 por RLS en storage.buckets.
      buckets: storageBuckets ?? [],
    },
    db: {
      // Extensiones de Postgres instaladas (nombre + versión + schema).
      // Útil para verificar que pg_net, vault, etc. están disponibles.
      // null si la RPC no existe (migración 20260523000004 no aplicada).
      extensions: dbExtensions,
    },
    edge_functions: edgeFunctionStats,
    // Lista de pg_cron jobs activos + su última ejecución. null si la
    // RPC no existe (migración 20260523000007 no aplicada) o si pg_cron
    // no está instalado. Empty array si todo OK pero no hay jobs.
    cron_jobs: cronJobs,
    // Uso de espacio (DB + storage). Incluye los bytes actuales + las
    // cuotas configuradas en system_settings + el threshold de alerta.
    // El panel lo usa para mostrar barras de progreso con free/used/total
    // y para destacar (rojo) cuando se cruza el umbral. `null` si la
    // migración 20260523000010 no se aplicó.
    storage_usage: storageUsage,
    secrets,
    received_payload: payload,
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
