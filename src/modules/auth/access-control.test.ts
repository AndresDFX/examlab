import { describe, it, expect } from "vitest";
import { studentAccessLevel } from "./access-control";

describe("studentAccessLevel", () => {
  it("activo o sin estado → full", () => {
    expect(studentAccessLevel("activo", ["Estudiante"])).toBe("full");
    expect(studentAccessLevel(null, ["Estudiante"])).toBe("full");
    expect(studentAccessLevel(undefined, ["Estudiante"])).toBe("full");
  });

  it("retirado y aplazado → blocked", () => {
    expect(studentAccessLevel("retirado", ["Estudiante"])).toBe("blocked");
    expect(studentAccessLevel("aplazado", ["Estudiante"])).toBe("blocked");
  });

  it("graduado → readonly", () => {
    expect(studentAccessLevel("graduado", ["Estudiante"])).toBe("readonly");
  });

  it("staff NUNCA se bloquea, sin importar el estado", () => {
    for (const estado of ["retirado", "aplazado", "graduado", "activo", null]) {
      expect(studentAccessLevel(estado, ["Admin"])).toBe("full");
      expect(studentAccessLevel(estado, ["Docente"])).toBe("full");
      expect(studentAccessLevel(estado, ["SuperAdmin"])).toBe("full");
    }
  });

  it("rol mixto (Estudiante + Docente) → full (gana staff)", () => {
    expect(studentAccessLevel("retirado", ["Estudiante", "Docente"])).toBe("full");
  });

  it("sin roles + retirado → blocked", () => {
    expect(studentAccessLevel("retirado", [])).toBe("blocked");
  });
});
