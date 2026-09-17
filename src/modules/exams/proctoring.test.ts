import { describe, expect, it } from "vitest";

import {
  MAX_WARNINGS,
  blurCuentaComoStrike,
  creaVentanasDeProctoring,
  isStrikeEvent,
  shouldMarkSuspicious,
  warningEventTimestamp,
  warningLabel,
  type WarningEvent,
} from "./proctoring";

describe("shouldMarkSuspicious", () => {
  it("is false while warnings are under the threshold", () => {
    expect(shouldMarkSuspicious(0)).toBe(false);
    expect(shouldMarkSuspicious(1)).toBe(false);
    expect(shouldMarkSuspicious(2)).toBe(false);
  });

  it("flips to true when warnings reach the configured max", () => {
    expect(shouldMarkSuspicious(MAX_WARNINGS)).toBe(true);
    expect(shouldMarkSuspicious(MAX_WARNINGS + 1)).toBe(true);
  });

  it("accepts a custom threshold", () => {
    expect(shouldMarkSuspicious(4, 5)).toBe(false);
    expect(shouldMarkSuspicious(5, 5)).toBe(true);
  });

  it("treats the default MAX_WARNINGS as 3", () => {
    expect(MAX_WARNINGS).toBe(3);
  });
});

describe("warningLabel", () => {
  it("maps Spanish take-flow keys to Spanish labels", () => {
    expect(warningLabel("pestaña")).toBe("Salida de pestaña/ventana");
    expect(warningLabel("copiar")).toBe("Intento de copiar");
    expect(warningLabel("pegar")).toBe("Intento de pegar");
    expect(warningLabel("cortar")).toBe("Intento de cortar");
    expect(warningLabel("menu")).toBe("Menú contextual");
  });

  it("maps legacy English monitor keys to the same Spanish labels", () => {
    expect(warningLabel("blur")).toBe("Salida de pestaña/ventana");
    expect(warningLabel("copy")).toBe("Intento de copiar");
    expect(warningLabel("paste")).toBe("Intento de pegar");
    expect(warningLabel("context_menu")).toBe("Menú contextual");
  });

  it("covers visibility and fullscreen events", () => {
    expect(warningLabel("visibility_hidden")).toBe("Pestaña oculta");
    expect(warningLabel("fullscreen_exit")).toBe("Salida de pantalla completa");
  });

  it("falls back to the raw type for unknown keys", () => {
    expect(warningLabel("some_future_type")).toBe("some_future_type");
  });
});

describe("warningEventTimestamp", () => {
  it("reads numeric ts (ms)", () => {
    const ev: WarningEvent = { type: "blur", ts: 1_700_000_000_000 };
    expect(warningEventTimestamp(ev)).toBe(1_700_000_000_000);
  });

  it("reads numeric at (ms)", () => {
    const ev: WarningEvent = { type: "blur", at: 1_700_000_000_000 };
    expect(warningEventTimestamp(ev)).toBe(1_700_000_000_000);
  });

  it("parses ISO at strings", () => {
    const iso = "2026-04-20T12:34:56.000Z";
    const ev: WarningEvent = { type: "pestaña", at: iso };
    expect(warningEventTimestamp(ev)).toBe(Date.parse(iso));
  });

  it("returns null for invalid / missing timestamps", () => {
    expect(warningEventTimestamp({ type: "blur" })).toBeNull();
    expect(warningEventTimestamp({ type: "blur", at: "not-a-date" })).toBeNull();
  });
});

describe("proctoring flow simulation", () => {
  /**
   * Mirrors how the take-flow increments warnings on window blur / visibility
   * events and flips the submission into "sospechoso" once the threshold is
   * reached. The utilities are pure, so we reproduce the loop without needing
   * a full React render.
   */
  it("increments the counter and flips to suspicious at MAX_WARNINGS", () => {
    const events: WarningEvent[] = [
      { type: "pestaña", at: new Date().toISOString() },
      { type: "copiar", at: new Date().toISOString() },
      { type: "pestaña", at: new Date().toISOString() },
    ];

    let warnings = 0;
    let suspicious = false;
    for (const ev of events) {
      warnings += 1;
      expect(warningLabel(ev.type)).toBeTruthy();
      if (shouldMarkSuspicious(warnings)) suspicious = true;
    }

    expect(warnings).toBe(3);
    expect(suspicious).toBe(true);
  });

  it("stays within bounds for 2 warnings (autosave but not suspended)", () => {
    const warnings = 2;
    expect(shouldMarkSuspicious(warnings)).toBe(false);
  });
});

describe("blurCuentaComoStrike", () => {
  it("en un teléfono o tableta, el blur suelto NO suma strike", () => {
    // Es lo que produce la burbuja del corrector ortográfico al tocar una
    // palabra subrayada: corregir una palabra no puede costar un strike.
    expect(blurCuentaComoStrike({ punteroGrueso: true, punteroFino: false })).toBe(false);
  });

  it("en un computador SÍ suma: ahí el blur es la única señal del alt+tab", () => {
    expect(blurCuentaComoStrike({ punteroGrueso: false, punteroFino: true })).toBe(true);
  });

  it("un portátil con pantalla táctil sigue contando como computador", () => {
    // Tiene los dos punteros y el alt+tab sigue siendo posible.
    expect(blurCuentaComoStrike({ punteroGrueso: true, punteroFino: true })).toBe(true);
  });

  it("sin información de puntero, falla del lado seguro (cuenta)", () => {
    expect(blurCuentaComoStrike({ punteroGrueso: false, punteroFino: false })).toBe(true);
  });

  it("salir de la app en móvil SIGUE sumando por la otra vía", () => {
    // `visibility_hidden` es lo que dispara cambiar de app en un teléfono, y
    // se mantiene en el set de tipos que suman: el proctoring no se debilita.
    expect(isStrikeEvent("visibility_hidden")).toBe(true);
    expect(isStrikeEvent("fullscreen_exit")).toBe(true);
  });
});

describe("creaVentanasDeProctoring", () => {
  it("una señal blanda NO puede tragarse el strike que viene detrás", () => {
    // La secuencia real de un cambio de app en un teléfono: primero `blur`
    // (blanda, por el arreglo del corrector) y enseguida `visibilitychange`
    // (strike). Con una sola ventana compartida, el strike se perdía.
    const v = creaVentanasDeProctoring(500);
    expect(v.permiteBlanda(1000)).toBe(true);
    expect(v.permiteStrike(1050)).toBe(true);
  });

  it("y un strike tampoco silencia la señal blanda", () => {
    const v = creaVentanasDeProctoring(500);
    expect(v.permiteStrike(1000)).toBe(true);
    expect(v.permiteBlanda(1050)).toBe(true);
  });

  it("cada clase sí se deduplica contra sí misma", () => {
    const v = creaVentanasDeProctoring(500);
    expect(v.permiteStrike(1000)).toBe(true);
    expect(v.permiteStrike(1200)).toBe(false);
    expect(v.permiteStrike(1600)).toBe(true);
    expect(v.permiteBlanda(1000)).toBe(true);
    expect(v.permiteBlanda(1200)).toBe(false);
  });
});
