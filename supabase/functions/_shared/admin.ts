// Singleton service-role Supabase client compartido entre todas las
// edge functions.
//
// Antes cada handler creaba su propio `createClient(SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY)`. Eso duplicaba boilerplate (8 imports +
// 3 líneas de creación), y en algunos casos lo hacía DENTRO del handler
// — lo que regenera el cliente en cada request, sin reusar conexiones.
//
// Acá lo exportamos una sola vez por instancia de Deno. La primera
// llamada lo crea; las siguientes lo reusan. Sigue siendo SECURITY
// CRITICAL — solo usar en server-side, nunca exponer la key.

import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_KEY) {
  // No tiramos en module-load para no romper el cold start de cada
  // función — algunas (calendar-ics) pueden booteear sin que esto sea
  // crítico de inmediato. Pero logueamos para detectar misconfig rápido.
  console.warn("[admin] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — adminClient inviable");
}

export const adminClient = createClient(SUPABASE_URL ?? "", SERVICE_KEY ?? "");

/**
 * Crea un cliente con JWT del usuario (no service-role). Útil para
 * `auth.getUser()` y queries que deben respetar RLS. Devuelve null si
 * no hay Authorization header.
 */
export function userClientFromRequest(req: Request) {
  const auth = req.headers.get("Authorization");
  if (!auth) return null;
  const anonKey =
    Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";
  return createClient(SUPABASE_URL ?? "", anonKey, {
    global: { headers: { Authorization: auth } },
  });
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Respuesta JSON estandarizada (status + payload). Las edge functions
 * la usan para no replicar `new Response(JSON.stringify(...), { headers })`
 * en cada return.
 */
export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Atajo para errores. Siempre devuelve `{ error: msg }` con el status. */
export function jsonError(error: string, status = 500): Response {
  return jsonResponse({ error }, status);
}
