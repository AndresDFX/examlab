import { describe, it, expect } from "vitest";
import fs from "node:fs";

/**
 * El docente que entra a SIMULAR un examen tiene que poder salir.
 *
 * Lo que lo encierra son las capas que tapan la pantalla ENTERA —la de «volvé a
 * pantalla completa» y la de «el docente pausó el examen»—, con un solo botón la
 * primera y NINGUNO la segunda. Como tapan todo, tapan también el menú lateral,
 * que es por donde el docente sí podría salir (`isTakingExam` de `AppLayout` no
 * cubre la ruta del simulacro, así que fuera de las capas el nav funciona). Para
 * el alumno es exactamente lo que se busca; para quien está probando es una
 * trampa, y así se reportó.
 *
 * Lo que este test cuida es el modo de falla que vuelve: **agregar una capa
 * nueva que bloquee la pantalla y olvidarse de darle salida**. No rompe nada, no
 * da error, y nadie se entera hasta que a alguien le pasa. Por eso se cuenta
 * contra el disco: si aparece una capa más, este test obliga a decidir.
 */

const SRC = fs.readFileSync("src/modules/exams/TakeExamScreen.tsx", "utf8");

/** Capas que tapan la pantalla ENTERA y bloquean la interacción. */
const CAPAS_QUE_BLOQUEAN = 2; // «volvé a pantalla completa» + «examen pausado»

describe("salida del ensayo", () => {
  it("no aparecio una capa nueva que bloquee la pantalla sin salida", () => {
    const capas = [...SRC.matchAll(/className="fixed inset-0 z-50/g)].length;
    expect(
      capas,
      "Apareció (o desapareció) una capa que tapa la pantalla entera en la " +
        "pantalla de examen. Si es nueva, montale <SalirDelEnsayo> dentro " +
        "cuando `simulacro` sea true — si no, el docente que esté probando " +
        "queda encerrado sin más salida que el botón «Atrás» del navegador. " +
        "Después actualizá este número.",
    ).toBe(CAPAS_QUE_BLOQUEAN);
  });

  it("la salida se monta en el aviso permanente y dentro de cada capa", () => {
    // 1 por capa (2) + 1 en el aviso permanente = 3. El `import` NO entra: el
    // patrón pide `<` pegado al nombre y ahí no lo hay.
    const montajes = [...SRC.matchAll(/<SalirDelEnsayo/g)].length;
    expect(montajes).toBe(CAPAS_QUE_BLOQUEAN + 1);
  });

  it("salir apaga el proctoring ANTES de soltar la pantalla completa", () => {
    // El orden no es cosmético: `recordWarning` corta con `submittedRef`, así que
    // marcarlo después dejaría que el propio gesto de salir se cobre un aviso y
    // levante la capa que se está abandonando.
    const cuerpo = /const salirDelEnsayo = useCallback\(async \(\) => \{([\s\S]*?)\}, \[/.exec(SRC);
    expect(cuerpo, "no se encontró `salirDelEnsayo`").toBeTruthy();
    const marca = cuerpo![1].indexOf("submittedRef.current = true");
    const suelta = cuerpo![1].indexOf("exitFullscreen");
    expect(marca).toBeGreaterThan(-1);
    expect(suelta).toBeGreaterThan(marca);
  });

  it("en un ensayo el boton Atras sale, en vez de abrir el dialogo de advertencia", () => {
    // Ese diálogo dice que salir «registra una advertencia»: en un ensayo no hay
    // advertencia que registrar, así que preguntarlo es mentir y además estorba
    // el único gesto que hoy funciona para escapar.
    expect(SRC).toMatch(/if \(simulacro\) \{\s*\n\s*void salirDelEnsayo\(\);/);
  });
});
