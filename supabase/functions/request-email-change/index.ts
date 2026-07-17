// ──────────────────────────────────────────────────────────────────────
// request-email-change — paso 1 del flujo custom de cambio de email.
//
// Flow (doble correo + delay de seguridad):
//  1. Recibe { newEmail } por POST. Requiere JWT del usuario logueado.
//  2. Valida formato + que el email no este en uso por otro user.
//  3. Invalida cualquier token pendiente del mismo user.
//  4. Genera DOS tokens URL-safe de 32 bytes:
//       - `token` (confirm): va al NUEVO email.
//       - `cancel_token`: va al ANTERIOR email.
//  5. INSERT en email_change_tokens con expires_at = NOW + 1h.
//  6. Manda DOS correos:
//       - Al NUEVO email: "Confirma tu nuevo correo" + link al token.
//       - Al ANTERIOR email: "Alguien solicito cambiar tu correo a X.
//         Si no fuiste tu, cancela aqui: <cancel_link>".
//  7. Audit log 'user.email_change_requested'.
//
// El cambio NO se aplica al hacer click en el link del nuevo email —
// solo se marca `confirmed_at` y se agenda apply_after = NOW + 24h. El
// usuario duenho del correo viejo tiene 24h para cancelar antes que el
// cron lo aplique.
// ──────────────────────────────────────────────────────────────────────

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import {
  adminClient as admin,
  corsHeaders,
  jsonError,
  jsonResponse,
  userClientFromRequest,
} from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";
import { asciiEmailSubject, emailMimeContent } from "../_shared/email.ts";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 32 bytes random → base64url sin padding (~43 chars). 256 bits entropia. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/**
 * HTML del correo de CONFIRMACIÓN — destino: NUEVO email del usuario.
 * El click confirma el cambio (pero no lo aplica — agenda apply_after).
 */
function renderConfirmHtml(params: {
  recipientName: string | null;
  newEmail: string;
  confirmUrl: string;
  brandName: string;
}): string {
  const brand = escapeHtml(params.brandName);
  const newEmail = escapeHtml(params.newEmail);
  const url = escapeHtml(params.confirmUrl);
  const greeting = params.recipientName
    ? `Hola ${escapeHtml(params.recipientName.split(" ")[0] ?? params.recipientName)},`
    : "Hola,";
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Confirma el cambio de correo</title></head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f4f5; padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px; background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="padding:24px 32px; border-bottom:1px solid #e5e7eb;">
          <span style="font-size:18px; font-weight:600; color:#2563eb;">${brand}</span>
        </td></tr>
        <tr><td style="padding:28px 32px 8px 32px;">
          <p style="margin:0 0 16px 0; font-size:14px; color:#6b7280;">${greeting}</p>
          <p style="margin:0 0 12px 0; font-size:16px; font-weight:600; color:#111827; line-height:1.4;">Confirma el cambio de tu correo</p>
          <p style="margin:0 0 12px 0; font-size:14px; color:#374151; line-height:1.6;">
            Solicitaste cambiar el correo de tu cuenta en ${brand} a:
          </p>
          <p style="margin:0 0 16px 0; font-size:14px; font-weight:600; color:#111827; padding:10px 12px; background-color:#f3f4f6; border-radius:6px; word-break:break-all;">
            ${newEmail}
          </p>
          <p style="margin:0; font-size:14px; color:#374151; line-height:1.6;">
            Pulsa el botón para confirmar. Por seguridad, el cambio se aplicará
            <strong>24 horas después</strong> de la confirmación — durante ese
            tiempo, tu correo actual puede cancelarlo si la solicitud no fue
            legítima. El enlace es válido por 1 hora.
          </p>
        </td></tr>
        <tr><td style="padding:24px 0 8px 0; text-align:center;">
          <a href="${url}" style="display:inline-block; background-color:#2563eb; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:500; font-size:14px;">
            Confirmar nuevo correo
          </a>
        </td></tr>
        <tr><td style="padding:16px 32px 24px 32px; border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 10px 0; padding:10px 12px; font-size:12px; color:#92400e; background-color:#fef3c7; border-left:3px solid #f59e0b; line-height:1.5;">
            <strong>⚠️ ¿No solicitaste este cambio?</strong> Ignora este correo —
            tu correo actual no se modificará.
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

/**
 * HTML del correo de AVISO — destino: ANTERIOR email del usuario.
 * Notifica que se solicitó un cambio y permite cancelarlo desde acá.
 * Si el correo del solicitante fue comprometido, el dueño legítimo
 * recibe este aviso y puede frenar el cambio antes que se aplique.
 */
function renderNoticeHtml(params: {
  recipientName: string | null;
  newEmail: string;
  cancelUrl: string;
  brandName: string;
  requestIp: string | null;
}): string {
  const brand = escapeHtml(params.brandName);
  const newEmail = escapeHtml(params.newEmail);
  const url = escapeHtml(params.cancelUrl);
  const ip = params.requestIp ? escapeHtml(params.requestIp) : null;
  const greeting = params.recipientName
    ? `Hola ${escapeHtml(params.recipientName.split(" ")[0] ?? params.recipientName)},`
    : "Hola,";
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Se solicitó cambiar tu correo</title></head>
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
            ⚠️ Se solicitó cambiar el correo de tu cuenta
          </p>
          <p style="margin:0 0 12px 0; font-size:14px; color:#374151; line-height:1.6;">
            Alguien (probablemente tú) solicitó cambiar el correo de tu cuenta en ${brand} a:
          </p>
          <p style="margin:0 0 16px 0; font-size:14px; font-weight:600; color:#111827; padding:10px 12px; background-color:#f3f4f6; border-radius:6px; word-break:break-all;">
            ${newEmail}
          </p>
          ${
            ip
              ? `<p style="margin:0 0 12px 0; font-size:12px; color:#6b7280; line-height:1.5;">
            Solicitud desde la IP: <code style="color:#374151;">${ip}</code>
          </p>`
              : ""
          }
          <p style="margin:0; font-size:14px; color:#374151; line-height:1.6;">
            Por seguridad, el cambio NO se aplica de inmediato — tienes <strong>al menos 24 horas</strong> después de la confirmación del nuevo correo para cancelarlo desde acá.
          </p>
        </td></tr>
        <tr><td style="padding:24px 32px 8px 32px;">
          <p style="margin:0 0 12px 0; font-size:14px; font-weight:600; color:#dc2626;">
            ¿No fuiste tú? Cancela ahora:
          </p>
        </td></tr>
        <tr><td style="padding:0 0 8px 0; text-align:center;">
          <a href="${url}" style="display:inline-block; background-color:#dc2626; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:500; font-size:14px;">
            Cancelar el cambio de correo
          </a>
        </td></tr>
        <tr><td style="padding:16px 32px 24px 32px; border-top:1px solid #e5e7eb;">
          <p style="margin:0 0 10px 0; padding:10px 12px; font-size:12px; color:#1e40af; background-color:#dbeafe; border-left:3px solid #2563eb; line-height:1.5;">
            <strong>💡 Si fuiste tú,</strong> no hace falta hacer nada acá — solo confirma desde el correo que llegó a tu nueva dirección. El cambio se aplica solo tras la confirmación y el delay de seguridad.
          </p>
          <p style="margin:0 0 10px 0; padding:10px 12px; font-size:12px; color:#7f1d1d; background-color:#fee2e2; border-left:3px solid #dc2626; line-height:1.5;">
            <strong>🚨 Si sospechas un intento de toma de cuenta,</strong> cancela arriba y cambia tu contraseña inmediatamente desde el login.
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

  let userId: string | undefined;
  try {
    // ── Auth: resolver user desde JWT ──
    const userClient = userClientFromRequest(req);
    if (!userClient) return jsonError("missing_auth", 401);
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return jsonError("invalid_auth", 401);
    userId = u.user.id;
    const currentEmail = (u.user.email ?? "").toLowerCase();

    let body: { newEmail?: string };
    try {
      body = await req.json();
    } catch {
      return jsonError("invalid_json", 400);
    }
    const newEmail = body?.newEmail?.trim().toLowerCase() ?? "";
    if (!newEmail) return jsonError("missing_new_email", 400);
    if (!EMAIL_RE.test(newEmail)) return jsonError("invalid_email_format", 400);
    if (newEmail === currentEmail) return jsonError("same_as_current_email", 400);

    // ── Unicidad: el nuevo email no debe estar tomado por OTRO user ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: takenData, error: takenErr } = await (admin as any).rpc("check_email_taken", {
      p_email: newEmail,
      p_exclude_user_id: userId,
    });
    if (takenErr) {
      console.error("[request-email-change] check_email_taken", takenErr);
      return jsonError("internal_error", 500);
    }
    if (takenData === true) return jsonError("email_already_taken", 409);

    // ── Invalidar tokens pendientes previos del mismo user ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (admin as any)
      .from("email_change_tokens")
      .update({ used_at: new Date().toISOString() })
      .eq("user_id", userId)
      .is("used_at", null);

    // ── Persistir el nuevo token (confirm + cancel) ──
    const token = generateToken();
    const cancelToken = generateToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const requestIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const requestUa = req.headers.get("user-agent")?.slice(0, 500) ?? null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: tokErr } = await (admin as any).from("email_change_tokens").insert({
      user_id: userId,
      new_email: newEmail,
      token,
      cancel_token: cancelToken,
      expires_at: expiresAt,
      request_ip: requestIp,
      request_ua: requestUa,
    });
    if (tokErr) {
      console.error("[request-email-change] token insert", tokErr);
      return jsonError("internal_error", 500);
    }

    // ── Resolver nombre del destinatario (para el saludo de ambos correos) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prof } = await (admin as any)
      .from("profiles")
      .select("full_name")
      .eq("id", userId)
      .maybeSingle();
    const recipientName: string | null = prof?.full_name ?? null;

    // ── SMTP config ──
    const host = Deno.env.get("SMTP_HOST");
    const portRaw = Deno.env.get("SMTP_PORT");
    const smtpUser = Deno.env.get("SMTP_USER");
    const smtpPass = Deno.env.get("SMTP_PASSWORD");
    const from = Deno.env.get("EMAIL_FROM");
    const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? "ExamLab";
    const appUrl = Deno.env.get("APP_PUBLIC_URL") ?? "";

    if (!host || !portRaw || !smtpUser || !smtpPass || !from || !appUrl) {
      void auditFromEdge(admin, {
        actorId: userId,
        action: "user.email_change_requested",
        category: "user",
        severity: "warning",
        entityType: "user",
        entityId: userId,
        metadata: {
          reason: "smtp_env_missing",
          new_email: newEmail,
        },
      });
      return jsonError("smtp_not_configured", 500);
    }
    const port = Number(portRaw);
    if (!Number.isFinite(port)) return jsonError("smtp_port_invalid", 500);

    // ── Links ──
    const base = appUrl.replace(/\/+$/, "");
    const confirmUrl = `${base}/auth/confirm-email-change?token=${encodeURIComponent(token)}`;
    const cancelUrl = `${base}/auth/cancel-email-change?token=${encodeURIComponent(cancelToken)}`;

    const confirmHtml = renderConfirmHtml({
      recipientName,
      newEmail,
      confirmUrl,
      brandName: fromName,
    });
    const confirmText =
      `Confirma el cambio de tu correo en ${fromName}.\n\n` +
      `Nuevo correo solicitado: ${newEmail}\n\n` +
      `Abre este enlace para confirmar (válido 1h):\n${confirmUrl}\n\n` +
      `Por seguridad, el cambio se aplica 24h después de la confirmación. Si NO solicitaste este cambio, ignora este correo.`;

    const noticeHtml = renderNoticeHtml({
      recipientName,
      newEmail,
      cancelUrl,
      brandName: fromName,
      requestIp,
    });
    const noticeText =
      `⚠️ Se solicitó cambiar el correo de tu cuenta en ${fromName} a: ${newEmail}\n\n` +
      `Si NO fuiste tú, cancela inmediatamente desde:\n${cancelUrl}\n\n` +
      `Por seguridad el cambio se aplica al menos 24h después de la confirmación — tienes ese tiempo para cancelarlo.\n` +
      `Si fuiste tú, no hace falta hacer nada acá; confirma desde el correo enviado a tu nueva dirección.`;

    // ── Enviar ambos correos en paralelo, una sola conexion SMTP ──
    const smtpStartMs = Date.now();
    const sendErrors: string[] = [];
    try {
      const client = new SMTPClient({
        connection: {
          hostname: host,
          port,
          tls: port === 465,
          auth: { username: smtpUser, password: smtpPass },
        },
      });

      // 1) Al NUEVO email — confirmación.
      try {
        await client.send({
          from: `${fromName} <${from}>`,
          to: newEmail,
          replyTo: from,
          subject: asciiEmailSubject(`${fromName}: Confirma tu nuevo correo`),
          mimeContent: emailMimeContent(confirmText, confirmHtml),
          headers: {
            "X-Entity-Ref-ID": `email-change-confirm-${userId}-${Date.now()}`,
            "List-Unsubscribe": `<mailto:${from}?subject=Cancelar%20notificaciones%20${encodeURIComponent(fromName)}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        });
      } catch (e) {
        sendErrors.push(`confirm: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 2) Al ANTERIOR email — aviso + link de cancelación.
      if (currentEmail) {
        try {
          await client.send({
            from: `${fromName} <${from}>`,
            to: currentEmail,
            replyTo: from,
            // asciiEmailSubject: denomailer rompe asuntos no-ASCII largos (emoji
            // ⚠️ + acentos) → cuerpo MIME crudo. Ver _shared/email.ts.
            subject: asciiEmailSubject(`${fromName}: ⚠️ Se solicitó cambiar el correo de tu cuenta`),
            mimeContent: emailMimeContent(noticeText, noticeHtml),
            headers: {
              "X-Entity-Ref-ID": `email-change-notice-${userId}-${Date.now()}`,
              "List-Unsubscribe": `<mailto:${from}?subject=Cancelar%20notificaciones%20${encodeURIComponent(fromName)}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
          });
        } catch (e) {
          sendErrors.push(`notice: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      await client.close();
    } catch (e) {
      sendErrors.push(`smtp_setup: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Política: si TODO falló, devolvemos error. Si solo uno de los dos
    // falló (ej. el aviso al viejo), audit-warning y seguimos — el
    // confirm es suficiente para que el cambio funcione, el aviso es
    // defensa-en-profundidad.
    if (sendErrors.length === 2) {
      void auditFromEdge(admin, {
        actorId: userId,
        action: "user.email_change_requested",
        category: "user",
        severity: "error",
        entityType: "user",
        entityId: userId,
        metadata: {
          reason: "both_emails_failed",
          errors: sendErrors,
          new_email: newEmail,
        },
      });
      return jsonError(`smtp_send_failed: ${sendErrors.join("; ").slice(0, 200)}`, 500);
    }

    void auditFromEdge(admin, {
      actorId: userId,
      action: "user.email_change_requested",
      category: "user",
      severity: sendErrors.length > 0 ? "warning" : "info",
      entityType: "user",
      entityId: userId,
      entityName: currentEmail,
      metadata: {
        new_email: newEmail,
        smtp_ms: Date.now() - smtpStartMs,
        request_ip: requestIp,
        partial_failures: sendErrors.length > 0 ? sendErrors : undefined,
      },
    });
    return jsonResponse({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[request-email-change] unexpected", msg);
    return jsonError(msg, 500);
  }
});
