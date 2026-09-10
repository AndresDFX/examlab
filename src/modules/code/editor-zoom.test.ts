import { describe, expect, it } from "vitest";

import { escalarAltoEditor } from "./editor-zoom";

describe("escalarAltoEditor", () => {
  it("en zoom 1 devuelve el alto tal cual", () => {
    expect(escalarAltoEditor("20rem", 1)).toBe("20rem");
    expect(escalarAltoEditor("auto", 1)).toBe("auto");
  });

  it("escala el número y CONSERVA la unidad", () => {
    // Es el punto del helper: multiplicar el string entero daría "20rem1.5" y
    // devolver solo el número dejaría un alto sin unidad, que el navegador
    // ignora.
    expect(escalarAltoEditor("20rem", 1.5)).toBe("30rem");
    expect(escalarAltoEditor("400px", 1.25)).toBe("500px");
    expect(escalarAltoEditor("60vh", 2)).toBe("120vh");
    expect(escalarAltoEditor("50%", 1.5)).toBe("75%");
  });

  it("un número sin unidad se escala y sigue sin unidad", () => {
    expect(escalarAltoEditor("300", 2)).toBe("600");
  });

  it("redondea a 2 decimales y no deja ceros de relleno", () => {
    expect(escalarAltoEditor("14rem", 1.25)).toBe("17.5rem");
    expect(escalarAltoEditor("10rem", 1.25)).toBe("12.5rem");
  });

  it("un alto que NO es un número se devuelve intacto", () => {
    // Preferir el alto original a inventar uno: un editor de 0px es peor que
    // uno que no creció.
    for (const raw of ["auto", "calc(100% - 2rem)", "", "  ", "min-content", "100"]) {
      const esperado = raw === "100" ? "150" : raw;
      expect(escalarAltoEditor(raw, 1.5)).toBe(esperado);
    }
  });

  it("tolera espacios alrededor", () => {
    expect(escalarAltoEditor("  20rem  ", 1.5)).toBe("30rem");
  });
});
