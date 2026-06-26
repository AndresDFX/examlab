/**
 * Tests de la lógica PURA de failover de API keys (ai-failover.ts).
 * Inyectamos un `fetchWithKey` mockeado y un `sleep` no-op para verificar la
 * política de rotación sin red ni Deno.
 */
import { describe, expect, it, vi } from "vitest";
import {
  dedupeNonEmpty,
  runKeyFailover,
  ROTATABLE_STATUS,
  TRANSIENT_STATUS,
  type FailoverResponse,
} from "./ai-failover";

const noopSleep = () => Promise.resolve();

/** Crea un FailoverResponse-like a partir de un status. */
function resp(status: number, retryAfter?: string): FailoverResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
  };
}

/** fetchWithKey que devuelve un status fijo por índice de key. */
function sequenceFetcher(statusByIndex: number[]) {
  const calls: number[] = [];
  const fn = (_key: string, index: number) => {
    calls.push(index);
    return Promise.resolve(resp(statusByIndex[index]));
  };
  return { fn, calls };
}

describe("dedupeNonEmpty", () => {
  it("descarta vacíos, espacios y null/undefined", () => {
    expect(dedupeNonEmpty(["a", "", "  ", null, undefined, "b"])).toEqual(["a", "b"]);
  });
  it("deduplica preservando el orden (trim incluido)", () => {
    expect(dedupeNonEmpty(["a", " a ", "b", "a", "c"])).toEqual(["a", "b", "c"]);
  });
  it("lista vacía → []", () => {
    expect(dedupeNonEmpty([])).toEqual([]);
    expect(dedupeNonEmpty([null, "", "   "])).toEqual([]);
  });
});

describe("predicados de status", () => {
  it("ROTATABLE incluye 401/402/403/429/5xx; NO 400", () => {
    for (const s of [401, 402, 403, 429, 500, 502, 503, 504]) expect(ROTATABLE_STATUS.has(s)).toBe(true);
    expect(ROTATABLE_STATUS.has(400)).toBe(false);
    expect(ROTATABLE_STATUS.has(200)).toBe(false);
  });
  it("TRANSIENT (backoff última key) = 429/502/503/504", () => {
    for (const s of [429, 502, 503, 504]) expect(TRANSIENT_STATUS.has(s)).toBe(true);
    expect(TRANSIENT_STATUS.has(401)).toBe(false);
    expect(TRANSIENT_STATUS.has(402)).toBe(false);
  });
});

describe("runKeyFailover", () => {
  it("lista vacía → lanza", async () => {
    await expect(runKeyFailover([], { fetchWithKey: () => Promise.resolve(resp(200)), sleep: noopSleep })).rejects.toThrow();
  });

  it("una key OK → la devuelve sin reintentos", async () => {
    const { fn, calls } = sequenceFetcher([200]);
    const r = await runKeyFailover(["k1"], { fetchWithKey: fn, sleep: noopSleep });
    expect(r.status).toBe(200);
    expect(calls).toEqual([0]); // 1 sola llamada
  });

  it("principal 429, secundaria OK → rota y devuelve la secundaria (sin reintentar la principal)", async () => {
    const { fn, calls } = sequenceFetcher([429, 200]);
    const r = await runKeyFailover(["k1", "k2"], { fetchWithKey: fn, sleep: noopSleep });
    expect(r.status).toBe(200);
    expect(calls).toEqual([0, 1]); // k1 una vez (rota directo), luego k2
  });

  it("principal 401 (key inválida), secundaria OK → rota", async () => {
    const { fn } = sequenceFetcher([401, 200]);
    const r = await runKeyFailover(["bad", "good"], { fetchWithKey: fn, sleep: noopSleep });
    expect(r.status).toBe(200);
  });

  it("principal 402 (sin créditos), secundaria OK → rota (otra cuenta puede tener créditos)", async () => {
    const { fn } = sequenceFetcher([402, 200]);
    const r = await runKeyFailover(["k1", "k2"], { fetchWithKey: fn, sleep: noopSleep });
    expect(r.status).toBe(200);
  });

  it("status 400 NO rota: devuelve inmediato aunque haya más keys", async () => {
    const { fn, calls } = sequenceFetcher([400, 200]);
    const r = await runKeyFailover(["k1", "k2"], { fetchWithKey: fn, sleep: noopSleep });
    expect(r.status).toBe(400);
    expect(calls).toEqual([0]); // no tocó k2
  });

  it("todas las keys 429 → devuelve la última respuesta (tras backoff en la última)", async () => {
    // 3 keys, todas 429. k1 y k2 rotan; k3 (última) hace backoff y sigue 429.
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve(resp(429));
    };
    const sleep = vi.fn(() => Promise.resolve());
    const r = await runKeyFailover(["k1", "k2", "k3"], { fetchWithKey: fn, sleep });
    expect(r.status).toBe(429);
    // k1 (1) + k2 (1) + k3 con backoff (MAX_RETRIES_LAST_KEY=3 → 3 intentos) = 5
    expect(calls).toBe(5);
    expect(sleep).toHaveBeenCalledTimes(2); // 2 esperas entre los 3 intentos de k3
  });

  it("respeta Retry-After (capeado a 8s) en el backoff de la última key", async () => {
    let calls = 0;
    const fn = () => {
      calls++;
      return Promise.resolve(resp(429, "100")); // 100s → capea a 8000ms
    };
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    await runKeyFailover(["only"], { fetchWithKey: fn, sleep });
    expect(waits.every((w) => w === 8000)).toBe(true);
  });

  it("error de red en principal → rota; OK en secundaria", async () => {
    const fn = (_k: string, i: number) =>
      i === 0 ? Promise.reject(new Error("ECONNRESET")) : Promise.resolve(resp(200));
    const r = await runKeyFailover(["k1", "k2"], { fetchWithKey: fn, sleep: noopSleep });
    expect(r.status).toBe(200);
  });

  it("error de red en la ÚLTIMA key → propaga", async () => {
    const fn = () => Promise.reject(new Error("boom"));
    await expect(runKeyFailover(["only"], { fetchWithKey: fn, sleep: noopSleep })).rejects.toThrow("boom");
  });

  it("onEvent reporta rotación y resolución", async () => {
    const events: string[] = [];
    const { fn } = sequenceFetcher([429, 200]);
    await runKeyFailover(["k1", "k2"], {
      fetchWithKey: fn,
      sleep: noopSleep,
      onEvent: (e) => events.push(`${e.kind}#${e.index}`),
    });
    expect(events).toEqual(["rotate#0", "resolved#1"]);
  });
});
