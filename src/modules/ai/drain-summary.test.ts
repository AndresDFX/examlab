import { describe, expect, it } from "vitest";

import {
  RESUMEN_VACIO,
  acumularPasada,
  decidirCorte,
  mensajeDeDrenaje,
} from "./drain-summary";

describe("acumularPasada", () => {
  it("suma los pendientes de las DOS colas (el bug: solo miraba calificación)", () => {
    // El worker de generación tenía 3 en espera y el de calificación ninguno.
    // Con la aritmética anterior (`g?.remainingPending ?? 0`) esto daba 0, el
    // bucle cortaba en la primera pasada y el toast decía "no quedan tareas".
    const r = acumularPasada(RESUMEN_VACIO, {
      calificacion: { processed: 0, remainingPending: 0 },
      generacion: { processed: 0, remainingPending: 3 },
    });
    expect(r.pendientes).toBe(3);
  });

  it("`pendientes` es una foto de la última pasada, no una suma", () => {
    let r = acumularPasada(RESUMEN_VACIO, {
      calificacion: { processed: 1, remainingPending: 3 },
      generacion: null,
    });
    expect(r.pendientes).toBe(3);
    r = acumularPasada(r, {
      calificacion: { processed: 2, remainingPending: 1 },
      generacion: null,
    });
    expect(r.pendientes).toBe(1);
    // procesadas / fallidas SÍ acumulan.
    expect(r.procesadas).toBe(3);
  });

  it("acumula procesadas y fallidas de ambas colas", () => {
    const r = acumularPasada(RESUMEN_VACIO, {
      calificacion: { processed: 2, failed: 1, remainingPending: 0 },
      generacion: { processed: 3, failed: 2, remainingPending: 0 },
    });
    expect(r.procesadas).toBe(5);
    expect(r.fallidas).toBe(3);
  });

  it("un worker viejo sin remainingPending cuenta 0 (no inventa pendientes)", () => {
    const r = acumularPasada(RESUMEN_VACIO, {
      calificacion: { processed: 1 },
      generacion: { processed: 1 },
    });
    expect(r.pendientes).toBe(0);
    // …y queda MARCADO que ese 0 no es una medición, para no anunciarlo como
    // «no quedan tareas».
    expect(r.pendientesConocidas).toBe(false);
    expect(
      decidirCorte(r, { intento: 0, maxIntentos: 3, pendientesPrevios: Infinity }),
    ).toBe("listo");
  });

  it("si CUALQUIER worker reporta pendientes, el dato cuenta como conocido", () => {
    const soloGen = acumularPasada(RESUMEN_VACIO, {
      calificacion: { processed: 1 },
      generacion: { processed: 0, remainingPending: 4 },
    });
    expect(soloGen.pendientesConocidas).toBe(true);
    expect(soloGen.pendientes).toBe(4);
  });

  it("propaga diferidas, diferidasIncluidas y el flag ignorado", () => {
    const r = acumularPasada(RESUMEN_VACIO, {
      calificacion: null,
      generacion: {
        processed: 0,
        remainingPending: 3,
        deferred: 3,
        deferredIncluded: 0,
        includeDeferredIgnored: true,
      },
    });
    expect(r.diferidas).toBe(3);
    expect(r.diferidasIncluidas).toBe(0);
    expect(r.flagIgnorado).toBe(true);
  });
});

describe("decidirCorte", () => {
  const base = { ...RESUMEN_VACIO };
  it("sin pendientes ⇒ listo", () => {
    expect(
      decidirCorte({ ...base, pendientes: 0 }, {
        intento: 0,
        maxIntentos: 3,
        pendientesPrevios: 5,
      }),
    ).toBe("listo");
  });
  it("los pendientes no bajaron ⇒ sin-progreso", () => {
    expect(
      decidirCorte({ ...base, pendientes: 5 }, {
        intento: 1,
        maxIntentos: 3,
        pendientesPrevios: 5,
      }),
    ).toBe("sin-progreso");
  });
  it("se agotaron los reintentos ⇒ reintentos-agotados", () => {
    expect(
      decidirCorte({ ...base, pendientes: 2 }, {
        intento: 3,
        maxIntentos: 3,
        pendientesPrevios: 9,
      }),
    ).toBe("reintentos-agotados");
  });
  it("bajaron y quedan reintentos ⇒ continuar", () => {
    expect(
      decidirCorte({ ...base, pendientes: 2 }, {
        intento: 0,
        maxIntentos: 3,
        pendientesPrevios: 9,
      }),
    ).toBe("continuar");
  });
});

describe("mensajeDeDrenaje", () => {
  it("cola vacía ⇒ 'no había tareas', en tono informativo (no un éxito)", () => {
    // «Vacía» significa que un worker REPORTÓ 0, no que no haya dato: sin dato
    // el caso es el de abajo. `RESUMEN_VACIO` solo no alcanza para afirmarlo.
    const m = mensajeDeDrenaje({ ...RESUMEN_VACIO, pendientesConocidas: true }, "listo");
    expect(m.clave).toBe("drainNothingToDo");
    expect(m.tono).toBe("info");
  });

  it("sin dato de pendientes NO se afirma que la cola estaba vacía", () => {
    // Ventana de despliegue: el panel ya está vivo y el worker viejo no
    // devuelve `remainingPending`. Contarlo como 0 decía «No había tareas en
    // espera» con la cola llena — la misma frase falsa que el módulo elimina.
    const m = mensajeDeDrenaje({ ...RESUMEN_VACIO, pendientesConocidas: false }, "listo");
    expect(m.clave).toBe("drainPendingUnknown");
    expect(m.tono).toBe("warning");
  });

  it("nada procesado y lo que queda es diferido ⇒ aviso que explica por qué", () => {
    const m = mensajeDeDrenaje(
      { ...RESUMEN_VACIO, pendientes: 3, diferidas: 3 },
      "sin-progreso",
    );
    expect(m.clave).toBe("drainDeferredOnly");
    expect(m.tono).toBe("warning");
    expect(m.valores.diferidas).toBe(3);
  });

  it("procesó diferidas a pedido ⇒ éxito que lo dice", () => {
    const m = mensajeDeDrenaje(
      { ...RESUMEN_VACIO, procesadas: 3, diferidasIncluidas: 3 },
      "listo",
    );
    expect(m.clave).toBe("drainDoneWithDeferred");
    expect(m.tono).toBe("success");
    expect(m.valores.diferidas).toBe(3);
  });

  it("procesó todo sin diferidas ⇒ drainDone", () => {
    const m = mensajeDeDrenaje({ ...RESUMEN_VACIO, procesadas: 4 }, "listo");
    expect(m.clave).toBe("drainDone");
    expect(m.tono).toBe("success");
  });

  it("quedan pendientes tras los reintentos ⇒ drainExhausted", () => {
    const m = mensajeDeDrenaje(
      { ...RESUMEN_VACIO, procesadas: 2, pendientes: 4 },
      "reintentos-agotados",
    );
    expect(m.clave).toBe("drainExhausted");
    expect(m.tono).toBe("warning");
  });

  it("NINGÚN resultado con procesadas === 0 sale en tono de éxito", () => {
    const motivos = ["listo", "sin-progreso", "reintentos-agotados"] as const;
    for (const motivo of motivos) {
      for (const pendientes of [0, 3]) {
        for (const diferidas of [0, 3]) {
          const m = mensajeDeDrenaje(
            { ...RESUMEN_VACIO, procesadas: 0, pendientes, diferidas },
            motivo,
          );
          expect(m.tono).not.toBe("success");
        }
      }
    }
  });
});
