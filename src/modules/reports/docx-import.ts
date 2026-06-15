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

// ── Imágenes embebidas + relaciones (rels) ─────────────────────────────
// Un .docx referencia imágenes por relationship id (rId). El mapeo rId →
// archivo vive en word/_rels/<part>.xml.rels; el binario en word/media/*.
// Embebemos las imágenes como data URI para que sobrevivan en el HTML
// guardado y en la exportación (Word/PDF) sin depender de archivos externos.
// Así las CABECERAS con logo del .docx aparecen en el preview y al exportar.

/** Función que resuelve un rId de imagen a un data URI (o null). */
export type ImageResolver = (rId: string) => string | null;

const NO_IMAGES: ImageResolver = () => null;

/** rId → ruta destino, parseado de un *.rels. Ignora relaciones externas. */
function parseRels(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  const RE = /<Relationship\b[^>]*?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(relsXml)) !== null) {
    const tag = m[0];
    if (/\bTargetMode="External"/.test(tag)) continue;
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (id && target) map.set(id, target);
  }
  return map;
}

/** Resuelve un Target (relativo con `../`/`./`, o absoluto `/word/...`) contra
 *  el directorio de la parte (ej. "word/"). Devuelve la ruta canónica del ZIP. */
function resolveTarget(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const stack: string[] = [];
  for (const part of (baseDir + target).split("/")) {
    if (part === "..") stack.pop();
    else if (part !== "." && part !== "") stack.push(part);
  }
  return stack.join("/");
}

/** MIME de una imagen por extensión, o null si el navegador no la renderiza
 *  en `<img>` (emf/wmf/tiff → vectoriales/legacy de Windows, se omiten). */
function imageMime(path: string): string | null {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "bmp": return "image/bmp";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    default: return null;
  }
}

/** Base64 de un Uint8Array (browser `btoa`, o `Buffer` en Node/jsdom). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  if (typeof btoa !== "undefined") return btoa(binary);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).Buffer.from(bytes).toString("base64");
}

/** Construye un ImageResolver para una parte (document/header/footer) dado su
 *  mapa de rels y las entradas del ZIP. `baseDir` = carpeta de la parte. */
function makeImageResolver(
  rels: Map<string, string>,
  entries: Record<string, Uint8Array>,
  baseDir: string,
): ImageResolver {
  const cache = new Map<string, string | null>();
  return (rId: string) => {
    if (cache.has(rId)) return cache.get(rId) ?? null;
    let uri: string | null = null;
    const target = rels.get(rId);
    if (target) {
      const path = resolveTarget(baseDir, target);
      const bytes = entries[path];
      const mime = imageMime(path);
      if (bytes && mime) uri = `data:${mime};base64,${bytesToBase64(bytes)}`;
    }
    cache.set(rId, uri);
    return uri;
  };
}

/** Extrae las imágenes de UN run: `<a:blip r:embed>` (DrawingML moderno) y
 *  `<v:imagedata r:id>` (VML legacy). Devuelve `<img>` con data URI;
 *  dimensiona por `<wp:extent>` (EMU → px CSS) cuando está presente. */
function runImagesToHtml(runXml: string, resolveImage: ImageResolver): string {
  const ids: string[] = [];
  const BLIP = /<a:blip\b[^>]*?\br:embed="([^"]+)"/g;
  const VML = /<v:imagedata\b[^>]*?\br:id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = BLIP.exec(runXml)) !== null) ids.push(m[1]);
  while ((m = VML.exec(runXml)) !== null) ids.push(m[1]);
  if (ids.length === 0) return "";
  // Dimensión del drawing (EMU; 9525 EMU = 1px CSS).
  const extent = /<wp:extent\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(runXml);
  let sizeStyle = "max-width:100%;height:auto;";
  if (extent) {
    const w = Math.round(Number(extent[1]) / 9525);
    if (w > 0) sizeStyle = `width:${w}px;max-width:100%;height:auto;`;
  }
  const imgs: string[] = [];
  for (const id of ids) {
    const uri = resolveImage(id);
    if (uri) imgs.push(`<img src="${uri}" style="${sizeStyle}" alt="" />`);
  }
  return imgs.join("");
}

/** Alineación del párrafo (`<w:jc>`) → valor CSS `text-align`, o null. */
function paragraphAlign(paragraphXml: string): string | null {
  const v = /<w:jc\s+w:val="([^"]+)"/.exec(paragraphXml)?.[1];
  if (v === "center") return "center";
  if (v === "right" || v === "end") return "right";
  if (v === "both" || v === "distribute") return "justify";
  return null;
}

/** Texto + formato (negrita/itálica) de UN run `<w:r>`. */
function runToHtml(runXml: string, resolveImage: ImageResolver = NO_IMAGES): string {
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
  // Imágenes del run (logo de cabecera, etc.) → al final del run.
  const imgs = runImagesToHtml(runXml, resolveImage);
  if (imgs) out.push(imgs);
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
function paragraphToHtml(paragraphXml: string, resolveImage: ImageResolver = NO_IMAGES): string {
  const runs: string[] = [];
  const RUN_RE = /<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g;
  let m: RegExpExecArray | null;
  while ((m = RUN_RE.exec(paragraphXml)) !== null) {
    const h = runToHtml(m[1] ?? "", resolveImage);
    if (h) runs.push(h);
  }
  const inner = runs.join("");
  if (!inner.trim()) return ""; // párrafo vacío → se omite
  const level = paragraphHeadingLevel(paragraphXml);
  const tag = level ? `h${level}` : "p";
  const align = paragraphAlign(paragraphXml);
  const attr = align ? ` style="text-align:${align}"` : "";
  // Si el párrafo contiene saltos de página, los sacamos a nivel top-level:
  // un <div.examlab-page-break> dentro de un <p> es HTML inválido. Partimos
  // por el marcador y envolvemos cada fragmento de texto en su <p>/<hN>,
  // dejando el corte como hermano.
  if (!inner.includes(PAGE_BREAK_HTML)) {
    return `<${tag}${attr}>${inner}</${tag}>`;
  }
  const segments = inner.split(PAGE_BREAK_HTML);
  const html: string[] = [];
  segments.forEach((seg, i) => {
    if (seg.trim()) html.push(`<${tag}${attr}>${seg}</${tag}>`);
    if (i < segments.length - 1) html.push(PAGE_BREAK_HTML);
  });
  return html.join("");
}

/** ¿La tabla/celda define un borde visible (no `nil`/`none`)? */
const HAS_VISIBLE_BORDER = /<w:(?:tbl|tc)Borders>[\s\S]*?w:val="(?:single|double|thick|dotted|dashed|wave)"/;

/**
 * Porcentajes de ancho de columna a partir del `<w:tblGrid>` del .docx (cada
 * `<w:gridCol w:w="twips"/>` define el ancho de una columna). Preservarlos es
 * lo que evita que una cabecera "logo | título | versión" se DESFASE al
 * exportar (sin esto las columnas reflowean a ancho automático/igual y la
 * estructura queda distinta al original). Devuelve [] si no hay grid.
 */
function parseGridColPercents(tableXml: string): number[] {
  const grid = /<w:tblGrid>([\s\S]*?)<\/w:tblGrid>/.exec(tableXml)?.[1] ?? "";
  const widths: number[] = [];
  const RE = /<w:gridCol\b[^>]*\bw:w="(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = RE.exec(grid)) !== null) widths.push(Number(m[1]));
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= 0 || widths.length === 0) return [];
  return widths.map((w) => Math.round((w / total) * 1000) / 10); // % con 1 decimal
}

/**
 * Convierte un `<w:tbl>` a un `<table>` HTML preservando el CONTENIDO de cada
 * celda (párrafos con imágenes/negrita/alineación, no sólo texto plano) — así
 * una cabecera tipo "logo | título | versión" se ve como en el .docx. Los
 * bordes se respetan sólo si la tabla o la celda los declaran (una cabecera
 * sin bordes no inventa líneas; una tabla de datos sí las conserva).
 */
function tableToHtml(tableXml: string, resolveImage: ImageResolver = NO_IMAGES): string {
  const tblHasBorder = HAS_VISIBLE_BORDER.test(/<w:tblPr>[\s\S]*?<\/w:tblPr>/.exec(tableXml)?.[0] ?? "");
  const colPercents = parseGridColPercents(tableXml);
  const useFixed = colPercents.length > 0; // con grid → respetar anchos exactos
  const rows: string[] = [];
  const ROW_RE = /<w:tr(?:\s[^>]*)?>([\s\S]*?)<\/w:tr>/g;
  let rm: RegExpExecArray | null;
  while ((rm = ROW_RE.exec(tableXml)) !== null) {
    const cells: string[] = [];
    const CELL_RE = /<w:tc(?:\s[^>]*)?>([\s\S]*?)<\/w:tc>/g;
    let cm: RegExpExecArray | null;
    let colIdx = 0; // índice de columna para mapear anchos del grid
    while ((cm = CELL_RE.exec(rm[1] ?? "")) !== null) {
      const cellXml = cm[1] ?? "";
      const cellHasBorder = tblHasBorder || HAS_VISIBLE_BORDER.test(cellXml);
      // gridSpan: cuántas columnas del grid ocupa esta celda (título centrado
      // de la cabecera suele abarcar varias).
      const span = Math.max(1, Number(/<w:gridSpan\s+w:val="(\d+)"/.exec(cellXml)?.[1] ?? "1"));
      let widthStyle = "";
      if (useFixed) {
        let pct = 0;
        for (let k = 0; k < span && colIdx + k < colPercents.length; k++) pct += colPercents[colIdx + k];
        if (pct > 0) widthStyle = `width:${Math.round(pct * 10) / 10}%;`;
      }
      colIdx += span;
      // Contenido de la celda: sus párrafos con formato/imágenes.
      const paras: string[] = [];
      const PARA_RE = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
      let pm: RegExpExecArray | null;
      while ((pm = PARA_RE.exec(cellXml)) !== null) {
        const ph = paragraphToHtml(pm[1] ?? "", resolveImage);
        if (ph) paras.push(ph);
      }
      const cellHtml = paras.join("") || "&nbsp;";
      const border = cellHasBorder ? "border:1px solid #444;" : "";
      const colspanAttr = span > 1 ? ` colspan="${span}"` : "";
      cells.push(
        `<td${colspanAttr} style="padding:4px 6px;vertical-align:middle;${widthStyle}${border}">${cellHtml}</td>`,
      );
    }
    if (cells.length > 0) rows.push(`<tr>${cells.join("")}</tr>`);
  }
  if (rows.length === 0) return "";
  // table-layout:fixed sólo cuando hay anchos de grid → respeta los % exactos
  // (sin esto el navegador re-reparte por contenido y la cabecera se desfasa).
  const tableStyle = `border-collapse:collapse;width:100%;${useFixed ? "table-layout:fixed;" : ""}`;
  return `<table style="${tableStyle}">${rows.join("")}</table>`;
}

/**
 * Convierte el XML del cuerpo a HTML preservando párrafos, encabezados,
 * negrita/itálica y tablas, EN ORDEN. Una sola pasada con una regex que
 * matchea tablas O párrafos top-level: cuando matchea un `<w:tbl>` consume
 * el bloque completo (incl. sus párrafos internos), así que esos no se
 * re-emiten sueltos.
 */
export function extractHtmlFromDocumentXml(
  documentXml: string,
  resolveImage: ImageResolver = NO_IMAGES,
): string {
  const out: string[] = [];
  const BLOCK_RE = /<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(documentXml)) !== null) {
    if (m[1] !== undefined) {
      const t = tableToHtml(m[1], resolveImage);
      if (t) out.push(t);
    } else {
      const p = paragraphToHtml(m[2] ?? "", resolveImage);
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
  return parseDocxBundle(bytes).bodyHtml;
}

/** HTML del cuerpo + cabecera + pie de un .docx (con imágenes embebidas). */
export interface DocxBundle {
  bodyHtml: string;
  headerHtml: string;
  footerHtml: string;
}

/** Descomprime el .docx validando tamaño/contenedor (compartido). */
function unzipDocx(bytes: Uint8Array): Record<string, Uint8Array> {
  if (bytes.byteLength === 0) throw new Error("El archivo está vacío.");
  if (bytes.byteLength > MAX_DOCX_BYTES) {
    throw new Error("El archivo supera el tamaño máximo permitido (8 MB).");
  }
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error("El archivo no es un .docx válido (no se pudo descomprimir).");
  }
}

/** Lee y parsea un *.rels del ZIP (vacío si no existe). */
function readRels(entries: Record<string, Uint8Array>, path: string): Map<string, string> {
  const b = entries[path];
  return b ? parseRels(strFromU8(b)) : new Map<string, string>();
}

/**
 * Resuelve y extrae a HTML la CABECERA o PIE "por defecto" del documento.
 * Word referencia los headers/footers en `<w:sectPr>` vía
 * `<w:headerReference w:type="default|first|even" r:id="rIdX"/>`. Elegimos el
 * `default` (luego `first`, luego cualquiera); si no hay referencia, caemos a
 * `word/header1.xml` / `word/footer1.xml` si existen. Las imágenes de la parte
 * (logo institucional) se embeben con su propio mapa de rels.
 */
function extractHeaderFooter(
  entries: Record<string, Uint8Array>,
  documentXml: string,
  docRels: Map<string, string>,
  kind: "header" | "footer",
): string {
  const refTag = kind === "header" ? "headerReference" : "footerReference";
  const byType: Record<string, string> = {};
  const REF_RE = new RegExp(`<w:${refTag}\\b[^>]*>`, "g");
  let rm: RegExpExecArray | null;
  while ((rm = REF_RE.exec(documentXml)) !== null) {
    const tag = rm[0];
    const type = /w:type="([^"]+)"/.exec(tag)?.[1] ?? "default";
    const rid = /r:id="([^"]+)"/.exec(tag)?.[1];
    if (rid) byType[type] = rid;
  }
  const chosenRid = byType["default"] ?? byType["first"] ?? byType["even"] ?? null;

  let partPath: string | null = null;
  if (chosenRid) {
    const target = docRels.get(chosenRid);
    if (target) partPath = resolveTarget("word/", target);
  }
  if (!partPath || !entries[partPath]) {
    const guess = `word/${kind}1.xml`;
    if (entries[guess]) partPath = guess;
    else return "";
  }

  const xml = strFromU8(entries[partPath]);
  const fileName = partPath.split("/").pop() ?? "";
  const baseDir = partPath.slice(0, partPath.length - fileName.length); // "word/"
  const rels = readRels(entries, `${baseDir}_rels/${fileName}.rels`);
  const resolver = makeImageResolver(rels, entries, baseDir);
  return extractHtmlFromDocumentXml(xml, resolver);
}

/**
 * Parsea un .docx COMPLETO: cuerpo + cabecera + pie, con las imágenes
 * (logos, sellos) embebidas como data URI. La cabecera va a `header_html` de
 * la plantilla y el pie a `footer_html`, así el preview y la exportación
 * muestran el documento ORIGINAL completo (lo "antiguo") y el docente sólo
 * agrega encima sus `{{variables}}` (lo "nuevo").
 */
export function parseDocxBundle(bytes: Uint8Array): DocxBundle {
  const entries = unzipDocx(bytes);
  const docXmlBytes = entries[DOCUMENT_XML_PATH];
  if (!docXmlBytes) {
    throw new Error("El archivo no contiene un documento de Word (falta word/document.xml).");
  }
  const documentXml = strFromU8(docXmlBytes);
  const docRels = readRels(entries, "word/_rels/document.xml.rels");
  const bodyResolver = makeImageResolver(docRels, entries, "word/");
  return {
    bodyHtml: extractHtmlFromDocumentXml(documentXml, bodyResolver),
    headerHtml: extractHeaderFooter(entries, documentXml, docRels, "header"),
    footerHtml: extractHeaderFooter(entries, documentXml, docRels, "footer"),
  };
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
