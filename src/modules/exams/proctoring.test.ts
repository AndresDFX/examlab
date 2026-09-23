import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  GRACIA_OCULTO_MOVIL_MS,
  TIPOS_QUE_SUMAN_STRIKE,
  MAX_WARNINGS,
  blurCuentaComoStrike,
  creaVentanasDeProctoring,
  isStrikeEvent,
  ocultarCuentaComoStrike,
  salidaDePantallaCompletaCuentaComoStrike,
  shouldMarkSuspicious,
  type WarningEvent,
  warningEventTimestamp,
  warningLabel,
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

  it("el pantallazo y el botón «atrás» SUMAN", () => {
    // `retroceso` sumaba desde siempre —la pantalla de toma incrementa el
    // contador al confirmar el diálogo— pero estaba fuera de la lista, así que
    // perdonarlo desde el monitor borraba la fila y dejaba el strike puesto.
    expect(isStrikeEvent("retroceso")).toBe(true);
    expect(isStrikeEvent("pantallazo")).toBe(true);
  });

  it("copiar y pegar NO suman: en una pregunta de código son parte de responder", () => {
    for (const t of ["copiar", "pegar", "cortar"]) expect(isStrikeEvent(t)).toBe(false);
  });

  it("la clave VIEJA del pantallazo sigue sin sumar", () => {
    // Hay 11 `screenshot_attempt` en producción que nunca sumaron. Si esta clave
    // pasara a sumar, perdonar uno de esos once DESCONTARÍA un strike que no
    // existió, y si eso baja del umbral des-suspende a un alumno.
    expect(isStrikeEvent("screenshot_attempt")).toBe(false);
  });

  // El mismo set vive en SQL (`_exam_warning_is_strike`), que es lo que usa
  // `teacher_clear_exam_warnings` para decidir si descuenta. Si divergen, el
  // monitor muestra una cosa y la base hace otra con el expediente del alumno.
  it("el set coincide con el espejo en SQL, leído de la migración", () => {
    // Se busca la ÚLTIMA migración que define la función, no un nombre fijo:
    // con el archivo escrito a mano, la migración siguiente que cambie el set
    // dejaría al test leyendo una versión vieja y pasando en verde contra ella
    // — que es justo el modo de falla que este test existe para tapar. Mismo
    // patrón que `page-types.test.ts`.
    const dir = "supabase/migrations";
    const archivo = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .reverse()
      .find((f) =>
        fs.readFileSync(path.join(dir, f), "utf8").includes(
          "FUNCTION public._exam_warning_is_strike",
        ),
      );
    expect(archivo, "ninguna migración define _exam_warning_is_strike").toBeTruthy();

    const sql = fs.readFileSync(path.join(dir, archivo!), "utf8");
    const m = sql.match(/_type IN \(([^)]*)\)/);
    expect(m, "no se encontró la lista en la migración").not.toBeNull();
    const enSql = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();

    // Contra el set REAL, no contra una copia escrita en el test: si alguien
    // agrega un tipo de un solo lado, con una copia los dos seguirían
    // coincidiendo entre sí y nadie se enteraría.
    expect(enSql).toEqual([...TIPOS_QUE_SUMAN_STRIKE].sort());
    for (const t of enSql) expect(isStrikeEvent(t), t).toBe(true);
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

describe("qué cuenta como strike en un teléfono", () => {
  const movil = { punteroGrueso: true, punteroFino: false };
  const computador = { punteroGrueso: false, punteroFino: true };
  // Un portátil con pantalla táctil: tiene los dos punteros y sigue siendo un
  // computador (el alt+tab existe).
  const portatilTactil = { punteroGrueso: true, punteroFino: true };

  it("perder la pantalla completa no suma en un teléfono, sí en un computador", () => {
    expect(salidaDePantallaCompletaCuentaComoStrike(movil)).toBe(false);
    expect(salidaDePantallaCompletaCuentaComoStrike(computador)).toBe(true);
    expect(salidaDePantallaCompletaCuentaComoStrike(portatilTactil)).toBe(true);
  });

  it("en computador, ocultarse suma siempre — sin esperar", () => {
    // Ahí ocultarse ES cambiar de pestaña; no hay burbujas del sistema de por
    // medio y el menú contextual está bloqueado.
    expect(ocultarCuentaComoStrike(computador, 0)).toBe(true);
    expect(ocultarCuentaComoStrike(portatilTactil, 10)).toBe(true);
  });

  it("en móvil, ocultarse un instante NO suma; quedarse oculto SÍ", () => {
    // Las tres primeras son las diferencias REALES medidas en producción entre
    // el `blur` de la corrección y el ocultamiento que lo acompaña.
    expect(ocultarCuentaComoStrike(movil, 0)).toBe(false);
    expect(ocultarCuentaComoStrike(movil, 1000)).toBe(false);
    expect(ocultarCuentaComoStrike(movil, 2000)).toBe(false);
    // Irse a otra aplicación de verdad deja el documento oculto mucho más.
    expect(ocultarCuentaComoStrike(movil, GRACIA_OCULTO_MOVIL_MS)).toBe(true);
    expect(ocultarCuentaComoStrike(movil, 30_000)).toBe(true);
  });

  it("la gracia es corta: no alcanza para mirar nada", () => {
    // Si alguien la sube, que sea una decisión consciente: con 10 s se puede
    // leer un mensaje entero y volver sin que quede registro de strike.
    expect(GRACIA_OCULTO_MOVIL_MS).toBeLessThanOrEqual(3000);
  });

  it("las señales blandas nuevas NO suman strike", () => {
    expect(isStrikeEvent("oculto_breve_movil")).toBe(false);
    expect(isStrikeEvent("fullscreen_exit_movil")).toBe(false);
    // Y las que sí suman siguen sumando.
    expect(isStrikeEvent("visibility_hidden")).toBe(true);
    expect(isStrikeEvent("fullscreen_exit")).toBe(true);
  });

  it("las señales blandas nuevas tienen etiqueta legible y dicen que no suman", () => {
    for (const t of ["oculto_breve_movil", "fullscreen_exit_movil"] as const) {
      const etiqueta = warningLabel(t);
      expect(etiqueta).not.toBe(t);
      expect(etiqueta).toContain("no suma");
    }
  });
});
