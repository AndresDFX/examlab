import { describe, expect, it } from "vitest";

import { resolverSeleccionInicial } from "./selection-required";

describe("resolverSeleccionInicial — la regla que hace que el patrón no moleste", () => {
  it("con UNA sola opción, la elige sola", () => {
    // Obligar a un clic cuando no hay alternativa es fricción pura.
    expect(resolverSeleccionInicial(["c1"])).toBe("c1");
  });

  it("con VARIAS, no elige ninguna", () => {
    // Elegir la primera muestra datos de algo que nadie pidió; en Asistencia
    // eso se traduce en pasar lista sobre el curso equivocado.
    expect(resolverSeleccionInicial(["c1", "c2"])).toBeNull();
    expect(resolverSeleccionInicial(["c1", "c2", "c3"])).toBeNull();
  });

  it("sin opciones, no hay nada que elegir", () => {
    expect(resolverSeleccionInicial([])).toBeNull();
  });

  it("descarta ids vacíos antes de contar", () => {
    // Una lista con un hueco («» del Select) no debe leerse como «hay dos».
    expect(resolverSeleccionInicial(["", "c1"])).toBe("c1");
    expect(resolverSeleccionInicial(["  ", ""])).toBeNull();
  });

  it("no muta la lista que recibe", () => {
    const ids = ["c1", "c2"];
    resolverSeleccionInicial(ids);
    expect(ids).toEqual(["c1", "c2"]);
  });
});
