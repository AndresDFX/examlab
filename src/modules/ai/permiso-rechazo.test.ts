import { describe, expect, it } from "vitest";

import { esRechazoDePermisos } from "./ai-grading";

/**
 * Este predicado decide si una calificación que el worker rechazó se puede
 * reintentar por el edge directo. Equivocarse tiene costo en las dos
 * direcciones: un falso negativo deja la entrega del alumno esperando al cron
 * (el bug que originó el arreglo), y un falso positivo gasta una llamada de IA
 * para chocar con el mismo error.
 */
describe("esRechazoDePermisos", () => {
  it("reconoce el 401 por el status del error de invoke", () => {
    // La forma real de un FunctionsHttpError: el status NO viene en el mensaje.
    expect(esRechazoDePermisos({ context: { status: 401 } }, null)).toBe(true);
    expect(esRechazoDePermisos({ context: { status: 403 } }, null)).toBe(true);
  });

  it("reconoce el mensaje exacto que devuelve el worker", () => {
    // Copiado literal de ai-grading-worker: si ese texto cambia, este test es
    // el que avisa.
    expect(
      esRechazoDePermisos(null, { ok: false, error: "No autorizado para procesar la cola IA" }),
    ).toBe(true);
  });

  it("reconoce el rechazo cuando solo llega el detalle ya extraído", () => {
    expect(esRechazoDePermisos(null, null, "No autorizado para procesar la cola IA")).toBe(true);
    expect(esRechazoDePermisos(null, null, "HTTP 401: Unauthorized")).toBe(true);
  });

  it("un fallo del PROVEEDOR no es un rechazo de permisos", () => {
    // El caso que más importa no confundir: sin cuota hay que dejar el trabajo
    // en la cola, no reintentar por otra puerta y gastar otra llamada.
    expect(esRechazoDePermisos({ context: { status: 429 } }, null, "HTTP 429 quota exceeded")).toBe(
      false,
    );
    expect(esRechazoDePermisos({ context: { status: 500 } }, null, "internal server error")).toBe(
      false,
    );
    expect(esRechazoDePermisos(null, { error: "workshop_full batch failed" })).toBe(false);
  });

  it("no explota con entradas vacías o de forma inesperada", () => {
    for (const [e, d] of [
      [null, null],
      [undefined, undefined],
      [{}, {}],
      ["texto suelto", 42],
      [{ context: {} }, { error: 7 }],
    ] as Array<[unknown, unknown]>) {
      expect(typeof esRechazoDePermisos(e, d)).toBe("boolean");
    }
  });
});
