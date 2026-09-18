import { describe, expect, it } from "vitest";
import { estadoDeFila } from "./estado-monitor";

const base = { userId: "u1", enProgreso: false, pares: [] as never[] };

describe("estadoDeFila", () => {
  it("un intento en curso manda sobre cualquier otro estado", () => {
    expect(
      estadoDeFila({ ...base, enProgreso: true, ultima: { status: "sospechoso" } }),
    ).toBe("en_progreso");
  });

  it("sin intentos finalizados no hay estado que mostrar", () => {
    expect(estadoDeFila({ ...base, ultima: null })).toBeNull();
  });

  it("devuelve el estado tal cual cuando no es sospechoso", () => {
    expect(estadoDeFila({ ...base, ultima: { status: "completado" } })).toBe("completado");
  });

  it("sospechoso por IA pasa a chequeado SOLO si el docente la revisó", () => {
    const conIA = { status: "sospechoso", ai_detected_score: 0.8 };
    expect(estadoDeFila({ ...base, ultima: conIA })).toBe("sospechoso");
    expect(
      estadoDeFila({ ...base, ultima: { ...conIA, ai_review_at: "2026-09-17T00:00:00Z" } }),
    ).toBe("chequeado");
  });

  it("sin señal de IA no se exige revisarla", () => {
    // Pedirla dejaría en rojo para siempre a quien solo fue marcado por copia.
    expect(
      estadoDeFila({ ...base, ultima: { status: "sospechoso", ai_detected_score: 0.1 } }),
    ).toBe("chequeado");
  });

  it("un par de copia sin revisar lo mantiene sospechoso", () => {
    const pares = [{ user_a: "u1", user_b: "u2", reviewed_at: null }];
    expect(estadoDeFila({ ...base, pares, ultima: { status: "sospechoso" } })).toBe("sospechoso");
  });

  it("con TODOS sus pares revisados pasa a chequeado", () => {
    const pares = [
      { user_a: "u1", user_b: "u2", reviewed_at: "2026-09-17T00:00:00Z" },
      { user_a: "u3", user_b: "u1", reviewed_at: "2026-09-17T00:00:00Z" },
    ];
    expect(estadoDeFila({ ...base, pares, ultima: { status: "sospechoso" } })).toBe("chequeado");
  });

  it("los pares de OTROS estudiantes no lo afectan", () => {
    const pares = [{ user_a: "u9", user_b: "u8", reviewed_at: null }];
    expect(estadoDeFila({ ...base, pares, ultima: { status: "sospechoso" } })).toBe("chequeado");
  });

  it("basta UN par sin revisar entre varios", () => {
    const pares = [
      { user_a: "u1", user_b: "u2", reviewed_at: "2026-09-17T00:00:00Z" },
      { user_a: "u1", user_b: "u3", reviewed_at: null },
    ];
    expect(estadoDeFila({ ...base, pares, ultima: { status: "sospechoso" } })).toBe("sospechoso");
  });
});
