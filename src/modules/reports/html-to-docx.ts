/**
 * Exportador HTML → .docx REAL (OOXML), sin librerías nuevas (fflate + DOMParser).
 *
 * Reemplaza la técnica anterior "HTML-como-Word" (.doc MSO): esa la abría Word
 * pero RE-INTERPRETABA el HTML y cambiaba el formato, y la cabecera quedaba al
 * INICIO del cuerpo en vez de en el área de ENCABEZADO de página. Acá generamos
 * un paquete OOXML válido:
 *   - el cuerpo va en `word/document.xml`,
 *   - la cabecera en `word/header1.xml` (área de encabezado, referenciada en
 *     `<w:sectPr><w:headerReference>`) → se repite arriba en CADA página,
 *   - el pie en `word/footer1.xml`,
 *   - las imágenes (logo) embebidas en `word/media/*` con su relación.
 *
 * Sólo mapea el subconjunto de HTML que produce nuestro importador/editor:
 * p, h1–h4, strong/b, em/i, br, span, a, img (data URI), table (con anchos de
 * `<w:tblGrid>` preservados vía width:% + colspan), y el divisor de salto de
 * página `.examlab-page-break`. Entrada: el HTML COMPUESTO (`composeTemplateHtml`)
 * — extraemos `<header>`, `<main>` y `<footer>` + el tamaño/orientación del @page.
 */
import { strToU8, zipSync } from "fflate";

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const ROOT_NS =
  `xmlns:w="${NS_W}" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
  `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ` +
  `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;

const EMU_PER_PX = 9525;
const TWIPS_PER_MM = 56.6929;

function xmlEscape(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function base64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = typeof atob !== "undefined"
      ? atob(b64)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : (globalThis as any).Buffer.from(b64, "base64").toString("binary");
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** data:image/png;base64,XXXX → { bytes, ext }. null si no se puede decodificar. */
function parseDataUri(uri: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:image\/([a-z0-9+.-]+);base64,([\s\S]+)$/i.exec(uri.trim());
  if (!m) return null;
  const bytes = base64ToBytes(m[2]);
  if (!bytes) return null;
  let ext = m[1].toLowerCase();
  if (ext === "jpeg") ext = "jpg";
  if (ext === "svg+xml") return null; // Word no embebe SVG por este camino
  if (!["png", "jpg", "gif"].includes(ext)) return null;
  return { bytes, ext };
}

/** Contexto de UNA parte (document/header/footer): acumula imágenes + relaciones. */
interface PartCtx {
  prefix: string; // 'doc' | 'hdr' | 'ftr' (para ids únicos de relación/imagen)
  rels: { id: string; target: string; type: string }[];
  media: { path: string; bytes: Uint8Array }[];
  imgSeq: number;
  /** Contador de `wp:docPr/@id` COMPARTIDO entre cuerpo/cabecera/pie: ese id
   *  debe ser único a nivel de TODO el documento (LibreOffice es estricto). */
  idSeq: { n: number };
}

function newPartCtx(prefix: string, idSeq: { n: number }): PartCtx {
  return { prefix, rels: [], media: [], imgSeq: 0, idSeq };
}

const IMAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

/** Estilo inline (style="...") → mapa de propiedades. */
function styleMap(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const s = el.getAttribute("style") ?? "";
  for (const decl of s.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
  }
  return out;
}

function jcFromAlign(align?: string): string {
  if (!align) return "";
  const a = align.toLowerCase();
  if (a === "center") return '<w:jc w:val="center"/>';
  if (a === "right" || a === "end") return '<w:jc w:val="right"/>';
  if (a === "justify" || a === "both") return '<w:jc w:val="both"/>';
  return "";
}

/** Formato de caracter acumulado por la recursión de inline. */
interface RunFmt {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  sz?: string; // medios-puntos (w:sz)
  color?: string; // hex sin #
  font?: string;
}

/** `<w:rPr>` desde el formato acumulado, en el orden que exige CT_RPr
 *  (rFonts, b, i, color, sz, u) — Word es estricto con la secuencia. */
function rPrXml(fmt: RunFmt): string {
  const parts: string[] = [];
  if (fmt.font) parts.push(`<w:rFonts w:ascii="${xmlEscape(fmt.font)}" w:hAnsi="${xmlEscape(fmt.font)}"/>`);
  if (fmt.b) parts.push("<w:b/>");
  if (fmt.i) parts.push("<w:i/>");
  if (fmt.color) parts.push(`<w:color w:val="${fmt.color}"/>`);
  if (fmt.sz) parts.push(`<w:sz w:val="${fmt.sz}"/>`);
  if (fmt.u) parts.push('<w:u w:val="single"/>');
  return parts.length ? `<w:rPr>${parts.join("")}</w:rPr>` : "";
}

/** Lee el `style` inline de un <span> y lo mezcla en el formato de run. */
function fmtFromSpanStyle(el: Element, base: RunFmt): RunFmt {
  const st = styleMap(el);
  const next: RunFmt = { ...base };
  const fs = st["font-size"];
  if (fs) {
    const pt = parseFloat(fs);
    if (Number.isFinite(pt) && pt > 0) next.sz = String(Math.round(pt * 2)); // pt → medios-puntos
  }
  const color = st["color"];
  const hex = /#([0-9a-fA-F]{6})/.exec(color ?? "")?.[1];
  if (hex) next.color = hex.toUpperCase();
  const ff = st["font-family"];
  if (ff) next.font = ff.replace(/['"]/g, "").split(",")[0].trim();
  return next;
}

/** Runs de contenido inline (texto + strong/em/u/br/img/span con estilos). */
function inlineRuns(node: Node, ctx: PartCtx, fmt: RunFmt): string {
  let out = "";
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3 /* text */) {
      const text = child.textContent ?? "";
      if (text.length === 0) return;
      out += `<w:r>${rPrXml(fmt)}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
      return;
    }
    if (child.nodeType !== 1) return;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") {
      out += "<w:r><w:br/></w:r>";
    } else if (tag === "strong" || tag === "b") {
      out += inlineRuns(el, ctx, { ...fmt, b: true });
    } else if (tag === "em" || tag === "i") {
      out += inlineRuns(el, ctx, { ...fmt, i: true });
    } else if (tag === "u") {
      out += inlineRuns(el, ctx, { ...fmt, u: true });
    } else if (tag === "img") {
      out += imageRun(el, ctx);
    } else if (tag === "span") {
      // Copia tamaño/color/fuente del .docx importado al run.
      out += inlineRuns(el, ctx, fmtFromSpanStyle(el, fmt));
    } else {
      // a / otros → heredar formato.
      out += inlineRuns(el, ctx, fmt);
    }
  });
  return out;
}

/** Run con un <w:drawing> para una imagen data-URI; "" si no se puede embeber. */
function imageRun(img: Element, ctx: PartCtx): string {
  const src = img.getAttribute("src") ?? "";
  const parsed = parseDataUri(src);
  if (!parsed) return "";
  const st = styleMap(img);
  const wPx = parseFloat(st["width"] ?? "") || 120;
  const hPx = parseFloat(st["height"] ?? "") || Math.round(wPx * 0.4);
  const cx = Math.max(1, Math.round(wPx * EMU_PER_PX));
  const cy = Math.max(1, Math.round(hPx * EMU_PER_PX));

  ctx.imgSeq += 1;
  const fileName = `image_${ctx.prefix}_${ctx.imgSeq}.${parsed.ext}`;
  const relId = `rId${ctx.prefix}Img${ctx.imgSeq}`;
  ctx.media.push({ path: `word/media/${fileName}`, bytes: parsed.bytes });
  ctx.rels.push({ id: relId, target: `media/${fileName}`, type: IMAGE_REL });
  const pid = ctx.idSeq.n++;

  return (
    "<w:r><w:drawing>" +
    `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${pid}" name="Imagen ${pid}"/>` +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${pid}" name="Imagen ${pid}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline>` +
    "</w:drawing></w:r>"
  );
}

/** Párrafo `<w:p>` desde un <p>/<h1-4>/td-content. styleId opcional (heading). */
function paragraph(el: Element, ctx: PartCtx, styleId?: string): string {
  const st = styleMap(el);
  const jc = jcFromAlign(st["text-align"]);
  const pStyle = styleId ? `<w:pStyle w:val="${styleId}"/>` : "";
  const pPr = pStyle || jc ? `<w:pPr>${pStyle}${jc}</w:pPr>` : "";
  const runs = inlineRuns(el, ctx, {});
  return `<w:p>${pPr}${runs}</w:p>`;
}

const HEADING_STYLE: Record<string, string> = { h1: "Heading1", h2: "Heading2", h3: "Heading3", h4: "Heading4" };

function tableToWml(table: Element, ctx: PartCtx): string {
  const rows = Array.from(table.querySelectorAll(":scope > tbody > tr, :scope > tr"));
  if (rows.length === 0) return "";
  // Anchos de columna desde la 1ª fila (width:% de cada td) → tblGrid en pct.
  const firstCells = Array.from(rows[0].children).filter((c) => c.tagName.toLowerCase() === "td");
  const pcts: number[] = [];
  for (const cell of firstCells) {
    const span = Math.max(1, Number(cell.getAttribute("colspan") ?? "1"));
    const w = parseFloat(styleMap(cell)["width"] ?? "");
    const per = Number.isFinite(w) ? w / span : 0;
    for (let k = 0; k < span; k++) pcts.push(per);
  }
  // Nº de columnas LÓGICAS = máx (suma de colspans) entre TODAS las filas
  // (no sólo la primera): si una fila posterior es más ancha, el grid debe
  // cubrirla o LibreOffice rechaza el archivo.
  let gridCols = 0;
  for (const tr of rows) {
    let n = 0;
    for (const c of Array.from(tr.children)) {
      if (c.tagName.toLowerCase() !== "td") continue;
      n += Math.max(1, Number(c.getAttribute("colspan") ?? "1"));
    }
    gridCols = Math.max(gridCols, n);
  }
  gridCols = Math.max(1, gridCols);
  const total = pcts.reduce((a, b) => a + b, 0);
  // `<w:tblGrid>` es OBLIGATORIO en CT_Tbl (minOccurs=1): si lo omitiéramos
  // cuando no hay anchos, Word muestra "contenido ilegible / reparar". Por eso
  // SIEMPRE se emite — con los % de la 1ª fila si cubren todas las columnas, o
  // equitativo en caso contrario.
  const grid =
    total > 0 && pcts.length === gridCols
      ? `<w:tblGrid>${pcts.map((p) => `<w:gridCol w:w="${Math.max(1, Math.round((p / total) * 9000))}"/>`).join("")}</w:tblGrid>`
      : `<w:tblGrid>${Array.from({ length: gridCols }, () => `<w:gridCol w:w="${Math.round(9000 / gridCols)}"/>`).join("")}</w:tblGrid>`;
  const tblPr = `<w:tblPr><w:tblW w:type="pct" w:w="5000"/><w:tblLayout w:type="fixed"/></w:tblPr>`;

  const trs = rows
    .map((tr) => {
      const cells = Array.from(tr.children).filter((c) => c.tagName.toLowerCase() === "td");
      const tcs = cells
        .map((td) => {
          const tdStyle = styleMap(td);
          const span = Math.max(1, Number(td.getAttribute("colspan") ?? "1"));
          const w = parseFloat(tdStyle["width"] ?? "");
          const tcW = Number.isFinite(w) ? `<w:tcW w:type="pct" w:w="${Math.round(w * 50)}"/>` : "";
          const gridSpan = span > 1 ? `<w:gridSpan w:val="${span}"/>` : "";
          // Borde POR CELDA (la celda con borde lleva su caja; el logo no).
          const hasBorder = /\b(solid|double|dashed|dotted)\b/i.test(tdStyle["border"] ?? "");
          const tcBorders = hasBorder
            ? "<w:tcBorders>" +
              ["top", "left", "bottom", "right"]
                .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="444444"/>`)
                .join("") +
              "</w:tcBorders>"
            : "";
          // Sombreado de celda (background-color) + alineación vertical.
          const fillHex = /#([0-9a-fA-F]{6})/.exec(tdStyle["background-color"] ?? "")?.[1];
          const shd = fillHex
            ? `<w:shd w:val="clear" w:color="auto" w:fill="${fillHex.toUpperCase()}"/>`
            : "";
          const va = tdStyle["vertical-align"];
          const vAlign = va === "top" ? "top" : va === "bottom" ? "bottom" : "center";
          // Orden CT_TcPr: tcW, gridSpan, tcBorders, shd, vAlign.
          const tcPr = `<w:tcPr>${tcW}${gridSpan}${tcBorders}${shd}<w:vAlign w:val="${vAlign}"/></w:tcPr>`;
          // El contenido de la celda son párrafos; Word exige ≥1 <w:p>.
          const inner = cellContent(td, ctx);
          return `<w:tc>${tcPr}${inner}</w:tc>`;
        })
        .join("");
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join("");
  return `<w:tbl>${tblPr}${grid}${trs}</w:tbl>`;
}

/** Contenido de una celda: sus bloques; si no hay, un párrafo con sus runs. */
function cellContent(td: Element, ctx: PartCtx): string {
  const blocks = blocksToWml(td, ctx);
  return blocks.trim() ? blocks : `<w:p>${inlineRuns(td, ctx, {})}</w:p>`;
}

/** Recorre los hijos de bloque de un contenedor → WML (párrafos/tablas/saltos). */
function blocksToWml(container: Element, ctx: PartCtx): string {
  let out = "";
  container.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const text = (child.textContent ?? "").trim();
      if (text) out += `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
      return;
    }
    if (child.nodeType !== 1) return;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "table") {
      out += tableToWml(el, ctx);
    } else if (HEADING_STYLE[tag]) {
      out += paragraph(el, ctx, HEADING_STYLE[tag]);
    } else if (tag === "p") {
      out += paragraph(el, ctx);
    } else if (tag === "div" && el.classList.contains("examlab-page-break")) {
      out += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    } else if (tag === "br") {
      out += "<w:p></w:p>";
    } else if (tag === "ul" || tag === "ol") {
      // Listas → un párrafo por <li> con viñeta textual (mapeo simple, sin
      // numbering.xml para no inflar el paquete).
      Array.from(el.children).forEach((li) => {
        if (li.tagName.toLowerCase() !== "li") return;
        const bullet = tag === "ol" ? "" : "•  ";
        out += `<w:p><w:r><w:t xml:space="preserve">${bullet}</w:t></w:r>${inlineRuns(li, ctx, {})}</w:p>`;
      });
    } else if (tag === "header" || tag === "main" || tag === "footer" || tag === "div" || tag === "section") {
      out += blocksToWml(el, ctx); // contenedor → recursar
    } else {
      // Elemento inline a nivel de bloque → envolver en un párrafo.
      const runs = inlineRuns(el, ctx, {});
      if (runs.trim()) out += `<w:p>${runs}</w:p>`;
    }
  });
  return out;
}

function relsXml(rels: { id: string; target: string; type: string }[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("") +
    `</Relationships>`
  );
}

const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:styles xmlns:w="${NS_W}">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  [1, 2, 3, 4]
    .map(
      (n) =>
        `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>` +
        `<w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="${n - 1}"/><w:spacing w:before="120" w:after="60"/></w:pPr>` +
        `<w:rPr><w:b/><w:sz w:val="${36 - (n - 1) * 4}"/></w:rPr></w:style>`,
    )
    .join("") +
  `</w:styles>`;

/** Tamaño de página en twips (A4 / letter, portrait/landscape). */
function pageSize(size: string, orientation: string): { w: number; h: number; landscape: boolean } {
  const base = size === "letter" ? { w: 12240, h: 15840 } : { w: 11906, h: 16838 };
  const landscape = orientation === "landscape";
  return landscape ? { w: base.h, h: base.w, landscape } : { ...base, landscape };
}

export interface DocxFromHtmlOptions {
  pageSize?: "A4" | "letter";
  pageOrientation?: "portrait" | "landscape";
}

/**
 * Construye el MAPA de partes OOXML (ruta → bytes) de un .docx a partir del
 * HTML COMPUESTO del informe. Extrae `<header>`, `<main>`/`<body>` y `<footer>`;
 * la cabecera va al área de encabezado de página (word/header1.xml). Expuesto
 * aparte de `htmlToDocxBlob` para poder validar la estructura OOXML en tests.
 * DOMParser-dependiente (browser/jsdom).
 */
export function htmlToDocxFiles(
  composedHtml: string,
  opts?: DocxFromHtmlOptions,
): Record<string, Uint8Array> {
  const doc = new DOMParser().parseFromString(composedHtml, "text/html");
  const headerEl = doc.querySelector("header");
  const footerEl = doc.querySelector("footer");
  const mainEl = doc.querySelector("main") ?? doc.body;

  const margin = Math.round(18 * TWIPS_PER_MM); // 18mm
  // Tamaño/orientación: de opts o, si no, del `@page size: A4 portrait` del HTML.
  const pageDecl = /@page\s*\{[^}]*size:\s*(a4|letter)\s+(portrait|landscape)/i.exec(composedHtml);
  const size = pageSize(
    opts?.pageSize ?? ((pageDecl?.[1]?.toLowerCase() === "letter" ? "letter" : "A4")),
    opts?.pageOrientation ?? (pageDecl?.[2]?.toLowerCase() === "landscape" ? "landscape" : "portrait"),
  );

  // Contador de ids de dibujo compartido por todas las partes.
  const idSeq = { n: 1 };

  // ── Cuerpo ──
  const docCtx = newPartCtx("doc", idSeq);
  let bodyWml = blocksToWml(mainEl, docCtx);
  if (!bodyWml.trim()) bodyWml = "<w:p/>";

  // ── Cabecera / pie (partes propias con sus imágenes) ──
  const files: Record<string, Uint8Array> = {};
  const docRels: { id: string; target: string; type: string }[] = [
    {
      id: "rIdStyles",
      target: "styles.xml",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
    },
  ];
  let headerRef = "";
  let footerRef = "";
  const ctOverrides: string[] = [
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`,
  ];

  if (headerEl) {
    const hCtx = newPartCtx("hdr", idSeq);
    const hWml = blocksToWml(headerEl, hCtx) || "<w:p/>";
    files["word/header1.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${ROOT_NS}>${hWml}</w:hdr>`,
    );
    if (hCtx.rels.length) files["word/_rels/header1.xml.rels"] = strToU8(relsXml(hCtx.rels));
    for (const m of hCtx.media) files[m.path] = m.bytes;
    docRels.push({
      id: "rIdHdr1",
      target: "header1.xml",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header",
    });
    headerRef = '<w:headerReference w:type="default" r:id="rIdHdr1"/>';
    ctOverrides.push(
      `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>`,
    );
  }
  if (footerEl) {
    const fCtx = newPartCtx("ftr", idSeq);
    const fWml = blocksToWml(footerEl, fCtx) || "<w:p/>";
    files["word/footer1.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr ${ROOT_NS}>${fWml}</w:ftr>`,
    );
    if (fCtx.rels.length) files["word/_rels/footer1.xml.rels"] = strToU8(relsXml(fCtx.rels));
    for (const m of fCtx.media) files[m.path] = m.bytes;
    docRels.push({
      id: "rIdFtr1",
      target: "footer1.xml",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer",
    });
    footerRef = '<w:footerReference w:type="default" r:id="rIdFtr1"/>';
    ctOverrides.push(
      `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>`,
    );
  }

  // Imágenes + relaciones del cuerpo.
  for (const m of docCtx.media) files[m.path] = m.bytes;
  for (const rel of docCtx.rels) docRels.push(rel);

  const sectPr =
    `<w:sectPr>${headerRef}${footerRef}` +
    `<w:pgSz w:w="${size.w}" w:h="${size.h}"${size.landscape ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="${margin}" w:right="${margin}" w:bottom="${margin}" w:left="${margin}" w:header="708" w:footer="708" w:gutter="0"/>` +
    `</w:sectPr>`;

  files["word/document.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document ${ROOT_NS}><w:body>${bodyWml}${sectPr}</w:body></w:document>`,
  );
  files["word/styles.xml"] = strToU8(STYLES_XML);
  files["word/_rels/document.xml.rels"] = strToU8(relsXml(docRels));
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Default Extension="png" ContentType="image/png"/>` +
      `<Default Extension="jpg" ContentType="image/jpeg"/>` +
      `<Default Extension="gif" ContentType="image/gif"/>` +
      ctOverrides.join("") +
      `</Types>`,
  );

  return files;
}

/**
 * Construye un .docx (Blob OOXML) a partir del HTML COMPUESTO del informe.
 * La cabecera va al área de encabezado de página (word/header1.xml).
 */
export function htmlToDocxBlob(composedHtml: string, opts?: DocxFromHtmlOptions): Blob {
  const zipped = zipSync(htmlToDocxFiles(composedHtml, opts));
  return new Blob([new Uint8Array(zipped)], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}
