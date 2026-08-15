import { describe, expect, it } from "vitest";
import { hasSchemaSummary, summarizeSetupSql } from "./sql-schema";

const tablas = (sql: string) => summarizeSetupSql(sql).tables;

describe("summarizeSetupSql", () => {
  it("detecta las tablas de un esquema típico de clase", () => {
    const sql = `
      CREATE TABLE cliente (id serial PRIMARY KEY, nombre text NOT NULL);
      CREATE TABLE pedido (id serial PRIMARY KEY, cliente_id int REFERENCES cliente(id));
      INSERT INTO cliente (nombre) VALUES ('Ana'), ('Luis');
    `;
    expect(tablas(sql)).toEqual(["cliente", "pedido"]);
  });

  it("NO confunde el nombre de una FK con una tabla declarada", () => {
    // `REFERENCES cliente(id)` menciona la tabla pero no la declara. Si el
    // resumen la contara dos veces el docente vería tablas fantasma.
    expect(tablas("CREATE TABLE pedido (cliente_id int REFERENCES cliente(id));")).toEqual([
      "pedido",
    ]);
  });

  it("soporta IF NOT EXISTS, TEMPORARY y UNLOGGED", () => {
    expect(tablas("create temporary table if not exists t1 (a int);")).toEqual(["t1"]);
    expect(tablas("CREATE UNLOGGED TABLE t2 (a int);")).toEqual(["t2"]);
  });

  it("quita el esquema calificado y las comillas", () => {
    expect(tablas('CREATE TABLE public.venta (a int);')).toEqual(["venta"]);
    expect(tablas('CREATE TABLE "Factura" (a int);')).toEqual(["Factura"]);
    expect(tablas('CREATE TABLE public."Nota Final" (a int);')).toEqual(["Nota Final"]);
  });

  it("preserva la capitalización de un identificador entre comillas", () => {
    // En Postgres "Cliente" con comillas ES sensible a mayúsculas: mostrarlo en
    // minúscula daría un nombre con el que la consulta fallaría.
    expect(tablas('CREATE TABLE "Cliente" (a int);')).toEqual(["Cliente"]);
  });

  it("ignora lo que está COMENTADO", () => {
    const sql = `
      -- CREATE TABLE vieja (a int);
      /* CREATE TABLE tambien_vieja (a int); */
      CREATE TABLE nueva (a int);
    `;
    expect(tablas(sql)).toEqual(["nueva"]);
  });

  it("dedup case-insensitive: no lista la misma tabla dos veces", () => {
    expect(tablas("CREATE TABLE cliente (a int); create table Cliente (b int);")).toEqual([
      "cliente",
    ]);
  });

  it("detecta vistas por separado de las tablas", () => {
    const s = summarizeSetupSql(
      "CREATE TABLE cliente (a int); CREATE OR REPLACE VIEW v_activos AS SELECT * FROM cliente;",
    );
    expect(s.tables).toEqual(["cliente"]);
    expect(s.views).toEqual(["v_activos"]);
  });

  it("vistas materializadas también", () => {
    expect(summarizeSetupSql("CREATE MATERIALIZED VIEW mv AS SELECT 1;").views).toEqual(["mv"]);
  });

  it("entradas vacías o no-string devuelven listas vacías, sin lanzar", () => {
    for (const v of [null, undefined, "", "   "]) {
      expect(summarizeSetupSql(v as string | null)).toEqual({ tables: [], views: [] });
    }
  });

  it("un script SIN DDL no inventa nada", () => {
    expect(summarizeSetupSql("SELECT * FROM algo; INSERT INTO otra VALUES (1);")).toEqual({
      tables: [],
      views: [],
    });
  });

  it("no se confunde con un CREATE TABLE dentro de un literal de texto", () => {
    // Detectado por este test: sin filtrar los literales aparecía la tabla
    // fantasma `falso`.
    expect(tablas("INSERT INTO log (msg) VALUES ('create table falso');")).toEqual([]);
  });

  it("ignora un CREATE TABLE dentro de un cuerpo de función (dollar-quoted)", () => {
    // No se ejecuta al cargar el esquema, solo si se invoca la función.
    const sql = `
      CREATE TABLE real_t (a int);
      CREATE FUNCTION f() RETURNS void AS $$ BEGIN CREATE TABLE interna (a int); END $$ LANGUAGE plpgsql;
    `;
    expect(tablas(sql)).toEqual(["real_t"]);
  });

  it("literales con comilla escapada ('') no rompen el filtrado", () => {
    expect(tablas("INSERT INTO t VALUES ('O''Brien'); CREATE TABLE post (a int);")).toEqual([
      "post",
    ]);
  });
});

describe("hasSchemaSummary", () => {
  it("false cuando no hay nada que mostrar — el caller oculta el resumen", () => {
    // Mostrar "0 tablas" se leería como "el esquema está mal"; mejor no mostrar.
    expect(hasSchemaSummary({ tables: [], views: [] })).toBe(false);
  });

  it("true con al menos una tabla o una vista", () => {
    expect(hasSchemaSummary({ tables: ["a"], views: [] })).toBe(true);
    expect(hasSchemaSummary({ tables: [], views: ["v"] })).toBe(true);
  });
});
