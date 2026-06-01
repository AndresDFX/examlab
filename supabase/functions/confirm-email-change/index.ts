// ──────────────────────────────────────────────────────────────────────
// confirm-email-change — paso 2 del flujo custom (con delay de 24h).
//
// IMPORTANTE: a diferencia del flujo anterior, este endpoint YA NO
// aplica el cambio en auth.users — solo marca `confirmed_at` y agenda
// `apply_after = NOW + 24h`. El cron job
// `apply_pending_email_changes_15min` aplica los cambios pasado ese
// delay (si no fueron cancelados desde el correo viejo).
//
// Flow:
//  1. Recibe { token } por POST. Anon-callable.
//  2. Busca el token. Valida: existe, no usado, no expirado, no
//     confirmado todavia, no cancelado.
//  3. Verifica que el new_email no este tomado por otro user.
//  4. Marca confirmed_at = NOW + apply_after = NOW + DELAY_MS.
//  5. Manda un SEGUNDO aviso al correo VIEJO: "tu cambio fue
//     confirmado y se aplicara en 24h, cancela aqui si no fuiste tu".
//     Best-effort: si falla, igualmente respondemos OK al usuario que
//     confirmo desde el nuevo correo — el primer aviso ya se envio
//     al solicitar el cambio.
//  6. Audit log.
//  7. Retorna { ok: true, newEmail, applyAfter } al cliente.
// ──────────────────────────────────────────────────────────────────────

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { adminClient, corsHeaders, jsonError, jsonResponse } from "../_shared/admin.ts";

// Delay de seguridad ANTES de aplicar el cambio confirmado. 24h es el
// estandar de la industria (GitHub, Google) — balance entre UX y
// ventana defensiva contra toma de cuenta.
const DELAY_MS = 24 * 60 * 60 * 1000;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Segundo aviso al correo VIEJO: notifica que el cambio fue confirmado
 * desde el nuevo correo, y se aplicara en 24h salvo cancelacion.
 */
function renderConfirmedNoticeHtml(params: {
  recipientName: string | null;
  newEmail: string;
  cancelUrl: string;
  applyAt: Date;
  brandName: string;
}): string {
  const brand = escapeHtml(params.brandName);
  const newEmail = escapeHtml(params.newEmail);
  const url = escapeHtml(params.cancelUrl);
  const greeting = params.recipientName
    ? `Hola ${escapeHtml(params.recipientName.split(" ")[0] ?? params.recipientName)},`
    : "Hola,";
  const applyAtStr = escapeHtml(
    params.applyAt.toLocaleString("es-CO", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Bogota",
    }),
  );
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Cambio de correo confirmado — pendiente de aplicar</title></head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f4f5; padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px; background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="padding:24px 32px; border-bottom:1px solid #e5e7eb;">
          <span style="font-size:18px; font-weight:600; color:#2563eb;">${brand}</span>
        </td></tr>
        <tr><td style="padding:28px 32px 8px 32px;">
          <p style="margin:0 0 16px 0; font-size:14px; color:#6b7280;">${greeting}</p>
          <p style="margin:0 0 12px 0; font-size:16px; font-weight:600; color:#111827; line-height:1.4;">
            ⏳ El cambio de tu correo fue confirmado
          </p>
          <p style="margin:0 0 12px 0; font-size:14px; color:#374151; line-height:1.6;">
            Alguien confirmó (desde el nuevo correo) el cambio a:
          </p>
          <p style="margin:0 0 16px 0; font-size:14px; font-weight:600; color:#111827; padding:10px 12px; background-color:#f3f4f6; border-radius:6px; word-break:break-all;">
            ${newEmail}
          </p>
          <p style="margin:0 0 12px 0; font-size:14px; color:#374151; line-height:1.6;">
            Por seguridad, el cambio se aplicará el:
          </p>
          <p style="margin:0 0 16px 0; font-size:14px; font-weight:600; color:#92400e; padding:10px 12px; background-color:#fef3c7; border-radius:6px;">
            ${applyAtStr} (Colombia)
          </p>
          <p style="margin:0; font-size:14px; color:#374151; line-height:1.6;">
            Si ese fuiste tú y reconoces la solicitud, no hace falta hacer nada — el cambio se aplicará automáticamente. Tu correo actual seguirá funcionando hasta ese momento.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px 8px 32px;">
          <p style="margin:0 0 12px 0; font-size:14px; font-weight:600; color:#dc2626;">
            ¿No lo solicitaste? Cancela antes de que se aplique:
          </p>
        </td></tr>
        <tr><td style="padding:0 0 8px 0; text-align:center;">
          <a href="${url}" style="display:inline-block; background-color:#dc2626; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:500; font-size:14px;">
            Cancelar el cambio
          </a>
        </td></tr>
        <tr><td style="padding:16px 32px 24px 32px; border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 10px 0; padding:10px 12px; font-size:12px; color:#7f1d1d; background-color:#fee2e2; border-left:3px solid #dc2626; line-height:1.5;">
            <strong>🚨 Si sospechas un intento de toma de cuenta,</strong> cancela arriba y cambia tu contraseña inmediatamente.
          </p>
          <p style="margin:0; font-size:11px; color:#9ca3af; line-height:1.5;">
            Este correo es automático. No respondas a este mensaje.
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method_not_allowed", 405);

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }
  const token = body?.token?.trim();
  if (!token) return jsonError("missing_token", 400);

  // 1) Buscar token + validar estado.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error: lookupErr } = await (adminClient as any)
    .from("email_change_tokens")
    .select("id, user_id, new_email, cancel_token, used_at, expires_at, confirmed_at, cancelled_at")
    .eq("token", token)
    .maybeSingle();

  if (lookupErr) {
    console.error("[confirm-email-change] lookup", lookupErr);
    return jsonError("internal_error", 500);
  }
  if (!row) return jsonError("token_invalid", 400);
  if (row.used_at) return jsonError("token_invalid", 400);
  if (row.cancelled_at) return jsonError("token_cancelled", 400);
  if (row.confirmed_at) return jsonError("token_already_confirmed", 400);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return jsonError("token_expired", 400);
  }

  // 2) Re-verificar que el new_email no este tomado por otro user en el
  //    ínterin entre request y confirm.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: takenData, error: takenErr } = await (adminClient as any).rpc("check_email_taken", {
    p_email: row.new_email,
    p_exclude_user_id: row.user_id,
  });
  if (takenErr) {
    console.error("[confirm-email-change] check_email_taken", takenErr);
    return jsonError("internal_error", 500);
  }
  if (takenData === true) {
    return jsonError("email_already_taken", 409);
  }

  // 3) Marcar como CONFIRMADO + agendar apply_after. NO aplica todavía.
  const now = new Date();
  const applyAfter = new Date(now.getTime() + DELAY_MS);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: confErr } = await (adminClient as any)
    .from("email_change_tokens")
    .update({
      confirmed_at: now.toISOString(),
      apply_after: applyAfter.toISOString(),
    })
    .eq("id", row.id);
  if (confErr) {
    console.error("[confirm-email-change] mark confirmed", confErr);
    return jsonError("internal_error", 500);
  }

  // 4) Best-effort: SEGUNDO aviso al correo VIEJO (auth.users.email
  //    actual). Si falla, igual respondemos OK — el aviso #1 fue al
  //    solicitar; este es defensa-en-profundidad.
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: userRow } = await (adminClient as any).auth.admin.getUserById(row.user_id);
      const oldEmail: string | null = userRow?.user?.email ?? null;
      if (!oldEmail) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: prof } = await (adminClient as any)
        .from("profiles")
        .select("full_name")
        .eq("id", row.user_id)
        .maybeSingle();
      const recipientName: string | null = prof?.full_name ?? null;

      const host = Deno.env.get("SMTP_HOST");
      const portRaw = Deno.env.get("SMTP_PORT");
      const smtpUser = Deno.env.get("SMTP_USER");
      const smtpPass = Deno.env.get("SMTP_PASSWORD");
      const from = Deno.env.get("EMAIL_FROM");
      const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? "ExamLab";
      const appUrl = Deno.env.get("APP_PUBLIC_URL") ?? "";
      if (!host || !portRaw || !smtpUser || !smtpPass || !from || !appUrl) return;
      const port = Number(portRaw);
      if (!Number.isFinite(port)) return;

      const cancelUrl = `${appUrl.replace(/\/+$/, "")}/auth/cancel-email-change?token=${encodeURIComponent(row.cancel_token)}`;
      const html = renderConfirmedNoticeHtml({
        recipientName,
        newEmail: row.new_email,
        cancelUrl,
        applyAt: applyAfter,
        brandName: fromName,
      });
      const text =
        `Tu cambio de correo en ${fromName} fue confirmado.\n\n` +
        `Nuevo correo: ${row.new_email}\n` +
        `Se aplicará: ${applyAfter.toISOString()}\n\n` +
        `Si NO fuiste tú, cancela: ${cancelUrl}\n`;

      const client = new SMTPClient({
        connection: {
          hostname: host,
          port,
          tls: port === 465,
          auth: { username: smtpUser, password: smtpPass },
        },
      });
      await client.send({
        from: `${fromName} <${from}>`,
        to: oldEmail,
        replyTo: from,
        subject: `${fromName}: ⏳ Cambio de correo confirmado — se aplicará en 24h`,
        content: text,
        html,
        headers: {
          "X-Entity-Ref-ID": `email-change-confirmed-${row.user_id}-${Date.now()}`,
        },
      });
      await client.close();
    } catch (e) {
      console.warn("[confirm-email-change] notice send failed", e);
    }
  })();

  // 5) Audit log.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (adminClient as any)
    .rpc("log_audit_event", {
      p_action: "user.email_change_confirmed",
      p_category: "user",
      p_severity: "info",
      p_actor_role: "Sistema",
      p_entity_type: "user",
      p_entity_id: row.user_id,
      p_entity_name: row.new_email,
      p_metadata: { token_id: row.id, apply_after: applyAfter.toISOString() },
    })
    .then?.(() => undefined)
    .catch?.(() => undefined);

  return jsonResponse({
    ok: true,
    newEmail: row.new_email,
    applyAfter: applyAfter.toISOString(),
  });
});
