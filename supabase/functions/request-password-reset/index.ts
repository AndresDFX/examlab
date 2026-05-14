// ──────────────────────────────────────────────────────────────────────
// request-password-reset — paso 1 del flujo de recuperación de
// contraseña custom (reemplaza a supabase.auth.resetPasswordForEmail).
//
// Por qué un edge propio:
//  - Para que el correo salga vía nuestro pipeline (send-email + Brevo)
//    con el template unificado, no con la plantilla de Supabase Auth.
//  - Para controlar el flujo: tokens 1h single-use, audit log, no leak
//    si la cuenta existe.
//
// Flow:
//  1. Recibe { email } por POST. Anon-callable (el user no está logueado).
//  2. Busca user_id por institutional_email. Si no existe, devuelve
//     200 OK genérico (no leak de enumeración).
//  3. Genera token random URL-safe de 32 chars (crypto.getRandomValues).
//  4. INSERT en password_reset_tokens con expires_at = NOW + 1h.
//  5. INSERT en notifications con kind='system' + link a /auth/reset-password?token=X.
//     El trigger notifications_send_email dispara el correo automático
//     con el template unificado.
//  6. Retorna 200 OK siempre (sin distinguir si email existía o no).
// ──────────────────────────────────────────────────────────────────────

import { adminClient, corsHeaders, jsonError, jsonResponse } from "../_shared/admin.ts";

/** Genera un token URL-safe de aprox 43 chars (32 bytes en base64url).
 *  Suficiente entropía (256 bits) para que adivinarlo sea infeasible. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64 estándar → reemplazo a base64url (URL-safe) sin padding.
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method_not_allowed", 405);

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }

  const email = body?.email?.trim().toLowerCase();
  if (!email) return jsonError("missing_email", 400);

  // 1) Buscar usuario por institutional_email. Si no existe, responder
  //    OK genérico (no leak). Lookup case-insensitive (ilike) para
  //    tolerar variaciones de mayúsculas que el usuario haya tipeado.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile } = await (adminClient as any)
    .from("profiles")
    .select("id, full_name")
    .ilike("institutional_email", email)
    .maybeSingle();

  if (!profile?.id) {
    // No-enumeration: devolvemos OK genérico, dormimos un poco para
    // que el timing de respuesta no permita distinguir cuentas válidas
    // de inválidas.
    await new Promise((r) => setTimeout(r, 200));
    return jsonResponse({ ok: true, sent: false, generic: true });
  }

  // 2) Generar token + persistir
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h
  const requestIp =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const requestUa = req.headers.get("user-agent")?.slice(0, 500) ?? null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: tokErr } = await (adminClient as any).from("password_reset_tokens").insert({
    user_id: profile.id,
    token,
    expires_at: expiresAt,
    request_ip: requestIp,
    request_ua: requestUa,
  });
  if (tokErr) {
    console.error("[request-password-reset] token insert", tokErr);
    return jsonError("internal_error", 500);
  }

  // 3) Insert notif → trigger envía correo automático con template unificado.
  //    El link va con el token; expires_at no se incluye en URL — el
  //    confirm endpoint chequea la DB.
  const linkPath = `/auth/reset-password?token=${encodeURIComponent(token)}`;
  const firstName = profile.full_name?.split(" ")[0] ?? "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: notifErr } = await (adminClient as any).from("notifications").insert({
    user_id: profile.id,
    title: "Recuperar contraseña — ExamLab",
    body:
      (firstName ? `Hola ${firstName}, recibimos` : "Recibimos") +
      " una solicitud para restablecer la contraseña de tu cuenta en ExamLab. " +
      "Haz click en el botón abajo para definir una nueva contraseña.\n\n" +
      "El enlace es válido por 1 hora y solo puede usarse una vez.\n\n" +
      "Si NO solicitaste este cambio, ignora este correo — tu contraseña no cambiará.",
    kind: "system",
    link: linkPath,
  });
  if (notifErr) {
    console.error("[request-password-reset] notif insert", notifErr);
    return jsonError("internal_error", 500);
  }

  return jsonResponse({ ok: true, sent: true });
});
