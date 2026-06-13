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
