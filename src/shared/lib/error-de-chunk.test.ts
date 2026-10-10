import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Los cuatro detectores de «chunk viejo» están duplicados (el de __root.tsx es
// un script inline que no puede importar). Si uno pierde el mensaje de WebKit,
// en Safari una pestaña vieja muestra «Algo salió mal» en vez de recargarse.
const ARCHIVOS = [
  "src/router.tsx",
  "src/shared/components/ErrorBoundary.tsx",
  "src/shared/components/GlobalErrorLogger.tsx",
  "src/routes/__root.tsx",
];
const MENSAJES = [
  "Failed to fetch dynamically imported module",
  "Importing a module script failed",
  "is not a valid JavaScript MIME type",
  "Loading chunk",
];

describe("detectores de chunk viejo", () => {
  for (const f of ARCHIVOS)
    it(`${f} reconoce los mensajes de todos los navegadores`, () => {
      const t = readFileSync(f, "utf8");
      for (const m of MENSAJES) expect(t, m).toContain(m);
    });

  it("el service worker no guarda HTML bajo un .js", () => {
    const sw = readFileSync("public/sw.js", "utf8");
    expect(sw).toMatch(/text\/html[\s\S]{0,120}status: 404/);
  });
});
