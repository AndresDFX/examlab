// Callback público de OAuth. Google y Microsoft redirigen aquí con
// ?code&state después de que el docente acepta el consentimiento.
// Enrutamos por el `provider` persistido en `calendar_oauth_states`.
//
// Para que esto funcione, registrar EXACTAMENTE esta misma URI como
// "Authorized redirect URI" en CADA proveedor:
//   - Google Cloud Console → Credenciales
//   - Azure App Registration → Authentication → Redirect URIs
// URI:
//   https://<tu-proyecto>.supabase.co/functions/v1/calendar-oauth-callback
//
// Esta function NO requiere JWT (los providers no mandan Authorization).
// En la config del proyecto Supabase:
//   supabase/config.toml → [functions.calendar-oauth-callback]
//                          verify_jwt = false

import {
  adminClient,
  corsHeaders,
  decodeIdTokenEmail,
  exchangeCodeForTokens,
} from "../_shared/calendar-google.ts";
import {
  decodeMicrosoftIdTokenEmail,
  exchangeCodeForMicrosoftTokens,
  fetchMicrosoftUserEmail,
} from "../_shared/calendar-microsoft.ts";

type Provider = "google" | "microsoft";
const PROVIDER_LABEL: Record<Provider, string> = {
  google: "Google Calendar",
  microsoft: "Outlook / Microsoft 365",
};

/**
 * Inserta directo en audit_logs porque la RPC `log_audit_event` usa
 * auth.uid() y acá no hay JWT (Google llama público). Capturamos email
 * + role del docente con un SELECT manual para que la fila quede
 * indistinguible de las que escribe el frontend con la RPC.
 */
async function auditCalendarConnect(
  teacherId: string,
  severity: "info" | "error",
  action: string,
  provider: Provider | null,
  metadata: Record<string, unknown>,
) {
  try {
    // El email del docente vive en auth.users — el adminClient bypassea RLS.
    const { data: u } = await adminClient.auth.admin.getUserById(teacherId);
    const email = u?.user?.email ?? null;
    const { data: r } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", teacherId)
      .maybeSingle();
    await adminClient.from("audit_logs").insert({
      actor_id: teacherId,
      actor_email: email,
      actor_role: r?.role ?? "Docente",
      action,
      category: "system",
      severity,
      entity_type: "calendar_connection",
      entity_id: teacherId,
      entity_name: provider ? PROVIDER_LABEL[provider] : "Calendar",
      metadata,
    });
  } catch (_) {
    // Auditoría es best-effort — nunca abortar el flujo OAuth por esto.
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Helper para construir la redirección de vuelta al frontend.
  // Si pudimos parsear el origin del state lo usamos; si no, caemos al
  // origin del request (último recurso — debería ser el published URL).
  const redirectBack = (origin: string, params: Record<string, string>) => {
    const target = new URL(`${origin}/app/teacher/calendar`);
    for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
    return Response.redirect(target.toString(), 302);
  };

  // Parse del state: <teacher_id>:<nonce>:<origin_b64>
  const parts = (state ?? "").split(":");
  const teacherId = parts[0] ?? "";
  const originB64 = parts.slice(2).join(":");
  let origin = url.origin; // fallback
  try {
    // Volver a agregar padding al base64url para atob.
    const padded = originB64 + "=".repeat((4 - (originB64.length % 4)) % 4);
    origin = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    // Si el decode falla, redirigimos al origin del request (que será
    // el dominio de Supabase). El user va a ver un 404 — toca contactarnos.
  }

  if (error) {
    if (teacherId) {
      await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", null, {
        reason: error,
      });
    }
    return redirectBack(origin, { err: error });
  }
  if (!code || !state || !teacherId) {
    return redirectBack(origin, { err: "missing_params" });
  }

  // OAUTH-1/2: validar el state contra calendar_oauth_states (one-time +
  // no expirado). El provider sale de esta fila — el `init` lo persiste
  // cuando crea el state. Sin esto no sabríamos a qué proveedor pedirle
  // el token exchange.
  const { data: stateRow, error: stateErr } = await adminClient
    .from("calendar_oauth_states")
    .select("teacher_id, origin, expires_at, consumed_at, provider")
    .eq("state", state)
    .maybeSingle();
  if (stateErr || !stateRow) {
    await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", null, {
      reason: "invalid_state",
    });
    return redirectBack(origin, { err: "invalid_state" });
  }
  if (stateRow.consumed_at) {
    await auditCalendarConnect(
      teacherId,
      "error",
      "calendar.connect_failed",
      (stateRow.provider ?? null) as Provider | null,
      { reason: "state_replayed" },
    );
    return redirectBack(origin, { err: "state_replayed" });
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    return redirectBack(origin, { err: "state_expired" });
  }
  if (stateRow.teacher_id !== teacherId) {
    return redirectBack(origin, { err: "state_mismatch" });
  }
  const provider: Provider =
    stateRow.provider === "microsoft" ? "microsoft" : "google";
  // Origin verificado del lado servidor — más confiable que el b64 del state.
  origin = stateRow.origin || origin;
  await adminClient
    .from("calendar_oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state", state);

  try {
    // ── Token exchange por provider ──
    let access_token: string;
    let refresh_token: string | undefined;
    let expires_in: number;
    let email: string | null;

    if (provider === "microsoft") {
      const tok = await exchangeCodeForMicrosoftTokens(code);
      access_token = tok.access_token;
      refresh_token = tok.refresh_token;
      expires_in = tok.expires_in;
      // Intentamos sacar el email del id_token primero (rápido, sin
      // round-trip extra). Si falla, llamamos /me — pero eso requiere
      // un access_token vigente, que recién tendremos persistido.
      email = decodeMicrosoftIdTokenEmail(tok.id_token);
    } else {
      const tok = await exchangeCodeForTokens(code);
      access_token = tok.access_token;
      refresh_token = tok.refresh_token;
      expires_in = tok.expires_in;
      email = decodeIdTokenEmail(tok.id_token);
    }

    if (!refresh_token) {
      await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", provider, {
        reason: "no_refresh_token",
      });
      return redirectBack(origin, { err: "no_refresh_token" });
    }
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // CAMBIO DE PROVIDER: la PK actual es (teacher_id) — un docente
    // solo puede tener 1 conexión activa, sea Google o Microsoft
    // (decisión de producto: single connection). El UPSERT pisa la
    // fila anterior con el nuevo provider. La columna `google_email`
    // queda histórica; para conexiones MS la dejamos en null.
    const upsertPayload: Record<string, unknown> = {
      teacher_id: teacherId,
      provider,
      provider_email: email,
      refresh_token,
      access_token,
      expires_at: expiresAt,
      // Limpiar calendar_id/name si el provider cambió — la lista de
      // calendarios es distinta entre Google y Microsoft. El docente
      // elige nuevo desde el panel.
      calendar_id: null,
      calendar_name: null,
    };
    if (provider === "google") {
      upsertPayload.google_email = email;
    } else {
      upsertPayload.google_email = null;
    }
    const { error: upErr } = await adminClient
      .from("teacher_google_tokens")
      .upsert(upsertPayload);
    if (upErr) {
      await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", provider, {
        reason: `db:${upErr.message}`,
      });
      return redirectBack(origin, { err: `db:${upErr.message}` });
    }

    // Si no pudimos sacar el email del id_token (Microsoft a veces no
    // lo trae cuando el scope `email` no aplica), pedimos a /me y
    // actualizamos in-place. Best-effort — no rompe el flow si falla.
    if (!email && provider === "microsoft") {
      const fetched = await fetchMicrosoftUserEmail(teacherId);
      if (fetched) {
        await adminClient
          .from("teacher_google_tokens")
          .update({ provider_email: fetched })
          .eq("teacher_id", teacherId);
        email = fetched;
      }
    }

    await auditCalendarConnect(teacherId, "info", "calendar.connected", provider, {
      provider_email: email,
    });
    return redirectBack(origin, { ok: "1", provider });
  } catch (e) {
    const msg = (e as Error).message;
    await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", provider, {
      reason: msg,
    });
    return redirectBack(origin, { err: msg });
  }
});
