// Envío por la API transaccional de Brevo (HTTPS, sin SMTP).
//
// Se usa para los correos de CUENTA Y ACCESO (restablecer contraseña, confirmar
// cambio de correo, bienvenida con enlace para crear la contraseña): si esos no
// llegan, la persona se queda sin poder entrar. El SMTP de Gmail institucional
// los aceptaba («delivered») pero no siempre los entregaba, y además se traba
// con «454 Too many login attempts». Brevo sale por otra vía; si falla, el
// llamador cae al SMTP de siempre, así que nunca quedan sin salida.
//
// El remitente es una dirección verificada en Brevo como «sender». NO puede ser
// una de correounivalle.edu.co: ese dominio publica DMARC `p=reject` y solo
// autoriza a Google en su SPF, así que un envío desde Brevo con ese remitente
// se RECHAZA en destino (verificado el 2026-10-04). Un Gmail (DMARC `p=none`)
// llega, en el peor caso a spam.

export const BREVO_SENDER_DEFAULT = "andresdfwxyz@gmail.com";

export interface CorreoBrevo {
  apiKey: string;
  senderEmail: string;
  senderName: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  headers?: Record<string, string>;
}

export type ResultadoBrevo = { ok: true; messageId: string | null; ms: number } | { ok: false; error: string; ms: number };

export async function enviarPorBrevo(c: CorreoBrevo, fetchImpl: typeof fetch = fetch): Promise<ResultadoBrevo> {
  const inicio = Date.now();
  try {
    const r = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": c.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: c.senderEmail, name: c.senderName },
        to: c.to.map((email) => ({ email })),
        subject: c.subject,
        htmlContent: c.html,
        textContent: c.text,
        ...(c.replyTo ? { replyTo: { email: c.replyTo } } : {}),
        ...(c.headers ? { headers: c.headers } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    const cuerpo = await r.text();
    if (!r.ok) return { ok: false, error: `brevo ${r.status}: ${cuerpo.slice(0, 180)}`, ms: Date.now() - inicio };
    let messageId: string | null = null;
    try {
      messageId = (JSON.parse(cuerpo) as { messageId?: string }).messageId ?? null;
    } catch {
      /* respuesta sin JSON: igual se aceptó */
    }
    return { ok: true, messageId, ms: Date.now() - inicio };
  } catch (e) {
    return { ok: false, error: `brevo: ${(e instanceof Error ? e.message : String(e)).slice(0, 180)}`, ms: Date.now() - inicio };
  }
}
