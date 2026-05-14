/**
 * Helpers puros del flujo de envío de notificaciones por email.
 *
 * Tres responsabilidades:
 *
 * 1. `shouldSendEmail` — espeja el predicado SQL
 *    `_notification_kind_emails(kind, link)` de la migración
 *    20260523000000. Cada vez que cambies el filtro, ACTUALIZA AMBOS
 *    LADOS. Los tests de este archivo verifican los casos que el SQL
 *    no podía testar directamente.
 *
 * 2. `renderEmailHtml` — arma el cuerpo HTML del correo. Inline-styles
 *    porque los clientes (Outlook, Gmail Web) cortan CSS externo. Sin
 *    librerías de templating — string concatenation directa con escape
 *    XSS de los placeholders.
 *
 * 3. `escapeHtml` — escape para los placeholders. Se exporta para que
 *    si más adelante hay otra plantilla en otro contexto se reuse.
 */

/** Kinds que disparan email por sí solos (sin condiciones extra).
 *  Mantener sincronizado con el predicado SQL
 *  `_notification_kind_emails` (migración 20260523000007 añadió
 *  workshop+project para los recordatorios de vencimiento). */
export const CRITICAL_KINDS = ["grade", "exam", "feedback", "workshop", "project"] as const;

/** Prefijo de link que indica "mensaje 1-a-1" — usado para discriminar
 *  `kind='info'` de mensajería vs `kind='info'` genérico del sistema. */
export const MESSAGE_LINK_PREFIX = "/app/messages";

export interface ShouldSendEmailParams {
  kind: string;
  link: string | null | undefined;
  /** Si el usuario marcó "no quiero correos" en sus preferencias. */
  userOptedOut?: boolean;
  /** Si el usuario no tiene email registrado en su perfil. */
  hasEmail?: boolean;
}

export type SkipReason =
  | "kind_not_critical"
  | "user_opted_out"
  | "no_email"
  | null;

/**
 * Decide si enviar email + en caso negativo, el motivo exacto.
 * El SQL de la migración filtra por (kind, link); este helper agrega
 * los dos opt-outs del usuario (preferencia + email vacío).
 *
 * Orden de evaluación:
 *   1. Sin email → "no_email" (no podemos enviar).
 *   2. Kind no crítico → "kind_not_critical".
 *   3. Usuario opted out → "user_opted_out".
 *   4. Pasa todos los filtros → null (= sí enviar).
 */
export function shouldSendEmail(params: ShouldSendEmailParams): {
  send: boolean;
  reason: SkipReason;
} {
  if (params.hasEmail === false) return { send: false, reason: "no_email" };

  const isCriticalKind = (CRITICAL_KINDS as readonly string[]).includes(params.kind);
  const isMessage =
    params.kind === "info" &&
    typeof params.link === "string" &&
    params.link.startsWith(MESSAGE_LINK_PREFIX);
  if (!isCriticalKind && !isMessage) return { send: false, reason: "kind_not_critical" };

  if (params.userOptedOut === true) return { send: false, reason: "user_opted_out" };

  return { send: true, reason: null };
}

/**
 * Escape de caracteres HTML peligrosos. NO usar para atributos —
 * solo texto entre tags. Para atributos hay que escapar también
 * comillas. Acá no las uso porque los placeholders van solo en texto.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface RenderEmailParams {
  recipientName: string | null | undefined;
  title: string;
  body: string;
  /** Ruta relativa de la app (ej. `/app/student/exams`). Si está, se
   *  arma el botón CTA. Si NO, no se renderiza el botón. */
  link?: string | null;
  /** URL absoluta pública de la app (ej. `https://examlab.app`). Sin
   *  trailing slash. Se concatena con `link` para el href del CTA. */
  appUrl: string;
  /** Nombre del producto que se muestra en el header. Default ExamLab. */
  brandName?: string;
}

/**
 * Plantilla HTML simple compatible con Gmail, Outlook, Apple Mail.
 * Inline styles + table-based layout son los antídotos contra los
 * clientes que rompen CSS.
 *
 * NO se firma a nivel SMTP ni se agrega DKIM aquí — eso lo hace el
 * provider (Gmail SMTP auto-firma con el dominio del sender). La
 * función solo retorna el body HTML.
 */
export function renderEmailHtml(params: RenderEmailParams): string {
  const brand = escapeHtml(params.brandName ?? "ExamLab");
  const greeting = params.recipientName
    ? `Hola ${escapeHtml(params.recipientName.split(" ")[0] ?? params.recipientName)},`
    : "Hola,";
  const title = escapeHtml(params.title);
  // Body preserva saltos de línea: cada \n se convierte en <br>.
  // Hacemos el escape ANTES del replace para no romper el escapeHtml.
  const bodyHtml = escapeHtml(params.body).replace(/\n/g, "<br>");

  // El CTA solo aparece si hay link. El href se construye con appUrl +
  // link. NOTE: si appUrl viene con trailing slash, el `+` produce un
  // doble slash. Lo normalizamos con replace defensivo.
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

  // El footer se mantiene mínimo. Si en el futuro agregamos preferencia
  // de opt-out por usuario (Fase 4), acá va el link "Desactivar correos".
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
