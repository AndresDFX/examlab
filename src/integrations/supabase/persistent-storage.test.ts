import { beforeEach, describe, expect, it, vi } from "vitest";

const idb = vi.hoisted(() => ({
  modo: "ok" as "ok" | "colgado" | "falla",
  datos: new Map<string, string>(),
}));
vi.mock("idb-keyval", () => {
  const op = <T>(f: () => T) =>
    idb.modo === "colgado"
      ? new Promise<T>(() => {})
      : idb.modo === "falla"
        ? Promise.reject(new Error("idb"))
        : Promise.resolve(f());
  return {
    createStore: () => ({}),
    get: (k: string) => op(() => idb.datos.get(k)),
    set: (k: string, v: string) => op(() => void idb.datos.set(k, v)),
    del: (k: string) => op(() => void idb.datos.delete(k)),
  };
});

import {
  MS_TOPE_INDEXEDDB,
  _reiniciarEstadoIndexedDb,
  persistentAuthStorage as s,
} from "./persistent-storage";

beforeEach(() => {
  idb.modo = "ok";
  idb.datos.clear();
  localStorage.clear();
  _reiniciarEstadoIndexedDb();
  vi.useRealTimers();
});

describe("almacenamiento de la sesión", () => {
  it("escribe en los dos y lee lo de localStorage", async () => {
    await s.setItem("k", "v1");
    expect(localStorage.getItem("k")).toBe("v1");
    expect(idb.datos.get("k")).toBe("v1");
    expect(await s.getItem("k")).toBe("v1");
  });

  it("con localStorage desalojado, recupera de IndexedDB y repara la copia", async () => {
    idb.datos.set("k", "v1");
    expect(await s.getItem("k")).toBe("v1");
    expect(localStorage.getItem("k")).toBe("v1");
  });

  it("IndexedDB colgado: nada espera más que el tope y la sesión sigue en localStorage", async () => {
    vi.useFakeTimers();
    idb.modo = "colgado";
    const escritura = s.setItem("k", "v1");
    await vi.advanceTimersByTimeAsync(MS_TOPE_INDEXEDDB);
    await escritura;
    expect(await s.getItem("k")).toBe("v1");
    // Ya marcado como colgado: las lecturas siguientes no esperan.
    localStorage.clear();
    expect(await s.getItem("k")).toBeNull();
  });

  it("IndexedDB que falla no rompe la lectura", async () => {
    idb.modo = "falla";
    expect(await s.getItem("k")).toBeNull();
  });

  it("cerrar sesión con IndexedDB colgado no resucita la sesión", async () => {
    await s.setItem("k", "v1");
    vi.useFakeTimers();
    idb.modo = "colgado";
    const borrado = s.removeItem("k");
    await vi.advanceTimersByTimeAsync(MS_TOPE_INDEXEDDB);
    await borrado;
    idb.modo = "ok";
    _reiniciarEstadoIndexedDb();
    expect(idb.datos.get("k")).toBe("v1");
    expect(await s.getItem("k")).toBeNull();
  });

  it("volver a entrar quita la marca de borrado", async () => {
    await s.removeItem("k");
    await s.setItem("k", "v2");
    localStorage.removeItem("k");
    expect(await s.getItem("k")).toBe("v2");
  });
});
