/**
 * material-extract (copia Deno) — extracción de TEXTO legible del material
 * del curso para el contexto del Tutor IA.
 *
 * COPIA VERBATIM de `src/modules/contents/material-extract.ts` (Deno no
 * importa de `src/`). Si cambias una, sincroniza la otra. La parte de unzip
 * (fflate) NO vive acá — la hace el handler del edge con los bytes ya
 * descargados de Storage; acá solo van las transformaciones puras
 * string/JSON → texto.
 */

export function extensionOf(name: string | null | undefined): string {
  if (!name) return "";
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function isNotebook(name: string | null | undefined): boolean {
  return extensionOf(name) === "ipynb";
}

export function isOfficeDoc(name: string | null | undefined): boolean {
  const e = extensionOf(name);
  return e === "docx" || e === "pptx" || e === "xlsx";
}

export function isImageFile(name: string | null | undefined): boolean {
  return /^(png|jpg|jpeg|gif|webp|svg|bmp)$/.test(extensionOf(name));
}

export function isReferenceableFile(name: string | null | undefined): boolean {
  if (!name) return false;
  if (isImageFile(name)) return false;
  const e = extensionOf(name);
  if (e === "zip" || e === "rar" || e === "7z" || e === "mp4" || e === "mp3" || e === "wav") {
    return false;
  }
  return true;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // Guard code point fuera de rango (evita RangeError que descarta todo el doc).
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      const cp = parseInt(h, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&#(\d+);/g, (m, d) => {
      const cp = parseInt(d, 10);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    })
    .replace(/&amp;/g, "&");
}

function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function notebookToReadableText(jsonText: string | null | undefined): string {
  if (!jsonText) return "";
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return "";
  }
  // deno-lint-ignore no-explicit-any
  const raw = obj as any;
  if (!raw || !Array.isArray(raw.cells)) return "";
  const lang = String(
    raw.metadata?.kernelspec?.language || raw.metadata?.language_info?.name || "python",
  );
  const blocks: string[] = [];
  for (const c of raw.cells) {
    const source = Array.isArray(c?.source)
      ? c.source.join("")
      : typeof c?.source === "string"
        ? c.source
        : "";
    const text = source.trim();
    if (!text) continue;
    if (c?.cell_type === "markdown" || c?.cell_type === "raw") {
      blocks.push(text);
    } else {
      blocks.push("```" + lang + "\n" + text + "\n```");
    }
  }
  return normalizeWhitespace(blocks.join("\n\n"));
}

export function docxXmlToText(documentXml: string | null | undefined): string {
  if (!documentXml) return "";
  let s = documentXml;
  s = s.replace(/<w:tab\b[^>]*\/?>/g, "\t");
  s = s.replace(/<w:br\b[^>]*\/?>/g, "\n");
  s = s.replace(/<\/w:p>/g, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeXmlEntities(s);
  return normalizeWhitespace(s);
}

export function pptxSlideXmlToText(slideXml: string | null | undefined): string {
  if (!slideXml) return "";
  let s = slideXml;
  s = s.replace(/<a:br\b[^>]*\/?>/g, "\n");
  s = s.replace(/<\/a:p>/g, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeXmlEntities(s);
  return normalizeWhitespace(s);
}

// Tabla de cadenas compartidas de un .xlsx (xl/sharedStrings.xml).
export function xlsxSharedStrings(sstXml: string | null | undefined): string[] {
  if (!sstXml) return [];
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(sstXml))) {
    const parts: string[] = [];
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(m[1]))) parts.push(tm[1]);
    out.push(decodeXmlEntities(parts.join("")));
  }
  return out;
}

// Texto plano de una hoja de xlsx (xl/worksheets/sheetN.xml) usando sharedStrings.
export function xlsxSheetXmlToText(
  sheetXml: string | null | undefined,
  sharedStrings: string[] = [],
): string {
  if (!sheetXml) return "";
  const rows: string[] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(sheetXml))) {
    const cells: string[] = [];
    const cRe = /<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cRe.exec(rm[1]))) {
      const attrs = cm[1];
      const body = cm[2];
      let val = "";
      if (/\bt="inlineStr"/.test(attrs)) {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
        val = t ? decodeXmlEntities(t[1]) : "";
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const raw = v ? v[1] : "";
        if (/\bt="s"/.test(attrs)) {
          const idx = parseInt(raw, 10);
          val = Number.isFinite(idx) ? (sharedStrings[idx] ?? "") : "";
        } else {
          val = decodeXmlEntities(raw);
        }
      }
      if (val) cells.push(val);
    }
    if (cells.length) rows.push(cells.join("\t"));
  }
  return normalizeWhitespace(rows.join("\n"));
}
