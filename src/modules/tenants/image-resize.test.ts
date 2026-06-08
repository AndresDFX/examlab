/**
 * Tests para `resizeImageForLogo` (image-resize.ts).
 *
 * ALCANCE: solo las ramas PURAS y determinísticas que NO tocan canvas.
 * El resize real de PNG/JPG/WebP depende de `createImageBitmap` /
 * `OffscreenCanvas` / `canvas.getContext("2d")` — NINGUNO disponible en
 * jsdom (getContext lanza "Not implemented: ... without installing the
 * canvas npm package"). Esas ramas se documentan como `skipped` en el
 * reporte y NO se mockean (regla: no mockear dependencias pesadas).
 *
 * Lo que SÍ es testeable sin canvas son los dos early-return que ocurren
 * ANTES de cualquier llamada a canvas:
 *   1. SVG (`image/svg+xml`)          → devuelve el File original sin tocar.
 *   2. Tipo no rasterizable (no PNG/JPEG/WebP) → devuelve el File original.
 *
 * En ambos casos el contrato es `ResizeResult` con:
 *   { file: <el mismo File>, resized: false,
 *     originalSize: file.size, finalSize: file.size }
 */
import { describe, it, expect } from "vitest";
import { resizeImageForLogo, type ResizeResult } from "./image-resize";

/** Construye un File con un payload de tamaño conocido y el MIME dado. */
function makeFile(name: string, type: string, sizeBytes = 10): File {
  const payload = sizeBytes > 0 ? "x".repeat(sizeBytes) : "";
  return new File([payload], name, { type });
}

/**
 * Aserta el contrato "devolver el original sin modificar": misma
 * referencia de File, resized=false, y los dos tamaños iguales a file.size.
 */
function expectPassthrough(result: ResizeResult, input: File) {
  expect(result.resized).toBe(false);
  // Identidad del File: NO se re-crea ni se reemplaza.
  expect(result.file).toBe(input);
  expect(result.originalSize).toBe(input.size);
  expect(result.finalSize).toBe(input.size);
  // Invariante de passthrough: ambos tamaños coinciden.
  expect(result.finalSize).toBe(result.originalSize);
}

describe("resizeImageForLogo — SVG (vector, no resize)", () => {
  it("devuelve el SVG original sin modificar", async () => {
    const file = makeFile("logo.svg", "image/svg+xml", 4096);
    const result = await resizeImageForLogo(file);
    expectPassthrough(result, file);
  });

  it("preserva el nombre y el tipo MIME del SVG", async () => {
    const file = makeFile("mi-marca.svg", "image/svg+xml", 1234);
    const result = await resizeImageForLogo(file);
    expect(result.file.name).toBe("mi-marca.svg");
    expect(result.file.type).toBe("image/svg+xml");
  });

  it("reporta originalSize y finalSize iguales al tamaño del SVG", async () => {
    const file = makeFile("vector.svg", "image/svg+xml", 9999);
    const result = await resizeImageForLogo(file);
    expect(result.originalSize).toBe(9999);
    expect(result.finalSize).toBe(9999);
  });

  it("no hace resize aunque el SVG sea grande (vectores no se rasterizan)", async () => {
    // Un SVG de 5MB igual se devuelve tal cual — el cap de 512px no aplica.
    const file = makeFile("enorme.svg", "image/svg+xml", 5 * 1024 * 1024);
    const result = await resizeImageForLogo(file);
    expectPassthrough(result, file);
  });
});

describe("resizeImageForLogo — tipos no rasterizables (passthrough)", () => {
  // Solo PNG/JPEG/WebP entran al pipeline de canvas. Cualquier otro tipo
  // sale por el early-return de la línea `if (!rasterTypes.has(file.type))`.
  const nonRasterTypes: Array<[string, string]> = [
    ["image/gif", "anim.gif"],
    ["image/bmp", "bitmap.bmp"],
    ["image/avif", "moderno.avif"],
    ["image/tiff", "scan.tiff"],
    ["image/x-icon", "favicon.ico"],
    ["application/pdf", "documento.pdf"],
    ["text/plain", "notas.txt"],
    ["application/octet-stream", "binario.bin"],
  ];

  it.each(nonRasterTypes)(
    "devuelve el original para %s",
    async (type, name) => {
      const file = makeFile(name, type, 50);
      const result = await resizeImageForLogo(file);
      expectPassthrough(result, file);
    },
  );

  it("tipo MIME vacío también es passthrough (no está en el set raster)", async () => {
    const file = makeFile("sin-tipo", "", 100);
    expect(file.type).toBe("");
    const result = await resizeImageForLogo(file);
    expectPassthrough(result, file);
  });

  it("preserva nombre y tipo del archivo no rasterizable", async () => {
    const file = makeFile("foto.gif", "image/gif", 777);
    const result = await resizeImageForLogo(file);
    expect(result.file.name).toBe("foto.gif");
    expect(result.file.type).toBe("image/gif");
    expect(result.file.size).toBe(777);
  });
});

describe("resizeImageForLogo — forma del ResizeResult", () => {
  it("retorna las 4 claves del contrato ResizeResult", async () => {
    const file = makeFile("logo.svg", "image/svg+xml", 64);
    const result = await resizeImageForLogo(file);
    expect(Object.keys(result).sort()).toEqual(
      ["file", "finalSize", "originalSize", "resized"].sort(),
    );
    expect(typeof result.resized).toBe("boolean");
    expect(typeof result.originalSize).toBe("number");
    expect(typeof result.finalSize).toBe("number");
    expect(result.file).toBeInstanceOf(File);
  });

  it("maneja un File de tamaño 0 (payload vacío) en rama passthrough", async () => {
    const file = makeFile("vacio.svg", "image/svg+xml", 0);
    expect(file.size).toBe(0);
    const result = await resizeImageForLogo(file);
    expectPassthrough(result, file);
    expect(result.originalSize).toBe(0);
    expect(result.finalSize).toBe(0);
  });
});
