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
