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
// Mantener sincronizado con src/lib/notification-email.ts y con la
// función SQL _notification_kind_emails (migración 20260523000007
// añadió workshop+project).
const CRITICAL_KINDS = ["grade", "exam", "feedback", "workshop", "project"];
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
  const isPasswordReset =
    params.kind === "system" &&
    typeof params.link === "string" &&
    params.link.startsWith("/auth/reset-password");
  if (!isCriticalKind && !isMessage && !isPasswordReset) return { send: false, reason: "kind_not_critical" };
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
  // Mantener sincronizado con src/lib/notification-email.ts:
  // /auth/reset-password → CTA "Restablecer contraseña".
  const ctaLabel = params.link?.startsWith("/auth/reset-password")
    ? "Restablecer contraseña"
    : `Ver en ${brand}`;
  const cta = fullLink
    ? `
      <tr>
        <td style="padding: 24px 0 8px 0; text-align: center;">
          <a href="${escapeHtml(fullLink)}"
             style="display:inline-block; background-color:#2563eb; color:#ffffff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:500; font-size:14px;">
            ${escapeHtml(ctaLabel)}
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
              <p style="margin:0 0 8px 0; font-size:11px; color:#9ca3af; line-height:1.5;">
                Recibiste este correo porque tienes una cuenta en ${brand} y se generó una
                notificación dirigida a ti. Este es un mensaje automático del sistema; si
                contestas, llegará al administrador.
              </p>
              <p style="margin:0; font-size:11px; color:#9ca3af; line-height:1.5;">
                ¿No quieres recibir más correos de notificaciones?
                Responde a este mensaje con el asunto
                <strong>"Cancelar notificaciones ExamLab"</strong> y el administrador desactivará
                el envío para tu cuenta.
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

// ── Audit log helper ─────────────────────────────────────────────────
// Llama al RPC `audit_email_event` que escribe en public.audit_logs con
// categoría 'email'. Fire-and-forget: si el RPC falla (extension missing,
// notif borrada, etc.), no rompemos el flujo principal. Misma filosofía
// que `logEvent` del frontend.
async function auditEmail(
  notificationId: string,
  action: "email.dispatched" | "email.skipped" | "email.delivered" | "email.failed",
  severity: "info" | "warning" | "error" | "critical",
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adminClient as any).rpc("audit_email_event", {
      p_notification_id: notificationId,
      p_action: action,
      p_severity: severity,
      p_metadata: { ...metadata, stage: "edge" },
    });
  } catch {
    // silencio — audit nunca rompe el envío
  }
}

// ── Handler ──────────────────────────────────────────────────────────
// Wrapper top-level que captura excepciones no manejadas — denomailer
// 1.6.0 puede emitir errores desde event handlers internos durante
// STARTTLS (puerto 587) que escapan de try/catch normal y aparecen
// como UncaughtException en logs sin quedar en audit_logs. Este
// wrapper los atrapa via globalThis.addEventListener("unhandledrejection")
// + try/catch del cuerpo, y los logea con el notification_id si lo
// teníamos.
let currentNotificationId: string | null = null;
globalThis.addEventListener("unhandledrejection", (event) => {
  const id = currentNotificationId;
  if (!id) return;
  const msg = event.reason instanceof Error ? event.reason.message : String(event.reason);
  // No await — el unhandledrejection no es async-friendly. Mejor
  // disparar y olvidar; si llega tarde queda como audit log igual.
  void auditEmail(id, "email.failed", "error", {
    reason: "uncaught_exception",
    error: msg.slice(0, 200),
    stage: "edge_global",
  });
});

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
  currentNotificationId = notificationId;

  // 1) Cargar notification + perfil del destinatario.
  // Antes intentaba un embed `profile:profiles!notifications_user_id_fkey`
  // pero la FK real de `notifications.user_id` apunta a `auth.users.id`,
  // NO a `profiles.id` — PostgREST no puede seguir esa relación y
  // devuelve "Could not find a relationship between 'notifications' and
  // 'profiles' in the schema cache". Lo dividimos en dos queries
  // (notification primero, profile después). Dos round-trips pero
  // robusto a la estructura de FKs del proyecto.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error: rowErr } = await (adminClient as any)
    .from("notifications")
    .select("id, user_id, title, body, link, kind")
    .eq("id", notificationId)
    .maybeSingle();

  if (rowErr || !row) {
    await auditEmail(notificationId, "email.failed", "error", {
      reason: "notification_not_found",
      error: rowErr?.message ?? "unknown",
    });
    return jsonError(`notification not found: ${rowErr?.message ?? "unknown"}`, 404);
  }

  // Chequeo del kill switch + toggles por tipo (tabla email_settings).
  // Si la migración 20260523000009 no se aplicó, la tabla no existe y
  // hacemos fail-open (asumimos enabled). Eso evita romper el flujo si
  // alguien deploya la edge antes que la migración.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: settings } = await (adminClient as any)
    .from("email_settings")
    .select("globally_enabled, enabled_kinds")
    .eq("id", 1)
    .maybeSingle();

  if (settings) {
    if (settings.globally_enabled === false) {
      await markSkipped(notificationId, "globally_disabled");
      await auditEmail(notificationId, "email.skipped", "info", {
        reason: "globally_disabled",
        stage: "edge",
      });
      return jsonResponse({ ok: true, sent: false, reason: "globally_disabled" });
    }
    // Mapeo notification.kind/link → categoría visible en el config.
    // Los mensajes 1-a-1 vienen como kind='info' con link de /messages;
    // los exponemos como 'messages' en el toggle del admin.
    const isMessage = row.kind === "info" && row.link?.startsWith("/app/messages");
    const categoryKey = isMessage ? "messages" : row.kind;
    const enabledKinds = settings.enabled_kinds ?? {};
    if (enabledKinds[categoryKey] === false) {
      await markSkipped(notificationId, `kind_disabled:${categoryKey}`);
      await auditEmail(notificationId, "email.skipped", "info", {
        reason: "kind_disabled",
        category: categoryKey,
        stage: "edge",
      });
      return jsonResponse({ ok: true, sent: false, reason: `kind_disabled:${categoryKey}` });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile } = await (adminClient as any)
    .from("profiles")
    .select("full_name, institutional_email, personal_email")
    .eq("id", row.user_id)
    .maybeSingle();

  const institutional: string | null = profile?.institutional_email ?? null;
  const personal: string | null = profile?.personal_email ?? null;
  const fullName: string | null = profile?.full_name ?? null;
  // Recipients: institucional siempre primero (es el canal "oficial"
  // y queremos que sea el remitente más visible para el alumno). El
  // personal se agrega si existe y es distinto del institucional —
  // evita mandar dos veces al mismo address si el alumno puso el
  // mismo correo en ambos campos. denomailer acepta string[] en `to`
  // y manda un solo mensaje SMTP con varios RCPT TO, pero ojo: Gmail
  // contabiliza cada destinatario contra el límite diario (500/día).
  const recipients: string[] = [];
  if (institutional) recipients.push(institutional);
  if (personal && personal.toLowerCase() !== institutional?.toLowerCase()) {
    recipients.push(personal);
  }
  // Para `hasEmail` del shouldSendEmail nos basta con saber si hay al
  // menos un destinatario válido. El email principal sigue siendo el
  // institucional (para audit y para el rate-limit por destinatario).
  const email: string | null = recipients.length > 0 ? recipients[0] : null;

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
    await auditEmail(notificationId, "email.skipped", "info", {
      reason: decision.reason ?? "unknown",
    });
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
    await auditEmail(notificationId, "email.failed", "error", {
      reason: "smtp_env_missing",
      missing: {
        SMTP_HOST: !host,
        SMTP_PORT: !portRaw,
        SMTP_USER: !user,
        SMTP_PASSWORD: !password,
        EMAIL_FROM: !from,
      },
    });
    return jsonError("SMTP env vars missing", 500);
  }
  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    await markSkipped(notificationId, "no_settings");
    await auditEmail(notificationId, "email.failed", "error", {
      reason: "smtp_port_invalid",
      port_raw: portRaw,
    });
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
  const smtpStartMs = Date.now();
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
      // Array de recipients — denomailer hace 1 transacción SMTP con
      // múltiples RCPT TO. El alumno ve a ambos addresses en el header
      // "Para:" del correo (mismo usuario, sus dos correos — no es leak
      // de privacidad). Si solo hay uno (institutional o personal),
      // pasa un array de 1 y SMTP ignora la diferencia.
      to: recipients,
      // Reply-To: si el alumno responde, va al SMTP_USER (la cuenta
      // que el docente/admin monitorea). Sin esto, Outlook penaliza
      // el trust score por ausencia de canal de respuesta.
      replyTo: from,
      // Asunto branded: prefijo "<BrandName> — " antes del título de la
      // notificación. Mejora deliverability (clientes pesan el brand al
      // clasificar) y le da contexto inmediato al alumno cuando ve
      // varios correos en el inbox. Idempotente: si el title ya empieza
      // con el brand (legacy o template manual), no lo duplicamos.
      subject: row.title.toLowerCase().startsWith(fromName.toLowerCase())
        ? row.title
        : `${fromName} — ${row.title}`,
      content: text,
      html,
      // Headers extra para deliverability — especialmente Outlook/
      // Hotmail los pesan fuerte:
      //   - List-Unsubscribe: RFC 2369 — mecanismo opt-out. Sin esto,
      //     Outlook clasifica como bulk/junk por default.
      //   - List-Unsubscribe-Post: RFC 8058 — habilita el botón
      //     "Cancelar suscripción" nativo de Outlook/Gmail web.
      //   - X-Entity-Ref-ID: ayuda a Gmail a agrupar threads de la
      //     misma notif (no afecta spam pero mejora UX).
      headers: {
        "List-Unsubscribe": `<mailto:${from}?subject=Cancelar%20notificaciones%20ExamLab>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        "X-Entity-Ref-ID": notificationId,
      },
    });
    await client.close();
    await markDelivered(notificationId);
    await auditEmail(notificationId, "email.delivered", "info", {
      smtp_host: host,
      smtp_port: port,
      smtp_ms: Date.now() - smtpStartMs,
      sender: `${fromName} <${from}>`,
      recipients_count: recipients.length,
      // Lista de destinatarios — útil para diagnóstico si el alumno
      // reclama "no me llegó al personal" y queremos confirmar a cuáles
      // se mandó. NO incluimos el contenido del mensaje.
      recipients,
    });
    return jsonResponse({ ok: true, sent: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const truncated = msg.slice(0, 200);
    await markSkipped(notificationId, `provider_error: ${truncated}`);
    await auditEmail(notificationId, "email.failed", "error", {
      reason: "provider_error",
      error: truncated,
      smtp_host: host,
      smtp_port: port,
      smtp_ms: Date.now() - smtpStartMs,
    });
    return jsonError(`SMTP send failed: ${truncated}`, 500);
  }
});
