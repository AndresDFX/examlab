import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./sql-split";

/** Solo el texto de cada sentencia, que es lo que se manda al motor. */
const partes = (s: string) => splitSqlStatements(s).map((x) => x.sql);

describe("splitSqlStatements", () => {
  it("parte por punto y coma y recorta", () => {
    expect(partes("select 1; select 2;")).toEqual(["select 1", "select 2"]);
  });

  it("la última sentencia sin punto y coma cuenta igual", () => {
    // El caso de la captura del reporte: la hoja termina sin `;`.
    expect(partes("create table t (id int);\nselect * from t")).toEqual([
      "create table t (id int)",
      "select * from t",
    ]);
  });

  it("un texto vacío o solo espacios no da sentencias", () => {
    expect(partes("")).toEqual([]);
    expect(partes("   \n\t ")).toEqual([]);
    expect(partes(";;;")).toEqual([]);
  });

  it("una hoja que son puros comentarios no manda nada al motor", () => {
    expect(partes("-- nada que correr\n/* tampoco */")).toEqual([]);
  });

  it("un comentario suelto entre sentencias no cuenta como sentencia", () => {
    expect(partes("select 1;\n-- explico algo\nselect 2;")).toEqual([
      "select 1",
      "-- explico algo\nselect 2",
    ]);
  });

  it("el punto y coma dentro de un literal NO parte la sentencia", () => {
    expect(partes("insert into t values ('a;b'); select 1")).toEqual([
      "insert into t values ('a;b')",
      "select 1",
    ]);
  });

  it("la comilla escapada con '' no cierra el literal", () => {
    expect(partes("select 'O''Brien; no parte'; select 2")).toEqual([
      "select 'O''Brien; no parte'",
      "select 2",
    ]);
  });

  it("en un literal E'...' la barra escapa la comilla", () => {
    // `String.raw` para que la barra llegue al separador: en una cadena
    // normal `\'` se colapsa a `'` y el caso a probar desaparece.
    const g = String.raw`select E'a\'; b'; select 2`;
    expect(partes(g)).toEqual([String.raw`select E'a\'; b'`, "select 2"]);
  });

  it("pero una E que es parte de una palabra no hace literal con escapes", () => {
    // `case'x'` no es E-string; la comilla abre un literal normal.
    expect(partes("select case'a;b' end; select 2").length).toBe(2);
  });

  it("el punto y coma dentro de un identificador entre comillas dobles no parte", () => {
    expect(partes('select "col;raro" from t; select 2')).toEqual([
      'select "col;raro" from t',
      "select 2",
    ]);
  });

  it("el punto y coma dentro de un comentario de línea no parte", () => {
    expect(partes("select 1 -- ojo; esto no parte\n; select 2")).toEqual([
      "select 1 -- ojo; esto no parte",
      "select 2",
    ]);
  });

  it("el punto y coma dentro de un comentario de bloque no parte", () => {
    expect(partes("select 1 /* ; ni acá ; */ ; select 2")).toEqual([
      "select 1 /* ; ni acá ; */",
      "select 2",
    ]);
  });

  it("los comentarios de bloque de Postgres ANIDAN", () => {
    // Con un contador de un solo nivel, el `*/` interno cerraría antes y el
    // `;` de afuera partiría la sentencia por la mitad.
    expect(partes("select 1 /* a /* b ; */ c ; */ ; select 2")).toEqual([
      "select 1 /* a /* b ; */ c ; */",
      "select 2",
    ]);
  });

  it("un bloque $$ ... $$ con punto y coma adentro queda entero", () => {
    const f = `CREATE FUNCTION f() RETURNS int AS $$
BEGIN
  PERFORM 1;
  RETURN 2;
END
$$ LANGUAGE plpgsql;
select f()`;
    const r = partes(f);
    expect(r).toHaveLength(2);
    expect(r[0]).toContain("RETURN 2;");
    expect(r[1]).toBe("select f()");
  });

  it("una dólar-comilla con tag solo cierra con el MISMO tag", () => {
    const f = `do $cuerpo$ begin perform 1; end $cuerpo$; select 1`;
    expect(partes(f)).toEqual(["do $cuerpo$ begin perform 1; end $cuerpo$", "select 1"]);
  });

  it("un $1 de parámetro no se confunde con una dólar-comilla", () => {
    expect(partes("select * from t where id = $1; select 2")).toEqual([
      "select * from t where id = $1",
      "select 2",
    ]);
  });

  it("una dólar-comilla sin cerrar deja el resto como UNA sentencia", () => {
    // Se prefiere que el motor devuelva su error a partirla por un `;` interno.
    expect(partes("select 1; do $$ begin perform 1; end")).toEqual([
      "select 1",
      "do $$ begin perform 1; end",
    ]);
  });

  it("las posiciones apuntan a la sentencia dentro del texto original", () => {
    const texto = "select 1;\n\n  select 22;";
    const r = splitSqlStatements(texto);
    expect(r).toHaveLength(2);
    expect(texto.slice(r[0].start, r[0].end)).toBe("select 1");
    expect(texto.slice(r[1].start, r[1].end)).toBe("select 22");
  });

  it("la posición sirve para saber qué precede al cursor", () => {
    // Es lo que permite correr una selección con el guion de arriba como contexto.
    const texto = "create table t (id int);\ninsert into t values (1);\nselect * from t";
    const r = splitSqlStatements(texto);
    const cursor = texto.indexOf("select * from t");
    expect(r.filter((x) => x.end <= cursor).map((x) => x.sql)).toEqual([
      "create table t (id int)",
      "insert into t values (1)",
    ]);
  });
});
