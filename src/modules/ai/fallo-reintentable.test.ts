import { describe, expect, it } from "vitest";
import { esFalloReintentable, PATRON_TRANSITORIO } from "./fallo-reintentable";
import { TRANSIENT_ERROR_PATTERN } from "../../../supabase/functions/_shared/transient-errors";

/** Simula el `error` de un FunctionsHttpError: `context` ES el Response. */
function httpError(status: number) {
  return { context: { status } as unknown as Response };
}

describe("esFalloReintentable", () => {
  it("encola por status transitorio (429, 5xx, 408)", () => {
    expect(esFalloReintentable({ error: httpError(429) })).toBe(true);
    expect(esFalloReintentable({ error: httpError(500) })).toBe(true);
    expect(esFalloReintentable({ error: httpError(503) })).toBe(true);
    expect(esFalloReintentable({ error: httpError(408) })).toBe(true);
  });

  it("NO encola por status de validación/permiso/cuenta", () => {
    for (const s of [400, 401, 402, 403, 404, 422]) {
      expect(esFalloReintentable({ error: httpError(s) })).toBe(false);
    }
  });

  it("lee http_status del body del edge", () => {
    expect(esFalloReintentable({ data: { error: "x", http_status: 429 } })).toBe(true);
    expect(esFalloReintentable({ data: { error: "prompt_too_large", http_status: 400 } })).toBe(
      false,
    );
  });

  it("sin status: clasifica por texto no reintentable", () => {
    expect(esFalloReintentable({ data: { error: "prompt_too_large" } })).toBe(false);
    expect(esFalloReintentable({ detalle: "Sin créditos de IA." })).toBe(false);
    expect(esFalloReintentable({ detalle: "No autorizado para esta acción." })).toBe(false);
    expect(esFalloReintentable({ data: { error: "course not found" } })).toBe(false);
  });

  it("sin status: clasifica por texto transitorio", () => {
    expect(esFalloReintentable({ detalle: "fetch failed" })).toBe(true);
    expect(esFalloReintentable({ error: { message: "network timeout" } })).toBe(true);
    expect(esFalloReintentable({ detalle: "rate limit exceeded" })).toBe(true);
  });

  it("sin señal reconocible: encola (regla del dueño)", () => {
    expect(esFalloReintentable({})).toBe(true);
    expect(esFalloReintentable({ error: { message: "algo raro" } })).toBe(true);
  });

  it("el status gana al texto: 400 con texto transitorio NO encola", () => {
    // Un 400 que menciona 'timeout' igual es validación → no encolar.
    expect(esFalloReintentable({ error: httpError(400), detalle: "request timeout" })).toBe(false);
  });

  it("espeja el patrón transitorio del worker", () => {
    expect(PATRON_TRANSITORIO.source).toBe(TRANSIENT_ERROR_PATTERN.source);
  });
});

describe("el tope de uso no se encola", () => {
  it("429 con rate_limited es un límite del usuario: se muestra, no se encola", () => {
    expect(esFalloReintentable({ data: { ok: false, rate_limited: true, error: "Límite de uso de IA" } })).toBe(false);
  });
});
