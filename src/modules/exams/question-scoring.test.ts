import { describe, expect, it } from "vitest";
import {
  scoreCerradaMulti,
  scoreCerradaSingle,
  validateCerradaMultiSelection,
} from "./question-scoring";

describe("scoreCerradaSingle — todo-o-nada + guard de config corrupta", () => {
  it("respuesta correcta → puntaje completo", () => {
    expect(scoreCerradaSingle(2, 2, 10)).toBe(10);
  });
  it("respuesta incorrecta → 0", () => {
    expect(scoreCerradaSingle(1, 2, 10)).toBe(0);
  });
  it("[BUG FIX] en blanco (undefined) + correct_index ausente (undefined) → 0, NO puntaje completo", () => {
    expect(scoreCerradaSingle(undefined, undefined, 10)).toBe(0);
  });
  it("en blanco con correct_index válido → 0", () => {
    expect(scoreCerradaSingle(undefined, 1, 10)).toBe(0);
  });
  it("correct_index ausente pero el alumno respondió → 0 (no regala puntos)", () => {
    expect(scoreCerradaSingle(0, undefined, 10)).toBe(0);
  });
  it("correct_index tipo string no cuenta como match", () => {
    expect(scoreCerradaSingle(2, "2" as unknown, 10)).toBe(0);
  });
  it("points NaN/negativo → 0", () => {
    expect(scoreCerradaSingle(2, 2, NaN)).toBe(0);
    expect(scoreCerradaSingle(2, 2, -5)).toBe(0);
  });
  it("índice 0 correcto (no es falsy-trap)", () => {
    expect(scoreCerradaSingle(0, 0, 5)).toBe(5);
  });
});

describe("scoreCerradaMulti — proporcional positivo", () => {
  it("100% cuando marca exactamente las correctas", () => {
    const r = scoreCerradaMulti({
      selected: [0, 2],
      correctIndices: [0, 2],
      totalPoints: 10,
    });
    expect(r.earned).toBe(10);
    expect(r.isAnswered).toBe(true);
  });

  it("50% cuando marca solo 1 de 2 correctas", () => {
    const r = scoreCerradaMulti({
      selected: [0],
      correctIndices: [0, 2],
      totalPoints: 10,
    });
    expect(r.earned).toBe(5);
    expect(r.isAnswered).toBe(true);
  });

  it("NO penaliza por marcar opciones incorrectas (proporcional positivo)", () => {
    // 2 correctas + 1 incorrecta marcada → sigue siendo 100%
    const r = scoreCerradaMulti({
      selected: [0, 2, 3],
      correctIndices: [0, 2],
      totalPoints: 10,
    });
    expect(r.earned).toBe(10);
  });

  it("33.33% cuando marca 1 de 3 correctas", () => {
    const r = scoreCerradaMulti({
      selected: [0],
      correctIndices: [0, 1, 2],
      totalPoints: 10,
    });
    // 1/3 * 10 = 3.333... → 3.33
    expect(r.earned).toBe(3.33);
  });

  it("0% cuando no marca ninguna correcta", () => {
    const r = scoreCerradaMulti({
      selected: [3, 4],
      correctIndices: [0, 2],
      totalPoints: 10,
    });
    expect(r.earned).toBe(0);
    expect(r.isAnswered).toBe(true);
  });

  it("vacío: earned 0, isAnswered=false", () => {
    const r = scoreCerradaMulti({
      selected: [],
      correctIndices: [0, 2],
      totalPoints: 10,
    });
    expect(r.earned).toBe(0);
    expect(r.isAnswered).toBe(false);
  });

  it("deduplica selecciones repetidas (defensa contra UI buggy)", () => {
    const r = scoreCerradaMulti({
      selected: [0, 0, 2, 2],
      correctIndices: [0, 2],
      totalPoints: 10,
    });
    expect(r.earned).toBe(10);
  });

  it("redondea a 2 decimales", () => {
    // 2 de 7 correctas = 0.2857... → 2.86
    const r = scoreCerradaMulti({
      selected: [0, 1],
      correctIndices: [0, 1, 2, 3, 4, 5, 6],
      totalPoints: 10,
    });
    expect(r.earned).toBe(2.86);
  });

  it("totalPoints=0: earned=0", () => {
    const r = scoreCerradaMulti({
      selected: [0, 1],
      correctIndices: [0, 1],
      totalPoints: 0,
    });
    expect(r.earned).toBe(0);
  });

  it("correctIndices vacío (config inválida): earned=0", () => {
    const r = scoreCerradaMulti({
      selected: [0, 1],
      correctIndices: [],
      totalPoints: 10,
    });
    expect(r.earned).toBe(0);
  });
});

describe("scoreCerradaMulti — min/max selections", () => {
  it("below_min: earned=0 y belowMin=true", () => {
    const r = scoreCerradaMulti({
      selected: [0],
      correctIndices: [0, 1, 2],
      totalPoints: 10,
      minSelections: 2,
    });
    expect(r.earned).toBe(0);
    expect(r.belowMin).toBe(true);
    expect(r.isAnswered).toBe(false);
  });

  it("exceededMax: earned=0 y exceededMax=true", () => {
    const r = scoreCerradaMulti({
      selected: [0, 1, 2, 3],
      correctIndices: [0, 1],
      totalPoints: 10,
      maxSelections: 2,
    });
    expect(r.earned).toBe(0);
    expect(r.exceededMax).toBe(true);
    expect(r.isAnswered).toBe(false);
  });

  it("dentro de min/max: scoring normal", () => {
    const r = scoreCerradaMulti({
      selected: [0, 1],
      correctIndices: [0, 1, 2],
      totalPoints: 10,
      minSelections: 1,
      maxSelections: 3,
    });
    // 2/3 * 10 = 6.67
    expect(r.earned).toBe(6.67);
    expect(r.isAnswered).toBe(true);
  });

  it("min/max no definidos: sin restricción", () => {
    const r = scoreCerradaMulti({
      selected: [0, 1, 2, 3, 4],
      correctIndices: [0],
      totalPoints: 10,
    });
    expect(r.earned).toBe(10);
    expect(r.isAnswered).toBe(true);
  });
});

describe("validateCerradaMultiSelection", () => {
  it("ok cuando no hay restricciones", () => {
    expect(validateCerradaMultiSelection(0, undefined, undefined).ok).toBe(true);
    expect(validateCerradaMultiSelection(5, undefined, undefined).ok).toBe(true);
  });

  it("below_min cuando count < min", () => {
    const r = validateCerradaMultiSelection(1, 2, undefined);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("below_min");
  });

  it("above_max cuando count > max", () => {
    const r = validateCerradaMultiSelection(5, 1, 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("above_max");
  });

  it("ok cuando count está en el rango", () => {
    expect(validateCerradaMultiSelection(2, 1, 3).ok).toBe(true);
    expect(validateCerradaMultiSelection(1, 1, 3).ok).toBe(true);
    expect(validateCerradaMultiSelection(3, 1, 3).ok).toBe(true);
  });
});
