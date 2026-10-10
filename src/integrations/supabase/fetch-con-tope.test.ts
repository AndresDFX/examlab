import { afterEach, describe, expect, it, vi } from "vitest";
import { MS_TOPE_AUTH, crearFetchConTope, topeParaUrl } from "./fetch-con-tope";

afterEach(() => vi.useRealTimers());

const colgado: typeof fetch = (_i, init) =>
  new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));

describe("fetch con tope", () => {
  it("solo auth y rest llevan tope", () => {
    expect(topeParaUrl("https://x.supabase.co/auth/v1/token")).toBe(MS_TOPE_AUTH);
    expect(topeParaUrl("https://x.supabase.co/rest/v1/profiles")).not.toBeNull();
    expect(topeParaUrl("https://x.supabase.co/functions/v1/ai")).toBeNull();
    expect(topeParaUrl("https://x.supabase.co/storage/v1/object")).toBeNull();
  });

  it("aborta una renovación colgada al vencer el tope", async () => {
    vi.useFakeTimers();
    const p = crearFetchConTope(colgado)("https://x.supabase.co/auth/v1/token", {});
    const r = expect(p).rejects.toThrow(/Tiempo de espera/);
    await vi.advanceTimersByTimeAsync(MS_TOPE_AUTH);
    await r;
  });

  it("respeta la señal de quien llama", async () => {
    const c = new AbortController();
    const p = crearFetchConTope(colgado)("https://x.supabase.co/rest/v1/t", { signal: c.signal });
    c.abort(new Error("cancelado"));
    await expect(p).rejects.toThrow("cancelado");
  });

  it("no toca las funciones", async () => {
    const base = vi.fn(async () => new Response("ok"));
    await crearFetchConTope(base)("https://x.supabase.co/functions/v1/f", { method: "POST" });
    expect(base).toHaveBeenCalledWith("https://x.supabase.co/functions/v1/f", { method: "POST" });
  });
});
