import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guardar una hoja de la pizarra tiene que hacer DOS cosas: escribir en la base y
 * sincronizar el state local. Este test lee el archivo del disco y verifica que no
 * quede ningún camino que haga solo la primera.
 *
 * ── El bug que ataja ──────────────────────────────────────────────────────
 * Cada hoja se re-monta al cambiar de pestaña (`key={activePage.id}`) y se siembra
 * desde `pages`, que es state LOCAL: cambiar de hoja NO relee de la base. Un
 * handler que guarda sin sincronizar deja `pages` con el contenido VIEJO, y al
 * volver a la hoja el editor arranca con eso, su auto-guardado se dispara, y lo
 * escribe de vuelta. El trabajo se pierde de verdad, no solo en pantalla.
 *
 * Pasaba con DIBUJO y con TEXTO —sus handlers escribían y no tocaban `pages`—
 * mientras la de código sí sincronizaba. Reporte textual: "la de código se guarda
 * automático pero la de dibujo no".
 *
 * ── Por qué un test que lee el archivo ────────────────────────────────────
 * La lógica vive dentro de un componente con state de React: probarla de verdad
 * pediría montar Excalidraw, Monaco y un cliente de Supabase. Lo que sí se puede
 * fijar —y es donde estuvo el error— es la INVARIANTE estructural: un solo camino
 * de guardado, y que ese camino sincronice. Precedente del repo:
 * `page-types.test.ts` y `tutor-default-prompt.test.ts` también leen archivos para
 * fijar invariantes que ningún tipo puede expresar.
 */

const ARCHIVO = resolve(__dirname, "MultiPageWhiteboard.tsx");
const fuente = readFileSync(ARCHIVO, "utf8").split("\r\n").join("\n");

/**
 * El cuerpo de un `const <nombre> = …`, hasta la siguiente declaración del mismo
 * nivel. Se corta por indentación y no por `);` porque los handlers conviven: unos
 * son un `useCallback(...)` de quince líneas y otros un delegado de una sola.
 */
function cuerpoDe(nombre: string): string {
  const i = fuente.indexOf(`const ${nombre} =`);
  if (i < 0) return "";
  const sig = fuente.indexOf("\n  const ", i + 1);
  const doc = fuente.indexOf("\n  /**", i + 1);
  const candidatos = [sig, doc].filter((x) => x > 0);
  const fin = candidatos.length > 0 ? Math.min(...candidatos) : fuente.length;
  return fuente.slice(i, fin);
}

describe("guardar una hoja sincroniza el state local", () => {
  it("existe UN solo camino que escribe en whiteboard_pages el contenido de la hoja", () => {
    // El `update` de contenido tiene que estar centralizado. Antes había tres, y el
    // que se olvidó de sincronizar fue justo el del dibujo.
    const updates = fuente.match(/\.from\("whiteboard_pages"\)\s*\.update\(/g) ?? [];
    // Hay otros updates legítimos en el archivo (renombrar, reordenar, borrar), así
    // que se acota a los que reciben un `patch` genérico de contenido.
    const dePatch = fuente.match(/\.from\("whiteboard_pages"\)\.update\(patch\)/g) ?? [];
    expect(dePatch.length, "el update de contenido debe estar en un solo lugar").toBe(1);
    expect(updates.length).toBeGreaterThan(0);
  });

  it("ese camino llama a setPages ANTES de escribir", () => {
    const cuerpo = cuerpoDe("persistPagePatch");
    expect(cuerpo, "falta persistPagePatch").not.toBe("");
    expect(cuerpo).toContain("setPages(");
    expect(cuerpo.indexOf("setPages(")).toBeLessThan(cuerpo.indexOf(".update(patch)"));
  });

  it("los handlers de DIBUJO, TEXTO y CÓDIGO pasan todos por ese camino", () => {
    // Es lo que impide que la próxima hoja nueva vuelva a olvidarse: el patch dice
    // qué columna se toca y el resto es igual para todas.
    for (const h of ["persistDrawingPage", "persistTextPage", "persistCodePage"]) {
      const cuerpo = cuerpoDe(h);
      expect(cuerpo, `falta ${h}`).not.toBe("");
      expect(cuerpo, `${h} debe delegar en persistPagePatch`).toContain("persistPagePatch");
    }
  });

  it("ningún handler de hoja escribe en la base por su cuenta", () => {
    // La forma exacta del bug: un `.update({ … })` con un objeto literal dentro de
    // un handler de persistencia, sin pasar por el patcher.
    for (const h of ["persistDrawingPage", "persistTextPage", "persistCodePage"]) {
      expect(cuerpoDe(h), `${h} no debe escribir directo`).not.toContain('.from("whiteboard_pages")');
    }
  });

  it("el dibujo guarda en scene_json y el texto en text_content", () => {
    // Un patch con la columna equivocada guardaría en silencio: la hoja se ve vacía
    // al volver y no hay ningún error.
    expect(cuerpoDe("persistDrawingPage")).toContain("scene_json");
    expect(cuerpoDe("persistTextPage")).toContain("text_content");
  });
});
