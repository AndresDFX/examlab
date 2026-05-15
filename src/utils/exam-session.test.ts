import { describe, expect, it } from "vitest";
import { computeExtraSeconds, applyExtraTime, restoreQuestionIndex } from "./exam-session";

// ─── computeExtraSeconds ───────────────────────────────────────────────────

describe("computeExtraSeconds", () => {
  it("devuelve 0 para array vacío", () => {
    expect(computeExtraSeconds([])).toBe(0);
  });

  it("suma los segundos de filas add_time", () => {
    expect(
      computeExtraSeconds([
        { action: "add_time", extra_seconds: 300, target_user_id: "u1" },
        { action: "add_time", extra_seconds: 120, target_user_id: null },
      ]),
    ).toBe(420);
  });

  it("ignora filas pause y resume (no son tiempo extra)", () => {
    expect(
      computeExtraSeconds([
        { action: "pause", extra_seconds: 0, target_user_id: null },
        { action: "resume", extra_seconds: 0, target_user_id: null },
        { action: "add_time", extra_seconds: 60, target_user_id: "u1" },
      ]),
    ).toBe(60);
  });

  it("acumula múltiples add_time para el mismo estudiante", () => {
    expect(
      computeExtraSeconds([
        { action: "add_time", extra_seconds: 300, target_user_id: "u1" },
        { action: "add_time", extra_seconds: 300, target_user_id: "u1" },
      ]),
    ).toBe(600);
  });

  it("trata extra_seconds null como 0 (sin crashear)", () => {
    expect(
      computeExtraSeconds([
        { action: "add_time", extra_seconds: null, target_user_id: "u1" },
        { action: "add_time", extra_seconds: 180, target_user_id: "u1" },
      ]),
    ).toBe(180);
  });

  it("ignora valores no numéricos usando Number() con fallback 0", () => {
    expect(
      computeExtraSeconds([
        // @ts-expect-error: prueba de robustez con valor malo
        { action: "add_time", extra_seconds: "no-number", target_user_id: "u1" },
        { action: "add_time", extra_seconds: 90, target_user_id: "u1" },
      ]),
    ).toBe(90);
  });
});

// ─── applyExtraTime ────────────────────────────────────────────────────────

describe("applyExtraTime", () => {
  const BASE = "2026-05-15T14:00:00.000Z";

  it("devuelve el endTime original si extraSeconds es 0", () => {
    expect(applyExtraTime(BASE, 0)).toBe(BASE);
  });

  it("devuelve el endTime original si extraSeconds es negativo", () => {
    expect(applyExtraTime(BASE, -60)).toBe(BASE);
  });

  it("extiende el endTime por los segundos dados", () => {
    const extended = applyExtraTime(BASE, 300); // +5 minutos
    const expectedMs = new Date(BASE).getTime() + 300_000;
    expect(new Date(extended).getTime()).toBe(expectedMs);
  });

  it("devuelve ISO string válido", () => {
    const result = applyExtraTime(BASE, 600);
    expect(() => new Date(result)).not.toThrow();
    expect(isNaN(new Date(result).getTime())).toBe(false);
  });

  it("maneja extras grandes (1 hora)", () => {
    const result = applyExtraTime(BASE, 3600);
    const expected = new Date(new Date(BASE).getTime() + 3_600_000).toISOString();
    expect(result).toBe(expected);
  });
});

// ─── restoreQuestionIndex ─────────────────────────────────────────────────

describe("restoreQuestionIndex", () => {
  it("devuelve 0 para answers vacío", () => {
    expect(restoreQuestionIndex({})).toBe(0);
  });

  it("devuelve el índice persistido cuando es un número válido", () => {
    expect(restoreQuestionIndex({ __current_idx: 4 })).toBe(4);
  });

  it("devuelve 0 si el índice es 0 (primera pregunta)", () => {
    expect(restoreQuestionIndex({ __current_idx: 0 })).toBe(0);
  });

  it("devuelve 0 si __current_idx es string (no número)", () => {
    expect(restoreQuestionIndex({ __current_idx: "3" })).toBe(0);
  });

  it("devuelve 0 si __current_idx es undefined", () => {
    expect(restoreQuestionIndex({ __current_idx: undefined })).toBe(0);
  });

  it("devuelve 0 si __current_idx es null", () => {
    expect(restoreQuestionIndex({ __current_idx: null })).toBe(0);
  });

  it("devuelve 0 si __current_idx es negativo (estado corrupto)", () => {
    expect(restoreQuestionIndex({ __current_idx: -1 })).toBe(0);
  });

  it("ignora otras claves de answers (session_id, warnings, etc.)", () => {
    expect(
      restoreQuestionIndex({
        __session_id: "abc",
        __current_idx: 7,
        __warning_events: [],
        "q-1": "respuesta",
      }),
    ).toBe(7);
  });
});
