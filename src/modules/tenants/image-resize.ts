/**
 * Resize de imagen client-side antes del upload del logo.
 *
 * Problema: el admin sube un logo de 4000×4000 px que después la app
 * renderiza a 32×32 — el browser baja el archivo entero, lo escala en
 * cada paint, y el bucket guarda MB innecesarios. Hacemos un resize
 * proporcional a 512×512 max conservando aspect ratio.
 *
 * Para SVG no se hace resize — los vectores se renderizan a cualquier
 * tamaño sin pérdida. Para PNG/JPG/WebP convertimos a PNG con calidad
 * razonable (los logos chicos no necesitan más). Si el archivo ya está
 * por debajo del cap, lo pasamos sin modificar.
 *
 * Implementación: canvas API, sin dependencias externas. Si el browser
 * no soporta canvas o algo falla, devuelve el File original para no
 * romper el flujo (mejor un upload sin resize que un error).
 */

const MAX_DIMENSION = 512;
const PNG_QUALITY = 0.92;

export interface ResizeResult {
  file: File;
  /** True si efectivamente se hizo resize (false = se pasó el original). */
  resized: boolean;
  originalSize: number;
  finalSize: number;
}

export async function resizeImageForLogo(file: File): Promise<ResizeResult> {
  const original = { file, resized: false, originalSize: file.size, finalSize: file.size };

  // SVG: vector → no resize. Devolvemos el original. El admin sube SVG
  // si quiere logo perfecto a cualquier tamaño.
  if (file.type === "image/svg+xml") return original;

  // Solo rasterizamos PNG/JPG/WebP.
  const rasterTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!rasterTypes.has(file.type)) return original;

  try {
    const bitmap = await createBitmapFromFile(file);
    const { w: srcW, h: srcH } = { w: bitmap.width, h: bitmap.height };

    // Si ya está bajo el cap, no resize. Esto evita re-encode innecesario
    // que podría hacer un PNG pequeño más grande tras la conversión.
    if (srcW <= MAX_DIMENSION && srcH <= MAX_DIMENSION && file.size < 200 * 1024) {
      if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();
      return original;
    }

    // Resize proporcional al lado mayor = MAX_DIMENSION.
    const scale = Math.min(MAX_DIMENSION / srcW, MAX_DIMENSION / srcH, 1);
    const dstW = Math.round(srcW * scale);
    const dstH = Math.round(srcH * scale);

    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(dstW, dstH)
        : (() => {
            const c = document.createElement("canvas");
            c.width = dstW;
            c.height = dstH;
            return c;
          })();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (canvas as any).getContext("2d") as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!ctx) {
      if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();
      return original;
    }
    // imageSmoothingQuality 'high' produce mejor downscale en logos.
    if ("imageSmoothingQuality" in ctx) {
      (ctx as CanvasRenderingContext2D).imageSmoothingQuality = "high";
    }
    ctx.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, dstW, dstH);
    if ("close" in bitmap && typeof bitmap.close === "function") bitmap.close();

    // Encode a PNG (preserva transparencia que es lo común en logos).
    // JPG/WebP convierten a PNG — pérdida mínima en logos pequeños.
    const blob = await canvasToBlob(canvas, "image/png", PNG_QUALITY);
    if (!blob) return original;

    // Si el resize incrementó el tamaño (raro pero posible con PNG re-encode
    // de JPGs muy comprimidos), devolvemos el original.
    if (blob.size >= file.size) return original;

    // Nombre: <base>.png para que el caller pueda decidir extensión.
    const baseName = file.name.replace(/\.[^.]+$/, "") || "logo";
    const resizedFile = new File([blob], `${baseName}.png`, {
      type: "image/png",
      lastModified: Date.now(),
    });
    return {
      file: resizedFile,
      resized: true,
      originalSize: file.size,
      finalSize: blob.size,
    };
  } catch (e) {
    console.warn("[image-resize] falló, usando original:", e);
    return original;
  }
}

async function createBitmapFromFile(file: File): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap es más rápido y respeta orientación EXIF.
  if (typeof createImageBitmap === "function") {
    return await createImageBitmap(file);
  }
  // Fallback HTMLImageElement vía objectURL (browsers viejos).
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = URL.createObjectURL(file);
  });
}

function canvasToBlob(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  canvas: any,
  type: string,
  quality: number,
): Promise<Blob | null> {
  // OffscreenCanvas tiene convertToBlob; HTMLCanvas tiene toBlob.
  if ("convertToBlob" in canvas) {
    return (canvas as OffscreenCanvas).convertToBlob({ type, quality });
  }
  return new Promise((resolve) =>
    (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), type, quality),
  );
}
