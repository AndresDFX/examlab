import { describe, expect, it } from "vitest";

import {
  CARACTERES_DE_CODIGO,
  CARACTERES_DE_TEXTO,
  caracteresParaTipo,
  insertarCaracter,
} from "./caracteres-especiales";

describe("caracteresParaTipo", () => {
  it.each(["cerrada", "cerrada_multi", "red_gui", "codigo_zip"])(
    "'%s' NO muestra barra: ahí no se escribe",
    (tipo) => {
      expect(caracteresParaTipo(tipo)).toBeNull();
    },
  );

  it.each(["codigo", "java_gui", "python_gui", "bd_sql", "so_consola", "red_consola"])(
    "'%s' usa el juego de código",
    (tipo) => {
      expect(caracteresParaTipo(tipo)).toBe(CARACTERES_DE_CODIGO);
    },
  );

  it("una pregunta abierta usa el juego de texto", () => {
    expect(caracteresParaTipo("abierta")).toBe(CARACTERES_DE_TEXTO);
  });

  it("un tipo desconocido cae al juego de texto, no a null", () => {
    // Un tipo nuevo de redacción debe traer la barra por defecto; quedarse sin
    // ella es el fallo silencioso que este default evita.
    expect(caracteresParaTipo("ensayo_2027")).toBe(CARACTERES_DE_TEXTO);
  });

  it("el punto y coma está en el juego de código: sin él no hay programa en Java", () => {
    expect(CARACTERES_DE_CODIGO).toContain(";");
  });

  it("la eñe está en los DOS juegos", () => {
    // En código también: los nombres de variable y los comentarios se escriben
    // en español.
    expect(CARACTERES_DE_TEXTO).toContain("ñ");
    expect(CARACTERES_DE_CODIGO).toContain("ñ");
  });

  it("ningún juego trae caracteres repetidos", () => {
    for (const juego of [CARACTERES_DE_TEXTO, CARACTERES_DE_CODIGO]) {
      expect(new Set(juego).size).toBe(juego.length);
    }
  });
});

describe("insertarCaracter", () => {
  it("inserta en el cursor y deja el cursor DESPUÉS del carácter", () => {
    // Sin devolver el cursor, el campo se re-renderiza y salta al final: meter
    // un `;` en medio mandaba al alumno al final del archivo.
    expect(insertarCaracter("ab", 1, 1, ";")).toEqual({ valor: "a;b", cursor: 2 });
  });

  it("reemplaza la selección, como cualquier editor", () => {
    expect(insertarCaracter("hola", 1, 3, "ñ")).toEqual({ valor: "hña", cursor: 2 });
  });

  it("al final del texto", () => {
    expect(insertarCaracter("int x", 5, 5, ";")).toEqual({ valor: "int x;", cursor: 6 });
  });

  it("sobre un campo vacío", () => {
    expect(insertarCaracter("", 0, 0, "ñ")).toEqual({ valor: "ñ", cursor: 1 });
  });

  it("una posición fuera de rango se acota en vez de romper", () => {
    expect(insertarCaracter("ab", 99, 99, ";")).toEqual({ valor: "ab;", cursor: 3 });
    expect(insertarCaracter("ab", -5, -5, ";")).toEqual({ valor: ";ab", cursor: 1 });
  });

  it("un fin ANTERIOR al inicio no borra texto", () => {
    // Defensivo: si el campo reporta la selección al revés, insertar no puede
    // comerse lo que el alumno escribió.
    expect(insertarCaracter("abc", 2, 1, ";")).toEqual({ valor: "ab;c", cursor: 3 });
  });

  it("posiciones no numéricas caen al final", () => {
    expect(insertarCaracter("ab", Number.NaN, Number.NaN, ";")).toEqual({
      valor: "ab;",
      cursor: 3,
    });
  });
});
