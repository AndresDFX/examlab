// Helper compartido para el cuerpo de los correos enviados con denomailer.
//
// POR QUÉ EXISTE: denomailer 1.6.0 codifica text/html con quoted-printable
// usando hex en MINÚSCULAS (`=3d`, `=c3=b3` — su `quotedPrintableEncode` hace
// `i.toString(16)` sin `.toUpperCase()`), lo que viola RFC 2045 (los dígitos hex
// DEBEN ir en mayúscula). Clientes estrictos (Outlook/Hotmail) no decodifican
// ese QP y muestran el HTML CRUDO ("correo sin formato"). No podemos parchear el
// import remoto, así que entregamos el cuerpo YA codificado en base64 vía
// `mimeContent` (denomailer lo pasa TAL CUAL, sin re-encodear) — base64 lo
// decodifica idéntico TODO cliente. `resolveContent` mete los items de
// `mimeContent` al MISMO array de contenido que los shortcuts text/html, así que
// quedan como partes del multipart/alternative del cuerpo (NO como adjuntos).
//
// Uso en una llamada denomailer `client.send({...})`: reemplazar
//   `content: text, html` → `mimeContent: emailMimeContent(text, html)`.

/** Codifica UTF-8 → base64 MIME (líneas de 76 chars + CRLF, RFC 2045). */
export function b64MimeBody(s: string): string {
  const bytes = new TextEncoder().encode(s ?? "");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  // btoa codifica latin1/binario → seguro porque `bin` es byte-a-byte de UTF-8.
  return btoa(bin).replace(/.{76}/g, "$&\r\n");
}

/** mimeContent (text/plain + text/html en base64) para denomailer `client.send`. */
export function emailMimeContent(text: string, html: string) {
  return [
    { mimeType: 'text/plain; charset="utf-8"', content: b64MimeBody(text), transferEncoding: "base64" },
    { mimeType: 'text/html; charset="utf-8"', content: b64MimeBody(html), transferEncoding: "base64" },
  ];
}

/**
 * Transliterate un ASUNTO de correo a ASCII PURO seguro para denomailer 1.6.0.
 *
 * POR QUÉ (bug reportado — el correo de bienvenida al curso llegaba con el
 * cuerpo MIME como texto crudo): denomailer, si el subject tiene CUALQUIER byte
 * no-ASCII, lo envuelve en UN encoded-word `=?utf-8?Q?...?=` y luego —vía
 * `quotedPrintableEncode`— parte el quoted-printable cada 74 chars con `=\r\n`
 * DENTRO del encoded-word (RFC 2047 lo prohíbe) y sin folding whitespace en la
 * línea de continuación. El resultado es un header de asunto MALFORMADO que el
 * cliente no puede decodificar: ve un trozo suelto del asunto y pierde sincronía
 * con el parseo del cuerpo → muestra la estructura MIME (`--attachment100`,
 * `Content-Type: multipart/...`, base64) como TEXTO PLANO. Se dispara con
 * asuntos largos que tengan emoji (🎓/✅/⚠️/📢) o acentos (Administración,
 * solicitó…) — justo los asuntos de bienvenida, difusión y cambio de correo.
 *
 * No podemos entregar un asunto RFC 2047 correcto a través de denomailer:
 *   - por `subject`, re-encoda todo lo no-ASCII (roto) y TAMBIÉN todo lo que
 *     empiece con `=?` (doble-encoda un encoded-word ya armado);
 *   - por `headers.Subject`, escribe DOS headers `Subject:` (duplicado).
 * denomailer SOLO deja el asunto intacto si es ASCII puro y no empieza con `=?`
 * (ver `quotedPrintableEncodeInline`). Así que transliteramos: NFKD + quitar
 * diacríticos ("ó"→"o", "ñ"→"n") y eliminar emoji/símbolos no-ASCII. El CUERPO
 * conserva UTF-8 completo (base64 vía `emailMimeContent`); solo la línea de
 * asunto pierde acentos/emoji — trade-off aceptable a cambio de que el correo
 * SIEMPRE se renderice bien en todo cliente. También limpia saltos/tabs
 * (defensa contra header-injection). Aplicar en TODO `subject:` de un
 * `client.send` de denomailer (send-email, confirm/request-email-change).
 */
export function asciiEmailSubject(subject: string): string {
  const ascii = (subject ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // marcas diacríticas combinantes
    .replace(/[^\x20-\x7E]/g, "") // emoji / símbolos / control no-ASCII-imprimible
    .replace(/\s+/g, " ")
    .trim();
  // Defensivo: nunca empezar con "=?" (denomailer lo re-encodearía como RFC 2047).
  return ascii.startsWith("=?") ? ascii.slice(1) : ascii;
}
