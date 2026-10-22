import { describe, it, expect } from "vitest";
import {
  aplicarTopeDeNota,
  plazoPropioVigente,
  tieneCondicion,
  normalizarCondicion,
  indiceCondicionesPorActividad,
  indiceCondicionesPorEstudianteActividad,
  claveCondicion,
  type CondicionEstudiante,
} from "./condiciones-estudiante";

describe("aplicarTopeDeNota", () => {
  it("topa min(nota, N), no proporcional", () => {
    // Un 5,0 con tope 4,0 queda en 4,0.
    expect(aplicarTopeDeNota(5, 4)).toBe(4);
    // Un 4,5 con tope 4,0 queda en 4,0.
    expect(aplicarTopeDeNota(4.5, 4)).toBe(4);
  });

  it("deja la nota igual cuando ya está por debajo del tope", () => {
    expect(aplicarTopeDeNota(3, 4)).toBe(3);
    expect(aplicarTopeDeNota(4, 4)).toBe(4);
  });

  it("sin tope devuelve la nota tal cual (reversible)", () => {
    expect(aplicarTopeDeNota(5, null)).toBe(5);
    expect(aplicarTopeDeNota(5, undefined)).toBe(5);
  });

  it("sin nota devuelve null aunque haya tope", () => {
    expect(aplicarTopeDeNota(null, 4)).toBeNull();
    expect(aplicarTopeDeNota(undefined, 4)).toBeNull();
  });

  it("ignora un tope no numérico", () => {
    expect(aplicarTopeDeNota(5, Number.NaN)).toBe(5);
  });
});

describe("plazoPropioVigente", () => {
  const ahora = Date.parse("2026-10-21T12:00:00Z");
  it("vigente si la fecha es futura", () => {
    expect(plazoPropioVigente("2026-10-30T23:59:00Z", ahora)).toBe(true);
  });
  it("no vigente si ya pasó", () => {
    expect(plazoPropioVigente("2026-10-01T00:00:00Z", ahora)).toBe(false);
  });
  it("sin plazo o fecha ilegible → no vigente", () => {
    expect(plazoPropioVigente(null, ahora)).toBe(false);
    expect(plazoPropioVigente(undefined, ahora)).toBe(false);
    expect(plazoPropioVigente("no-es-fecha", ahora)).toBe(false);
  });
});

describe("tieneCondicion", () => {
  const base: CondicionEstudiante = {
    tipo: "taller",
    actividadId: "w1",
    userId: "u1",
    notaMaxima: null,
    plazoPropio: null,
    entregaIndividual: false,
    motivo: "x",
  };
  it("false sin ninguna de las tres", () => {
    expect(tieneCondicion(base)).toBe(false);
    expect(tieneCondicion(null)).toBe(false);
  });
  it("true con cualquiera de las tres", () => {
    expect(tieneCondicion({ ...base, notaMaxima: 4 })).toBe(true);
    expect(tieneCondicion({ ...base, plazoPropio: "2026-10-30T00:00:00Z" })).toBe(true);
    expect(tieneCondicion({ ...base, entregaIndividual: true })).toBe(true);
  });
});

describe("normalizarCondicion", () => {
  it("normaliza tipos y strings numéricos", () => {
    const c = normalizarCondicion({
      tipo: "taller",
      actividad_id: "w1",
      user_id: "u1",
      nota_maxima: "4.0",
      plazo_propio: "2026-10-30T00:00:00Z",
      entrega_individual: true,
      motivo: "  entrega tardía  ",
    });
    expect(c).toEqual({
      tipo: "taller",
      actividadId: "w1",
      userId: "u1",
      notaMaxima: 4,
      plazoPropio: "2026-10-30T00:00:00Z",
      entregaIndividual: true,
      motivo: "entrega tardía",
    });
  });

  it("tipo desconocido cae a taller y nota_maxima nula se conserva null", () => {
    const c = normalizarCondicion({ actividad_id: "p1", user_id: "u1", tipo: "proyecto", nota_maxima: null });
    expect(c?.tipo).toBe("proyecto");
    expect(c?.notaMaxima).toBeNull();
  });

  it("devuelve null sin actividad o sin usuario", () => {
    expect(normalizarCondicion({ user_id: "u1" })).toBeNull();
    expect(normalizarCondicion({ actividad_id: "w1" })).toBeNull();
    expect(normalizarCondicion(null)).toBeNull();
  });
});

describe("índices", () => {
  const filas = [
    { tipo: "taller", actividad_id: "w1", user_id: "u1", nota_maxima: 4, motivo: "a" },
    { tipo: "taller", actividad_id: "w2", user_id: "u1", plazo_propio: "2026-11-01T00:00:00Z", motivo: "b" },
  ];
  it("indiceCondicionesPorActividad llavea por actividad", () => {
    const m = indiceCondicionesPorActividad(filas);
    expect(m.get("w1")?.notaMaxima).toBe(4);
    expect(m.get("w2")?.plazoPropio).toBe("2026-11-01T00:00:00Z");
  });
  it("indiceCondicionesPorEstudianteActividad llavea por usuario+actividad", () => {
    const m = indiceCondicionesPorEstudianteActividad(filas);
    expect(m.get(claveCondicion("u1", "w1"))?.notaMaxima).toBe(4);
    expect(m.get(claveCondicion("u2", "w1"))).toBeUndefined();
  });
  it("tolera null/undefined", () => {
    expect(indiceCondicionesPorActividad(null).size).toBe(0);
    expect(indiceCondicionesPorEstudianteActividad(undefined).size).toBe(0);
  });
});
