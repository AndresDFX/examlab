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
import { emailMimeContent } from "../_shared/email.ts";

// ── Replicación del helper `shouldSendEmail` ─────────────────────────
// MANTENER SINCRONIZADO con `src/modules/notifications/notification-email.ts`
// y con la función SQL `_notification_kind_emails`. Los tests del
// helper TS son la fuente de verdad — acá replicamos la decisión sin
// poder importar (Deno edge no comparte src/).
//   - workshop + project: añadidos por migración 20260523000007.
//   - attendance: añadido por migración 20260517110000.
const CRITICAL_KINDS = [
  "grade",
  "exam",
  "feedback",
  "workshop",
  "project",
  "attendance",
  // broadcast: difusión docente/admin a todo un curso, emaila por
  // destinatario. Sincronizado con SQL `_notification_kind_emails`
  // (mig 20260708000000) y src/modules/notifications/notification-email.ts.
  "broadcast",
  // support: PQRS Admin↔SuperAdmin. El on/off vive UPSTREAM en el SQL
  // `_notification_kind_emails` (platform_settings.support_emails_enabled), que
  // notify_send_email consulta ANTES de invocar esta edge — acá solo lo aceptamos
  // (antes se descartaba con kind_not_critical → los correos de soporte no salían).
  "support",
  // course_welcome: bienvenida al curso, disparada por el trigger AFTER INSERT
  // en course_enrollments (mig 20261110000000). El toggle vive en
  // email_settings.enabled_kinds.course_welcome (gate más abajo). Sincronizado
  // con SQL `_notification_kind_emails` y notification-email.ts.
  "course_welcome",
];
const MESSAGE_LINK_PREFIX = "/app/messages";
const SYSTEM_ALERT_LINK_PREFIX = "/app/admin/system";

type SkipReason =
  | "kind_not_critical"
  | "user_opted_out"
  | "no_email"
  | "no_settings"
  | "suppressed"
  | "provider_error";

// ── Detección de rebote PERMANENTE de buzón/usuario ──────────────────
// RÉPLICA de src/modules/notifications/email-bounce.ts (Deno edge no importa de
// src/). Los tests de ese módulo son la fuente de verdad — si cambias la lógica
// acá, sincroniza allá (y viceversa).
//
// Auto-suprime SÓLO direcciones definitivamente muertas: exige código 5.x.x
// (permanente) — NUNCA 4.x (transitorio: un 452 "out of storage temporal" se
// reintenta solo). Los rebotes ASÍNCRONOS (NDR que llega horas después al
// remitente) no pasan por acá — esos los agrega el Admin a mano desde el panel.
function isPermanentMailboxError(msg: string): boolean {
  const m = (msg ?? "").toLowerCase();
  const permanent = /\b5\.[12]\.\d\b/.test(m) || /\b55\d\b/.test(m);
  const mailboxIssue =
    /mailbox.*(full|unavailable|disabled)/.test(m) ||
    /over.?quota/.test(m) ||
    /out of storage/.test(m) ||
    /(does not|doesn'?t) exist/.test(m) ||
    /(user|recipient|mailbox|address|account).*(unknown|not found|disabled)/.test(m) ||
    /no such (user|mailbox|recipient|address)/.test(m) ||
    /recipient.*reject/.test(m) ||
    /address rejected/.test(m);
  return permanent && mailboxIssue;
}

/**
 * ¿El error SMTP es TRANSITORIO (reintentable)? Gmail responde `421 4.3.0
 * Temporary System Problem` cuando se le mandan muchos correos en ráfaga
 * (p. ej. asignar un taller notifica a los N estudiantes del curso → N envíos
 * casi simultáneos). Esos rebotes se resuelven reintentando con backoff — a
 * diferencia de los permanentes (5.x.x mailbox), que NO se reintentan.
 * Detecta códigos SMTP 4.x.x / 4xx + patrones de throttle/timeout/conexión.
 */
function isTransientSmtpError(msg: string): boolean {
  const m = (msg ?? "").toLowerCase();
  // 5.x.x / 5xx = permanente → nunca transitorio.
  if (/\b5\.\d\.\d\b/.test(m) || /\b5\d\d\b/.test(m)) return false;
  return (
    /\b4\.\d\.\d\b/.test(m) || // SMTP enhanced status 4.x.x (ej. 4.3.0, 4.7.0)
    /\b4\d\d\b/.test(m) || // SMTP 4xx (421, 450, 451, 452)
    /temporar/.test(m) ||
    /try again/.test(m) ||
    /throttl/.test(m) ||
    /rate.?limit/.test(m) ||
    /too many/.test(m) ||
    /timeout|timed out/.test(m) ||
    /econn|connection (closed|reset|refused)|socket hang/.test(m) ||
    /greylist/.test(m) ||
    /service (not available|unavailable)/.test(m)
  );
}

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
  const isSystemAlert =
    params.kind === "system" &&
    typeof params.link === "string" &&
    params.link.startsWith(SYSTEM_ALERT_LINK_PREFIX);
  if (!isCriticalKind && !isMessage && !isPasswordReset && !isSystemAlert) {
    return { send: false, reason: "kind_not_critical" };
  }
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
  //   /auth/reset-password         → "Restablecer contraseña".
  //   /auth/confirm-email-change   → "Confirmar nuevo correo".
  // Cada rama de link especial obtiene un CTA propio; el resto cae al
  // genérico "Ver en <Brand>".
  const ctaLabel = params.link?.startsWith("/auth/reset-password")
    ? "Restablecer contraseña"
    : params.link?.startsWith("/auth/confirm-email-change")
      ? "Confirmar nuevo correo"
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
              <p style="margin:0 0 10px 0; padding:10px 12px; font-size:12px; color:#92400e; background-color:#fef3c7; border-left:3px solid #f59e0b; line-height:1.5;">
                <strong>⚠️ Notificación automática.</strong> No respondas a este correo —
                las respuestas no se procesan. Si necesitas contestar a un docente,
                administrador o compañero, hazlo directamente en la plataforma:
                <strong>Mensajes → Nueva conversación</strong>.
              </p>
              <p style="margin:0 0 8px 0; font-size:11px; color:#9ca3af; line-height:1.5;">
                Recibiste este correo porque tienes una cuenta en ${brand} y se generó una
                notificación dirigida a ti.
              </p>
              <p style="margin:0; font-size:11px; color:#9ca3af; line-height:1.5;">
                ¿No quieres recibir más correos de notificaciones?
                Ingresa a la plataforma → <strong>Preferencias</strong> → desactiva las
                notificaciones por correo.
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
    //
    //   `info` + /app/messages%        → "messages"        (chat interno)
    //   `system` + /app/admin/system%  → "system_alerts"   (alertas a
    //                                                       admins: storage threshold,
    //                                                       agregado en migración
    //                                                       20260603104500)
    //   `system` + /auth/reset-password o /auth/confirm-email-change
    //                                  → SIN toggle (transaccional —
    //                                                el usuario pierde
    //                                                acceso si se apaga)
    //   resto                          → `row.kind` directo
    const isMessage = row.kind === "info" && row.link?.startsWith("/app/messages");
    const isSystemAlert = row.kind === "system" && row.link?.startsWith("/app/admin/system");
    const isTransactional =
      row.kind === "system" &&
      (row.link?.startsWith("/auth/reset-password") ||
        row.link?.startsWith("/auth/confirm-email-change"));
    const categoryKey = isMessage ? "messages" : isSystemAlert ? "system_alerts" : row.kind;
    const enabledKinds = settings.enabled_kinds ?? {};
    // Transaccionales NO respetan el toggle — siempre se envían.
    if (!isTransactional && enabledKinds[categoryKey] === false) {
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
    .select("full_name, institutional_email, personal_email, tenant_id")
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

  // 2.5) Lista de SUPRESIÓN: quitar destinatarios cuyo buzón rebota
  // (bandeja llena / usuario inexistente). Enforcement GLOBAL por dirección —
  // consultamos por email sin filtrar por tenant. Si TODOS los destinatarios
  // están suprimidos, no enviamos. El email guardado ya está en minúsculas
  // (trigger de normalización), así que el `.in` con minúsculas matchea.
  {
    const lowered = recipients.map((r) => r.toLowerCase());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: supp } = await (adminClient as any)
      .from("email_suppressions")
      .select("email")
      .in("email", lowered);
    const suppressedSet = new Set<string>(
      (supp ?? []).map((s: { email: string }) => s.email.toLowerCase()),
    );
    if (suppressedSet.size > 0) {
      for (let i = recipients.length - 1; i >= 0; i--) {
        if (suppressedSet.has(recipients[i].toLowerCase())) recipients.splice(i, 1);
      }
      if (recipients.length === 0) {
        await markSkipped(notificationId, "suppressed");
        await auditEmail(notificationId, "email.skipped", "info", {
          reason: "suppressed",
          suppressed: Array.from(suppressedSet),
        });
        return jsonResponse({ ok: true, sent: false, reason: "suppressed" });
      }
      // Quedó ≥1 destinatario válido (ej. el personal) → seguimos sólo con esos.
    }
  }

  // 3) Configuración SMTP. Por defecto el SMTP GLOBAL (env). Si el tenant del
  // DESTINATARIO tiene config propia (tenant_email_settings.use_custom_smtp con
  // credenciales completas), la usamos en su lugar — así cada institución
  // manda con su propia cuenta y no comparte el throttle del SMTP global.
  let host = Deno.env.get("SMTP_HOST");
  let portRaw = Deno.env.get("SMTP_PORT");
  let user = Deno.env.get("SMTP_USER");
  let password = Deno.env.get("SMTP_PASSWORD");
  let from = Deno.env.get("EMAIL_FROM");
  let fromName = Deno.env.get("EMAIL_FROM_NAME") ?? "ExamLab";
  const appUrl = Deno.env.get("APP_PUBLIC_URL") ?? "";
  let smtpSource = "global";

  const tenantId: string | null = profile?.tenant_id ?? null;
  if (tenantId) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: tes } = await (adminClient as any)
      .from("tenant_email_settings")
      .select("use_custom_smtp, smtp_host, smtp_port, smtp_user, smtp_password, email_from, email_from_name")
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (
      tes?.use_custom_smtp &&
      tes.smtp_host &&
      tes.smtp_port &&
      tes.smtp_user &&
      tes.smtp_password &&
      tes.email_from
    ) {
      host = tes.smtp_host;
      portRaw = String(tes.smtp_port);
      user = tes.smtp_user;
      password = tes.smtp_password;
      from = tes.email_from;
      fromName = tes.email_from_name || fromName;
      smtpSource = "tenant";
    }
  }

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
  // Pre-jitter: desincroniza la ráfaga de N invocaciones concurrentes (una por
  // estudiante cuando se notifica a todo un curso) para no abrir N conexiones
  // SMTP a Gmail en el mismo instante — principal causa de los 421.
  await new Promise((res) => setTimeout(res, Math.floor(Math.random() * 1200)));

  // Envío SMTP encapsulado para poder reintentarlo con backoff ante errores
  // TRANSITORIOS (Gmail 421 4.3.0 Temporary System Problem, timeouts, conexión).
  async function attemptSmtpSend(): Promise<void> {
    const client = new SMTPClient({
      connection: {
        hostname: host,
        port,
        tls: port === 465, // 465 = SMTPS implícito, 587 = STARTTLS (lo maneja denomailer)
        auth: { username: user, password },
      },
    });
    const mailOptions = {
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
      // Asunto branded: prefijo "<BrandName>: " antes del título de la
      // notificación. Mejora deliverability (clientes pesan el brand al
      // clasificar) y le da contexto inmediato al alumno cuando ve
      // varios correos en el inbox. Idempotente: si el title ya empieza
      // con el brand, no lo duplicamos.
      //
      // IMPORTANTE — uso ":" (ASCII) y NO "—" (em-dash U+2014):
      //   denomailer 1.6.0 codifica el subject con RFC 2047 encoded-word
      //   (=?UTF-8?Q?...?=) cuando detecta cualquier char > 0x7F. Si el
      //   resultado supera 75 bytes lo parte con \n+TAB en lugar de
      //   CRLF+SPACE, y algunos relays SMTP (notablemente Gmail outbound)
      //   re-encoden esa partición mal. El cliente final ve un trozo
      //   suelto del subject ("n II?=") arriba de los otros headers y
      //   pierde sincronía con el parseo MIME del cuerpo (queda como
      //   texto crudo). Forzando ":" mantenemos el prefijo en ASCII puro
      //   — solo el title del row entra al encoded-word y suele caber.
      //
      // Sanitización del título: si el title viene con chars de control
      // o saltos de línea (raro pero posible si el docente inyecta
      // metadata), los limpiamos. Newlines en headers SMTP son una de
      // las clásicas inyecciones (header injection attack).
      subject: (() => {
        const cleanTitle = (row.title ?? "")
          .replace(/[\r\n\t]+/g, " ")
          .trim()
          .slice(0, 200); // tope defensivo para no sobrepasar límites SMTP
        if (cleanTitle.toLowerCase().startsWith(fromName.toLowerCase())) {
          return cleanTitle;
        }
        return `${fromName}: ${cleanTitle}`;
      })(),
      // Cuerpo en base64 vía mimeContent (NO `content`/`html`) para esquivar el
      // quoted-printable en minúsculas de denomailer 1.6.0 que rompe el render en
      // Outlook/Hotmail. Ver _shared/email.ts.
      mimeContent: emailMimeContent(text, html),
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
    };
    try {
      await client.send(mailOptions);
    } finally {
      // close() es TEARDOWN: (a) si lanza tras un send() exitoso NO debe
      // propagar — el correo ya se entregó; propagarlo dispararía reintento
      // (duplicado) o falso email.failed. (b) ante fallo de send() igual
      // cerramos para no filtrar la conexión SMTP en cada reintento.
      try {
        await client.close();
      } catch {
        /* best-effort */
      }
    }
  }

  // Retry-with-backoff: hasta 3 intentos. Solo reintenta TRANSITORIOS
  // (421/4.x.x/timeout/conexión) — los permanentes (5.x.x) fallan de una.
  const MAX_ATTEMPTS = 3;
  let lastErr = "";
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    try {
      await attemptSmtpSend();
      await markDelivered(notificationId);
      await auditEmail(notificationId, "email.delivered", "info", {
        smtp_host: host,
        smtp_port: port,
        smtp_source: smtpSource,
        smtp_ms: Date.now() - smtpStartMs,
        sender: `${fromName} <${from}>`,
        recipients_count: recipients.length,
        // Lista de destinatarios — útil para diagnóstico si el alumno reclama
        // "no me llegó al personal". NO incluimos el contenido del mensaje.
        recipients,
        attempts: attempt,
      });
      return jsonResponse({ ok: true, sent: true });
    } catch (e) {
      lastErr = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      if (
        attempt < MAX_ATTEMPTS &&
        isTransientSmtpError(lastErr) &&
        !isPermanentMailboxError(lastErr)
      ) {
        // Backoff exponencial + jitter (~1s, ~3s) para que los reintentos de
        // varios estudiantes no vuelvan a chocar en el mismo instante.
        const delay = (attempt === 1 ? 1000 : 3000) + Math.floor(Math.random() * 1500);
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      break; // permanente, o transitorio sin intentos restantes
    }
  }

  // Falló definitivamente (tras reintentos si aplicaba).
  const truncated = lastErr;
  await markSkipped(notificationId, `provider_error: ${truncated}`);
  // Auto-supresión: si el handshake SMTP rebotó PERMANENTEMENTE por buzón/
  // usuario (5.x.x), dejamos de golpear esa dirección. Sólo permanentes — un
  // 4.x transitorio NO se suprime. Best-effort: si la tabla no existe (mig
  // sin aplicar) o el insert choca con el índice único, lo ignoramos.
  let autoSuppressed = false;
  if (isPermanentMailboxError(truncated)) {
    // Un solo mensaje SMTP puede llevar 2 RCPT TO (institucional + personal).
    // Un 5.x.x suele ser de UNA dirección — no censuramos la válida por el
    // rebote de la otra. Suprimimos solo las ATRIBUIBLES: la única (si hay 1),
    // o las que aparecen en el string de error del servidor.
    const lowerErr = truncated.toLowerCase();
    const toSuppress =
      recipients.length === 1
        ? recipients
        : recipients.filter((r) => lowerErr.includes(r.toLowerCase()));
    for (const r of toSuppress) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: insErr } = await (adminClient as any)
          .from("email_suppressions")
          .insert({
            email: r.toLowerCase(),
            reason: "hard_bounce",
            note: `auto (send-email): ${truncated}`,
            tenant_id: tenantId,
          });
        if (!insErr) autoSuppressed = true;
      } catch {
        // silencio — la auto-supresión nunca rompe el flujo de error
      }
    }
  }
  await auditEmail(notificationId, "email.failed", "error", {
    reason: "provider_error",
    error: truncated,
    smtp_host: host,
    smtp_port: port,
    smtp_source: smtpSource,
    smtp_ms: Date.now() - smtpStartMs,
    auto_suppressed: autoSuppressed,
    // Cuántos intentos se hicieron + si se reintentó (transitorio).
    attempts: attemptsMade,
    retried: attemptsMade > 1,
  });
  return jsonError(`SMTP send failed: ${truncated}`, 500);
});
