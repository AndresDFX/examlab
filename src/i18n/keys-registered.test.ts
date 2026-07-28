/**
 * Gate de CLAVES REGISTRADAS: toda clave que el código usa con
 * `t("clave", { defaultValue: "…" })` debe existir en `es.json` Y en `en.json`.
 *
 * Por qué existe, además del test de paridad de al lado: `locale-parity.test.ts`
 * compara los dos locales ENTRE SÍ, así que una clave ausente de AMBOS pasa
 * inadvertida. Como i18next tiene `fallbackLng: "es"` y el `defaultValue` está
 * en español, la UI "funciona" y nadie nota nada… salvo el usuario en inglés,
 * que ve español. Caso real: un lote de cambios dejó 117 claves nuevas sin
 * registrar, con paridad 7/7 en verde.
 *
 * Escanea el árbol de `src/` en tiempo de test (no hay build step de i18n), y
 * el mensaje de fallo lista clave + archivo para que el fix sea mecánico.
 *
 * LIMITACIÓN CONOCIDA: solo detecta claves LITERALES con `defaultValue`
 * inline. Las claves construidas dinámicamente (`t(\`ns.${x}\`)`) o pasadas por
 * variable quedan fuera de alcance — no hay forma estática de resolverlas, y
 * las que no llevan `defaultValue` ya rompen visiblemente en español, así que
 * no necesitan este gate.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import en from "./locales/en.json";
import es from "./locales/es.json";

const SRC = resolve(__dirname, "..");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/node_modules|[.]git/.test(entry.name)) sourceFiles(full, acc);
    } else if (/[.](ts|tsx)$/.test(entry.name) && !/[.]test[.](ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * `t("clave", { … defaultValue: "texto" … })` e `i18n.t(...)`.
 * El defaultValue admite comilla simple, doble o backtick, y el objeto de
 * opciones puede traer saltos de línea y otras props antes o después.
 */
const KEY_WITH_DEFAULT =
  /\b(?:i18n\.)?t\(\s*["'`]([\w.$-]+)["'`]\s*,\s*\{[^{}]*?defaultValue:\s*(["'`])(?:\\.|(?!\2)[\s\S])*?\2/g;

function hasPath(obj: unknown, dotted: string): boolean {
  return (
    dotted.split(".").reduce<unknown>((node, part) => {
      if (node !== null && typeof node === "object") {
        return (node as Record<string, unknown>)[part];
      }
      return undefined;
    }, obj) !== undefined
  );
}

interface Usage {
  key: string;
  file: string;
}

function collectUsages(): Usage[] {
  const seen = new Map<string, Usage>();
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const match of src.matchAll(KEY_WITH_DEFAULT)) {
      const key = match[1];
      if (seen.has(key)) continue;
      seen.set(key, { key, file: relative(SRC, file).replace(/\\/g, "/") });
    }
  }
  return [...seen.values()];
}

describe("claves i18n registradas en los locales", () => {
  const usages = collectUsages();

  it("encuentra claves con defaultValue en el código (el escáner funciona)", () => {
    // Guard del propio test: si un refactor rompe el regex, el test pasaría
    // vacío y dejaría de proteger nada.
    expect(usages.length).toBeGreaterThan(100);
  });

  it("toda clave usada con defaultValue existe en es.json", () => {
    const missing = usages.filter((u) => !hasPath(es, u.key));
    expect(
      missing.map((u) => `${u.key}  (${u.file})`),
      `Claves usadas en el código pero ausentes de es.json. Registralas con el mismo texto del defaultValue.`,
    ).toEqual([]);
  });

  it("toda clave usada con defaultValue existe en en.json", () => {
    const missing = usages.filter((u) => !hasPath(en, u.key));
    expect(
      missing.map((u) => `${u.key}  (${u.file})`),
      `Claves usadas en el código pero ausentes de en.json. Sin esto el usuario en inglés ve el defaultValue en español.`,
    ).toEqual([]);
  });
});
