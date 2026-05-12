// Edge function: health-check
//
// Endpoint trivial para validar que el pipeline de deploy de edge
// functions del nuevo Supabase funciona end-to-end. Llamada desde el
// boton "Probar edge function" en la pagina de admin de Supabase
// (src/routes/app.admin.supabase.tsx).
//
// Devuelve un JSON con timestamp del servidor, region (si se puede
// detectar) y un eco del payload — util para confirmar que la funcion
// se desplego con el ultimo commit y que la app llega a ella.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let payload: unknown = null;
  if (req.method === "POST") {
    try {
      payload = await req.json();
    } catch {
      payload = null;
    }
  }

  const body = {
    status: "ok",
    message: "Edge functions del nuevo Supabase funcionando correctamente.",
    timestamp: new Date().toISOString(),
    deno_version: Deno.version.deno,
    region: Deno.env.get("SB_REGION") ?? Deno.env.get("DENO_REGION") ?? "unknown",
    received_payload: payload,
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
