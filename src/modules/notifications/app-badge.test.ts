import { describe, it, expect, vi } from "vitest";
import { aplicarInsignia, decidirInsignia, soportaInsignia } from "./app-badge";

const navFalso = () => {
  const set = vi.fn().mockResolvedValue(undefined);
  const clear = vi.fn().mockResolvedValue(undefined);
  return { setAppBadge: set, clearAppBadge: clear };
};

describe("soportaInsignia", () => {
  it("es false en un navegador sin la API", () => {
    expect(soportaInsignia({})).toBe(false);
    expect(soportaInsignia(null)).toBe(false);
    expect(soportaInsignia(undefined)).toBe(false);
  });
  it("exige las DOS funciones", () => {
    // Con solo `set` no se podría limpiar, y la insignia quedaría pegada.
    expect(soportaInsignia({ setAppBadge: async () => {} })).toBe(false);
    expect(soportaInsignia(navFalso())).toBe(true);
  });
});

describe("decidirInsignia", () => {
  it("con avisos sin leer, pone el numero", () => {
    expect(decidirInsignia(3)).toEqual({ accion: "poner", valor: 3 });
  });
  it("con cero LIMPIA en vez de poner cero", () => {
    // setAppBadge(0) deja un punto en varias implementaciones.
    expect(decidirInsignia(0)).toEqual({ accion: "limpiar" });
  });
  it("un conteo negativo o basura se trata como nada pendiente", () => {
    expect(decidirInsignia(-2)).toEqual({ accion: "limpiar" });
    expect(decidirInsignia(NaN)).toEqual({ accion: "limpiar" });
    expect(decidirInsignia(Infinity)).toEqual({ accion: "limpiar" });
  });
  it("trunca un decimal en vez de pasarlo al sistema operativo", () => {
    expect(decidirInsignia(2.7)).toEqual({ accion: "poner", valor: 2 });
  });
});

describe("aplicarInsignia", () => {
  it("pone el numero cuando hay sin leer", async () => {
    const nav = navFalso();
    await aplicarInsignia(5, nav);
    expect(nav.setAppBadge).toHaveBeenCalledWith(5);
    expect(nav.clearAppBadge).not.toHaveBeenCalled();
  });

  it("limpia cuando se leyo todo", async () => {
    const nav = navFalso();
    await aplicarInsignia(0, nav);
    expect(nav.clearAppBadge).toHaveBeenCalled();
    expect(nav.setAppBadge).not.toHaveBeenCalled();
  });

  it("no explota donde la API no existe", async () => {
    await expect(aplicarInsignia(3, {})).resolves.toBeUndefined();
  });

  it("se traga el rechazo de la promesa", async () => {
    // Un rechazo sin catch sale por `unhandledrejection`, que este proyecto
    // audita — se volvería ruido en audit_logs.
    const nav = {
      setAppBadge: vi.fn().mockRejectedValue(new Error("NotAllowedError")),
      clearAppBadge: vi.fn().mockResolvedValue(undefined),
    };
    await expect(aplicarInsignia(2, nav)).resolves.toBeUndefined();
  });
});
