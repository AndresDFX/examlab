import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { PAGE_TYPES } from "./page-types";

/**
 * Los tipos de hoja de una pizarra viven en DOS lados que nadie sincroniza
 * solo: el `CHECK (page_type IN (…))` de `whiteboard_pages` y la lista que el
 * cliente ofrece y despacha. Si difieren no hay ningún error visible:
 *
 *   - Un tipo que el cliente ofrece y el CHECK no acepta rebota el INSERT con
 *     un 23514, recién en el momento de crear la hoja.
 *   - Un tipo que la base acepta y el cliente no conoce cae en SILENCIO a la
 *     rama de dibujo: los ternarios del despacho tienen `else` final, así que
 *     TypeScript no dice nada y la hoja se abre con el editor equivocado.
 *
 * Este test lee del disco la última migración que toca el constraint y compara,
 * así que agregar un tipo en un solo lado rompe en rojo y dice cuál falta.
 * Precedente en el repo: `tutor-default-prompt.test.ts`, que también fija una
 * invariante cross-file leyendo archivos.
 */

const MIGRATIONS = resolve(__dirname, "../../../supabase/migrations");
const CONSTRAINT = "whiteboard_pages_page_type_check";
const CHECK_HEAD = "CHECK (page_type IN (";

/** Última migración (por nombre, que es el timestamp) que toca el constraint. */
function ultimaMigracionDelCheck(): string {
  const candidatas = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => leer(join(MIGRATIONS, f)).includes(CONSTRAINT));
  const ultima = candidatas.at(-1);
  if (!ultima) throw new Error(`Ninguna migración menciona ${CONSTRAINT}`);
  return join(MIGRATIONS, ultima);
}

/** CRLF → LF: el checkout en Windows guarda CRLF y sin normalizar el diff se ve
 *  idéntico pero no lo es. */
function leer(file: string): string {
  return readFileSync(file, "utf8").split("\r\n").join("\n");
}

/**
 * Extrae la lista del CHECK. Por índices y no con una regex sobre todo el
 * archivo: el `IN (…)` está anidado dentro del paréntesis del CHECK, y un
 * patrón perezoso cortaría en el paréntesis equivocado.
 */
function tiposDelCheck(sql: string): string[] {
  const start = sql.lastIndexOf(CHECK_HEAD);
  if (start === -1) throw new Error(`No encontré "${CHECK_HEAD}" en la migración`);
  const from = start + CHECK_HEAD.length;
  const end = sql.indexOf(")", from);
  if (end === -1) throw new Error("El CHECK no cierra su paréntesis");
  const lista = sql.slice(from, end);
  return [...lista.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe("page_type de las hojas de pizarra", () => {
  it("la lista del cliente coincide con el CHECK de la migración", () => {
    const tipos = tiposDelCheck(leer(ultimaMigracionDelCheck()));
    // Orden incluido: no cuesta nada mantenerlo y hace el diff legible cuando
    // alguien agrega un tipo.
    expect(tipos).toEqual([...PAGE_TYPES]);
  });

  it("no tiene tipos repetidos", () => {
    expect(new Set(PAGE_TYPES).size).toBe(PAGE_TYPES.length);
  });

  it("los valores van en inglés, sin la variante en español del tipo de pregunta", () => {
    // 'diagrama' es el tipo de PREGUNTA (otra tabla, otro enum). Mezclarlo acá
    // deja un CHECK que se lee como un error de tipeo.
    expect(PAGE_TYPES).not.toContain("diagrama" as never);
    expect(PAGE_TYPES).toContain("diagram");
  });
});
