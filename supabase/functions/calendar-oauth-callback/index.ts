// Callback público de OAuth. Google redirige aquí con ?code&state
// después de que el docente acepta el consentimiento. Intercambia el
// `code` por tokens y los guarda en teacher_google_tokens.
//
// Para que esto funcione DESDE Google: la URI registrada en Google
// Cloud Console → Credenciales → "Authorized redirect URIs" debe ser
// EXACTAMENTE:
//   https://<tu-proyecto>.supabase.co/functions/v1/calendar-oauth-callback
//
// Esta function NO requiere JWT (Google no manda Authorization). En la
// config del proyecto Supabase, hay que marcarla como pública:
//   supabase/config.toml → [functions.calendar-oauth-callback]
//                          verify_jwt = false

import {
  adminClient,
  corsHeaders,
  decodeIdTokenEmail,
  exchangeCodeForTokens,
} from "../_shared/calendar-google.ts";

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
      entity_name: "Google Calendar",
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
      await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", {
        provider: "google",
        reason: error,
      });
    }
    return redirectBack(origin, { err: error });
  }
  if (!code || !state || !teacherId) {
    return redirectBack(origin, { err: "missing_params" });
  }

  // OAUTH-1/2: validar el state contra calendar_oauth_states (one-time + no expirado).
  // Marca consumed_at para que un replay del callback no permita reusarlo.
  const { data: stateRow, error: stateErr } = await adminClient
    .from("calendar_oauth_states")
    .select("teacher_id, origin, expires_at, consumed_at")
    .eq("state", state)
    .maybeSingle();
  if (stateErr || !stateRow) {
    await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", {
      provider: "google",
      reason: "invalid_state",
    });
    return redirectBack(origin, { err: "invalid_state" });
  }
  if (stateRow.consumed_at) {
    await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", {
      provider: "google",
      reason: "state_replayed",
    });
    return redirectBack(origin, { err: "state_replayed" });
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    return redirectBack(origin, { err: "state_expired" });
  }
  if (stateRow.teacher_id !== teacherId) {
    return redirectBack(origin, { err: "state_mismatch" });
  }
  // Origin verificado del lado servidor — más confiable que el b64 del state.
  origin = stateRow.origin || origin;
  await adminClient
    .from("calendar_oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state", state);

  try {
    const tok = await exchangeCodeForTokens(code);
    if (!tok.refresh_token) {
      await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", {
        provider: "google",
        reason: "no_refresh_token",
      });
      return redirectBack(origin, { err: "no_refresh_token" });
    }
    const expiresAt = new Date(Date.now() + tok.expires_in * 1000).toISOString();
    const email = decodeIdTokenEmail(tok.id_token);

    const { error: upErr } = await adminClient.from("teacher_google_tokens").upsert({
      teacher_id: teacherId,
      provider: "google",
      provider_email: email,
      google_email: email,
      refresh_token: tok.refresh_token,
      access_token: tok.access_token,
      expires_at: expiresAt,
    });
    if (upErr) {
      await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", {
        provider: "google",
        reason: `db:${upErr.message}`,
      });
      return redirectBack(origin, { err: `db:${upErr.message}` });
    }

    await auditCalendarConnect(teacherId, "info", "calendar.connected", {
      provider: "google",
      provider_email: email,
    });
    return redirectBack(origin, { ok: "1", provider: "google" });
  } catch (e) {
    const msg = (e as Error).message;
    await auditCalendarConnect(teacherId, "error", "calendar.connect_failed", {
      provider: "google",
      reason: msg,
    });
    return redirectBack(origin, { err: msg });
  }
});
