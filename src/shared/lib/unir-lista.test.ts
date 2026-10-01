import { describe, expect, it } from "vitest";

import { unirLista } from "./unir-lista";

describe("unirLista", () => {
  it("une en español con «y»", () => {
    expect(unirLista(["3 exámenes", "2 talleres", "1 encuesta"], "es-CO")).toBe(
      "3 exámenes, 2 talleres y 1 encuesta",
    );
  });

  it("uno solo o ninguno", () => {
    expect(unirLista(["1 taller"], "es-CO")).toBe("1 taller");
    expect(unirLista([], "es-CO")).toBe("");
  });

  it("en inglés", () => {
    expect(unirLista(["a", "b"], "en")).toBe("a and b");
  });

  it("con un idioma inválido cae a la unión a mano", () => {
    expect(unirLista(["a", "b", "c"], "no-es-un-idioma-$$")).toBe("a, b y c");
  });
});
