import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Toda clave que el código pide con `t("...")` tiene que existir en los dos
 * locales.
 *
 * ── Por qué hace falta un test y no alcanza con revisar ───────────────
 *
 * Cuando una clave falta, i18next **no falla**: devuelve la clave misma. O sea
 * que la pantalla se ve entera, no hay error en consola, y en el lugar del
 * texto aparece `hc_routesAppTeacherExamsExamId.maxWarningsLabel`. Así estuvo
 * en producción, sobre el campo de «Máximo de advertencias» del formulario de
 * examen, hasta que un docente lo vio y lo reportó.
 *
 * Es el modo de falla que este repo ya conoce de otros lados: no rompe nada,
 * solo queda mal, y por eso nadie lo mira dos veces.
 *
 * ── Alcance honesto ───────────────────────────────────────────────────
 *
 * Solo caza las llamadas con la clave ESCRITA como literal — `t("a.b")`. Las
 * que se arman con una variable (`t(clave)`, `t(\`x.${y}\`)`) no se pueden
 * resolver leyendo el archivo, y esas siguen sin cubrir. Cubre la mayoría: al
 * escribirse este test, las literales eran ~4.900 y había exactamente UNA rota.
 *
 * Los plurales cuentan como presentes si existe `clave_one` / `clave_other`,
 * que es como i18next los resuelve.
 */

const LOCALES = ["es", "en"] as const;

function cargar(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join("src/i18n/locales", `${locale}.json`), "utf8"));
}

function tiene(json: Record<string, unknown>, clave: string): boolean {
  let actual: unknown = json;
  for (const parte of clave.split(".")) {
    if (actual == null || typeof actual !== "object") return false;
    actual = (actual as Record<string, unknown>)[parte];
  }
  return actual !== undefined;
}

const existe = (json: Record<string, unknown>, clave: string): boolean =>
  tiene(json, clave) || tiene(json, `${clave}_one`) || tiene(json, `${clave}_other`);

function archivosFuente(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) archivosFuente(p, acc);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

describe("claves de i18n que el codigo usa", () => {
  const json = Object.fromEntries(LOCALES.map((l) => [l, cargar(l)]));
  const usadas = new Map<string, string>();
  for (const f of archivosFuente("src")) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)"/g)) {
      if (!usadas.has(m[1])) usadas.set(m[1], f.split(path.sep).join("/"));
    }
  }

  it("encuentra una cantidad plausible de claves (el regex no se rompio)", () => {
    // Si alguien cambia el patrón y deja de encontrar nada, el test pasaría
    // vacío y dejaría de proteger — un guardrail que no mira nada es peor que
    // ninguno, porque da confianza.
    expect(usadas.size).toBeGreaterThan(1000);
  });

  for (const locale of LOCALES) {
    it(`ninguna falta en ${locale}`, () => {
      const faltan = [...usadas.entries()]
        .filter(([k]) => !existe(json[locale], k))
        .map(([k, f]) => `${k}  (${f})`);
      expect(
        faltan,
        `Sin estas claves la pantalla muestra el identificador crudo en vez del texto:\n${faltan.join("\n")}`,
      ).toEqual([]);
    });
  }
});
