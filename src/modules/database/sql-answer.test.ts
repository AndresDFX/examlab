import { describe, expect, it } from "vitest";
import {
  formatCell,
  formatNotice,
  isSqlAnswerBlank,
  MAX_NOTICES,
  MAX_PERSISTED_ROWS,
  parseSqlAnswer,
  renderTable,
  serializeSqlAnswer,
  sqlResultsForDisplay,
  sqlSourceForDisplay,
  type SqlAnswer,
} from "./sql-answer";
import { LIST_TABLES_SQL } from "./sql-help";

const answer = (over: Partial<SqlAnswer> = {}): SqlAnswer => ({
  sql: "SELECT 1 AS n;",
  results: [{ sql: "SELECT 1 AS n", columns: ["n"], rows: [["1"]] }],
  ...over,
});

describe("formatCell", () => {
  it("NULL se rinde en MAYÚSCULAS y distinto de la cadena 'null'", () => {
    // Es el corazón del tema: confundir NULL con 'null' es el error más común
    // que se enseña a detectar. Si se vieran igual, el error sería invisible.
    expect(formatCell(null)).toBe("NULL");
    expect(formatCell(undefined)).toBe("NULL");
    expect(formatCell("null")).toBe("null");
  });

  it("números, booleanos y fechas", () => {
    expect(formatCell(0)).toBe("0");
    expect(formatCell(false)).toBe("false");
    expect(formatCell(new Date("2026-08-08T00:00:00.000Z"))).toBe("2026-08-08T00:00:00.000Z");
  });

  it("objetos van como JSON (jsonb de Postgres)", () => {
    expect(formatCell({ a: 1 })).toBe('{"a":1}');
  });

  it("celdas larguísimas se recortan (no inflan el JSON de la respuesta)", () => {
    const out = formatCell("x".repeat(2000));
    expect(out.length).toBeLessThan(600);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("serializar / parsear", () => {
  it("ida y vuelta preserva SQL y resultados", () => {
    const p = parseSqlAnswer(serializeSqlAnswer(answer()));
    expect(p?.sql).toBe("SELECT 1 AS n;");
    expect(p?.results[0].columns).toEqual(["n"]);
    expect(p?.results[0].rows).toEqual([["1"]]);
  });

  it("recorta a MAX_PERSISTED_ROWS: un SELECT * no debe inflar la fila", () => {
    const rows = Array.from({ length: 500 }, (_, i) => [String(i)]);
    const p = parseSqlAnswer(
      serializeSqlAnswer(answer({ results: [{ sql: "SELECT * FROM t", columns: ["i"], rows }] })),
    );
    expect(p?.results[0].rows).toHaveLength(MAX_PERSISTED_ROWS);
  });

  it("preserva el error de Postgres (es la evidencia de qué falló)", () => {
    const p = parseSqlAnswer(
      serializeSqlAnswer(
        answer({ results: [{ sql: "SELECT nope", columns: [], rows: [], error: 'column "nope" does not exist' }] }),
      ),
    );
    expect(p?.results[0].error).toContain("does not exist");
  });

  it("preserva affectedRows de un INSERT/UPDATE", () => {
    const p = parseSqlAnswer(
      serializeSqlAnswer(answer({ results: [{ sql: "INSERT …", columns: [], rows: [], affectedRows: 3 }] })),
    );
    expect(p?.results[0].affectedRows).toBe(3);
  });

  it("parsear es tolerante: nada que no sea una respuesta bd_sql da null", () => {
    expect(parseSqlAnswer("texto plano de otra pregunta")).toBeNull();
    expect(parseSqlAnswer('{"v86":1,"transcript":"x"}')).toBeNull(); // respuesta de so_consola
    expect(parseSqlAnswer("{roto")).toBeNull();
    expect(parseSqlAnswer(null)).toBeNull();
    expect(parseSqlAnswer("")).toBeNull();
  });
});

describe("isSqlAnswerBlank", () => {
  it("SQL escrito pero NO ejecutado NO es blanco", () => {
    // El alumno respondió; solo no lo probó. Tratarlo como blanco dispararía la
    // confirmación de "entregar con respuestas vacías" a quien sí contestó.
    expect(isSqlAnswerBlank(serializeSqlAnswer({ sql: "SELECT 1;", results: [] }))).toBe(false);
  });

  it("sin SQL sí es blanco, aunque haya resultados viejos", () => {
    expect(
      isSqlAnswerBlank(serializeSqlAnswer({ sql: "   ", results: answer().results })),
    ).toBe(true);
  });

  it("no-bd_sql cae al criterio de texto plano", () => {
    expect(isSqlAnswerBlank("")).toBe(true);
    expect(isSqlAnswerBlank("  ")).toBe(true);
    expect(isSqlAnswerBlank("algo")).toBe(false);
  });
});

describe("renderTable", () => {
  it("alinea columnas y marca el conjunto vacío", () => {
    const t = renderTable(["id", "nombre"], []);
    expect(t).toContain("(0 filas)");
  });

  it("un SELECT que devuelve 0 filas NO es lo mismo que un error", () => {
    // Distinción pedagógica: "no encontró nada" vs "la consulta está mal".
    const ok = sqlResultsForDisplay(
      serializeSqlAnswer(answer({ results: [{ sql: "SELECT * FROM t WHERE 1=0", columns: ["id"], rows: [] }] })),
    );
    expect(ok).toContain("(0 filas)");
    expect(ok).not.toContain("ERROR");
  });

  it("capea el ancho de columna para que un TEXT largo no rompa la tabla", () => {
    const t = renderTable(["c"], [["y".repeat(200)]]);
    const maxLine = Math.max(...t.split("\n").map((l) => l.length));
    expect(maxLine).toBeLessThanOrEqual(45);
  });
});

describe("sqlResultsForDisplay / sqlSourceForDisplay", () => {
  it("rinde una sección por sentencia, en orden", () => {
    const out = sqlResultsForDisplay(
      serializeSqlAnswer(
        answer({
          results: [
            { sql: "CREATE TABLE t(id int)", columns: [], rows: [], affectedRows: 0 },
            { sql: "SELECT * FROM t", columns: ["id"], rows: [] },
          ],
        }),
      ),
    );
    expect(out).toContain("Sentencia 1");
    expect(out).toContain("Sentencia 2");
    expect(out!.indexOf("Sentencia 1")).toBeLessThan(out!.indexOf("Sentencia 2"));
  });

  it("un DDL sin filas informa filas afectadas, no una tabla vacía", () => {
    const out = sqlResultsForDisplay(
      serializeSqlAnswer(answer({ results: [{ sql: "CREATE TABLE t(id int)", columns: [], rows: [], affectedRows: 0 }] })),
    );
    expect(out).toContain("fila(s) afectada(s)");
  });

  it("avisa cuando el resultado quedó recortado", () => {
    const rows = Array.from({ length: MAX_PERSISTED_ROWS }, (_, i) => [String(i)]);
    const out = sqlResultsForDisplay(
      serializeSqlAnswer(answer({ results: [{ sql: "SELECT * FROM t", columns: ["i"], rows }] })),
    );
    expect(out).toContain("recortado");
  });

  it("null cuando no es una respuesta bd_sql (el caller usa el raw tal cual)", () => {
    expect(sqlResultsForDisplay("texto de otra pregunta")).toBeNull();
    expect(sqlSourceForDisplay("texto de otra pregunta")).toBeNull();
  });

  it("sqlSourceForDisplay devuelve el SQL del alumno", () => {
    expect(sqlSourceForDisplay(serializeSqlAnswer(answer()))).toBe("SELECT 1 AS n;");
  });
});

describe("isSqlAnswerBlank — lo que insertó un botón no es una respuesta", () => {
  it("una hoja que SOLO tiene la consulta de la ayuda sigue en blanco", () => {
    // El botón "Agregar al editor" de la ayuda "¿qué tablas hay?" escribe en el
    // editor, y eso persiste. Sin descontarlo, pulsar un botón de AYUDA y no
    // contestar nada hacía que la pregunta contara como respondida: el aviso de
    // "entregás con N en blanco" no la listaba y el monitor del docente la sumaba.
    expect(isSqlAnswerBlank(serializeSqlAnswer({ sql: LIST_TABLES_SQL, results: [] }))).toBe(true);
  });

  it("no importa el espaciado ni las mayúsculas con que haya quedado", () => {
    const raro = `  ${LIST_TABLES_SQL.toUpperCase().replace(/ /g, "\n  ")}  `;
    expect(isSqlAnswerBlank(serializeSqlAnswer({ sql: raro, results: [] }))).toBe(true);
  });

  it("pero si además escribió algo propio, SÍ respondió", () => {
    const conRespuesta = `${LIST_TABLES_SQL}\n\nselect * from clientes;`;
    expect(isSqlAnswerBlank(serializeSqlAnswer({ sql: conRespuesta, results: [] }))).toBe(false);
  });

  it("y un string plano igual a la consulta de la ayuda tampoco es respuesta", () => {
    // Camino sin serializar (respuesta vieja o de otro flujo).
    expect(isSqlAnswerBlank(LIST_TABLES_SQL)).toBe(true);
    expect(isSqlAnswerBlank("select 1")).toBe(false);
  });
});

describe("avisos de Postgres (RAISE NOTICE)", () => {
  it("se formatean como psql, con DETAIL y HINT cuando vienen", () => {
    expect(formatNotice({ severity: "NOTICE", message: "Insumo 3 dado de baja" })).toBe(
      "NOTICE:  Insumo 3 dado de baja",
    );
    expect(formatNotice({ severity: "WARNING", message: "ojo", detail: "d", hint: "h" })).toBe(
      "WARNING:  ojo\nDETAIL:  d\nHINT:  h",
    );
    // Sin severidad (no debería pasar) se asume NOTICE en vez de dejar «:  …».
    expect(formatNotice({ message: "x" })).toBe("NOTICE:  x");
  });

  it("se guardan con su sentencia y sobreviven ida y vuelta", () => {
    const a = answer({
      results: [{ sql: "CALL p()", columns: [], rows: [], affectedRows: 0, notices: ["NOTICE:  hola"] }],
    });
    expect(parseSqlAnswer(serializeSqlAnswer(a))?.results[0].notices).toEqual(["NOTICE:  hola"]);
  });

  it("se recortan: un RAISE NOTICE dentro de un bucle no debe inflar la respuesta", () => {
    const muchos = Array.from({ length: MAX_NOTICES + 20 }, (_, i) => `NOTICE:  ${i}`);
    const a = answer({ results: [{ sql: "DO $$ … $$", columns: [], rows: [], notices: muchos }] });
    const leido = parseSqlAnswer(serializeSqlAnswer(a))?.results[0];
    expect(leido?.notices).toHaveLength(MAX_NOTICES);
    // Y se dice: una salida recortada no puede leerse como un bucle más corto.
    expect(leido?.noticesTruncated).toBe(true);
    expect(sqlResultsForDisplay(serializeSqlAnswer(a))).toContain(
      `recortado a los primeros ${MAX_NOTICES} avisos`,
    );
  });

  it("una respuesta guardada antes de existir los avisos sigue leyéndose igual", () => {
    expect(parseSqlAnswer(serializeSqlAnswer(answer()))?.results[0].notices).toBeUndefined();
  });

  it("llegan al texto que lee quien califica, ANTES del resultado (como psql)", () => {
    const raw = serializeSqlAnswer(
      answer({
        results: [
          {
            sql: "CALL sp_baja(3)",
            columns: [],
            rows: [],
            affectedRows: 0,
            notices: ["NOTICE:  Insumo 3 dado de baja"],
          },
          {
            sql: "CALL sp_baja(9)",
            columns: [],
            rows: [],
            error: "El insumo 9 no existe",
            notices: ["NOTICE:  buscando 9"],
          },
        ],
      }),
    );
    const txt = sqlResultsForDisplay(raw) ?? "";
    expect(txt).toContain("CALL sp_baja(3)\nNOTICE:  Insumo 3 dado de baja\nOK");
    expect(txt).toContain("NOTICE:  buscando 9\nERROR: El insumo 9 no existe");
  });
});
