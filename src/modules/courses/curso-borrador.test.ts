import { describe, expect, it } from "vitest";

import { conAnclaActiva, cuantosCursos, mapaDeEstados, soloCursosEnBorrador } from "./curso-borrador";

const estados = mapaDeEstados([
  { id: "borrador1", status: "borrador" },
  { id: "borrador2", status: "borrador" },
  { id: "activo", status: "en_curso" },
  { id: "cerrado", status: "finalizado" },
  { id: "heredado", status: null },
]);

describe("soloCursosEnBorrador", () => {
  it("un curso en borrador bloquea", () => {
    expect(soloCursosEnBorrador(["borrador1"], estados)).toBe(true);
  });

  it("todos en borrador bloquea, y los repetidos no cambian nada", () => {
    expect(soloCursosEnBorrador(["borrador1", "borrador2", "borrador1"], estados)).toBe(true);
  });

  it("con un curso activo entre ellos no bloquea: ese curso lo usa", () => {
    expect(soloCursosEnBorrador(["borrador1", "activo"], estados)).toBe(false);
  });

  it("un curso finalizado no es borrador", () => {
    expect(soloCursosEnBorrador(["borrador1", "cerrado"], estados)).toBe(false);
  });

  it("un curso heredado sin estado cuenta como en curso", () => {
    expect(soloCursosEnBorrador(["heredado"], estados)).toBe(false);
  });

  it("sin cursos (material personal) no bloquea", () => {
    expect(soloCursosEnBorrador([], estados)).toBe(false);
    expect(soloCursosEnBorrador([null, undefined, ""], estados)).toBe(false);
  });

  it("un curso que la pantalla no conoce no se da por borrador", () => {
    expect(soloCursosEnBorrador(["borrador1", "ajeno"], estados)).toBe(false);
    expect(soloCursosEnBorrador(["ajeno"], estados)).toBe(false);
  });
});

describe("conAnclaActiva", () => {
  it("pone primero el primer curso activo y conserva el orden del resto", () => {
    expect(conAnclaActiva(["borrador1", "borrador2", "activo", "cerrado"], estados)).toEqual([
      "activo",
      "borrador1",
      "borrador2",
      "cerrado",
    ]);
  });

  it("si el primero ya es activo, no cambia nada", () => {
    expect(conAnclaActiva(["activo", "borrador1"], estados)).toEqual(["activo", "borrador1"]);
  });

  it("si todos están en borrador, no cambia nada", () => {
    expect(conAnclaActiva(["borrador2", "borrador1"], estados)).toEqual(["borrador2", "borrador1"]);
  });

  it("un curso desconocido no se elige como ancla", () => {
    expect(conAnclaActiva(["borrador1", "ajeno", "heredado"], estados)).toEqual([
      "heredado",
      "borrador1",
      "ajeno",
    ]);
  });

  it("devuelve una lista nueva", () => {
    const original = ["activo"];
    expect(conAnclaActiva(original, estados)).not.toBe(original);
  });
});

describe("cuantosCursos", () => {
  it("cuenta los distintos e ignora los vacíos", () => {
    expect(cuantosCursos(["a", "b", "a", null, undefined, ""])).toBe(2);
    expect(cuantosCursos([])).toBe(0);
  });
});
