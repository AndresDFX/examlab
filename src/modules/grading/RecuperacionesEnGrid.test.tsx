import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRecuperacionesDesplegadas } from "./RecuperacionesEnGrid";

const CLAVE = "examlab_recuperaciones_abiertas:test";
const NINGUNA = new Set<string>();

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("useRecuperacionesDesplegadas", () => {
  it("sin tocar, solo está abierta la fila que viene por defecto", () => {
    const { result } = renderHook(() => useRecuperacionesDesplegadas(CLAVE, new Set(["p1"])));
    expect(result.current.estaDesplegada("p1")).toBe(true);
    expect(result.current.estaDesplegada("p2")).toBe(false);
  });

  it("alternar cambia la fila y lo guarda en el mismo cambio", () => {
    const { result } = renderHook(() => useRecuperacionesDesplegadas(CLAVE, NINGUNA));
    act(() => result.current.alternar("p2"));
    expect(result.current.estaDesplegada("p2")).toBe(true);
    expect(JSON.parse(sessionStorage.getItem(CLAVE) ?? "{}")).toEqual({ p2: true });
    act(() => result.current.alternar("p2"));
    expect(result.current.estaDesplegada("p2")).toBe(false);
  });

  it("cerrar a mano una fila abierta por defecto se respeta", () => {
    const { result } = renderHook(() => useRecuperacionesDesplegadas(CLAVE, new Set(["p1"])));
    act(() => result.current.alternar("p1"));
    expect(result.current.estaDesplegada("p1")).toBe(false);
  });

  it("al volver a la pantalla recuerda lo abierto (la creación deja abierto el original)", () => {
    const primera = renderHook(() => useRecuperacionesDesplegadas(CLAVE, NINGUNA));
    act(() => primera.result.current.abrir("p3"));
    primera.unmount();
    const segunda = renderHook(() => useRecuperacionesDesplegadas(CLAVE, NINGUNA));
    expect(segunda.result.current.estaDesplegada("p3")).toBe(true);
  });

  it("sin storage (navegación privada) funciona igual, solo que no recuerda", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const { result } = renderHook(() => useRecuperacionesDesplegadas(CLAVE, NINGUNA));
    act(() => result.current.abrir("p4"));
    expect(result.current.estaDesplegada("p4")).toBe(true);
  });

  it("ignora lo guardado que no es un booleano", () => {
    sessionStorage.setItem(CLAVE, JSON.stringify({ p5: true, p6: "sí", p7: 1 }));
    const { result } = renderHook(() => useRecuperacionesDesplegadas(CLAVE, NINGUNA));
    expect(result.current.estaDesplegada("p5")).toBe(true);
    expect(result.current.estaDesplegada("p6")).toBe(false);
    expect(result.current.estaDesplegada("p7")).toBe(false);
  });
});
