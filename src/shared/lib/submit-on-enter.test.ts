import { describe, expect, it } from "vitest";
import { enterEnvia } from "./submit-on-enter";

describe("enterEnvia", () => {
  it("Enter pelado envía", () => {
    expect(enterEnvia({ key: "Enter" })).toBe(true);
  });

  it("Shift+Enter NO envía: es el salto de línea", () => {
    // El caso que estaba roto en el generador de SQL de la pizarra.
    expect(enterEnvia({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("otra tecla no envía", () => {
    expect(enterEnvia({ key: "a" })).toBe(false);
    expect(enterEnvia({ key: "Escape" })).toBe(false);
  });

  it("un `key` ausente no envía ni rompe", () => {
    // Puede llegar undefined en eventos sintéticos y en la composición de un IME.
    expect(enterEnvia({})).toBe(false);
    expect(enterEnvia({ shiftKey: true })).toBe(false);
  });

  it("durante la composición de un IME, Enter confirma el candidato y NO envía", () => {
    expect(enterEnvia({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(false);
  });

  it("terminada la composición, Enter vuelve a enviar", () => {
    expect(enterEnvia({ key: "Enter", nativeEvent: { isComposing: false } })).toBe(true);
    expect(enterEnvia({ key: "Enter", nativeEvent: null })).toBe(true);
  });

  it("Ctrl+Enter y Cmd+Enter siguen enviando (no se miran los modificadores)", () => {
    // Deliberado: quien viene de las cajas que envían con Ctrl+Enter lo intenta
    // por costumbre, y que no haga nada es peor que enviar.
    expect(enterEnvia({ key: "Enter", ...{ ctrlKey: true } })).toBe(true);
    expect(enterEnvia({ key: "Enter", ...{ metaKey: true } })).toBe(true);
  });

  it("Shift gana sobre cualquier otro modificador", () => {
    expect(enterEnvia({ key: "Enter", shiftKey: true, ...{ ctrlKey: true } })).toBe(false);
  });
});
