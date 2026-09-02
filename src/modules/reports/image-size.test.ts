import { describe, expect, it } from "vitest";

import { altoProporcional, intrinsicSize } from "./image-size";

/** Cabecera PNG mínima válida: firma + IHDR con el tamaño. */
function png(ancho: number, alto: number): Uint8Array {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.set([0, 0, 0, 13], 8); // largo del IHDR
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  b.set([ancho >>> 24, (ancho >>> 16) & 255, (ancho >>> 8) & 255, ancho & 255], 16);
  b.set([alto >>> 24, (alto >>> 16) & 255, (alto >>> 8) & 255, alto & 255], 20);
  return b;
}

function gif(ancho: number, alto: number): Uint8Array {
  const b = new Uint8Array(10);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  b.set([ancho & 255, ancho >>> 8, alto & 255, alto >>> 8], 6);
  return b;
}

/** JPEG con N segmentos de relleno antes del SOF0, para probar el recorrido. */
function jpeg(ancho: number, alto: number, rellenos = 0): Uint8Array {
  const partes: number[] = [0xff, 0xd8];
  for (let i = 0; i < rellenos; i++) {
    // APP0 de 16 bytes de contenido: no trae tamaño, hay que saltarlo.
    partes.push(0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0));
  }
  partes.push(0xff, 0xc0, 0x00, 0x11, 0x08, alto >>> 8, alto & 255, ancho >>> 8, ancho & 255);
  partes.push(...new Array(8).fill(0));
  return new Uint8Array(partes);
}

/** WebP extendido (VP8X): el lienzo va como valor-1 en 3 bytes little-endian. */
function webpVP8X(ancho: number, alto: number): Uint8Array {
  const b = new Uint8Array(30);
  b.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  b.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  b.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  const a = ancho - 1;
  const h = alto - 1;
  b.set([a & 255, (a >>> 8) & 255, (a >>> 16) & 255], 24);
  b.set([h & 255, (h >>> 8) & 255, (h >>> 16) & 255], 27);
  return b;
}

describe("intrinsicSize", () => {
  it("lee un PNG", () => {
    // 205×225 son las medidas REALES del logo de FESNA en producción.
    expect(intrinsicSize(png(205, 225))).toEqual({ ancho: 205, alto: 225 });
  });

  it("lee un WebP extendido", () => {
    // 240×240 es el logo REAL de UNIAJ, y está en WebP.
    expect(intrinsicSize(webpVP8X(240, 240))).toEqual({ ancho: 240, alto: 240 });
  });

  it("lee un GIF", () => {
    expect(intrinsicSize(gif(64, 32))).toEqual({ ancho: 64, alto: 32 });
  });

  it("lee un JPEG con el SOF al principio", () => {
    expect(intrinsicSize(jpeg(800, 600))).toEqual({ ancho: 800, alto: 600 });
  });

  it("lee un JPEG con EXIF y miniaturas antes del SOF", () => {
    // El SOF NO está a un offset fijo: la cantidad de segmentos previos depende de
    // con qué se guardó el archivo. Un parser que lea un offset fijo devuelve
    // basura justo en las fotos que salen de una cámara o un teléfono.
    expect(intrinsicSize(jpeg(1024, 768, 3))).toEqual({ ancho: 1024, alto: 768 });
  });

  it("un formato desconocido devuelve null, no un número inventado", () => {
    expect(intrinsicSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });

  it("un SVG devuelve null (es texto, no tiene cabecera binaria)", () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(intrinsicSize(svg)).toBeNull();
  });

  it("un archivo truncado devuelve null en vez de lanzar", () => {
    expect(intrinsicSize(png(100, 100).subarray(0, 14))).toBeNull();
    expect(intrinsicSize(new Uint8Array(0))).toBeNull();
    expect(intrinsicSize(null)).toBeNull();
    expect(intrinsicSize(undefined)).toBeNull();
  });

  it("un tamaño 0 se rechaza (dividir por él daría Infinity)", () => {
    expect(intrinsicSize(png(0, 50))).toBeNull();
  });
});

describe("altoProporcional", () => {
  it("respeta la proporción real: el caso que arregla el achatamiento del Word", () => {
    // FESNA 205×225 a 150px de ancho: el alto correcto es ~165, no 60 (el
    // `0,4 × ancho` que el exportador inventaba cuando el HTML decía height:auto).
    expect(altoProporcional(150, { ancho: 205, alto: 225 })).toBe(165);
    expect(altoProporcional(150, { ancho: 205, alto: 225 })).not.toBe(60);
  });

  it("un logo cuadrado queda cuadrado", () => {
    // UNIAJ 240×240 a 173px: 173, no 69.
    expect(altoProporcional(173, { ancho: 240, alto: 240 })).toBe(173);
  });

  it("sin dimensiones reales devuelve null, para que el caller ponga SU respaldo", () => {
    expect(altoProporcional(150, null)).toBeNull();
  });

  it("un ancho inválido devuelve null", () => {
    expect(altoProporcional(0, { ancho: 100, alto: 50 })).toBeNull();
    expect(altoProporcional(NaN, { ancho: 100, alto: 50 })).toBeNull();
  });

  it("nunca devuelve 0 (una imagen de alto 0 no se ve)", () => {
    expect(altoProporcional(10, { ancho: 4000, alto: 3 })).toBe(1);
  });
});
