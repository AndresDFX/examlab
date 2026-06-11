import { describe, it, expect } from "vitest";
import { nextBoardContentName } from "./board-content-upload";

describe("nextBoardContentName", () => {
  it("arranca en #1 cuando no hay contenidos previos", () => {
    expect(nextBoardContentName([], "Paradigmas")).toBe("Contenidos #1 - Paradigmas");
  });

  it("incrementa al siguiente número tras el último", () => {
    expect(nextBoardContentName(["Contenidos #1 - Paradigmas"], "Paradigmas")).toBe(
      "Contenidos #2 - Paradigmas",
    );
  });

  it("usa max+1 cuando hay huecos (no rellena el hueco)", () => {
    expect(
      nextBoardContentName(
        ["Contenidos #1 - X", "Contenidos #3 - X", "Contenidos #2 - X"],
        "X",
      ),
    ).toBe("Contenidos #4 - X");
  });

  it("ignora nombres que no matchean el patrón", () => {
    expect(
      nextBoardContentName(["Semana 5 — Bucles", "Tarea final", "Clase 2"], "Algoritmos"),
    ).toBe("Contenidos #1 - Algoritmos");
  });

  it("matchea sin importar mayúsculas/minúsculas", () => {
    expect(nextBoardContentName(["contenidos #2 - x"], "X")).toBe("Contenidos #3 - X");
  });

  it("convive con nombres mixtos (matchean y no matchean)", () => {
    expect(
      nextBoardContentName(
        ["Contenidos #1 - Curso", "Diapositivas semana 1", "Contenidos #5 - Curso"],
        "Curso",
      ),
    ).toBe("Contenidos #6 - Curso");
  });

  it("ignora números malformados / vacíos", () => {
    expect(nextBoardContentName(["Contenidos #", "Contenidos #abc", ""], "Curso")).toBe(
      "Contenidos #1 - Curso",
    );
  });

  it("preserva el nombre del curso tal cual (con espacios y símbolos)", () => {
    expect(nextBoardContentName([], "Bases de Datos II (2026)")).toBe(
      "Contenidos #1 - Bases de Datos II (2026)",
    );
  });
});
