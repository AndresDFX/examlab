import { describe, expect, it } from "vitest";

import {
  DESVIO_MAXIMO_PUNTERO,
  MS_MINIMO_ENTRE_TICS,
  RETROCESO_GRADOS,
  VUELTAS_GIRO,
  amplitudDeAsentamiento,
  anguloDelGiro,
  desvioDelPuntero,
  tocaTic,
} from "./animacion-giro";
import { indiceBajoElPuntero, rotacionParaCaerEn } from "./ruleta";

describe("anguloDelGiro", () => {
  it("arranca exactamente donde estaba y termina exactamente en el sorteado", () => {
    expect(anguloDelGiro({ desde: 100, hasta: 2700, progreso: 0, gradosPorGajo: 10 })).toBe(100);
    expect(anguloDelGiro({ desde: 100, hasta: 2700, progreso: 1, gradosPorGajo: 10 })).toBe(2700);
    // Fuera de rango se recorta.
    expect(anguloDelGiro({ desde: 100, hasta: 2700, progreso: -1, gradosPorGajo: 10 })).toBe(100);
    expect(anguloDelGiro({ desde: 100, hasta: 2700, progreso: 7, gradosPorGajo: 10 })).toBe(2700);
  });

  it("toma impulso hacia atrás, pero nunca más que el retroceso", () => {
    let minimo = Infinity;
    for (let i = 0; i <= 1000; i++) {
      minimo = Math.min(minimo, anguloDelGiro({ desde: 0, hasta: 2600, progreso: i / 1000, gradosPorGajo: 10 }));
    }
    expect(minimo).toBeLessThan(0);
    expect(minimo).toBeGreaterThanOrEqual(-RETROCESO_GRADOS - 1e-9);
  });

  it("no se pasa del sorteado más que el asentamiento", () => {
    for (const s of [3, 10, 51.4, 180]) {
      let maximo = -Infinity;
      for (let i = 0; i <= 2000; i++) {
        maximo = Math.max(maximo, anguloDelGiro({ desde: 0, hasta: 2600, progreso: i / 2000, gradosPorGajo: s }));
      }
      expect(maximo, `s=${s}`).toBeLessThanOrEqual(2600 + amplitudDeAsentamiento(s) + 1e-9);
    }
  });

  it("al final el puntero NO sale del gajo sorteado, ni siquiera al asentarse (cualquier n, punto de partida y fracción)", () => {
    const fallas: string[] = [];
    for (const n of [2, 3, 7, 12, 21, 35, 60, 93, 150]) {
      const s = 360 / n;
      for (const desde of [0, 47.5, 359, 1234.5]) {
        for (const fraccion of [0, 0.3, 0.5, 1]) {
          for (let indice = 0; indice < n; indice += Math.max(1, Math.floor(n / 6))) {
            const hasta = rotacionParaCaerEn(desde, indice, n, VUELTAS_GIRO, fraccion);
            for (let i = 960; i <= 1000; i++) {
              const ang = anguloDelGiro({ desde, hasta, progreso: i / 1000, gradosPorGajo: s });
              const cae = indiceBajoElPuntero(ang, n);
              if (cae !== indice) {
                fallas.push(`n=${n} desde=${desde} f=${fraccion} i=${indice} t=${i / 1000}: ${cae}`);
                break;
              }
            }
          }
        }
      }
    }
    expect(fallas).toEqual([]);
  });

  it("después del impulso solo avanza, hasta que se asienta", () => {
    let anterior = -Infinity;
    for (let i = 60; i <= 900; i++) {
      const ang = anguloDelGiro({ desde: 0, hasta: 2600, progreso: i / 1000, gradosPorGajo: 10 });
      expect(ang).toBeGreaterThanOrEqual(anterior);
      anterior = ang;
    }
  });
});

describe("amplitudDeAsentamiento", () => {
  it("un décimo de gajo, con tope, y nada si no hay gajos", () => {
    expect(amplitudDeAsentamiento(10)).toBe(1);
    expect(amplitudDeAsentamiento(180)).toBe(2.5);
    expect(amplitudDeAsentamiento(0)).toBe(0);
    expect(amplitudDeAsentamiento(Number.NaN)).toBe(0);
  });
});

describe("el puntero y el «clac»", () => {
  it("el puntero vuelve solo, igual a cualquier frecuencia de pantalla", () => {
    const a60 = [1, 2, 3, 4, 5, 6].reduce((d) => desvioDelPuntero(d, 16.7), DESVIO_MAXIMO_PUNTERO);
    const a120 = Array.from({ length: 12 }).reduce<number>((d) => desvioDelPuntero(d, 8.35), DESVIO_MAXIMO_PUNTERO);
    expect(a60).toBeLessThan(DESVIO_MAXIMO_PUNTERO / 2);
    expect(Math.abs(a60 - a120)).toBeLessThan(1e-9);
    expect(desvioDelPuntero(10, -5)).toBe(10);
  });

  it("los «clac» se espacian: al arrancar no suenan todos los gajos que pasan", () => {
    expect(tocaTic(null, 0)).toBe(true);
    expect(tocaTic(100, 100 + MS_MINIMO_ENTRE_TICS - 1)).toBe(false);
    expect(tocaTic(100, 100 + MS_MINIMO_ENTRE_TICS)).toBe(true);
  });
});
