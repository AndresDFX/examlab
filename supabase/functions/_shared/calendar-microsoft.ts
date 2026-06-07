/**
 * Helpers OAuth + REST de Microsoft Graph (Outlook Calendar + Teams)
 * para edge functions. Paralelo a `calendar-google.ts`.
 *
 * Diseño:
 *  - Endpoint OAuth común: `/common` → acepta cuentas personales
 *    (outlook.com, hotmail) + escuela/trabajo (Entra ID). Decisión
 *    de producto: ExamLab no restringe a un tenant Microsoft.
 *  - Scope `offline_access` es OBLIGATORIO para recibir refresh_token.
 *    Sin él, el primer login funciona pero al expirar el access_token
 *    (1h) el sync falla y no podemos refrescar.
 *  - Reuso la tabla `teacher_google_tokens` (nombre histórico) con la
 *    columna `provider` que ya existe. El PK actual es (teacher_id) →
 *    un docente solo puede tener 1 conexión activa, sea Google o
 *    Microsoft (decisión de producto: single connection per teacher).
 *  - Auto-Teams: el evento se crea con `isOnlineMeeting=true`. Si la
 *    cuenta no tiene licencia Teams o el tenant bloquea third-party
 *    apps, el evento se crea SIN link de Teams. El sync no aborta —
 *    el docente puede pegar un link manual después.
 */
import { adminClient } from "./calendar-google.ts";

// Endpoint OAuth común — acepta cuentas personales + escuela/trabajo.
// Si en el futuro queremos restringir a un solo tenant, cambiar a
// `/{tenant_id}/`. `/organizations` excluye personales.
const MS_AUTHORITY = "https://login.microsoftonline.com/common";
const MS_AUTH_URL = `${MS_AUTHORITY}/oauth2/v2.0/authorize`;
const MS_TOKEN_URL = `${MS_AUTHORITY}/oauth2/v2.0/token`;
const MS_GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Scopes mínimos para nuestro caso de uso.
 *  - openid/profile/email/User.Read → identificar al docente y traer su mail
 *  - offline_access → CRÍTICO: sin esto no llega refresh_token
 *  - Calendars.ReadWrite → crear/editar/borrar eventos
 *  - OnlineMeetings.ReadWrite → auto-crear reunión de Teams al sync
 *  No pedimos `Calendars.ReadWrite.Shared` — solo el calendario del
 *  propio docente, mismo alcance que Google. */
export const MS_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Calendars.ReadWrite",
  "OnlineMeetings.ReadWrite",
].join(" ");

export function getMicrosoftRedirectUri(): string {
  // Mismo callback que Google — la edge `calendar-oauth-callback`
  // routea por `calendar_oauth_states.provider` para distinguir.
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  return `${url}/functions/v1/calendar-oauth-callback`;
}

/** URL de consentimiento. El `state` es el mismo formato que Google
 *  (`<teacher_id>:<nonce>:<origin_b64>`) — la edge callback lo cruza
 *  contra `calendar_oauth_states` para validar.
 *
 *  `prompt=select_account` fuerza el chooser si el usuario tiene más
 *  de una cuenta MS logueada (común con personal + trabajo). Sin esto,
 *  MS usa silenciosamente la cuenta default — el docente podría
 *  conectar la cuenta equivocada y enterarse al ver el calendar list. */
export function buildMicrosoftAuthUrl(state: string): string {
  const clientId = Deno.env.get("MS_OAUTH_CLIENT_ID");
  if (!clientId) throw new Error("MS_OAUTH_CLIENT_ID no configurado");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getMicrosoftRedirectUri(),
    response_type: "code",
    response_mode: "query",
    scope: MS_SCOPES,
    state,
    prompt: "select_account",
  });
  return `${MS_AUTH_URL}?${params.toString()}`;
}

export interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  id_token?: string;
}

export async function exchangeCodeForMicrosoftTokens(
  code: string,
): Promise<MicrosoftTokenResponse> {
  const clientId = Deno.env.get("MS_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("MS_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Microsoft OAuth no configurado");

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: getMicrosoftRedirectUri(),
    grant_type: "authorization_code",
    scope: MS_SCOPES,
  });
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft token exchange falló [${res.status}]: ${text}`);
  }
  return (await res.json()) as MicrosoftTokenResponse;
}

async function refreshMicrosoftAccessToken(
  refreshToken: string,
): Promise<MicrosoftTokenResponse> {
  const clientId = Deno.env.get("MS_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("MS_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("Microsoft OAuth no configurado");
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    scope: MS_SCOPES,
  });
  const res = await fetch(MS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Microsoft refresh falló [${res.status}]: ${text}`);
  }
  return (await res.json()) as MicrosoftTokenResponse;
}

/** Devuelve un access_token vigente del docente para Microsoft Graph.
 *  Refresca si vence en <60s. Mantiene contrato análogo a Google.
 *
 *  Microsoft rota el refresh_token con frecuencia (rolling): cuando
 *  llega uno nuevo en la respuesta del refresh, hay que persistirlo
 *  para los siguientes ciclos. Sin esto, después de varias rotaciones
 *  el viejo deja de aceptarse y el docente pierde la conexión. */
export async function getValidMicrosoftAccessToken(teacherId: string): Promise<string> {
  const { data: row, error } = await adminClient
    .from("teacher_google_tokens")
    .select("refresh_token, access_token, expires_at")
    .eq("teacher_id", teacherId)
    .eq("provider", "microsoft")
    .maybeSingle();
  if (error) throw new Error(`No pude leer tokens: ${error.message}`);
  if (!row) throw new Error("not_connected");

  const expMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  const stillValid = row.access_token && expMs - Date.now() > 60_000;
  if (stillValid) return row.access_token!;

  const refreshed = await refreshMicrosoftAccessToken(row.refresh_token);
  const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  const updates: Record<string, unknown> = {
    access_token: refreshed.access_token,
    expires_at: newExpiry,
  };
  // Rolling refresh — persistir el nuevo refresh_token si vino.
  if (refreshed.refresh_token) updates.refresh_token = refreshed.refresh_token;
  await adminClient.from("teacher_google_tokens").update(updates).eq("teacher_id", teacherId);
  return refreshed.access_token;
}

/** Error tipado para llamadas a Microsoft Graph que fallan. Mismo patrón
 *  que `GoogleApiError` — expone `status` numérico para no depender de
 *  regex sobre el mensaje. */
export class MicrosoftApiError extends Error {
  status: number;
  path: string;
  responseBody: string;
  constructor(path: string, status: number, responseBody: string) {
    super(`Microsoft Graph ${path} falló [${status}]: ${responseBody}`);
    this.name = "MicrosoftApiError";
    this.status = status;
    this.path = path;
    this.responseBody = responseBody;
  }
}

/** True si el error representa un evento de Outlook que ya no existe
 *  (404/410). Mismo contrato que `isGoogleEventGoneError`. */
export function isMicrosoftEventGoneError(err: unknown): boolean {
  if (err instanceof MicrosoftApiError) {
    return err.status === 404 || err.status === 410;
  }
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\[(404|410)\]/.test(msg);
}

/** Wrapper de fetch contra Graph API. Auth bearer + refresh automático.
 *  El header `Prefer: outlook.timezone="UTC"` deja claro que las fechas
 *  van en UTC; el caller setea timeZone explícito en cada `start/end`. */
export async function callMicrosoft<T>(
  teacherId: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getValidMicrosoftAccessToken(teacherId);
  const res = await fetch(`${MS_GRAPH_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new MicrosoftApiError(path, res.status, text);
  }
  // Algunos endpoints (DELETE, PATCH 204) devuelven cuerpo vacío —
  // hay que evitar el .json() que rompe con "Unexpected end of input".
  if (res.status === 204) return null as T;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) return null as T;
  return (await res.json()) as T;
}

/** Decodifica el id_token de Microsoft (no verifica firma — solo extrae
 *  email/preferred_username). Útil para guardar `provider_email` sin
 *  hacer un round-trip extra a `/me`. */
export function decodeMicrosoftIdTokenEmail(idToken?: string): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    // `email` viene si pedimos scope `email`; `preferred_username` es el
    // fallback común (siempre presente, formato user@tenant.onmicrosoft.com
    // o cuenta personal). `upn` es legacy de Entra ID.
    return (
      (typeof payload.email === "string" && payload.email) ||
      (typeof payload.preferred_username === "string" && payload.preferred_username) ||
      (typeof payload.upn === "string" && payload.upn) ||
      null
    );
  } catch {
    return null;
  }
}

/** Obtiene el email primario del usuario via `/me`. Llamar solo si
 *  `decodeMicrosoftIdTokenEmail` retorna null — round-trip extra. */
export async function fetchMicrosoftUserEmail(teacherId: string): Promise<string | null> {
  try {
    const me = await callMicrosoft<{
      mail?: string | null;
      userPrincipalName?: string | null;
    }>(teacherId, "/me?$select=mail,userPrincipalName");
    return me.mail || me.userPrincipalName || null;
  } catch {
    return null;
  }
}
