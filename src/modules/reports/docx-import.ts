/**
 * Importador de .docx → texto plano editable, sin dependencias nuevas.
 *
 * Un .docx es un ZIP (OOXML). El contenido textual del documento vive en
 * `word/document.xml`. Acá lo extraemos con `fflate.unzipSync` (ya en el
 * lockfile), parseamos los párrafos `<w:p>` y los runs de texto `<w:t>`
 * con regex (no traemos un parser XML completo — el subset OOXML que nos
 * interesa es plano y predecible), y devolvemos texto con saltos de
 * párrafo preservados.
 *
 * Por qué regex y no DOMParser: este helper corre tanto en el browser
 * como en los tests de vitest (jsdom). Un parser XML basado en regex
 * sobre el subset acotado de OOXML que importa (w:p / w:t / w:br / w:tab)
 * es suficiente, no añade peso, y es trivial de testear con un .docx
 * mínimo construido con `fflate.zipSync`.
 *
 * NO intentamos preservar formato (negritas, tablas, estilos): el objetivo
 * es traer el TEXTO al editor de plantillas para que el docente lo edite
 * inline e inserte las `{{variables}}` del catálogo de informes. El
 * sistema de templates existente (report_templates + template-engine +
 * report-context) se reutiliza tal cual — esto solo alimenta el body.
 */
import { strFromU8, unzipSync } from "fflate";

/** Tamaño máximo aceptado para un .docx importado (8 MB). Defensa contra
 *  archivos enormes que harían que `unzipSync` (síncrono) congele el tab. */
export const MAX_DOCX_BYTES = 8 * 1024 * 1024;

/** Path canónico del XML del cuerpo dentro del contenedor OOXML. */
const DOCUMENT_XML_PATH = "word/document.xml";

/**
 * Desescapa las 5 entidades XML predefinidas que pueden aparecer dentro
 * de `<w:t>`. OOXML no usa otras entidades nombradas en el texto del
 * cuerpo (los caracteres no-ASCII van como UTF-8 crudo).
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // &amp; al final para no re-decodificar entidades ya expandidas.
    .replace(/&amp;/g, "&");
}

/**
 * Convierte el XML de un `<w:p>` (un párrafo) a su texto plano.
 * Concatena todos los runs `<w:t>` en orden, traduce `<w:tab/>` a TAB
 * y `<w:br/>` a salto de línea suave. Cualquier otro tag se descarta.
 */
function paragraphToText(paragraphXml: string): string {
  let out = "";
  // Recorremos en orden los nodos que producen texto/espaciado.
  // - <w:t ...>texto</w:t>  (xml:space="preserve" es opcional)
  // - <w:tab/>  o  <w:tab></w:tab>
  // - <w:br/>   o  <w:br></w:br>
  const TOKEN_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/?>|<w:br(?:\s[^>]*)?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(paragraphXml)) !== null) {
    const tag = m[0];
    // OJO: `<w:tab>` y `<w:br>` también empiezan con `<w:t`/`<w:b`,
    // así que hay que descartarlos ANTES del caso genérico `<w:t>`.
    if (tag.startsWith("<w:tab")) {
      out += "\t";
    } else if (tag.startsWith("<w:br")) {
      out += "\n";
    } else {
      // <w:t>…</w:t> — m[1] es el texto del run.
      out += decodeXmlEntities(m[1] ?? "");
    }
  }
  return out;
}

/**
 * Extrae el texto del XML del cuerpo (`word/document.xml`), un párrafo
 * por línea. Separado de `parseDocxToText` para poder testear el parser
 * de XML sin tener que armar un ZIP — y para reutilizarlo si algún día
 * el XML llega por otra vía.
 */
export function extractTextFromDocumentXml(documentXml: string): string {
  const paragraphs: string[] = [];
  // Cada <w:p ...>…</w:p> es un párrafo. Los párrafos vacíos (sin <w:t>)
  // representan líneas en blanco intencionales en el documento → los
  // preservamos como string vacío para no colapsar el espaciado.
  const PARA_RE = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = PARA_RE.exec(documentXml)) !== null) {
    paragraphs.push(paragraphToText(m[1] ?? ""));
  }
  // Caso degenerado: documento sin párrafos cerrados (ej. `<w:p/>`
  // autocerrado, o XML sin <w:p>). Devolvemos cadena vacía en vez de
  // lanzar — el docente verá un editor vacío y entenderá que no se
  // extrajo nada.
  return paragraphs.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── Variante HTML: preserva formato básico ────────────────────────────
// Además del texto plano, ofrecemos una conversión a HTML que conserva
// párrafos, encabezados (w:pStyle Heading/Título), negrita, itálica y
// tablas — así el .docx cargado se ve parecido al original en el editor de
// plantillas y el docente solo agrega las {{variables}} (la "lógica"). No
// es una conversión OOXML completa (sin listas numeradas, imágenes ni
// estilos finos) — cubre lo común de un informe institucional.

/** Escapa los 3 caracteres peligrosos para insertar texto plano en HTML.
 *  NO escapa llaves → preserva los `{{placeholders}}` que el docente ya
 *  hubiera tipeado en el Word. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Marcador HTML de salto de página. `composeTemplateHtml` lo convierte en
 *  un corte real en impresión/PDF y en un divisor visible en pantalla. */
export const PAGE_BREAK_HTML = '<div class="examlab-page-break"></div>';

/** Texto + formato (negrita/itálica) de UN run `<w:r>`. */
function runToHtml(runXml: string): string {
  // Propiedades del run (rPr) → negrita / itálica. `w:val="false|0|off"`
  // desactiva el atributo heredado de un estilo, así que lo excluimos.
  const rPr = /<w:rPr>([\s\S]*?)<\/w:rPr>/.exec(runXml)?.[1] ?? "";
  const isOn = (tag: string) =>
    new RegExp(`<w:${tag}(?:\\s[^>]*)?/?>`).test(rPr) &&
    !new RegExp(`<w:${tag}\\s+w:val="(?:false|0|off)"`).test(rPr);
  const bold = isOn("b");
  const italic = isOn("i");

  // Acumulamos el texto formateado del run, pero los SALTOS DE PÁGINA se
  // emiten como bloques sueltos (fuera de <strong>/<em>) para que el corte
  // sea top-level y no quede envuelto en formato inline.
  let text = "";
  const out: string[] = [];
  const flush = () => {
    if (!text) return;
    let html = text;
    if (italic) html = `<em>${html}</em>`;
    if (bold) html = `<strong>${html}</strong>`;
    out.push(html);
    text = "";
  };
  // OOXML expresa los saltos de página de dos formas:
  //   - <w:br w:type="page"/>          salto manual (lo insertó el autor)
  //   - <w:lastRenderedPageBreak/>     hint de Word de dónde paginó (auto)
  // Ambos los traducimos al marcador de salto para que el docente VEA dónde
  // cambian las páginas del .docx original. Un <w:br/> sin type="page" es un
  // salto de línea suave (textWrapping) → <br/>.
  const TOKEN_RE =
    /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/?>|<w:br(\s[^>]*)?\/?>|<w:lastRenderedPageBreak\s*\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(runXml)) !== null) {
    const tag = m[0];
    if (tag.startsWith("<w:tab")) {
      text += "&#9;";
    } else if (tag.startsWith("<w:lastRenderedPageBreak")) {
      flush();
      out.push(PAGE_BREAK_HTML);
    } else if (tag.startsWith("<w:br")) {
      if (/w:type\s*=\s*"page"/.test(tag)) {
        flush();
        out.push(PAGE_BREAK_HTML);
      } else {
        text += "<br/>";
      }
    } else {
      text += escapeHtml(decodeXmlEntities(m[1] ?? ""));
    }
  }
  flush();
  return out.join("");
}

/** Nivel de encabezado del párrafo (1..4) o null si es párrafo normal. */
function paragraphHeadingLevel(paragraphXml: string): number | null {
  const style = /<w:pStyle\s+w:val="([^"]*)"/.exec(paragraphXml)?.[1] ?? "";
  const m = /(?:heading|t[íi]tulo)\s*([1-9])/i.exec(style);
  if (m) return Math.min(4, Math.max(1, Number(m[1])));
  return null;
}

/** Convierte un `<w:p>` a `<p>`/`<hN>` con sus runs formateados. */
function paragraphToHtml(paragraphXml: string): string {
  const runs: string[] = [];
  const RUN_RE = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
  let m: RegExpExecArray | null;
  while ((m = RUN_RE.exec(paragraphXml)) !== null) {
    const h = runToHtml(m[1] ?? "");
    if (h) runs.push(h);
  }
  const inner = runs.join("");
  if (!inner.trim()) return ""; // párrafo vacío → se omite
  const level = paragraphHeadingLevel(paragraphXml);
  const tag = level ? `h${level}` : "p";
  // Si el párrafo contiene saltos de página, los sacamos a nivel top-level:
  // un <div.examlab-page-break> dentro de un <p> es HTML inválido. Partimos
  // por el marcador y envolvemos cada fragmento de texto en su <p>/<hN>,
  // dejando el corte como hermano.
  if (!inner.includes(PAGE_BREAK_HTML)) {
    return `<${tag}>${inner}</${tag}>`;
  }
  const segments = inner.split(PAGE_BREAK_HTML);
  const html: string[] = [];
  segments.forEach((seg, i) => {
    if (seg.trim()) html.push(`<${tag}>${seg}</${tag}>`);
    if (i < segments.length - 1) html.push(PAGE_BREAK_HTML);
  });
  return html.join("");
}

/** Convierte un `<w:tbl>` a un `<table>` HTML simple (texto plano por celda). */
function tableToHtml(tableXml: string): string {
  const rows: string[] = [];
  const ROW_RE = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g;
  let rm: RegExpExecArray | null;
  while ((rm = ROW_RE.exec(tableXml)) !== null) {
    const cells: string[] = [];
    const CELL_RE = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
    let cm: RegExpExecArray | null;
    while ((cm = CELL_RE.exec(rm[1] ?? "")) !== null) {
      // Texto de la celda: concatenamos sus párrafos (sin formato fino).
      const cellText = escapeHtml(extractTextFromDocumentXml(cm[1] ?? "")).replace(/\n/g, "<br/>");
      cells.push(`<td style="border:1px solid #ccc;padding:4px;">${cellText}</td>`);
    }
    if (cells.length > 0) rows.push(`<tr>${cells.join("")}</tr>`);
  }
  if (rows.length === 0) return "";
  return `<table style="border-collapse:collapse;width:100%;">${rows.join("")}</table>`;
}

/**
 * Convierte el XML del cuerpo a HTML preservando párrafos, encabezados,
 * negrita/itálica y tablas, EN ORDEN. Una sola pasada con una regex que
 * matchea tablas O párrafos top-level: cuando matchea un `<w:tbl>` consume
 * el bloque completo (incl. sus párrafos internos), así que esos no se
 * re-emiten sueltos.
 */
export function extractHtmlFromDocumentXml(documentXml: string): string {
  const out: string[] = [];
  const BLOCK_RE = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(documentXml)) !== null) {
    if (m[1] !== undefined) {
      const t = tableToHtml(m[1]);
      if (t) out.push(t);
    } else {
      const p = paragraphToHtml(m[2] ?? "");
      if (p) out.push(p);
    }
  }
  return out.join("\n");
}

/**
 * Parsea un .docx y devuelve HTML con formato básico preservado (párrafos,
 * encabezados, negrita/itálica, tablas). Mismas validaciones de tamaño y
 * contenedor que `parseDocxToText`.
 */
export function parseDocxToHtml(bytes: Uint8Array): string {
  const xml = readDocumentXml(bytes);
  return extractHtmlFromDocumentXml(xml);
}

/** Lee y descomprime `word/document.xml` de los bytes del .docx. Compartido
 *  por las variantes texto/HTML. Lanza Error en español si algo falla. */
function readDocumentXml(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    throw new Error("El archivo está vacío.");
  }
  if (bytes.byteLength > MAX_DOCX_BYTES) {
    throw new Error("El archivo supera el tamaño máximo permitido (8 MB).");
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("El archivo no es un .docx válido (no se pudo descomprimir).");
  }
  const docXmlBytes = entries[DOCUMENT_XML_PATH];
  if (!docXmlBytes) {
    throw new Error("El archivo no contiene un documento de Word (falta word/document.xml).");
  }
  return strFromU8(docXmlBytes);
}

/**
 * Parsea un .docx (bytes del archivo subido) y devuelve su texto plano,
 * con un párrafo por línea. Lanza un Error con mensaje en español si el
 * archivo no es un ZIP válido o no contiene `word/document.xml`.
 */
export function parseDocxToText(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    throw new Error("El archivo está vacío.");
  }
  if (bytes.byteLength > MAX_DOCX_BYTES) {
    throw new Error("El archivo supera el tamaño máximo permitido (8 MB).");
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error("El archivo no es un .docx válido (no se pudo descomprimir).");
  }
  const docXmlBytes = entries[DOCUMENT_XML_PATH];
  if (!docXmlBytes) {
    throw new Error("El archivo no contiene un documento de Word (falta word/document.xml).");
  }
  const xml = strFromU8(docXmlBytes);
  return extractTextFromDocumentXml(xml);
}

/**
 * Extrae los placeholders `{{variable}}` presentes en un texto, sin
 * duplicados y en orden de aparición. Soporta tanto `{{var}}` (con
 * escape) como `{{{var}}}` (sin escape, el escape-hatch del
 * template-engine) — para ambos devuelve el path interno (`var`).
 *
 * NO devuelve los tags de bloque (`{{#each}}`, `{{/each}}`, `{{#if}}`,
 * `{{/if}}`) — solo las variables de interpolación, que es lo que el
 * docente quiere ver listado tras importar un .docx que ya traía
 * placeholders.
 */
export function extractPlaceholders(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  // {{{ raw }}} primero o {{ var }} — capturamos el contenido interno.
  const RE = /\{\{\{([\s\S]+?)\}\}\}|\{\{([\s\S]+?)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(text)) !== null) {
    const raw = (m[1] ?? m[2] ?? "").trim();
    if (!raw) continue;
    // Saltar tags de bloque y control.
    if (raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("@")) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    found.push(raw);
  }
  return found;
}
