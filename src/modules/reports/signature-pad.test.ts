import { describe, expect, it } from "vitest";
import { cajaDelTrazo, conMargen, trazoDemasiadoChico } from "./signature-pad";

/** Lienzo RGBA con los píxeles indicados opacos. */
function lienzo(ancho: number, alto: number, puntos: Array<[number, number, number?]>) {
  const d = new Uint8ClampedArray(ancho * alto * 4);
  for (const [x, y, alfa] of puntos) d[(y * ancho + x) * 4 + 3] = alfa ?? 255;
  return d;
}

describe("cajaDelTrazo", () => {
  it("encierra la tinta y nada más", () => {
    const d = lienzo(10, 10, [
      [3, 4],
      [5, 6],
    ]);
    expect(cajaDelTrazo(d, 10, 10)).toEqual({ x: 3, y: 4, w: 3, h: 3 });
  });

  it("un solo píxel da una caja de 1×1, no de 0×0", () => {
    // El +1 de los índices inclusivos: sin él, recortar un punto da un lienzo de
    // ancho 0 y `drawImage` no dibuja nada.
    expect(cajaDelTrazo(lienzo(5, 5, [[2, 2]]), 5, 5)).toEqual({ x: 2, y: 2, w: 1, h: 1 });
  });

  it("un lienzo sin tinta devuelve null, no una caja vacía", () => {
    // Quien llama necesita distinguir "no dibujó" de "dibujó algo de tamaño cero".
    expect(cajaDelTrazo(lienzo(8, 8, []), 8, 8)).toBeNull();
  });

  it("un trazo pegado a las cuatro esquinas cubre el lienzo entero", () => {
    const d = lienzo(4, 3, [
      [0, 0],
      [3, 2],
    ]);
    expect(cajaDelTrazo(d, 4, 3)).toEqual({ x: 0, y: 0, w: 4, h: 3 });
  });

  it("ignora el antialiasing casi invisible del borde", () => {
    // Sin umbral, esos píxeles de alfa 3 agrandan la caja sin que se vea nada ahí.
    const d = lienzo(10, 10, [
      [1, 1, 3],
      [5, 5, 255],
      [8, 8, 2],
    ]);
    expect(cajaDelTrazo(d, 10, 10)).toEqual({ x: 5, y: 5, w: 1, h: 1 });
  });

  it("con umbral 0 sí los toma (el umbral es lo que los descarta)", () => {
    const d = lienzo(10, 10, [
      [1, 1, 3],
      [5, 5, 255],
    ]);
    expect(cajaDelTrazo(d, 10, 10, 0)).toEqual({ x: 1, y: 1, w: 5, h: 5 });
  });

  it("un lienzo de dimensión cero no rompe", () => {
    expect(cajaDelTrazo(new Uint8ClampedArray(0), 0, 0)).toBeNull();
    expect(cajaDelTrazo(new Uint8ClampedArray(0), 10, 0)).toBeNull();
  });
});

describe("conMargen", () => {
  it("agranda por los cuatro lados", () => {
    expect(conMargen({ x: 10, y: 10, w: 5, h: 5 }, 3, 100, 100)).toEqual({
      x: 7,
      y: 7,
      w: 11,
      h: 11,
    });
  });

  it("no se sale por arriba ni por la izquierda", () => {
    expect(conMargen({ x: 1, y: 0, w: 4, h: 4 }, 3, 100, 100)).toEqual({
      x: 0,
      y: 0,
      w: 8,
      h: 7,
    });
  });

  it("no se sale por abajo ni por la derecha", () => {
    // El caso que rompía la primera versión: cuando el recorte de un lado es
    // PARCIAL, el ancho no es `w + 2*margen`.
    expect(conMargen({ x: 96, y: 95, w: 4, h: 5 }, 3, 100, 100)).toEqual({
      x: 93,
      y: 92,
      w: 7,
      h: 8,
    });
  });

  it("una caja que ya cubre el lienzo no crece", () => {
    expect(conMargen({ x: 0, y: 0, w: 20, h: 10 }, 5, 20, 10)).toEqual({
      x: 0,
      y: 0,
      w: 20,
      h: 10,
    });
  });

  it("margen 0 devuelve la misma caja", () => {
    const c = { x: 4, y: 5, w: 6, h: 7 };
    expect(conMargen(c, 0, 100, 100)).toEqual(c);
  });
});

describe("trazoDemasiadoChico", () => {
  it("un toque accidental no cuenta como firma", () => {
    expect(trazoDemasiadoChico({ x: 5, y: 5, w: 2, h: 2 })).toBe(true);
  });

  it("no dibujar tampoco", () => {
    expect(trazoDemasiadoChico(null)).toBe(true);
  });

  it("una firma corta de iniciales SÍ cuenta", () => {
    expect(trazoDemasiadoChico({ x: 0, y: 0, w: 40, h: 20 })).toBe(false);
  });

  it("basta que UN lado alcance: una raya horizontal es una firma", () => {
    // Con `&&` una firma larga y plana pasa; con `||` se rechazaría, y hay gente
    // que firma con una línea casi recta.
    expect(trazoDemasiadoChico({ x: 0, y: 0, w: 200, h: 3 })).toBe(false);
  });
});
