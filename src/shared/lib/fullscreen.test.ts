import { describe, expect, it } from "vitest";
import { proctoringModeFrom } from "./fullscreen";

/**
 * El bug que originó el helper: la pantalla de toma decidía "no se pudo activar
 * pantalla completa" mirando SOLO `document.fullscreenElement`. En Safari la API
 * está detrás del prefijo `webkit`, así que ese campo era `undefined` y el
 * examen se bloqueaba con la API prefijada disponible y sin usar. Y en iPhone,
 * donde la API no existe para elementos ni instalando la app, el mensaje le
 * pedía al alumno instalar la PWA — pero el código nunca miraba el modo
 * standalone, así que seguir la instrucción no cambiaba nada.
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
