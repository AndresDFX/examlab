import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  quitarFondoDeFirma,
  dimensionesDeAnalisis,
  firmaCabeEnColumna,
  MAX_CARACTERES_FIRMA,
} from "./signature-image";

/** Lienzo RGBA de un color plano. */
function lienzo(ancho: number, alto: number, r: number, g: number, b: number, a = 255) {
  const d = new Uint8ClampedArray(ancho * alto * 4);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  }
  return d;
}
const alfaEn = (d: Uint8ClampedArray, ancho: number, x: number, y: number) =>
  d[(y * ancho + x) * 4 + 3];
const pintar = (d: Uint8ClampedArray, ancho: number, x: number, y: number, r: number, g: number, b: number) => {
  const i = (y * ancho + x) * 4;
  d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
};

describe("quitarFondoDeFirma", () => {
  it("el papel queda transparente y la tinta opaca", () => {
    const W = 40, H = 20;
    const d = lienzo(W, H, 245, 244, 240); // papel crema
    for (let x = 5; x < 35; x++) pintar(d, W, x, 10, 20, 24, 30); // trazo

    const r = quitarFondoDeFirma(d, W, H);
    expect(r.ok).toBe(true);
    expect(alfaEn(d, W, 20, 10)).toBe(255); // tinta
    expect(alfaEn(d, W, 20, 2)).toBe(0); // papel
    expect(alfaEn(d, W, 0, 0)).toBe(0);
  });

  it("aguanta la luz DESPAREJA, que es lo que rompe un umbral fijo", () => {
    // Una esquina del papel a 240 y la otra a 150: el mismo papel cae a los dos
    // lados de cualquier umbral fijo, y la firma saldria con medio rectangulo
    // gris pegado. Es el caso real de una foto con la sombra de la mano.
    //
    // El tamano no es decorativo: la correccion es por celdas, asi que necesita
    // pixeles suficientes para que el degradado DENTRO de una celda sea chico.
    // Una "foto" de 60 px de ancho no es una foto, y con ella este mismo test
    // deja un velo de alfa 12 — que ademas romperia el recorte, porque
    // `cajaDelTrazo` cuenta como tinta todo lo que pase de 8.
    const W = 480, H = 120;
    const d = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = 240 - Math.round((x / (W - 1)) * 90); // 240 → 150
        pintar(d, W, x, y, v, v, v);
      }
    }
    for (let x = 40; x < 440; x++) pintar(d, W, x, 60, 25, 25, 28); // trazo oscuro

    const r = quitarFondoDeFirma(d, W, H);
    expect(r.ok).toBe(true);
    // Papel en la zona CLARA y en la OSCURA: los dos transparentes.
    expect(alfaEn(d, W, 10, 20)).toBe(0);
    expect(alfaEn(d, W, 470, 20)).toBe(0);
    // Y el trazo sigue entero de lado a lado, del claro al oscuro.
    expect(alfaEn(d, W, 45, 60)).toBe(255);
    expect(alfaEn(d, W, 435, 60)).toBe(255);
    // Ni un solo pixel de papel por encima del umbral del recorte (8): si lo
    // hubiera, `cajaDelTrazo` agrandaria la caja a la hoja entera y la firma
    // saldria diminuta dentro de un rectangulo vacio.
    let papelSucio = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (y !== 60 && alfaEn(d, W, x, y) > 8) papelSucio++;
    expect(papelSucio).toBe(0);
  });

  it("una hoja en blanco se RECHAZA en vez de devolver basura", () => {
    const W = 20, H = 20;
    const d = lienzo(W, H, 250, 250, 250);
    const r = quitarFondoDeFirma(d, W, H);
    expect(r).toEqual({ ok: false, motivo: "sin_contraste" });
    // Y no se toca el buffer: quien llama puede reintentar con otra imagen.
    expect(alfaEn(d, W, 5, 5)).toBe(255);
  });

  it("una foto toda oscura tampoco pasa", () => {
    const W = 20, H = 20;
    const d = lienzo(W, H, 18, 18, 20);
    expect(quitarFondoDeFirma(d, W, H)).toEqual({ ok: false, motivo: "sin_contraste" });
  });

  it("conserva el color de la tinta: una lapicera azul sigue azul", () => {
    const W = 40, H = 20;
    const d = lienzo(W, H, 250, 250, 250);
    for (let x = 5; x < 35; x++) pintar(d, W, x, 10, 20, 40, 160); // azul
    const r = quitarFondoDeFirma(d, W, H);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.analisis.tinta.b).toBeGreaterThan(r.analisis.tinta.r + 40);
    // Y el pixel de tinta salio con ESE color, no con negro.
    const i = (10 * W + 20) * 4;
    expect(d[i + 2]).toBeGreaterThan(d[i] + 40);
  });

  it("un PNG que YA venia recortado no se arruina", () => {
    // Sus pixeles transparentes traen RGB en cero: contarlos como tinta
    // invertiria la estimacion y destruiria una imagen que ya estaba bien.
    const W = 40, H = 20;
    const d = new Uint8ClampedArray(W * H * 4); // todo transparente, RGB 0
    for (let x = 5; x < 35; x++) pintar(d, W, x, 10, 250, 250, 250); // trazo CLARO opaco
    for (let x = 5; x < 35; x++) pintar(d, W, x, 11, 20, 20, 20); // y otro oscuro
    const r = quitarFondoDeFirma(d, W, H);
    expect(r.ok).toBe(true);
    // Lo que ya era transparente sigue transparente.
    expect(alfaEn(d, W, 0, 0)).toBe(0);
    expect(alfaEn(d, W, 39, 19)).toBe(0);
    // Y el trazo oscuro sobrevive.
    expect(alfaEn(d, W, 20, 11)).toBe(255);
  });

  it("el borde del trazo queda con alfa PARCIAL, no en escalera", () => {
    const W = 30, H = 10;
    const d = lienzo(W, H, 250, 250, 250);
    for (let x = 0; x < W; x++) {
      pintar(d, W, x, 5, 20, 20, 20); // nucleo
      pintar(d, W, x, 4, 135, 135, 135); // penumbra del borde
    }
    const r = quitarFondoDeFirma(d, W, H);
    expect(r.ok).toBe(true);
    const borde = alfaEn(d, W, 15, 4);
    expect(borde).toBeGreaterThan(0);
    expect(borde).toBeLessThan(255);
  });

  it("una imagen vacia se reporta como vacia, no como falta de contraste", () => {
    expect(quitarFondoDeFirma(new Uint8ClampedArray(0), 0, 0)).toEqual({ ok: false, motivo: "vacia" });
    const soloTransparente = new Uint8ClampedArray(16 * 4);
    expect(quitarFondoDeFirma(soloTransparente, 4, 4)).toEqual({ ok: false, motivo: "vacia" });
  });
});

describe("dimensionesDeAnalisis", () => {
  it("baja una foto de teléfono al lado de análisis, con su proporción", () => {
    const { w, h } = dimensionesDeAnalisis(4032, 3024);
    expect(Math.max(w, h)).toBe(1400);
    expect(w / h).toBeCloseTo(4032 / 3024, 2);
  });

  it("no agranda una imagen que ya es chica", () => {
    expect(dimensionesDeAnalisis(300, 120)).toEqual({ w: 300, h: 120 });
  });

  it("una imagen sin tamaño no produce un lienzo negativo", () => {
    expect(dimensionesDeAnalisis(0, 0)).toEqual({ w: 0, h: 0 });
  });
});

describe("firmaCabeEnColumna", () => {
  it("corta justo en el tope", () => {
    expect(firmaCabeEnColumna("x".repeat(MAX_CARACTERES_FIRMA))).toBe(true);
    expect(firmaCabeEnColumna("x".repeat(MAX_CARACTERES_FIRMA + 1))).toBe(false);
  });

  // El tope no es un número elegido acá: es el CHECK de la columna. Si alguna vez
  // cambia en una migración y este archivo se queda con el viejo, el cliente
  // dejaría pasar un PNG que la base rechaza —`invalid_drawing` DESPUÉS de que la
  // persona creyó haber firmado—, o recortaría de más sin motivo. Se lee del
  // disco, mismo patrón que `page-types.test.ts` con su migración.
  it("el tope es EL de `chk_report_signatures_drawing`, leído de la migración", () => {
    const sql = fs.readFileSync(
      "supabase/migrations/20261940000000_report_signature_drawing.sql",
      "utf8",
    );
    const m = sql.match(/length\(signed_drawing\)\s*<=\s*(\d+)/);
    expect(m, "no se encontró el tope en la migración").not.toBeNull();
    expect(Number(m![1])).toBe(MAX_CARACTERES_FIRMA);
  });
});
