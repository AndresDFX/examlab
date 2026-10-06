import { describe, expect, it } from "vitest";
import { retroDeExamenVisible, retroDeTallerVisible } from "./retroalimentacion-visible";

describe("retroalimentación visible solo cuando está calificado", () => {
  it("taller o proyecto entregado y por calificar: no se ve", () => {
    expect(retroDeTallerVisible({ status: "entregado", final_grade: null })).toBe(false);
  });
  it("taller calificado, o con nota final puesta: se ve", () => {
    expect(retroDeTallerVisible({ status: "calificado", final_grade: 4 })).toBe(true);
    expect(retroDeTallerVisible({ status: "entregado", final_grade: 3.5 })).toBe(true);
  });
  it("sin entrega no hay nada que ver", () => {
    expect(retroDeTallerVisible(null)).toBe(false);
    expect(retroDeExamenVisible(undefined)).toBe(false);
  });
  it("examen: se ve cuando tiene nota, de la IA o del docente", () => {
    expect(retroDeExamenVisible({ ai_grade: null, final_override_grade: null })).toBe(false);
    expect(retroDeExamenVisible({ ai_grade: 3.2, final_override_grade: null })).toBe(true);
    expect(retroDeExamenVisible({ ai_grade: null, final_override_grade: 4 })).toBe(true);
  });
});
