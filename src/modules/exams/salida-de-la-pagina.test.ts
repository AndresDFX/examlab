import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { creaStrikesDiferidos, isStrikeEvent, warningLabel } from "./proctoring";

describe("creaStrikesDiferidos", () => {
  it("cobra el strike si la página sigue viva", () => {
    vi.useFakeTimers();
    const d = creaStrikesDiferidos(700);
    const contar = vi.fn();
    d.diferir("pestaña", contar);
    vi.advanceTimersByTime(699);
    expect(contar).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(contar).toHaveBeenCalledWith("pestaña");
    vi.useRealTimers();
  });

  it("un gesto con varios eventos cobra UNO solo", () => {
    vi.useFakeTimers();
    const d = creaStrikesDiferidos(700);
    const contar = vi.fn();
    d.diferir("pestaña", contar);
    d.diferir("visibility_hidden", contar);
    d.diferir("fullscreen_exit", contar);
    vi.advanceTimersByTime(1000);
    expect(contar).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("cerrar o recargar cancela lo pendiente y descarta lo que llegue después", () => {
    vi.useFakeTimers();
    const d = creaStrikesDiferidos(700);
    const contar = vi.fn();
    d.diferir("pestaña", contar);
    d.marcarSalida();
    d.diferir("visibility_hidden", contar);
    vi.advanceTimersByTime(5000);
    expect(contar).not.toHaveBeenCalled();
    d.marcarRegreso();
    d.diferir("pestaña", contar);
    vi.advanceTimersByTime(700);
    expect(contar).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("salir de la página es señal blanda", () => {
    expect(isStrikeEvent("salida_de_la_pagina")).toBe(false);
    expect(warningLabel("salida_de_la_pagina")).toMatch(/no suma/);
  });
});

describe("TakeExamScreen: cerrar o recargar no suma advertencia", () => {
  const src = readFileSync(join(__dirname, "TakeExamScreen.tsx"), "utf8");
  const inicio = src.indexOf("const onBeforeUnload");
  const fin = src.indexOf("const onPageHide", inicio);
  const cuerpo = src.slice(inicio, fin);

  it("onBeforeUnload no escribe focus_warnings ni cierra el intento", () => {
    expect(inicio).toBeGreaterThan(0);
    expect(fin).toBeGreaterThan(inicio);
    expect(cuerpo).not.toMatch(/focus_warnings/);
    expect(cuerpo).not.toMatch(/close_reason/);
    expect(cuerpo).not.toMatch(/status/);
    expect(cuerpo).toMatch(/salida_de_la_pagina/);
  });
});
