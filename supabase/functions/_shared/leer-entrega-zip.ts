/**
 * Lee los DOCUMENTOS de un ZIP de entrega (Word, PowerPoint, PDF) cuando la entrega acepta más que código
 * (`contenido-zip.ts`). Solo del servidor: usa `npm:` y no lo importa el navegador.
 *
 * Lo que no se puede leer (imágenes, hojas de cálculo, PDF escaneados o pasados del tope) vuelve en
 * `noLeidos`, para NOMBRÁRSELO a la IA en vez de que lo cuente como faltante.
 */
import { docxXmlToText, pptxSlideXmlToText } from "../tutor-chat/material-extract.ts";
import {
  PDF_MAX_ARCHIVOS,
  PDF_MAX_PAGINAS,
  PDF_PRESUPUESTO_MS,
  extensionDe,
  revisarArchivosDelZip,
} from "./contenido-zip.ts";

export interface LecturaDeDocumentos {
  archivos: { path: string; content: string }[];
  noLeidos: string[];
  /** Algún PDF se leyó solo en parte (tope de páginas o de tiempo). */
  pdfParcial: boolean;
  caracteres: number;
  /** Se llegó al tope de caracteres. */
  tope: boolean;
}

export async function leerDocumentosDelZip(
  unzipped: Record<string, Uint8Array>,
  paths: string[],
  yaLeidos: ReadonlySet<string>,
  maxCaracteres: number,
): Promise<LecturaDeDocumentos> {
  const out: LecturaDeDocumentos = { archivos: [], noLeidos: [], pdfParcial: false, caracteres: 0, tope: false };
  const fflate = await import("npm:fflate@0.8.2");
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const hastaPdf = Date.now() + PDF_PRESUPUESTO_MS;
  let pdfs = 0;
  for (const path of revisarArchivosDelZip(paths, null).aceptados) {
    if (yaLeidos.has(path)) continue;
    const ext = extensionDe(path);
    const data = unzipped[path];
    let texto = "";
    let etiqueta = path;
    try {
      if (ext === "docx" || ext === "pptx") {
        const inner = fflate.unzipSync(data, {
          filter: (f: { name: string }) =>
            f.name === "word/document.xml" || /^ppt\/slides\/slide\d+\.xml$/.test(f.name),
        });
        if (ext === "docx") {
          const xml = inner["word/document.xml"];
          texto = docxXmlToText(xml ? decoder.decode(xml) : "");
        } else {
          const n = (k: string) => Number(/slide(\d+)\.xml$/.exec(k)?.[1] ?? 0);
          texto = Object.keys(inner)
            .sort((a, b) => n(a) - n(b))
            .map((k, i) => `[Diapositiva ${i + 1}]\n${pptxSlideXmlToText(decoder.decode(inner[k]))}`)
            .join("\n\n");
        }
      } else if (ext === "pdf" && pdfs < PDF_MAX_ARCHIVOS && Date.now() < hastaPdf) {
        // pdf.js cuesta ~100 ms de CPU por página (medido con Deno) y el servidor corta la función que
        // pasa de ~2 s: por eso el import perezoso y los topes de páginas y de tiempo.
        const { getDocumentProxy } = await import("npm:unpdf@1.8.1");
        const pdf = await getDocumentProxy(new Uint8Array(data));
        const total = pdf.numPages;
        let leidas = 0;
        for (let i = 1; i <= Math.min(total, PDF_MAX_PAGINAS) && Date.now() < hastaPdf; i++) {
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          texto += tc.items.map((it) => ("str" in it ? it.str : "")).join(" ") + "\n";
          leidas = i;
        }
        pdfs++;
        // Sin ninguna página leída el PDF va a `noLeidos`: no es «parcial».
        if (leidas > 0 && leidas < total) {
          etiqueta = `${path} (páginas 1 a ${leidas} de ${total})`;
          out.pdfParcial = true;
        }
      }
    } catch (e) {
      console.warn(`[zip-grading] no se pudo leer ${path}:`, e instanceof Error ? e.message : String(e));
      texto = "";
    }
    texto = texto.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!texto || out.caracteres + texto.length > maxCaracteres) {
      if (texto) out.tope = true;
      out.noLeidos.push(path);
      continue;
    }
    out.caracteres += texto.length;
    out.archivos.push({ path: etiqueta, content: texto });
  }
  return out;
}
