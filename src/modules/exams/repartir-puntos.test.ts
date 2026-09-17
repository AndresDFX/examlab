import { describe, expect, it } from "vitest";
import { diferenciaHastaObjetivo, repartirPuntos } from "./repartir-puntos";

const suma = (xs: readonly number[]) => Number(xs.reduce((a, b) => a + b, 0).toFixed(2));

describe("repartirPuntos", () => {
  it("el caso reportado: se borró una pregunta y faltan 0,30 para llegar a 5", () => {
    // Nueve preguntas que sumaban 4,70 tras borrar una.
    const antes = [0.3, 0.3, 0.3, 0.3, 0.3, 0.3, 0.6, 0.6, 1.0];
    expect(suma(antes)).toBe(3.99 + 0.01); // 4,00
    const despues = repartirPuntos(antes, 5)!;
    expect(suma(despues)).toBe(5);
    expect(despues).toHaveLength(antes.length);
  });

  it("siempre suma EXACTAMENTE el objetivo, aunque no reparta redondo", () => {
    // 5 entre 3 da 1,6666…: redondear cada una por su cuenta da 5,01 o 4,99.
    for (const n of [3, 6, 7, 9, 11, 13]) {
      const r = repartirPuntos(Array(n).fill(1), 5)!;
      expect(suma(r)).toBe(5);
    }
  });

  it("conserva la proporción que puso el docente", () => {
    // La de código vale el doble que las cerradas: tiene que seguir valiendo
    // el doble después de ajustar.
    const r = repartirPuntos([0.25, 0.25, 0.5], 4)!;
    expect(suma(r)).toBe(4);
    expect(r[2]).toBeCloseTo(r[0] * 2, 2);
    expect(r[0]).toBeCloseTo(r[1], 2);
  });

  it("ninguna pregunta queda en cero", () => {
    // Una pregunta que no vale nada se puede dejar en blanco sin costo.
    const r = repartirPuntos([100, 0.01, 0.01], 5)!;
    expect(suma(r)).toBe(5);
    for (const v of r) expect(v).toBeGreaterThan(0);
  });

  it("reparte parejo cuando NINGUNA pregunta tiene puntaje", () => {
    // Sin proporción previa no hay criterio del docente que conservar.
    const r = repartirPuntos([0, 0, 0, 0], 5)!;
    expect(r).toEqual([1.25, 1.25, 1.25, 1.25]);
  });

  it("también reparte hacia ABAJO cuando la suma se pasó", () => {
    const r = repartirPuntos([3, 3, 3], 5)!;
    expect(suma(r)).toBe(5);
  });

  it("es determinista: pulsar dos veces da lo mismo", () => {
    const una = repartirPuntos([0.3, 0.3, 0.6, 1], 5)!;
    const otra = repartirPuntos(una, 5)!;
    expect(otra).toEqual(una);
  });

  it("no reparte cuando no tiene sentido", () => {
    expect(repartirPuntos([], 5)).toBeNull();
    expect(repartirPuntos([1, 1], 0)).toBeNull();
    expect(repartirPuntos([1, 1], -3)).toBeNull();
    expect(repartirPuntos([1, 1], Number.NaN)).toBeNull();
    // 0,02 entre 3 preguntas dejaría alguna en cero.
    expect(repartirPuntos([1, 1, 1], 0.02)).toBeNull();
  });

  it("tolera puntajes inválidos guardados en la base", () => {
    const r = repartirPuntos([Number.NaN, -5, 1] as number[], 3)!;
    expect(suma(r)).toBe(3);
    for (const v of r) expect(v).toBeGreaterThan(0);
  });
});

describe("diferenciaHastaObjetivo", () => {
  it("dice cuánto falta", () => {
    expect(diferenciaHastaObjetivo([0.3, 0.3, 0.6, 1], 5)).toBe(2.8);
  });

  it("dice cuánto sobra, con signo negativo", () => {
    expect(diferenciaHastaObjetivo([3, 3], 5)).toBe(-1);
  });

  it("da 0 cuando ya está cuadrado, pese a la coma flotante", () => {
    // 0.1 + 0.2 !== 0.3: sin redondear antes de comparar, el botón de ajustar
    // aparecería sobre un examen que ya suma exactamente la nota máxima.
    expect(diferenciaHastaObjetivo([0.1, 0.2, 4.7], 5)).toBe(0);
    expect(diferenciaHastaObjetivo([1.67, 1.67, 1.66], 5)).toBe(0);
  });
});
