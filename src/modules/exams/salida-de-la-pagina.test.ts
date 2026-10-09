import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  contarSalidasDeLaPagina,
  creaStrikesDiferidos,
  cuerpoAlSalirDeLaPagina,
  eventoSumoStrike,
  isStrikeEvent,
  warningLabel,
} from "./proctoring";

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
});

describe("cuerpoAlSalirDeLaPagina", () => {
  const base = { answers: { q1: "x" }, maxWarnings: 3, ahoraIso: "2026-10-08T20:00:00.000Z", userId: "u1" };

  it("por defecto solo guarda las respuestas: no suma ni cierra", () => {
    const r = cuerpoAlSalirDeLaPagina({ ...base, warnings: 2, cuentaComoAdvertencia: false });
    expect(r.body).toEqual({ answers: { q1: "x" } });
    expect(r.warnings).toBe(2);
    expect(r.cierra).toBe(false);
  });

  it("con la opción del examen suma una advertencia", () => {
    const r = cuerpoAlSalirDeLaPagina({ ...base, warnings: 0, cuentaComoAdvertencia: true });
    expect(r.body).toEqual({ answers: { q1: "x" }, focus_warnings: 1 });
    expect(r.cierra).toBe(false);
  });

  it("y al llegar al tope cierra el intento con la marca de cierre", () => {
    const r = cuerpoAlSalirDeLaPagina({ ...base, warnings: 2, cuentaComoAdvertencia: true });
    expect(r.warnings).toBe(3);
    expect(r.cierra).toBe(true);
    expect(r.body).toMatchObject({
      focus_warnings: 3,
      status: "completado",
      close_reason: "advertencias",
      closed_by: "u1",
      closed_at: base.ahoraIso,
      submitted_at: base.ahoraIso,
    });
  });
});

describe("el evento de salida", () => {
  it("cuenta o no según su marca `suma`, que es lo que descuenta perdonarlo", () => {
    expect(isStrikeEvent("salida_de_la_pagina")).toBe(false);
    expect(eventoSumoStrike({ type: "salida_de_la_pagina", suma: false })).toBe(false);
    expect(eventoSumoStrike({ type: "salida_de_la_pagina", suma: true })).toBe(true);
    expect(warningLabel("salida_de_la_pagina")).toBe("Cerró o recargó el examen");
  });

  it("el monitor cuenta las salidas aparte de las advertencias", () => {
    expect(contarSalidasDeLaPagina(null)).toBe(0);
    expect(
      contarSalidasDeLaPagina([
        { type: "salida_de_la_pagina" },
        { type: "pestaña" },
        { type: "salida_de_la_pagina" },
      ]),
    ).toBe(2);
  });
});

describe("TakeExamScreen: cerrar o recargar solo suma si el examen lo pide", () => {
  const src = readFileSync(join(__dirname, "TakeExamScreen.tsx"), "utf8");
  const inicio = src.indexOf("const onBeforeUnload");
  const fin = src.indexOf("const onPageHide", inicio);
  const cuerpo = src.slice(inicio, fin);

  it("onBeforeUnload no arma a mano el contador ni el cierre", () => {
    expect(inicio).toBeGreaterThan(0);
    expect(fin).toBeGreaterThan(inicio);
    // Lo que se manda lo decide `cuerpoAlSalirDeLaPagina`, que tiene sus tests.
    expect(cuerpo).not.toMatch(/focus_warnings/);
    expect(cuerpo).not.toMatch(/close_reason/);
    expect(cuerpo).toMatch(/cuerpoAlSalirDeLaPagina\(/);
    expect(cuerpo).toMatch(/salida_de_la_pagina/);
  });

  it("suma solo con la opción del examen y ya dentro de pantalla completa", () => {
    expect(cuerpo).toMatch(/const suma = dentro && cierreSuma;/);
    expect(cuerpo).toMatch(/cuentaComoAdvertencia: suma/);
    expect(src).toMatch(/const cierreSuma = exam\?\.reload_counts_as_warning === true;/);
  });

  it("una recarga que pidió la plataforma no cuenta ni se anota", () => {
    expect(cuerpo).toMatch(/const dentro = hasEverEnteredFullscreenRef\.current && !esRecargaPropia\(\);/);
  });
});

describe("las recargas que hace la plataforma se marcan como propias", () => {
  const leer = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

  it("el script previo a la hidratación marca la bandera antes de cada recarga", () => {
    // No puede importar `recargarLaApp`: es un string que corre antes de React.
    const root = leer("routes/__root.tsx");
    const recargas = [...root.matchAll(/window\.location\.reload\(\);/g)];
    expect(recargas.length).toBeGreaterThan(0);
    for (const r of recargas) {
      const antes = root.slice(Math.max(0, (r.index ?? 0) - 120), r.index);
      expect(antes).toMatch(/window\.__examlabRecargaPropia = true;/);
    }
  });

  it("el router y el ErrorBoundary recargan con `recargarLaApp`", () => {
    for (const p of ["router.tsx", "shared/components/ErrorBoundary.tsx"]) {
      const src = leer(p);
      expect(src, p).toMatch(/recargarLaApp/);
      expect(src, p).not.toMatch(/window\.location\.reload\(\)/);
    }
  });
});
