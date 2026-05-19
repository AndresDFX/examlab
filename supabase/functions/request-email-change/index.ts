// ──────────────────────────────────────────────────────────────────────
// request-email-change — paso 1 del flujo custom de cambio de email.
//
// Reemplaza a `supabase.auth.updateUser({ email })` que dispara una
// confirmación vía el SMTP opaco de Supabase Auth. Acá generamos el
// token y mandamos el correo por NUESTRO SMTP **directamente** (mismo
// patrón que broadcast-course-message: conexión SMTP propia + render
// HTML propio + audit log via auditFromEdge). NO pasamos por la tabla
// `notifications` ni por el pipeline send-email — el correo de
// confirmación es un canal "fuera-de-banda" que no debe verse en la
// campana del usuario y no debe llegar al email viejo.
//
// Flow:
//  1. Recibe { newEmail } por POST. Requiere JWT del usuario logueado.
//  2. Valida formato + que el email no esté en uso por otro user.
//  3. Invalida cualquier token pendiente del mismo user (defense in
//     depth sobre el UNIQUE INDEX parcial).
//  4. Genera token URL-safe de 32 bytes (256 bits de entropía).
//  5. INSERT en email_change_tokens con expires_at = NOW + 1h.
//  6. Manda el correo **al NUEVO email** (no al viejo) — el usuario
//     debe demostrar que controla la nueva dirección. Si comprometen
//     la cuenta, el atacante no puede confirmar el cambio.
//  7. Audit log 'user.email_change_requested'.
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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 32 bytes random → base64url sin padding (~43 chars). 256 bits entropía. */
function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function renderEmailHtml(params: {
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
            Pulsa el botón para confirmar el cambio. El enlace es válido por <strong>1 hora</strong> y solo puede usarse una vez. Tu correo actual seguirá funcionando hasta que confirmes.
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
            tu correo actual no se modificará. Si crees que alguien intenta
            tomar tu cuenta, cambia tu contraseña inmediatamente.
          </p>
          <p style="margin:0; font-size:11px; color:#9ca3af; line-height:1.5;">
            Este correo se generó porque alguien (probablemente tú) solicitó cambiar el correo de la cuenta asociada a ${brand}.
            No respondas a este mensaje — es automático.
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

    // ── Persistir el nuevo token ──
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const requestIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const requestUa = req.headers.get("user-agent")?.slice(0, 500) ?? null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: tokErr } = await (admin as any).from("email_change_tokens").insert({
      user_id: userId,
      new_email: newEmail,
      token,
      expires_at: expiresAt,
      request_ip: requestIp,
      request_ua: requestUa,
    });
    if (tokErr) {
      console.error("[request-email-change] token insert", tokErr);
      return jsonError("internal_error", 500);
    }

    // ── Resolver nombre del destinatario (para el saludo del HTML) ──
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prof } = await (admin as any)
      .from("profiles")
      .select("full_name")
      .eq("id", userId)
      .maybeSingle();
    const recipientName: string | null = prof?.full_name ?? null;

    // ── SMTP config (mismo set de env vars que broadcast/send-email) ──
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

    // ── Construir el link de confirmación ──
    const confirmUrl =
      appUrl.replace(/\/+$/, "") +
      `/auth/confirm-email-change?token=${encodeURIComponent(token)}`;

    const html = renderEmailHtml({ recipientName, newEmail, confirmUrl, brandName: fromName });
    const text =
      `Confirma el cambio de tu correo en ${fromName}.\n\n` +
      `Nuevo correo solicitado: ${newEmail}\n\n` +
      `Abre este enlace para confirmar (válido 1h):\n${confirmUrl}\n\n` +
      `Si NO solicitaste este cambio, ignora este correo — tu correo actual no se modificará.`;

    // ── Enviar SMTP (igual que broadcast-course-message) ──
    const smtpStartMs = Date.now();
    try {
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
        // Destinatario = NUEVO email (no el viejo). Si comprometen la
        // cuenta, el atacante no puede confirmar porque el correo no
        // llega a su buzón.
        to: newEmail,
        replyTo: from,
        // ASCII puro en el separador para evitar el bug de subjects
        // con encoded-word + char no-ASCII (ver el parche de send-email).
        subject: `${fromName}: Confirma tu nuevo correo`,
        content: text,
        html,
        headers: {
          "X-Entity-Ref-ID": `email-change-${userId}-${Date.now()}`,
          "List-Unsubscribe": `<mailto:${from}?subject=Cancelar%20notificaciones%20${encodeURIComponent(fromName)}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      });
      await client.close();

      void auditFromEdge(admin, {
        actorId: userId,
        action: "user.email_change_requested",
        category: "user",
        severity: "info",
        entityType: "user",
        entityId: userId,
        entityName: currentEmail,
        metadata: {
          new_email: newEmail,
          smtp_ms: Date.now() - smtpStartMs,
          request_ip: requestIp,
        },
      });
      return jsonResponse({ ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      void auditFromEdge(admin, {
        actorId: userId,
        action: "user.email_change_requested",
        category: "user",
        severity: "error",
        entityType: "user",
        entityId: userId,
        metadata: {
          reason: "smtp_send_failed",
          new_email: newEmail,
          error: msg.slice(0, 500),
          smtp_ms: Date.now() - smtpStartMs,
        },
      });
      return jsonError(`smtp_send_failed: ${msg.slice(0, 200)}`, 500);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[request-email-change] unexpected", msg);
    return jsonError(msg, 500);
  }
});
