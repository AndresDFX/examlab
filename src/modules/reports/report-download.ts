/**
 * Descarga de informes GENERADOS como archivo: Word (.docx) o PDF (imprimir).
 *
 * El informe generado es un HTML completo (`composeTemplateHtml` ya resolvió
 * `@page`, saltos de página y datos reales).
 *
 * - **Word**: generamos un `.docx` REAL (OOXML) con `htmlToDocxBlob` — antes era
 *   un `.doc` HTML-como-Word (MSO) que Word RE-INTERPRETABA (cambiaba el formato)
 *   y dejaba la cabecera al inicio del cuerpo. Ahora la cabecera va al ÁREA de
 *   encabezado de página (word/header1.xml) y el formato se respeta.
 * - **PDF**: imprimimos el HTML en un iframe oculto → el usuario elige "Guardar
 *   como PDF". `composeTemplateHtml` posiciona header/footer como `position:fixed`
 *   en `@media print` para que se repitan en el área de encabezado/pie de cada
 *   página (no sólo al inicio).
 *
 * Las funciones que tocan DOM/`window` son no-op en SSR (guard `typeof`).
 */
import { htmlToDocxBlob } from "./html-to-docx";
import { inlineRemoteImages } from "./inline-images";

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
    /** Marca temporal (fecha-hora de generación) → nombre de archivo ÚNICO,
     *  para que dos informes generados no se sobrescriban al descargar. */
    stamp?: string | null;
  },
  ext: "docx" | "pdf",
): string {
  const segs = [
    "Informe",
    parts.templateName,
    parts.courseName,
    parts.studentName,
    parts.periodo,
    parts.stamp,
  ]
    .map(safePart)
    .filter(Boolean);
  const base = segs.join(" - ") || "Informe";
  return `${base}.${ext}`;
}

/** Marca temporal legible y válida para nombre de archivo: "2026-06-15 1432". */
export function fileStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Descarga el HTML compuesto como archivo Word REAL (.docx OOXML).
 *
 * Es `async` porque antes de exportar hay que EMBEBER las imágenes remotas: el
 * exportador solo puede meter una imagen dentro del archivo si su `src` ya es un
 * data URI, así que el logo institucional —que vive en el bucket de marcas y llega
 * como URL— se perdía sin ningún error justo en el Word que la gente entrega.
 *
 * Devuelve cuántas imágenes no se pudieron traer, para que la pantalla lo avise.
 * No se lanza: un logo que no baja no puede impedir que el informe se descargue.
 */
export async function downloadReportAsWord(
  composedHtml: string,
  parts: Parameters<typeof reportFileName>[0],
): Promise<{ imagenesPerdidas: number }> {
  const { html, fallidas } = await inlineRemoteImages(composedHtml);
  downloadBlob(htmlToDocxBlob(html), reportFileName(parts, "docx"));
  return { imagenesPerdidas: fallidas };
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
