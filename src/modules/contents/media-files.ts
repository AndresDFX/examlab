/**
 * Helpers PUROS de detección de tipo de archivo de media para el módulo de
 * Contenidos (imágenes y PDF). Sin React ni Storage — testeables en aislado
 * (ver media-files.test.ts). Análogos a `codeLanguageForFile` /
 * `isNotebookFile` del módulo de código.
 *
 * Uso: decidir qué archivos de `generated_contents.files[]` se pueden VER
 * inline (visor) y cuáles se pueden EDITAR (editor de imagen sobre canvas).
 */

/** Extensión en minúsculas SIN el punto, o "" si no hay. */
export function extensionOf(name: string | null | undefined): string {
  if (!name) return "";
  const i = name.lastIndexOf(".");
  if (i < 0 || i === name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}

// Imágenes VISUALIZABLES inline (incluye vectoriales/animadas).
const VIEWABLE_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "avif"]);

// Imágenes EDITABLES en el editor de canvas: raster que `canvas.toBlob`
// puede re-exportar. SVG (vectorial) y GIF (animado) quedan SOLO como
// visualizables — editarlos sobre canvas perdería vector/animación.
const EDITABLE_IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "bmp", "avif"]);

/** ¿Es una imagen que se puede MOSTRAR inline con <img>? */
export function isImageFile(name: string | null | undefined): boolean {
  return VIEWABLE_IMAGE_EXTS.has(extensionOf(name));
}

/** ¿Es una imagen RASTER que el editor de canvas puede editar y re-exportar? */
export function isEditableImageFile(name: string | null | undefined): boolean {
  return EDITABLE_IMAGE_EXTS.has(extensionOf(name));
}

/** ¿Es un PDF? */
export function isPdfFile(name: string | null | undefined): boolean {
  return extensionOf(name) === "pdf";
}

/** ¿Se puede VER inline en el visor de media (imagen o PDF)? */
export function isViewableMedia(name: string | null | undefined): boolean {
  return isImageFile(name) || isPdfFile(name);
}

/**
 * MIME para subir/exportar la imagen editada. `canvas.toBlob` solo produce
 * png/jpeg/webp de forma confiable; cualquier otra (bmp/avif) la
 * normalizamos a PNG para no perder el archivo al guardar.
 */
export function canvasExportMimeForName(name: string | null | undefined): "image/png" | "image/jpeg" | "image/webp" {
  switch (extensionOf(name)) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

/** MIME para servir/descargar un archivo de media (contentType del upload). */
export function mediaMimeForName(name: string | null | undefined): string {
  switch (extensionOf(name)) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    case "avif":
      return "image/avif";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
