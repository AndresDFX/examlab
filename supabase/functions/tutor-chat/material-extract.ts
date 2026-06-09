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
  return e === "docx" || e === "pptx";
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
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
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
