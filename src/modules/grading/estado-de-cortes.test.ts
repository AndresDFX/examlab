import { describe, expect, it } from "vitest";
import { resumirCortes } from "./estado-de-cortes";

const ex = (grade: number | null) => ({ kind: "exam" as const, grade });
const asis = (grade: number | null) => ({ kind: "attendance" as const, grade });

describe("estado de los cortes según las notas", () => {
  it("con notas en el corte 1 y nada en los demás, el actual es el 1", () => {
    const r = resumirCortes([[ex(4.5)], [ex(null)], []]);
    expect(r.map((c) => c.estado)).toEqual(["actual", "sin_notas", "sin_notas"]);
  });

  it("con notas en el 1 y el 2, el actual es el 2", () => {
    const r = resumirCortes([[ex(4)], [ex(3)], [ex(null)]]);
    expect(r.map((c) => c.estado)).toEqual(["con_notas", "actual", "sin_notas"]);
  });

  it("la asistencia sola no hace que un corte tenga notas", () => {
    const r = resumirCortes([[ex(4.9), asis(5)], [asis(0)], []]);
    expect(r[1].conNotas).toBe(false);
    expect(r[1].estado).toBe("sin_notas");
    expect(r[0].estado).toBe("actual");
  });

  it("sin ninguna nota, el actual es el primero", () => {
    const r = resumirCortes([[ex(null)], [ex(null)]]);
    expect(r[0].estado).toBe("actual");
  });

  it("resume por tipo, en orden y solo los presentes", () => {
    const r = resumirCortes([[ex(4), ex(null), { kind: "workshop", grade: 5 }, asis(5)]]);
    expect(r[0].porTipo).toEqual([
      { kind: "exam", total: 2, conNota: 1 },
      { kind: "workshop", total: 1, conNota: 1 },
      { kind: "attendance", total: 1, conNota: 1 },
    ]);
  });
});
