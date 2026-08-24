import { describe, expect, it } from "vitest";
import { proctoringGateFrom, proctoringModeFrom } from "./fullscreen";

/**
 * El bug que originó el helper: en iPhone NO existe pantalla completa para
 * elementos (medido: ni `requestFullscreen` ni `webkitRequestFullscreen`), así
 * que la pantalla de toma bloqueaba el examen. El mensaje le pedía al alumno
 * instalar la app, pero el código nunca miraba el modo standalone: seguir la
 * instrucción no cambiaba nada. Los prefijos `webkit` se agregaron por Safari
 * anterior a 16.4 — NO eran la causa: en WebKit de escritorio actual las dos
 * versiones existen.
 *
 * Estos tests fijan la DECISIÓN, que es la parte que se puede probar sin
 * navegador. Las lecturas del entorno (`webkitFullscreenElement`,
 * `matchMedia('(display-mode: standalone)')`, `navigator.standalone`) son
 * envoltorios finos sobre globals y se verifican en el navegador real.
 */
describe("proctoringModeFrom", () => {
  it("con elemento en pantalla completa, el modo es fullscreen", () => {
    expect(proctoringModeFrom({ hayElementoFullscreen: true, esStandalone: false })).toBe(
      "fullscreen",
    );
  });

  it("app instalada sin fullscreen: standalone cuenta como modo válido", () => {
    // El caso del iPhone. Antes esto caía en "no se pudo activar" y el alumno
    // no tenía forma de rendir.
    expect(proctoringModeFrom({ hayElementoFullscreen: false, esStandalone: true })).toBe(
      "standalone",
    );
  });

  it("fullscreen GANA sobre standalone cuando se dan las dos", () => {
    // No es un detalle: si el alumno está en la app instalada Y además pidió
    // pantalla completa, salir de fullscreen SÍ es una señal registrable. Si
    // el modo dijera "standalone", ese strike se perdería.
    expect(proctoringModeFrom({ hayElementoFullscreen: true, esStandalone: true })).toBe(
      "fullscreen",
    );
  });

  it("ni una ni otra: ventana — el único caso que debe bloquear", () => {
    expect(proctoringModeFrom({ hayElementoFullscreen: false, esStandalone: false })).toBe(
      "ventana",
    );
  });

  it("solo 'ventana' significa que la vista NO está acotada", () => {
    // Invariante que consume la pantalla de toma: arranca el examen salvo que
    // el modo sea exactamente "ventana".
    const modos = [
      proctoringModeFrom({ hayElementoFullscreen: true, esStandalone: false }),
      proctoringModeFrom({ hayElementoFullscreen: false, esStandalone: true }),
      proctoringModeFrom({ hayElementoFullscreen: true, esStandalone: true }),
    ];
    expect(modos.every((m) => m !== "ventana")).toBe(true);
  });
});

/**
 * La distinción que faltaba, y que era el bug de fondo: bloquear a quien NO
 * QUIERE entrar a pantalla completa es la función; bloquear a quien NO PUEDE
 * —su plataforma no tiene la API— deja el examen inalcanzable. Desde el código
 * viejo las dos se veían iguales.
 */
describe("proctoringGateFrom", () => {
  it("vista acotada: permite, sin más", () => {
    for (const modo of ["fullscreen", "standalone"] as const) {
      const g = proctoringGateFrom({ modo, apiDisponible: true });
      expect(g).toEqual({ permitir: true, modo, motivo: "acotada" });
    }
  });

  it("SIN la API y en ventana: PERMITE — es el caso del iPhone", () => {
    // Acá estaba el alumno que no podía presentar. No hay nada que pueda hacer
    // para cumplir: ni instalando la app aparece la API en iOS.
    const g = proctoringGateFrom({ modo: "ventana", apiDisponible: false });
    expect(g.permitir).toBe(true);
    expect(g.motivo).toBe("sin_soporte");
  });

  it("CON la API y en ventana: bloquea — acá el alumno sí puede cumplir", () => {
    const g = proctoringGateFrom({ modo: "ventana", apiDisponible: true });
    expect(g.permitir).toBe(false);
    expect(g.motivo).toBe("rechazada");
  });

  it("la API ausente NO relaja nada cuando la vista ya está acotada", () => {
    // iPhone con la app instalada: no hay API, pero no hay cromo tampoco. Debe
    // leerse como "acotada", no como la excepción por falta de soporte.
    const g = proctoringGateFrom({ modo: "standalone", apiDisponible: false });
    expect(g.motivo).toBe("acotada");
  });

  it("el único caso que bloquea es ventana + API disponible", () => {
    const casos = [
      { modo: "fullscreen", apiDisponible: true },
      { modo: "fullscreen", apiDisponible: false },
      { modo: "standalone", apiDisponible: true },
      { modo: "standalone", apiDisponible: false },
      { modo: "ventana", apiDisponible: false },
      { modo: "ventana", apiDisponible: true },
    ] as const;
    const bloqueados = casos.filter((c) => !proctoringGateFrom(c).permitir);
    expect(bloqueados).toEqual([{ modo: "ventana", apiDisponible: true }]);
  });
});
