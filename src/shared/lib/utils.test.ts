import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn (clsx + tailwind-merge)", () => {
  it("concatena clases simples", () => {
    expect(cn("p-2", "m-4")).toBe("p-2 m-4");
  });

  it("filtra falsy (false, null, undefined, '')", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("aplica condicionales via objetos", () => {
    expect(cn("base", { active: true, hidden: false })).toBe("base active");
  });

  it("aplica condicionales via arrays anidados", () => {
    expect(cn(["a", "b"], "c")).toBe("a b c");
  });

  it("tailwind-merge: la ultima clase del mismo grupo gana", () => {
    // p-2 y p-4 son del mismo grupo (padding) → solo queda la ultima
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("tailwind-merge: distintos grupos coexisten", () => {
    expect(cn("p-2", "m-4")).toBe("p-2 m-4");
  });

  it("tailwind-merge: variantes responsive son grupos independientes", () => {
    // p-2 (mobile) y md:p-4 (md+) no chocan
    expect(cn("p-2", "md:p-4")).toBe("p-2 md:p-4");
  });

  it("retorna string vacio cuando todo es falsy", () => {
    expect(cn(false, null, undefined, "")).toBe("");
  });
});
