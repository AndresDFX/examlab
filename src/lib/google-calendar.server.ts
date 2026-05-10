// Helpers de OAuth + REST de Google Calendar para los server functions.
// SOLO se importa desde *.functions.ts y desde la server route del callback —
// nunca desde código de cliente (usa SUPABASE_SERVICE_ROLE_KEY).

import { supabaseAdmin } from "@/integrations/supabase/client.server";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

/** URL de redirect del OAuth. Debe coincidir con la registrada en Google Cloud. */
export function getRedirectUri(origin?: string): string {
  // Preferimos el origin del request (preview/published/custom). Si no hay,
  // caemos al published estable.
  const base = origin ?? "https://examlab.lovable.app";
  return `${base}/api/public/google-oauth-callback`;
}

export function buildAuthUrl(state: string, origin: string): string {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) throw new Error("GOOGLE_OAUTH_CLIENT_ID no configurado");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(origin),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    // prompt=consent fuerza que Google nos vuelva a dar refresh_token
    // incluso si el usuario ya autorizó antes — necesario en re-conexiones.
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  id_token?: string;
}

export async function exchangeCodeForTokens(
  code: string,
  origin: string,
): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Google OAuth no configurado");
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getRedirectUri(origin),
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
  return (await res.json()) as TokenResponse;
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
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
  return (await res.json()) as TokenResponse;
}

/** Devuelve un access_token vigente para el docente, refrescándolo si falta < 60s. */
export async function getValidAccessToken(teacherId: string): Promise<string> {
  const { data: row, error } = await supabaseAdmin
    .from("teacher_google_tokens")
    .select("refresh_token, access_token, expires_at")
    .eq("teacher_id", teacherId)
    .maybeSingle();
  if (error) throw new Error(`No pude leer tokens: ${error.message}`);
  if (!row) throw new Error("not_connected");

  const expMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const stillValid = row.access_token && expMs - Date.now() > 60_000;
  if (stillValid) return row.access_token!;

  const refreshed = await refreshAccessToken(row.refresh_token);
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  await supabaseAdmin
    .from("teacher_google_tokens")
    .update({ access_token: refreshed.access_token, expires_at: newExpiry })
    .eq("teacher_id", teacherId);
  return refreshed.access_token;
}

/** Wrapper simple para llamadas a Calendar API con auth bearer. */
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

/** Decodifica el id_token de Google (no verifica firma — solo extrae el email). */
export function decodeIdTokenEmail(idToken?: string): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    );
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}
