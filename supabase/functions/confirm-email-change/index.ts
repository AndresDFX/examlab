// ──────────────────────────────────────────────────────────────────────
// confirm-email-change — paso 2 del flujo custom.
//
// CAMBIO 2026-08: ahora el confirm APLICA EL CAMBIO INMEDIATO en
// auth.users + profiles via la RPC `apply_email_change_now`. La ventana
// de 24h pasa a ser para REVERTIR si el cambio fue malicioso (link en
// el aviso que mandamos al correo ANTERIOR).
//
// Antes: confirm marcaba confirmed_at y agendaba apply_after=NOW+24h;
// un cron aplicaba a las 24h. UX: usuario esperaba 24h para ver el
// correo nuevo activo. Ahora se ve activo al instante; el dueño legítimo
// del correo anterior tiene la misma ventana para revertir.
//
// Flow:
//  1. Recibe { token } por POST. Anon-callable.
//  2. Busca el token. Valida: existe, no usado, no expirado, no
//     confirmado todavia, no cancelado.
//  3. RPC `apply_email_change_now(token_id)` aplica el cambio + retorna
//     (previous_email, apply_after). La RPC valida unicidad de email
//     dentro de la misma transacción.
//  4. Manda un aviso al previous_email: "tu correo fue cambiado a X;
//     si NO fuiste vos, revertí dentro de 24h con este link".
//     Best-effort: si el SMTP falla, igualmente respondemos OK — el
//     cambio ya está aplicado.
//  5. Audit log lo hace la RPC.
//  6. Retorna { ok: true, newEmail, applyAfter, previousEmail }.
// ──────────────────────────────────────────────────────────────────────

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { adminClient, corsHeaders, jsonError, jsonResponse } from "../_shared/admin.ts";
import { emailMimeContent } from "../_shared/email.ts";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Aviso al correo ANTERIOR: notifica que el cambio FUE APLICADO y
 * ofrece un link de revertir válido dentro de la ventana de 24h.
 */
function renderAppliedNoticeHtml(params: {
  recipientName: string | null;
  newEmail: string;
  cancelUrl: string;
  revertUntil: Date;
  brandName: string;
}): string {
  const brand = escapeHtml(params.brandName);
  const newEmail = escapeHtml(params.newEmail);
  const url = escapeHtml(params.cancelUrl);
  const greeting = params.recipientName
    ? `Hola ${escapeHtml(params.recipientName.split(" ")[0] ?? params.recipientName)},`
    : "Hola,";
  const deadlineStr = escapeHtml(
    params.revertUntil.toLocaleString("es-CO", {
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
<head><meta charset="utf-8"><title>Tu correo en ${brand} fue cambiado</title></head>
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
            ✅ El correo de tu cuenta fue cambiado
          </p>
          <p style="margin:0 0 12px 0; font-size:14px; color:#374151; line-height:1.6;">
            Tu cuenta ahora usa este correo para iniciar sesión:
          </p>
          <p style="margin:0 0 16px 0; font-size:14px; font-weight:600; color:#111827; padding:10px 12px; background-color:#f3f4f6; border-radius:6px; word-break:break-all;">
            ${newEmail}
          </p>
          <p style="margin:0; font-size:14px; color:#374151; line-height:1.6;">
            Si <strong>vos solicitaste</strong> este cambio, no tenés que hacer nada — ya está listo.
          </p>
        </td></tr>
        <tr><td style="padding:20px 32px 8px 32px;">
          <p style="margin:0 0 8px 0; font-size:14px; font-weight:600; color:#dc2626;">
            ¿No lo solicitaste? Podés revertirlo:
          </p>
          <p style="margin:0 0 12px 0; font-size:14px; color:#374151; line-height:1.6;">
            Tenés hasta el <strong>${deadlineStr}</strong> (Colombia) para restaurar tu correo anterior con un click.
          </p>
        </td></tr>
        <tr><td style="padding:0 0 8px 0; text-align:center;">
          <a href="${url}" style="display:inline-block; background-color:#dc2626; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:500; font-size:14px;">
            Revertir al correo anterior
          </a>
        </td></tr>
        <tr><td style="padding:16px 32px 24px 32px; border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 10px 0; padding:10px 12px; font-size:12px; color:#7f1d1d; background-color:#fee2e2; border-left:3px solid #dc2626; line-height:1.5;">
            <strong>🚨 Si sospechás un intento de toma de cuenta,</strong> revertí arriba y cambiá tu contraseña inmediatamente.
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

  // 1) Buscar token + validar estado básico (la RPC re-valida con lock,
  //    pero un check temprano evita pegarle a la DB en errores comunes).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error: lookupErr } = await (adminClient as any)
    .from("email_change_tokens")
    .select(
      "id, user_id, new_email, cancel_token, used_at, expires_at, confirmed_at, cancelled_at, applied_at",
    )
    .eq("token", token)
    .maybeSingle();

  if (lookupErr) {
    console.error("[confirm-email-change] lookup", lookupErr);
    return jsonError("internal_error", 500);
  }
  if (!row) return jsonError("token_invalid", 400);
  if (row.used_at || row.applied_at) return jsonError("token_invalid", 400);
  if (row.cancelled_at) return jsonError("token_cancelled", 400);
  if (row.confirmed_at) return jsonError("token_already_confirmed", 400);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return jsonError("token_expired", 400);
  }

  // 2) Aplicar el cambio INMEDIATO via RPC. La RPC:
  //    - Re-valida en lock (no usado, no cancelado, no expirado).
  //    - Verifica que el new_email no esté tomado.
  //    - UPDATE auth.users.email + profiles.institutional_email.
  //    - Guarda previous_email y setea apply_after = NOW+24h (ahora
  //      es deadline de revert, no de aplicar).
  //    - Retorna (previous_email, apply_after).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: applyData, error: applyErr } = await (adminClient as any).rpc(
    "apply_email_change_now",
    { _token_id: row.id },
  );
  if (applyErr) {
    const msg = String(applyErr.message ?? "");
    // Mapear los códigos P0001 que tira la RPC a HTTP friendly.
    if (msg.includes("email_already_taken")) return jsonError("email_already_taken", 409);
    if (msg.includes("token_expired")) return jsonError("token_expired", 400);
    if (msg.includes("token_cancelled")) return jsonError("token_cancelled", 400);
    if (msg.includes("token_already_used") || msg.includes("token_not_found")) {
      return jsonError("token_invalid", 400);
    }
    console.error("[confirm-email-change] apply RPC failed", applyErr);
    return jsonError("internal_error", 500);
  }
  // RPC retorna TABLE(previous_email, apply_after) — un array de 1 fila.
  const applyResult = Array.isArray(applyData) ? applyData[0] : applyData;
  const previousEmail: string = applyResult?.previous_email ?? "";
  const applyAfterIso: string = applyResult?.apply_after ?? new Date().toISOString();
  const applyAfter = new Date(applyAfterIso);

  // 3) Best-effort: aviso al correo ANTERIOR ofreciendo revert. Si el
  //    SMTP falla, igualmente respondemos OK — el cambio ya está
  //    aplicado y persistido. El user puede pedir reset si descubre el
  //    cambio sin el aviso.
  void (async () => {
    try {
      const oldEmail = previousEmail;
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
      const html = renderAppliedNoticeHtml({
        recipientName,
        newEmail: row.new_email,
        cancelUrl,
        revertUntil: applyAfter,
        brandName: fromName,
      });
      const text =
        `Tu correo en ${fromName} fue cambiado a:\n` +
        `  ${row.new_email}\n\n` +
        `Si NO fuiste vos, podés revertir hasta ${applyAfter.toISOString()}:\n` +
        `  ${cancelUrl}\n`;

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
        subject: `${fromName}: ✅ Tu correo fue cambiado — 24h para revertir si no fuiste vos`,
        mimeContent: emailMimeContent(text, html),
        headers: {
          "X-Entity-Ref-ID": `email-change-applied-${row.user_id}-${Date.now()}`,
        },
      });
      await client.close();
    } catch (e) {
      console.warn("[confirm-email-change] notice send failed", e);
    }
  })();

  // Audit ya lo hace la RPC `apply_email_change_now` (action
  // user.email_changed). No duplicamos acá.

  return jsonResponse({
    ok: true,
    newEmail: row.new_email,
    previousEmail,
    applyAfter: applyAfter.toISOString(),
  });
});
