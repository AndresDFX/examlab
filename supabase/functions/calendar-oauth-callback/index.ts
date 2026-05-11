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

  if (error) return redirectBack(origin, { err: error });
  if (!code || !state || !teacherId) {
    return redirectBack(origin, { err: "missing_params" });
  }

  try {
    const tok = await exchangeCodeForTokens(code);
    if (!tok.refresh_token) {
      // Google no devolvió refresh_token. Pasa cuando el docente ya
      // autorizó antes y la app no pidió prompt=consent — pero
      // buildGoogleAuthUrl ya lo agrega. Si igual cae acá, le pedimos
      // que vaya a https://myaccount.google.com/permissions, revoque
      // el acceso a ExamLab y reintente.
      return redirectBack(origin, { err: "no_refresh_token" });
    }
    const expiresAt = new Date(Date.now() + tok.expires_in * 1000).toISOString();
    const email = decodeIdTokenEmail(tok.id_token);

    const { error: upErr } = await adminClient.from("teacher_google_tokens").upsert({
      teacher_id: teacherId,
      provider: "google",
      provider_email: email,
      google_email: email, // back-compat con la columna vieja
      refresh_token: tok.refresh_token,
      access_token: tok.access_token,
      expires_at: expiresAt,
    });
    if (upErr) return redirectBack(origin, { err: `db:${upErr.message}` });

    return redirectBack(origin, { ok: "1" });
  } catch (e) {
    return redirectBack(origin, { err: (e as Error).message });
  }
});
