/**
 * Markdown inline → HTML, para documentos que se ARMAN COMO STRING.
 *
 * ── Por qué existe, teniendo `MarkdownInline` ──────────────────────────
 * `MarkdownInline` es un componente React sobre `react-markdown`: sirve en
 * pantalla, no dentro de un `buildXHtml()` que devuelve un string para imprimir.
 * Y esos builders son puros a propósito (se testean sin DOM), así que no pueden
 * renderizar React.
 *
 * ── Y por qué no `markdownToPlain` ────────────────────────────────────
 * Porque ahí el énfasis ES el mensaje. El caso que lo originó: el PDF de
 * resultados de una encuesta imprimía literalmente
 *
 *     Opcional y confidencial: **solo yo veo tus respuestas**, no tus compañeros.
 *
 * con los asteriscos a la vista. Quitarlos deja la frase correcta pero pierde
 * justo lo que el docente quiso destacar; renderizarlos la deja como se escribió.
 *
 * ── El orden importa: se ESCAPA primero ───────────────────────────────
 * Primero se escapa TODO el texto y solo después se aplican los marcadores. Al
 * revés —insertar `<strong>` y escapar después— rompería las etiquetas propias;
 * y aplicar marcadores sobre texto sin escapar dejaría pasar el HTML que alguien
 * escriba en una respuesta abierta. Este módulo se usa sobre texto que ESCRIBEN
 * los usuarios, así que ese orden no es un detalle.
 *
 * Alcance deliberadamente chico: negrita, itálica, tachado, código y saltos de
 * línea. Sin enlaces (en papel no se hace clic), sin listas ni encabezados (esto
 * es para una frase, no para un documento). Si hiciera falta más, el lugar es
 * `MarkdownViewer` en pantalla, no acá.
 */

/** Escapa para insertar en HTML. Público porque el orden escape-primero importa. */
export function escapeHtml(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renderiza el markdown inline de una frase a HTML seguro.
 *
 * `**negrita**` · `*itálica*` / `_itálica_` · `~~tachado~~` · `` `código` `` ·
 * salto de línea → `<br>`.
 */
export function markdownInlineToHtml(md: string | null | undefined): string {
  let s = escapeHtml(md);
  if (!s) return "";

  // El código se aparta PRIMERO y su contenido queda fuera del resto del
  // proceso: dentro de `` `así` `` los asteriscos son literales, y si se
  // procesaran después ya habrían desaparecido.
  //
  // El marcador lleva `<` y `>` a propósito. En este punto el texto YA está
  // escapado, así que no puede contener esos caracteres: la colisión con lo que
  // alguien escriba no es improbable, es imposible. Con un marcador de texto
  // plano (`CODE0`) un test encontró que escribir literalmente "CODE0" chocaba.
  const codigos: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    codigos.push(c);
    return `<md-code:${codigos.length - 1}>`;
  });

  // Negrita antes que itálica: con `*` primero, `**x**` se comería un asterisco
  // de cada lado y quedaría `<em>*x*</em>`.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // `_` solo entre límites de palabra: `nombre_de_variable` no es itálica, y en
  // este proyecto abundan los identificadores con guion bajo.
  s = s.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, "$1<em>$2</em>");

  s = s.replace(/\r?\n/g, "<br>");

  return s.replace(
    /<md-code:(\d+)>/g,
    (_m, i: string) => `<code>${codigos[Number(i)]}</code>`,
  );
}
