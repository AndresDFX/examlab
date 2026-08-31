import { describe, expect, it } from "vitest";

import { appendSqlBlock, LIST_TABLES_SQL } from "@/modules/database/sql-help";
import { splitSqlStatements } from "@/modules/database/sql-split";

describe("LIST_TABLES_SQL", () => {
  it("consulta information_schema.tables del esquema public", () => {
    expect(LIST_TABLES_SQL).toContain("information_schema.tables");
    expect(LIST_TABLES_SQL).toContain("table_schema = 'public'");
  });

  it("pide el tipo, para que se distingan tablas de vistas", () => {
    // Es el motivo de no usar `pg_tables`, que omite las vistas.
    expect(LIST_TABLES_SQL).toContain("table_type");
  });

  it("es UNA sola sentencia terminada en punto y coma", () => {
    expect(LIST_TABLES_SQL.trim().endsWith(";")).toBe(true);
    expect(splitSqlStatements(LIST_TABLES_SQL)).toHaveLength(1);
  });

  it("es una sola línea: el mismo string se muestra y se inserta", () => {
    expect(LIST_TABLES_SQL).not.toContain("\n");
  });

  it("no lleva `{{`: en un valor i18n sería interpolación de i18next", () => {
    // No vive en los locales justamente por esto, pero si alguien la mueve
    // ahí, este test es el que avisa que se rompe.
    expect(LIST_TABLES_SQL).not.toContain("{{");
  });
});

describe("appendSqlBlock", () => {
  it("agrega al final y nunca reemplaza lo que ya estaba", () => {
    const out = appendSqlBlock("SELECT 1;", LIST_TABLES_SQL);
    expect(out.startsWith("SELECT 1;")).toBe(true);
    expect(out).toContain(LIST_TABLES_SQL);
  });

  it("separa los bloques con una línea en blanco", () => {
    expect(appendSqlBlock("SELECT 1;", "SELECT 2;")).toBe("SELECT 1;\n\nSELECT 2;\n");
  });

  it("sobre una hoja vacía deja solo el bloque nuevo", () => {
    expect(appendSqlBlock("", "SELECT 2;")).toBe("SELECT 2;\n");
    expect(appendSqlBlock("   \n\n ", "SELECT 2;")).toBe("SELECT 2;\n");
  });

  it("no agrega nada si el bloque nuevo está vacío", () => {
    expect(appendSqlBlock("SELECT 1;\n", "   ")).toBe("SELECT 1;");
  });

  it("el resultado sigue siendo divisible en las dos sentencias", () => {
    // `splitSqlStatements` devuelve cada sentencia SIN su `;` final.
    const out = appendSqlBlock("CREATE TABLE t (id int);", LIST_TABLES_SQL);
    expect(splitSqlStatements(out).map((s) => s.sql.trim())).toEqual([
      "CREATE TABLE t (id int)",
      LIST_TABLES_SQL.replace(/;$/, ""),
    ]);
  });
});
