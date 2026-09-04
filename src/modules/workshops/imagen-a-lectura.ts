/**
 * Archivo elegido por el docente → data URL lista para mandar a leer.
 *
 * Reduce a `MAX_LADO_PX` y re-codifica a JPEG. Medido: una captura de grilla a
 * 1920×1080 en PNG pesa ~1,0–1,5 MB en base64 y la misma en JPEG 0,8 pesa ~0,2–0,3 MB.
 * La pérdida no importa —lo que se lee son nombres en un rótulo— y quedar holgadamente
 * por debajo de cualquier tope de cuerpo es preferible a descubrir el techo con un
 * error en medio de una clase.
 *
 * El camino (object URL → `new Image()` → canvas → `toBlob`) es el mismo que ya usa el
 * editor de imágenes de Contenidos, incluido revocar el object URL en los DOS caminos:
 * sin revocarlo en `onerror`, cada archivo rechazado deja un blob colgado en memoria.
 */
import { MAX_LADO_PX } from "./imagen-limites";

export interface ImagenLeida {
  dataUrl: string;
  ancho: number;
  alto: number;
  /** Bytes aproximados del data URL, para poder avisar antes de mandarlo. */
  bytes: number;
}

export async function archivoAImagenBase64(file: File): Promise<ImagenLeida> {
  const objUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("No se pudo leer la imagen."));
      i.src = objUrl;
    });

    const escala = Math.min(1, MAX_LADO_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const ancho = Math.max(1, Math.round(img.naturalWidth * escala));
    const alto = Math.max(1, Math.round(img.naturalHeight * escala));

    const canvas = document.createElement("canvas");
    canvas.width = ancho;
    canvas.height = alto;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No se pudo procesar la imagen.");
    // Fondo blanco: el JPEG no tiene transparencia y sin esto un PNG con alfa queda
    // con el fondo negro, que es justo donde suelen ir los nombres en blanco.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, ancho, alto);
    ctx.drawImage(img, 0, 0, ancho, alto);

    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    return { dataUrl, ancho, alto, bytes: dataUrl.length };
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}
