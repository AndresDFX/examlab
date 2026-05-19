import { describe, expect, it } from "vitest";
import {
  displayNamesEqual,
  normalizeDisplayName,
  suggestUniqueDisplayName,
  validateDisplayName,
} from "./content-display-name";

describe("normalizeDisplayName", () => {
  it("trim + lower-case", () => {
    expect(normalizeDisplayName("  Hola Mundo  ")).toBe("hola mundo");
  });

  it("string vacío permanece vacío", () => {
    expect(normalizeDisplayName("")).toBe("");
    expect(normalizeDisplayName("   ")).toBe("");
  });
});

describe("displayNamesEqual", () => {
  it("'Semana 5' === 'semana 5'", () => {
    expect(displayNamesEqual("Semana 5", "semana 5")).toBe(true);
  });

  it("'Semana 5' === 'SEMANA 5  '", () => {
    expect(displayNamesEqual("Semana 5", "SEMANA 5  ")).toBe(true);
  });

  it("'Semana 5' !== 'Semana 6'", () => {
    expect(displayNamesEqual("Semana 5", "Semana 6")).toBe(false);
  });

  it("acentos importan (no se normalizan)", () => {
    expect(displayNamesEqual("Sesión 1", "Sesion 1")).toBe(false);
  });
});

describe("validateDisplayName", () => {
  it("acepta nombre normal", () => {
    expect(validateDisplayName("Semana 5")).toBeNull();
  });

  it("rechaza vacío", () => {
    expect(validateDisplayName("")).toMatch(/vac[íi]o/i);
    expect(validateDisplayName("   ")).toMatch(/vac[íi]o/i);
  });

  it("rechaza >120 caracteres", () => {
    const long = "A".repeat(121);
    expect(validateDisplayName(long)).toMatch(/largo/i);
  });

  it("acepta exactamente 120 caracteres", () => {
    const exactly = "A".repeat(120);
    expect(validateDisplayName(exactly)).toBeNull();
  });

  it("acepta con leading/trailing spaces (los cuenta sin trim para length pero usa trim para vacío)", () => {
    expect(validateDisplayName("  Semana 5  ")).toBeNull();
  });
});

describe("suggestUniqueDisplayName", () => {
  it("retorna tal cual si el deseado está libre", () => {
    expect(suggestUniqueDisplayName("Semana 5", [])).toBe("Semana 5");
    expect(suggestUniqueDisplayName("Semana 5", ["Otro"])).toBe("Semana 5");
  });

  it("aplica trim al deseado", () => {
    expect(suggestUniqueDisplayName("  Semana 5  ", [])).toBe("Semana 5");
  });

  it("agrega ' (2)' cuando el deseado choca", () => {
    expect(suggestUniqueDisplayName("Semana 5", ["Semana 5"])).toBe("Semana 5 (2)");
  });

  it("incrementa hasta encontrar libre", () => {
    expect(
      suggestUniqueDisplayName("Semana 5", ["Semana 5", "Semana 5 (2)", "Semana 5 (3)"]),
    ).toBe("Semana 5 (4)");
  });

  it("matching case-insensitive contra existing", () => {
    expect(suggestUniqueDisplayName("Semana 5", ["SEMANA 5"])).toBe("Semana 5 (2)");
    expect(suggestUniqueDisplayName("Semana 5", ["semana 5", "SEMANA 5 (2)"])).toBe(
      "Semana 5 (3)",
    );
  });

  it("si el deseado YA termina en ' (N)', arranca desde N+1 sin anidar", () => {
    // "Tema A (2)" colisiona — devolvemos "Tema A (3)", no "Tema A (2) (2)".
    expect(suggestUniqueDisplayName("Tema A (2)", ["Tema A (2)"])).toBe("Tema A (3)");
    // Incluso si "Tema A (3)" también está ocupado, sigue contando.
    expect(suggestUniqueDisplayName("Tema A (2)", ["Tema A (2)", "Tema A (3)"])).toBe(
      "Tema A (4)",
    );
  });

  it("base del sufijo respeta el deseado (no usa 'Tema A' si vino 'Tema A (5)')", () => {
    // "Tema A (5)" colisiona y no existe (6) → sugerencia es "Tema A (6)".
    expect(suggestUniqueDisplayName("Tema A (5)", ["Tema A (5)"])).toBe("Tema A (6)");
  });

  it("string vacío devuelve vacío (deja la validación al caller)", () => {
    expect(suggestUniqueDisplayName("", [])).toBe("");
    expect(suggestUniqueDisplayName("   ", [])).toBe("");
  });

  it("no es sensible al orden de la lista existente", () => {
    const a = suggestUniqueDisplayName("X", ["X (3)", "X (2)", "X"]);
    const b = suggestUniqueDisplayName("X", ["X", "X (2)", "X (3)"]);
    expect(a).toBe(b);
    expect(a).toBe("X (4)");
  });
});
