/**
 * Tests de los helpers puros del buscador global (⌘K).
 *
 * El caso que originó el módulo está abajo en "acentos": en es-CO la gente
 * escribe "matematicas" y el título dice "Matemáticas". Antes eso no encontraba
 * nada — ni en el filtro del cliente (cmdk hace `includes` crudo) ni en el
 * servidor (`ILIKE` no ignora diacríticos).
 */
import { describe, expect, it } from "vitest";
import {
  LOOSE_MIN_LENGTH,
  ilikePatternFor,
  matchesQuery,
  normalizeForSearch,
  queryTokens,
  relevanceScore,
  sortByRelevance,
} from "./search-text";

describe("normalizeForSearch", () => {
  it("baja a minúsculas y quita acentos", () => {
    expect(normalizeForSearch("Matemáticas")).toBe("matematicas");
    expect(normalizeForSearch("Programación II")).toBe("programacion ii");
    expect(normalizeForSearch("Diseño")).toBe("diseno");
    expect(normalizeForSearch("ÁÉÍÓÚÜÑ")).toBe("aeiouun");
  });

  it("colapsa espacios y recorta", () => {
    expect(normalizeForSearch("  Cálculo   I  ")).toBe("calculo i");
  });

  it("tolera null / undefined / vacío", () => {
    expect(normalizeForSearch(null)).toBe("");
    expect(normalizeForSearch(undefined)).toBe("");
    expect(normalizeForSearch("")).toBe("");
  });
});

describe("queryTokens", () => {
  it("parte en palabras normalizadas", () => {
    expect(queryTokens("Paradigmas  Programación")).toEqual(["paradigmas", "programacion"]);
  });

  it("consulta vacía ⇒ sin tokens", () => {
    expect(queryTokens("   ")).toEqual([]);
  });
});

describe("matchesQuery", () => {
  it("acentos: la consulta sin tildes encuentra el título con tildes", () => {
    expect(matchesQuery("Matemáticas Discretas", "matematicas")).toBe(true);
    expect(matchesQuery("Programación I", "PROGRAMACION")).toBe(true);
    expect(matchesQuery("Diseño de Software", "diseno")).toBe(true);
  });

  it("y también al revés (título sin tilde, consulta con tilde)", () => {
    expect(matchesQuery("Matematicas", "matemáticas")).toBe(true);
  });

  it("exige TODAS las palabras, en cualquier orden", () => {
    expect(matchesQuery("Paradigmas de Programación", "paradigmas prog")).toBe(true);
    expect(matchesQuery("Paradigmas de Programación", "prog paradigmas")).toBe(true);
    expect(matchesQuery("Paradigmas de Programación", "paradigmas calculo")).toBe(false);
  });

  it("consulta vacía no filtra; texto vacío nunca coincide", () => {
    expect(matchesQuery("lo que sea", "")).toBe(true);
    expect(matchesQuery("", "algo")).toBe(false);
    expect(matchesQuery(null, "algo")).toBe(false);
  });
});

describe("relevanceScore", () => {
  it("ordena exacto < prefijo < inicio de palabra < contiene", () => {
    expect(relevanceScore("Cálculo", "calculo")).toBe(0);
    expect(relevanceScore("Cálculo Integral", "calculo")).toBe(1);
    expect(relevanceScore("Taller de Cálculo", "calculo")).toBe(2);
    expect(relevanceScore("Precálculo", "calculo")).toBe(3);
  });

  it("palabras sueltas puntúan peor que el substring contiguo", () => {
    expect(relevanceScore("Paradigmas de Programación", "paradigmas programacion")).toBe(4);
  });

  it("sin coincidencia devuelve el peor score", () => {
    expect(relevanceScore("Física", "quimica")).toBe(5);
  });
});

describe("sortByRelevance", () => {
  const id = (s: string) => s;

  it("pone primero el más relevante y desempata alfabéticamente", () => {
    const out = sortByRelevance(
      ["Taller de Cálculo", "Cálculo Integral", "Cálculo", "Cálculo Avanzado"],
      "calculo",
      id,
    );
    expect(out).toEqual(["Cálculo", "Cálculo Avanzado", "Cálculo Integral", "Taller de Cálculo"]);
  });

  it("no muta la entrada", () => {
    const input = ["b", "a"];
    sortByRelevance(input, "a", id);
    expect(input).toEqual(["b", "a"]);
  });
});

describe("ilikePatternFor", () => {
  it("consulta larga: afloja las letras que pueden llevar tilde", () => {
    // "matematicas" (11) ⇒ superconjunto que sí matchea "Matemáticas".
    expect(ilikePatternFor("matematicas")).toBe("%m_t_m_t___s%");
  });

  it("consulta corta: patrón estricto (evita traer basura)", () => {
    expect("ab".length).toBeLessThan(LOOSE_MIN_LENGTH);
    expect(ilikePatternFor("ab")).toBe("%ab%");
  });

  it("neutraliza los comodines y separadores de PostgREST", () => {
    // `%` `_` `,` `(` `)` no pueden llegar crudos: serían sintaxis.
    expect(ilikePatternFor("50%")).toBe("%50_%");
    expect(ilikePatternFor("a,b")).toBe("%a_b%");
    expect(ilikePatternFor("x_y")).toBe("%x_y%");
  });

  it("el patrón laxo es superconjunto del literal", () => {
    // Sanity check del razonamiento: `_` también matchea la letra sin tilde.
    const pattern = ilikePatternFor("programacion");
    const rx = new RegExp(`^${pattern.slice(1, -1).replace(/_/g, ".")}$`.replace(/%/g, ".*"), "i");
    expect(rx.test("programacion")).toBe(true);
    expect(rx.test("programación")).toBe(true);
  });
});
