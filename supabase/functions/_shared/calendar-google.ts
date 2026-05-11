/**
 * Helpers OAuth + REST de Google Calendar para edge functions.
 *
 * Por qué viven acá y no en `src/lib/google-calendar.server.ts`:
 *   El proyecto corre en Lovable Cloud como un SPA + Supabase. NO hay
 *   runtime Node/Bun para ejecutar `createServerFn` ni
 *   `Route.server.handlers` de TanStack Start. Toda la lógica de
 *   servidor que toca secretos (CLIENT_SECRET, service_role) vive
 *   exclusivamente acá, en Deno edge functions.
 *
 * Cuando agreguemos Outlook, este archivo se queda intacto y se crea
 * un `calendar-microsoft.ts` paralelo. El edge function `calendar` (RPC)
 * decide cuál importar según `provider`.
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Scopes mínimos: leer/escribir eventos del docente + identificarlo.
 *  - calendar.events → crear/editar/borrar eventos en sus calendarios
 *  - calendar.readonly → listar sus calendarios para el selector
 *  - userinfo.email → guardar a qué cuenta Google quedó vinculado */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
  "openid",
].join(" ");

/** URI de redirect — apunta a la edge function pública `calendar-oauth-callback`.
 *  Debe estar REGISTRADA tal cual en Google Cloud Console → Credenciales. */
export function getRedirectUri(): string {
  // El callback vive en `${SUPABASE_URL}/functions/v1/calendar-oauth-callback`.
  // Es el único endpoint público que recibe el `?code` de Google.
  return `${SUPABASE_URL}/functions/v1/calendar-oauth-callback`;
}

/**
 * Construye la URL de consentimiento. El `state` opaco es
 *   `<teacher_id>:<nonce>:<origin_b64>`
 * El callback la parsea para saber a quién pertenece la conexión y a
 * dónde redirigir cuando termine (preview vs published URL).
 */
export function buildGoogleAuthUrl(state: string): string {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  if (!clientId) throw new Error("GOOGLE_OAUTH_CLIENT_ID no configurado");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES,
    access_type: "offline",
    // prompt=consent fuerza a Google a devolver refresh_token aun
    // cuando el usuario ya autorizó antes (re-conexión). Sin esto, la
    // 2ª vez no llega refresh_token y al refrescar el access_token
    // explota.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
}

export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Google OAuth no configurado");

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getRedirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange falló [${res.status}]: ${text}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

async function refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Google OAuth no configurado");
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google refresh falló [${res.status}]: ${text}`);
  }
  return (await res.json()) as GoogleTokenResponse;
}

/**
 * Devuelve un access_token vigente del docente. Si está por vencer
 * (<60s), lo refresca y persiste el nuevo + expires_at.
 */
export async function getValidAccessToken(teacherId: string): Promise<string> {
  const { data: row, error } = await adminClient
    .from("teacher_google_tokens")
    .select("refresh_token, access_token, expires_at")
    .eq("teacher_id", teacherId)
    .eq("provider", "google")
    .maybeSingle();
  if (error) throw new Error(`No pude leer tokens: ${error.message}`);
  if (!row) throw new Error("not_connected");

  const expMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const stillValid = row.access_token && expMs - Date.now() > 60_000;
  if (stillValid) return row.access_token!;

  const refreshed = await refreshAccessToken(row.refresh_token);
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await adminClient
    .from("teacher_google_tokens")
    .update({ access_token: refreshed.access_token, expires_at: newExpiry })
    .eq("teacher_id", teacherId);
  return refreshed.access_token;
}

/** Wrapper de fetch contra Google API con auth bearer + refresh automático. */
export async function callGoogle<T>(
  teacherId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getValidAccessToken(teacherId);
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google API ${path} falló [${res.status}]: ${text}`);
  }
  return (await res.json()) as T;
}

/** Decodifica el id_token de Google (no verifica firma — solo extrae el email).
 *  Útil para guardar `provider_email` sin un round trip extra a userinfo. */
export function decodeIdTokenEmail(idToken?: string): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    // Deno tiene atob/Uint8Array nativos.
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

/** Extrae el user_id del JWT que viene del cliente — el `auth` header
 *  trae el access_token de Supabase, lo intercambiamos contra getUser. */
export async function getUserIdFromRequest(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user.id;
}
