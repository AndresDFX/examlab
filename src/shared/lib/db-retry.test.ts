import { describe, expect, it, vi } from "vitest";
import { isTransientDbError, withDbRetry } from "./db-retry";

describe("isTransientDbError", () => {
  it("reconoce 57014 (statement_timeout) — el caso real reportado", () => {
    expect(
      isTransientDbError({
        code: "57014",
        message: "canceling statement due to statement timeout",
      }),
    ).toBe(true);
  });

  it("reconoce contención transitoria: serialization_failure, deadlock, lock_not_available", () => {
    expect(isTransientDbError({ code: "40001" })).toBe(true);
    expect(isTransientDbError({ code: "40P01" })).toBe(true);
    expect(isTransientDbError({ code: "55P03" })).toBe(true);
  });

  it("reconoce fallos de red por mensaje (sin SQLSTATE — no llegaron a Postgres)", () => {
    expect(isTransientDbError({ message: "Failed to fetch" })).toBe(true);
    expect(isTransientDbError({ message: "NetworkError when attempting to fetch resource" })).toBe(
      true,
    );
    expect(isTransientDbError({ message: "the operation timed out" })).toBe(true);
  });

  it("NO reintenta errores de validación/permisos reales", () => {
    expect(isTransientDbError({ code: "23503" })).toBe(false); // foreign_key_violation
    expect(isTransientDbError({ code: "23502" })).toBe(false); // not_null_violation
    expect(isTransientDbError({ code: "23514" })).toBe(false); // check_violation
    expect(isTransientDbError({ code: "42501" })).toBe(false); // insufficient_privilege
    expect(isTransientDbError({ code: "P0001", message: "No tienes permiso" })).toBe(false);
  });

  it("null/undefined no es transitorio", () => {
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError(undefined)).toBe(false);
  });
});

describe("withDbRetry", () => {
  it("devuelve el resultado directo cuando no hay error (sin reintentos de más)", async () => {
    const fn = vi.fn().mockResolvedValue({ data: "ok", error: null });
    const result = await withDbRetry(fn, { delaysMs: [1, 1] });
    expect(result).toEqual({ data: "ok", error: null });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reintenta un 57014 transitorio y se recupera en el segundo intento", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "57014", message: "query_canceled" } })
      .mockResolvedValueOnce({ data: "ok", error: null });
    const result = await withDbRetry(fn, { delaysMs: [1, 1] });
    expect(result).toEqual({ data: "ok", error: null });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("agota los reintentos y devuelve el último error si la contención sigue", async () => {
    const fn = vi.fn().mockResolvedValue({ data: null, error: { code: "57014" } });
    const result = await withDbRetry(fn, { delaysMs: [1, 1] });
    expect(result.error?.code).toBe("57014");
    // Intento inicial + 2 reintentos = 3.
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("NO reintenta un error no transitorio — falla rápido en el primer intento", async () => {
    const fn = vi.fn().mockResolvedValue({ data: null, error: { code: "23502" } });
    const result = await withDbRetry(fn, { delaysMs: [1, 1] });
    expect(result.error?.code).toBe("23502");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("no reintenta si el signal ya está abortado (batch detenido por el docente)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fn = vi.fn().mockResolvedValue({ data: null, error: { code: "57014" } });
    const result = await withDbRetry(fn, { delaysMs: [1, 1], signal: ctrl.signal });
    expect(result.error?.code).toBe("57014");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("corta el backoff en curso si el signal se aborta mientras espera", async () => {
    const ctrl = new AbortController();
    const fn = vi.fn().mockResolvedValue({ data: null, error: { code: "57014" } });
    const start = Date.now();
    const promise = withDbRetry(fn, { delaysMs: [200, 200], signal: ctrl.signal });
    // Deja pasar un tick real (bien por debajo de los 200ms del backoff)
    // para que el primer fn() ya haya resuelto y el código esté DENTRO del
    // sleep(200ms) antes de abortar — así se ejercita el listener de abort
    // de `sleep()`, no el guard previo de "ya estaba abortado".
    await new Promise((r) => setTimeout(r, 10));
    ctrl.abort();
    await promise;
    // El sleep interrumpido corta cerca de los 10ms, no espera los 200ms
    // completos del backoff.
    expect(Date.now() - start).toBeLessThan(150);
  });
});
