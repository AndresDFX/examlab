/**
 * Descarga de informes GENERADOS como archivo: Word (.doc) o PDF (imprimir).
 *
 * El informe generado es un HTML completo (`composeTemplateHtml` ya resolvió
 * `@page`, saltos de página y datos reales). De acá salen los dos formatos que
 * el docente pidió: "el archivo descargable en Word o PDF con los ajustes que
 * hice".
 *
 * - **Word**: usamos la técnica HTML-como-Word (MSO): un documento HTML con los
 *   namespaces de Office + un bloque `<!--[if gte mso 9]>` que Word interpreta
 *   para fijar la vista. Word lo abre como documento EDITABLE; respeta `@page`
 *   (tamaño/orientación) y `page-break-after` (saltos de página). Sin librerías
 *   nuevas, sin servidor — el `.docx` real (OOXML) sería desproporcionado para
 *   el valor que agrega. Extensión `.doc` porque es HTML+MSO, no OOXML.
 * - **PDF**: imprimimos el HTML en un iframe oculto → el usuario elige "Guardar
 *   como PDF" en el diálogo del navegador. Mismo motor que ya usaba el módulo.
 *
 * Las funciones que tocan DOM/`window` son no-op en SSR (guard `typeof`).
 */

/** Inyecta los namespaces de Office y el bloque MSO en un HTML compuesto. */
function toWordHtml(composedHtml: string): string {
  const ns =
    "<html xmlns:o='urn:schemas-microsoft-com:office:office' " +
    "xmlns:w='urn:schemas-microsoft-com:office:word' " +
    "xmlns='http://www.w3.org/TR/REC-html40'$1";
  const msoHead =
    "<head><meta charset='utf-8'>" +
    "<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View>" +
    "<w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->";
  return composedHtml
    .replace(/<html(\s|>)/i, ns)
    .replace(/<head>/i, msoHead);
}

/** Blob de Word (.doc) a partir del HTML compuesto del informe. */
export function htmlToWordBlob(composedHtml: string): Blob {
  // El BOM ﻿ ayuda a Word a detectar UTF-8.
  return new Blob(["﻿", toWordHtml(composedHtml)], {
    type: "application/msword",
  });
}

/** Dispara la descarga de un Blob con el nombre dado (no-op en SSR). */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revocar en el próximo tick: algunos navegadores necesitan que el click
  // se procese antes de liberar el object URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Sanitiza un texto para usarlo como parte de un nombre de archivo. */
function safePart(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/[\\/:*?"<>|]+/g, " ") // chars inválidos en nombres de archivo
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Arma el nombre de archivo de un informe: "Informe - {plantilla} - {curso}
 * [- {estudiante}] [- {periodo}].{ext}". Omite las partes vacías.
 */
export function reportFileName(
  parts: {
    templateName?: string | null;
    courseName?: string | null;
    studentName?: string | null;
    periodo?: string | null;
  },
  ext: "doc" | "pdf",
): string {
  const segs = ["Informe", parts.templateName, parts.courseName, parts.studentName, parts.periodo]
    .map(safePart)
    .filter(Boolean);
  const base = segs.join(" - ") || "Informe";
  return `${base}.${ext}`;
}

/** Descarga el HTML compuesto como archivo Word (.doc). */
export function downloadReportAsWord(
  composedHtml: string,
  parts: Parameters<typeof reportFileName>[0],
): void {
  downloadBlob(htmlToWordBlob(composedHtml), reportFileName(parts, "doc"));
}

/**
 * Imprime un HTML en un iframe OCULTO (el usuario elige "Guardar como PDF").
 * Usado tanto en el generador (preview en vivo) como en la re-descarga desde
 * el historial, donde no hay un iframe visible a mano. No-op en SSR.
 */
export function printReportHtml(composedHtml: string): void {
  if (typeof document === "undefined") return;
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");
  iframe.srcdoc = composedHtml;
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) {
      iframe.remove();
      return;
    }
    // Pequeño respiro para que el layout (y @page) se aplique antes de print.
    setTimeout(() => {
      win.focus();
      win.print();
      // Quitar el iframe tras un margen amplio (el diálogo de impresión es
      // modal del navegador; removerlo antes cancelaría la impresión).
      setTimeout(() => iframe.remove(), 60000);
    }, 150);
  };
  document.body.appendChild(iframe);
}
