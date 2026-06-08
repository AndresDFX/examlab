/**
 * Tests de PARIDAD entre los locales `es` y `en`.
 *
 * La app es i18n con `es-CO` como idioma por defecto + `en` como
 * traduccion. Si un locale gana una clave y el otro no, en runtime
 * i18next cae al fallback (`es`) y el usuario en ingles ve texto en
 * español sin aviso — bug silencioso. Estos tests son el gate de
 * "todo string traducido en un idioma existe en el otro".
 *
 * Derivamos TODO del contenido real de los JSON (resolveJsonModule
 * activo): no se hardcodea ningun conteo de claves. Si los locales
 * estan sincronizados, todos los tests pasan; cuando alguien agrega
 * una clave a un solo lado, el test la lista por nombre.
 */
import { describe, expect, it } from "vitest";

import en from "./locales/en.json";
import es from "./locales/es.json";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Recolecta recursivamente todas las dot-paths que terminan en un
 * valor NO-objeto (hoja). Los arrays se tratan como hoja (no
 * descendemos por indices — i18next no usa arrays como sub-namespaces).
 */
function collectLeafPaths(
  node: JsonValue,
  prefix = "",
  acc: string[] = [],
): string[] {
  if (
    node !== null &&
    typeof node === "object" &&
    !Array.isArray(node)
  ) {
    for (const key of Object.keys(node)) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      collectLeafPaths(node[key], childPath, acc);
    }
  } else {
    acc.push(prefix);
  }
  return acc;
}

/** Devuelve [enEspañolNoEnIngles, enInglesNoEnEspañol]. */
function diffSets(a: Set<string>, b: Set<string>): [string[], string[]] {
  const onlyInA = [...a].filter((k) => !b.has(k)).sort();
  const onlyInB = [...b].filter((k) => !a.has(k)).sort();
  return [onlyInA, onlyInB];
}

const esLeaves = collectLeafPaths(es as JsonValue);
const enLeaves = collectLeafPaths(en as JsonValue);
const esSet = new Set(esLeaves);
const enSet = new Set(enLeaves);

describe("locale parity — es ↔ en (todo el archivo)", () => {
  it("no hay claves duplicadas dentro de cada locale", () => {
    // Object.keys no puede tener dupes, pero esta aserta el invariante
    // que asumimos al construir los Set (size === length).
    expect(esSet.size).toBe(esLeaves.length);
    expect(enSet.size).toBe(enLeaves.length);
  });

  it("el conjunto de claves de `es` y `en` es idéntico", () => {
    const [missingInEn, missingInEs] = diffSets(esSet, enSet);

    const messages: string[] = [];
    if (missingInEn.length > 0) {
      messages.push(
        `Claves presentes en es.json pero FALTANTES en en.json (${missingInEn.length}):\n  - ${missingInEn.join("\n  - ")}`,
      );
    }
    if (missingInEs.length > 0) {
      messages.push(
        `Claves presentes en en.json pero FALTANTES en es.json (${missingInEs.length}):\n  - ${missingInEs.join("\n  - ")}`,
      );
    }

    // Si hay diferencias, fallamos con el detalle completo. Si no,
    // la igualdad de tamaño confirma la paridad.
    expect(messages.join("\n\n") || "ok").toBe("ok");
    expect(enSet.size).toBe(esSet.size);
  });

  it("ningún locale tiene claves de más respecto al otro", () => {
    const [missingInEn, missingInEs] = diffSets(esSet, enSet);
    expect(missingInEn).toEqual([]);
    expect(missingInEs).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────
// Namespace `toast` — el más volátil (cada toast nuevo agrega clave).
// `toast` tiene sub-objetos por módulo/ruta, así que comparamos las
// dot-paths recursivas del subtree, no solo las claves inmediatas.
// ──────────────────────────────────────────────────────────────────
describe("locale parity — namespace `toast`", () => {
  const esToast = (es as Record<string, JsonValue>).toast;
  const enToast = (en as Record<string, JsonValue>).toast;

  it("ambos locales tienen el namespace `toast` como objeto", () => {
    expect(esToast !== null && typeof esToast === "object").toBe(true);
    expect(enToast !== null && typeof enToast === "object").toBe(true);
    expect(Array.isArray(esToast)).toBe(false);
    expect(Array.isArray(enToast)).toBe(false);
  });

  const esToastLeaves = collectLeafPaths(esToast, "toast");
  const enToastLeaves = collectLeafPaths(enToast, "toast");
  const esToastSet = new Set(esToastLeaves);
  const enToastSet = new Set(enToastLeaves);

  it("`toast` tiene EXACTAMENTE las mismas claves en es y en", () => {
    const [missingInEn, missingInEs] = diffSets(esToastSet, enToastSet);

    const messages: string[] = [];
    if (missingInEn.length > 0) {
      messages.push(
        `toast keys en es pero NO en en (${missingInEn.length}):\n  - ${missingInEn.join("\n  - ")}`,
      );
    }
    if (missingInEs.length > 0) {
      messages.push(
        `toast keys en en pero NO en es (${missingInEs.length}):\n  - ${missingInEs.join("\n  - ")}`,
      );
    }

    expect(messages.join("\n\n") || "ok").toBe("ok");
    expect(enToastSet.size).toBe(esToastSet.size);
  });

  it("ningún valor de `toast` es vacío en es", () => {
    const empty = collectEmptyStringLeaves(esToast, "toast");
    expect(empty).toEqual([]);
  });

  it("ningún valor de `toast` es vacío en en", () => {
    const empty = collectEmptyStringLeaves(enToast, "toast");
    expect(empty).toEqual([]);
  });
});

/**
 * Recolecta las dot-paths de `toast` cuyo valor hoja es un string
 * vacío / solo-espacios. NO marca sub-objetos como vacíos (descendemos
 * en ellos), solo las hojas string. Un string vacío en un toast es un
 * bug: el usuario vería un toast en blanco.
 */
function collectEmptyStringLeaves(
  node: JsonValue,
  prefix = "",
  acc: string[] = [],
): string[] {
  if (node !== null && typeof node === "object" && !Array.isArray(node)) {
    for (const key of Object.keys(node)) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      collectEmptyStringLeaves(node[key], childPath, acc);
    }
  } else if (typeof node === "string" && node.trim() === "") {
    acc.push(prefix);
  }
  return acc;
}
