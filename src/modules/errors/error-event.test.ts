import { describe, it, expect } from "vitest";
import { errorMessage, ERROR_STATUSES, type ErrStatus } from "./error-event";

describe("errorMessage", () => {
  it("devuelve null para metadata nulo / no-objeto", () => {
    expect(errorMessage(null)).toBeNull();
    expect(errorMessage(undefined)).toBeNull();
    expect(errorMessage("string suelto")).toBeNull();
    expect(errorMessage(42)).toBeNull();
    expect(errorMessage(true)).toBeNull();
  });

  it("devuelve null cuando no hay ninguna clave conocida", () => {
    expect(errorMessage({ foo: "bar", code: 500 })).toBeNull();
    expect(errorMessage({})).toBeNull();
  });

  it("extrae la clave `error`", () => {
    expect(errorMessage({ error: "boom" })).toBe("boom");
  });

  it("respeta el orden de preferencia error > reason > message > detail", () => {
    expect(errorMessage({ error: "E", reason: "R", message: "M", detail: "D" })).toBe("E");
    expect(errorMessage({ reason: "R", message: "M", detail: "D" })).toBe("R");
    expect(errorMessage({ message: "M", detail: "D" })).toBe("M");
    expect(errorMessage({ detail: "D" })).toBe("D");
  });

  it("ignora valores no-string y sigue buscando", () => {
    // error es un objeto (no string) → cae a reason.
    expect(errorMessage({ error: { nested: true }, reason: "fallback" })).toBe("fallback");
    expect(errorMessage({ error: 123, message: "ok" })).toBe("ok");
  });

  it("trata la string vacía como ausente (sigue buscando)", () => {
    expect(errorMessage({ error: "", reason: "real" })).toBe("real");
    expect(errorMessage({ error: "" })).toBeNull();
  });

  it("preserva el mensaje original sin recortar", () => {
    const long = "x".repeat(500);
    expect(errorMessage({ error: long })).toBe(long);
  });
});

describe("ERROR_STATUSES", () => {
  it("lista los 4 estados en orden de flujo", () => {
    const expected: ErrStatus[] = ["nuevo", "revisando", "resuelto", "ignorado"];
    expect(ERROR_STATUSES).toEqual(expected);
  });
});
