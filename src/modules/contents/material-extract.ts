/**
 * material-extract — extracción de TEXTO legible del material del curso
 * (para alimentar al Tutor IA y otros consumidores que necesiten el
 * contenido, no solo el título).
 *
 * Helpers PUROS: sin red, sin Date.now. La descarga de Storage + el unzip
 * (docx/pptx son ZIPs) los hace el caller (el edge `tutor-chat`, con fflate);
 * acá solo transformamos strings/JSON ya obtenidos a texto plano legible.
 *
 * Tres tipos de material:
 *   - INLINE de texto/código: el `files[].body` ya es texto (md, txt, .java,
 *     .py, .js, etc.) → se usa tal cual.
 *   - Notebook `.ipynb`: el body es JSON → `notebookToReadableText` lo
 *     convierte a markdown + bloques de código (lo que explica + lo que
 *     muestra), descartando outputs/figuras.
 *   - Office binario (`.docx` / `.pptx` / `.xlsx`): NO tiene body inline; el
 *     edge baja el archivo de Storage, lo descomprime (ZIP) y pasa el XML
 *     interno por `docxXmlToText` / `pptxSlideXmlToText` / `xlsxSheetXmlToText`
 *     (+ `xlsxSharedStrings` para la tabla de cadenas del xlsx).
 *   - `.csv`: es texto → se guarda inline en `body` al subir (como el código),
 *     así que se lee directo. `.pdf` aún NO se extrae (requiere una lib Deno
 *     de PDF, p. ej. `npm:unpdf`; pendiente).
 *
 * INVARIANTE: existe una copia Deno casi verbatim en
 * `supabase/functions/tutor-chat/material-extract.ts` (Deno no importa de
 * `src/`). Si cambias una, sincroniza la otra (ver CLAUDE.md, invariantes
 * cross-file).
 */

/** Extensión en minúsculas (sin el punto) o "" si no tiene. */
export function extensionOf(name: string | null | undefined): string {
  if (!name) return "";
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** ¿Es un Jupyter notebook? */
export function isNotebook(name: string | null | undefined): boolean {
  return extensionOf(name) === "ipynb";
}

/** ¿Es un docx/pptx/xlsx que requiere extracción desde Storage (sin body inline)? */
export function isOfficeDoc(name: string | null | undefined): boolean {
  const e = extensionOf(name);
  return e === "docx" || e === "pptx" || e === "xlsx";
}

/** ¿Es una imagen (no aporta texto al tutor)? */
export function isImageFile(name: string | null | undefined): boolean {
  return /^(png|jpg|jpeg|gif|webp|svg|bmp)$/.test(extensionOf(name));
}

/**
 * ¿El archivo puede aportar texto legible al tutor? Cualquiera que tenga
 * body inline (texto/código/notebook) o sea office (docx/pptx, extraíble).
 * Las imágenes y binarios sin texto NO. Usado por el UI para listar los
 * archivos referenciables con `#`.
 */
export function isReferenceableFile(name: string | null | undefined): boolean {
  if (!name) return false;
  if (isImageFile(name)) return false;
  const e = extensionOf(name);
  // Binarios sin texto extraíble (los excluimos del picker).
  if (e === "zip" || e === "rar" || e === "7z" || e === "mp4" || e === "mp3" || e === "wav") {
    return false;
  }
  return true;
}

/** Decodifica las entidades XML básicas + numéricas. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    // & al final para no re-decodificar entidades ya resueltas.
    .replace(/&amp;/g, "&");
}

/** Normaliza whitespace: colapsa 3+ saltos, quita trailing spaces por línea. */
function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convierte el JSON de un .ipynb a texto legible: celdas markdown como texto
 * y celdas de código en bloques fenced ```. Descarta outputs (no son fuente
 * del docente) y celdas vacías. Devuelve "" si el JSON es inválido.
 */
export function notebookToReadableText(jsonText: string | null | undefined): string {
  if (!jsonText) return "";
  let obj: unknown;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return "";
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = obj as any;
  if (!raw || !Array.isArray(raw.cells)) return "";
  const lang = String(
    raw.metadata?.kernelspec?.language || raw.metadata?.language_info?.name || "python",
  );
  const blocks: string[] = [];
  for (const c of raw.cells) {
    const source = Array.isArray(c?.source) ? c.source.join("") : typeof c?.source === "string" ? c.source : "";
    const text = source.trim();
    if (!text) continue;
    if (c?.cell_type === "markdown" || c?.cell_type === "raw") {
      blocks.push(text);
    } else {
      // celda de código
      blocks.push("```" + lang + "\n" + text + "\n```");
    }
  }
  return normalizeWhitespace(blocks.join("\n\n"));
}

/**
 * Extrae texto plano del `word/document.xml` de un .docx. Los párrafos
 * (`<w:p>`) se separan por salto de línea; los runs de texto (`<w:t>`)
 * concatenan su contenido; el resto de tags se descarta. En document.xml
 * el texto solo vive dentro de `<w:t>`, así que strippear todos los tags
 * tras marcar los párrafos deja el texto correcto.
 */
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

/**
 * Extrae texto plano de un slide XML de pptx (`ppt/slides/slideN.xml`). El
 * texto vive en `<a:t>`; los párrafos son `<a:p>`. Mismo enfoque que docx.
 */
export function pptxSlideXmlToText(slideXml: string | null | undefined): string {
  if (!slideXml) return "";
  let s = slideXml;
  s = s.replace(/<a:br\b[^>]*\/?>/g, "\n");
  s = s.replace(/<\/a:p>/g, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeXmlEntities(s);
  return normalizeWhitespace(s);
}

/**
 * Tabla de cadenas compartidas de un .xlsx (`xl/sharedStrings.xml`). Cada
 * `<si>` es una entrada indexada (0,1,2…) cuyo texto son sus `<t>` concatenados.
 * Las celdas con `t="s"` referencian por índice a este arreglo.
 */
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

/**
 * Extrae texto plano de una hoja de xlsx (`xl/worksheets/sheetN.xml`) usando la
 * tabla de cadenas compartidas. Cada `<c>` es una celda: `t="s"` → su `<v>` es
 * un índice a `sharedStrings`; `t="inlineStr"` → texto en `<is><t>`; el resto
 * (números/fechas) → el literal de `<v>`. Filas por salto de línea, celdas por tab.
 */
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
