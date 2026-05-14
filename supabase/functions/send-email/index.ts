// ──────────────────────────────────────────────────────────────────────
// send-email — entrega de notificaciones por correo electrónico.
//
// Disparada por el trigger `notify_send_email` en `public.notifications`
// (migración 20260523000000). Recibe `{ notification_id }`, busca la fila
// y el email del destinatario, decide si enviar (mismo filtro que el SQL)
// y manda el correo vía SMTP usando `denomailer`.
//
// Provider esperado: Gmail SMTP por defecto (smtp.gmail.com:587 con
// STARTTLS y App Password). Las mismas variables sirven para Brevo,
// Resend, SendGrid, Mailgun — solo cambian los valores. Diseño portable
// a propósito.
//
// Secrets requeridos en Supabase Edge Functions:
//   - SMTP_HOST     (ej. smtp.gmail.com)
//   - SMTP_PORT     (ej. 587)
//   - SMTP_USER     (ej. tucuenta@gmail.com)
//   - SMTP_PASSWORD (App Password de Google, NO el password de la cuenta)
//   - EMAIL_FROM    (dirección del remitente — para Gmail, igual a SMTP_USER)
//   - EMAIL_FROM_NAME (nombre que se muestra, ej. "ExamLab")
//   - APP_PUBLIC_URL  (URL absoluta de la app para construir links del CTA)
//
// Settings de DB requeridas (configurar una vez):
//   ALTER DATABASE postgres SET app.settings.send_email_url = '<url>/functions/v1/send-email';
//   ALTER DATABASE postgres SET app.settings.service_role_key = '<service_role_jwt>';
//
// IMPORTANTE: El predicado de "enviar email" duplica intencionalmente
// el SQL (`_notification_kind_emails`) y el helper TS
// (`src/lib/notification-email.ts → shouldSendEmail`). Si cambias el
// filtro en uno, actualiza los tres. Los tests del helper TS son la
// fuente de verdad del comportamiento esperado.
// ──────────────────────────────────────────────────────────────────────

import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { adminClient, corsHeaders, jsonError, jsonResponse } from "../_shared/admin.ts";

// ── Replicación del helper `shouldSendEmail` ─────────────────────────
// MANTENER SINCRONIZADO con `src/lib/notification-email.ts`. Los tests
// del cliente cubren los edge cases — acá replicamos la decisión sin
// poder importar (Deno edge no comparte src/).
const CRITICAL_KINDS = ["grade", "exam", "feedback"];
const MESSAGE_LINK_PREFIX = "/app/messages";

type SkipReason =
  | "kind_not_critical"
  | "user_opted_out"
  | "no_email"
  | "no_settings"
  | "provider_error";

function shouldSendEmail(params: {
  kind: string;
  link: string | null;
  hasEmail: boolean;
  userOptedOut: boolean;
}): { send: boolean; reason: SkipReason | null } {
  if (!params.hasEmail) return { send: false, reason: "no_email" };
  const isCriticalKind = CRITICAL_KINDS.includes(params.kind);
  const isMessage =
    params.kind === "info" &&
    typeof params.link === "string" &&
    params.link.startsWith(MESSAGE_LINK_PREFIX);
  if (!isCriticalKind && !isMessage) return { send: false, reason: "kind_not_critical" };
  if (params.userOptedOut) return { send: false, reason: "user_opted_out" };
  return { send: true, reason: null };
}

// ── Render HTML — replica `renderEmailHtml` del helper TS ────────────
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderEmailHtml(params: {
  recipientName: string | null;
  title: string;
  body: string;
  link: string | null;
  appUrl: string;
  brandName: string;
}): string {
  const brand = escapeHtml(params.brandName);
  const greeting = params.recipientName
    ? `Hola ${escapeHtml(params.recipientName.split(" ")[0] ?? params.recipientName)},`
    : "Hola,";
  const title = escapeHtml(params.title);
  const bodyHtml = escapeHtml(params.body).replace(/\n/g, "<br>");
  const fullLink = params.link
    ? (params.appUrl.replace(/\/+$/, "") + params.link).replace(/(?<!:)\/\/+/g, "/")
    : null;
  const cta = fullLink
    ? `
      <tr>
        <td style="padding: 24px 0 8px 0; text-align: center;">
          <a href="${escapeHtml(fullLink)}"
             style="display:inline-block; background-color:#2563eb; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:500; font-size:14px;">
            Ver en ${brand}
          </a>
        </td>
      </tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin:0; padding:0; background-color:#f4f4f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#1f2937;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f4f5; padding: 24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px; background-color:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.06);">
          <tr>
            <td style="padding: 24px 32px; border-bottom:1px solid #e5e7eb;">
              <span style="font-size:18px; font-weight:600; color:#2563eb;">${brand}</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 28px 32px 8px 32px;">
              <p style="margin:0 0 16px 0; font-size:14px; color:#6b7280;">${greeting}</p>
              <p style="margin:0 0 12px 0; font-size:16px; font-weight:600; color:#111827; line-height:1.4;">${title}</p>
              <p style="margin:0; font-size:14px; color:#374151; line-height:1.6;">${bodyHtml}</p>
            </td>
          </tr>${cta}
          <tr>
            <td style="padding: 16px 32px 24px 32px; border-top:1px solid #e5e7eb; margin-top:16px;">
              <p style="margin:0; font-size:11px; color:#9ca3af; line-height:1.5;">
                Recibiste este correo porque tienes una cuenta en ${brand}. Si las notificaciones por correo te resultan ruidosas, contacta al administrador para ajustar la configuración.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Actualiza la fila notification con el resultado del envío ────────
async function markDelivered(notificationId: string): Promise<void> {
  await adminClient
    .from("notifications")
    .update({ email_delivered_at: new Date().toISOString(), email_skipped_reason: null })
    .eq("id", notificationId);
}

async function markSkipped(notificationId: string, reason: string): Promise<void> {
  await adminClient
    .from("notifications")
    .update({ email_skipped_reason: reason })
    .eq("id", notificationId);
}

// ── Handler ──────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let body: { notification_id?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }
  const notificationId = body?.notification_id;
  if (!notificationId) return jsonError("missing notification_id", 400);

  // 1) Cargar notification + perfil del destinatario en una sola query.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error: rowErr } = await (adminClient as any)
    .from("notifications")
    .select(
      "id, user_id, title, body, link, kind, profile:profiles!notifications_user_id_fkey(full_name, institutional_email)",
    )
    .eq("id", notificationId)
    .maybeSingle();

  if (rowErr || !row) {
    return jsonError(`notification not found: ${rowErr?.message ?? "unknown"}`, 404);
  }

  const email: string | null = row.profile?.institutional_email ?? null;
  const fullName: string | null = row.profile?.full_name ?? null;

  // 2) Decidir si enviar. Cubre filtros del SQL + opt-outs del usuario.
  // userOptedOut está hardcoded a false hasta la Fase 4 (preferencias
  // por usuario). Cuando se agregue la columna profiles.email_notifications_enabled,
  // léela acá y pásala.
  const decision = shouldSendEmail({
    kind: row.kind,
    link: row.link,
    hasEmail: !!email,
    userOptedOut: false,
  });
  if (!decision.send) {
    await markSkipped(notificationId, decision.reason ?? "unknown");
    return jsonResponse({ ok: true, sent: false, reason: decision.reason });
  }

  // 3) Configuración SMTP. Si falta cualquier secret, no podemos enviar.
  const host = Deno.env.get("SMTP_HOST");
  const portRaw = Deno.env.get("SMTP_PORT");
  const user = Deno.env.get("SMTP_USER");
  const password = Deno.env.get("SMTP_PASSWORD");
  const from = Deno.env.get("EMAIL_FROM");
  const fromName = Deno.env.get("EMAIL_FROM_NAME") ?? "ExamLab";
  const appUrl = Deno.env.get("APP_PUBLIC_URL") ?? "";

  if (!host || !portRaw || !user || !password || !from) {
    await markSkipped(notificationId, "no_settings");
    return jsonError("SMTP env vars missing", 500);
  }
  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    await markSkipped(notificationId, "no_settings");
    return jsonError("SMTP_PORT invalid", 500);
  }

  // 4) Render del HTML + texto plano de fallback.
  const html = renderEmailHtml({
    recipientName: fullName,
    title: row.title,
    body: row.body,
    link: row.link,
    appUrl,
    brandName: fromName,
  });
  // Versión plana (mejor entregabilidad — algunos filtros antispam
  // penalizan correos solo-HTML). Texto = título + body crudo.
  const text = `${row.title}\n\n${row.body}${row.link ? `\n\nVer: ${appUrl.replace(/\/+$/, "")}${row.link}` : ""}`;

  // 5) Conexión SMTP + envío. denomailer soporta STARTTLS automáticamente
  // si `tls: true` y maneja port 587 correctamente. Cualquier excepción
  // (auth fail, DNS, timeout, antivirus, etc.) cae al catch y se persiste.
  try {
    const client = new SMTPClient({
      connection: {
        hostname: host,
        port,
        tls: port === 465, // 465 = SMTPS implícito, 587 = STARTTLS (lo maneja denomailer)
        auth: { username: user, password },
      },
    });
    await client.send({
      from: `${fromName} <${from}>`,
      to: email!,
      subject: row.title,
      content: text,
      html,
    });
    await client.close();
    await markDelivered(notificationId);
    return jsonResponse({ ok: true, sent: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const truncated = msg.slice(0, 200);
    await markSkipped(notificationId, `provider_error: ${truncated}`);
    return jsonError(`SMTP send failed: ${truncated}`, 500);
  }
});
