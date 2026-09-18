import { describe, expect, it } from "vitest";
import {
  alternarSeleccion,
  coincideAlgunFiltro,
  coincideFiltro,
  etiquetaSeleccion,
  limpiarSeleccionInvalida,
} from "./filtro-multiple";

describe("coincideFiltro", () => {
  it("sin nada marcado NO filtra: pasa todo", () => {
    // Es la trampa que este módulo existe para cerrar. Tratar el arreglo vacío
    // como «ningún resultado» esconde la tabla entera.
    expect(coincideFiltro([], "curso-1")).toBe(true);
    expect(coincideFiltro([], null)).toBe(true);
  });

  it("con uno marcado se comporta como el filtro de siempre", () => {
    expect(coincideFiltro(["a"], "a")).toBe(true);
    expect(coincideFiltro(["a"], "b")).toBe(false);
  });

  it("con dos marcados pasan los dos: el caso que se pidió", () => {
    expect(coincideFiltro(["a", "b"], "a")).toBe(true);
    expect(coincideFiltro(["a", "b"], "b")).toBe(true);
    expect(coincideFiltro(["a", "b"], "c")).toBe(false);
  });

  it("un item sin valor no pasa cuando hay filtro activo", () => {
    // Una pizarra sin curso no se le puede atribuir al curso seleccionado.
    expect(coincideFiltro(["a"], null)).toBe(false);
    expect(coincideFiltro(["a"], undefined)).toBe(false);
  });
});

describe("coincideAlgunFiltro", () => {
  it("un taller compartido pasa si CUALQUIERA de sus cursos está marcado", () => {
    expect(coincideAlgunFiltro(["b"], ["a", "b"])).toBe(true);
  });

  it("no pasa si ninguno de sus cursos está marcado", () => {
    expect(coincideAlgunFiltro(["c"], ["a", "b"])).toBe(false);
  });

  it("sin filtro, pasa incluso sin cursos", () => {
    expect(coincideAlgunFiltro([], [])).toBe(true);
  });
});

describe("alternarSeleccion", () => {
  it("marca y desmarca", () => {
    expect(alternarSeleccion([], "a")).toEqual(["a"]);
    expect(alternarSeleccion(["a"], "a")).toEqual([]);
    expect(alternarSeleccion(["a"], "b")).toEqual(["a", "b"]);
  });

  it("no muta la lista original", () => {
    const original = ["a"];
    alternarSeleccion(original, "b");
    expect(original).toEqual(["a"]);
  });
});

describe("etiquetaSeleccion", () => {
  const nombres: Record<string, string> = { a: "Programación II", b: "Seminario" };
  const textos = { todos: "Todos los cursos", varios: (n: number) => `${n} seleccionados` };

  it("sin nada marcado dice «todos»", () => {
    expect(etiquetaSeleccion([], (v) => nombres[v], textos)).toBe("Todos los cursos");
  });

  it("con uno muestra su nombre, que es la información útil", () => {
    expect(etiquetaSeleccion(["a"], (v) => nombres[v], textos)).toBe("Programación II");
  });

  it("con dos o más cuenta, porque los nombres ya no entran", () => {
    expect(etiquetaSeleccion(["a", "b"], (v) => nombres[v], textos)).toBe("2 seleccionados");
  });

  it("si el nombre no se encuentra, no rompe: cuenta", () => {
    expect(etiquetaSeleccion(["z"], (v) => nombres[v], textos)).toBe("1 seleccionados");
  });
});

describe("limpiarSeleccionInvalida", () => {
  it("quita lo que ya no está entre las opciones", () => {
    // Pasa al encadenar filtros: al acotar por periodo, un curso marcado de
    // otro periodo seguiría filtrando la tabla SIN aparecer en el botón.
    expect(limpiarSeleccionInvalida(["a", "b"], ["a"])).toEqual(["a"]);
  });

  it("devuelve la MISMA referencia cuando no hay nada que quitar", () => {
    // Para no disparar un render (ni un efecto) en cada pasada.
    const sel = ["a", "b"];
    expect(limpiarSeleccionInvalida(sel, ["a", "b", "c"])).toBe(sel);
  });

  it("puede vaciar la selección, que vuelve a significar «todos»", () => {
    expect(limpiarSeleccionInvalida(["a"], ["b"])).toEqual([]);
  });
});
