/**
 * (De)serialización y formateo de la respuesta de una pregunta `bd_sql`
 * (PostgreSQL real vía PGlite/WASM en el navegador).
 *
 * Es el análogo de `serverconsole/v86-answer.ts`: la "respuesta" del alumno NO
 * es solo el texto que escribió, es **el SQL + lo que la base le contestó**. Se
 * persisten los dos juntos en la columna de respuesta existente (JSON), sin
 * columnas nuevas — mismo criterio que v86 y que el simulador de red.
 *
 * Por qué el resultado se guarda y no se recalcula al calificar: la base es
 * EFÍMERA y vive en el navegador del alumno. Si no se persiste lo que devolvió,
 * la evidencia se pierde al cerrar la pestaña y no hay con qué calificar ni con
 * qué responder un reclamo. Es exactamente la lección del análisis de entornos
 * efímeros: el entorno muere, la evidencia queda.
 *
 * TODO lo de este archivo es PURO (sin DOM, sin red) para poder testearlo.
 */

// `sql-help` no importa este módulo: no hay ciclo.
import { LIST_TABLES_SQL } from "@/modules/database/sql-help";

/** Una sentencia ejecutada y su resultado, ya normalizado a texto. */
export interface SqlStatementResult {
  /** El SQL de esta sentencia, tal como se envió. */
  sql: string;
  /** Nombres de columna, si la sentencia devolvió filas. */
  columns: string[];
  /** Filas como matriz de celdas ya formateadas a texto. */
  rows: string[][];
  /** Filas afectadas (INSERT/UPDATE/DELETE), cuando aplica. */
  affectedRows?: number;
  /** Mensaje de error de Postgres, si la sentencia falló. */
  error?: string;
}

export interface SqlAnswer {
  /** El SQL que el alumno escribió (fuente, sin tocar). */
  sql: string;
  /** Resultado de cada sentencia, en orden de ejecución. */
  results: SqlStatementResult[];
  /** ISO de la última ejecución, para que el docente sepa si el resultado
   *  corresponde al SQL guardado o quedó de un intento anterior. */
  executedAt?: string;
}

/** Tope del SQL persistido. Un ejercicio de clase son decenas de líneas; esto
 *  ataja un pegado accidental de un dump entero. */
const MAX_SQL_CHARS = 100_000;
/** Tope de filas que se PERSISTEN por sentencia. Un `SELECT *` sobre una tabla
 *  sembrada puede devolver miles: no cabe en la fila de la respuesta ni aporta
 *  a la calificación. Se guarda el principio, que es lo que se revisa. */
export const MAX_PERSISTED_ROWS = 50;
/** Tope de celdas individuales (un TEXT largo no debe inflar el JSON). */
const MAX_CELL_CHARS = 500;

/**
 * Formatea una celda de Postgres a texto.
 *
 * `null` se rinde como `NULL` en MAYÚSCULAS a propósito: en SQL la diferencia
 * entre `NULL` y la cadena `'null'` es justo lo que se está enseñando, y
 * mostrarlos igual haría invisible el error más común del tema.
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  const s = String(value);
  return s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) + "…" : s;
}

export function serializeSqlAnswer(answer: SqlAnswer): string {
  const results = (answer.results ?? []).map((r) => ({
    sql: (r.sql ?? "").slice(0, MAX_SQL_CHARS),
    columns: r.columns ?? [],
    rows: (r.rows ?? []).slice(0, MAX_PERSISTED_ROWS),
    ...(r.affectedRows !== undefined ? { affectedRows: r.affectedRows } : {}),
    ...(r.error ? { error: r.error } : {}),
  }));
  return JSON.stringify({
    bdSql: 1,
    sql: (answer.sql ?? "").slice(0, MAX_SQL_CHARS),
    results,
    ...(answer.executedAt ? { executedAt: answer.executedAt } : {}),
  });
}

/** Tolerante: devuelve null si `raw` no es una respuesta `bd_sql` válida. */
export function parseSqlAnswer(raw: unknown): SqlAnswer | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || obj.bdSql !== 1) return null;
    const rawResults = Array.isArray(obj.results) ? obj.results : [];
    const results: SqlStatementResult[] = rawResults.map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      return {
        sql: typeof o.sql === "string" ? o.sql : "",
        columns: Array.isArray(o.columns) ? o.columns.map((c) => String(c)) : [],
        rows: Array.isArray(o.rows)
          ? o.rows.map((row) => (Array.isArray(row) ? row.map((c) => String(c)) : []))
          : [],
        ...(typeof o.affectedRows === "number" ? { affectedRows: o.affectedRows } : {}),
        ...(typeof o.error === "string" && o.error ? { error: o.error } : {}),
      };
    });
    return {
      sql: typeof obj.sql === "string" ? obj.sql : "",
      results,
      ...(typeof obj.executedAt === "string" ? { executedAt: obj.executedAt } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * ¿La respuesta está en blanco?
 *
 * Ojo con el criterio: escribir SQL y NO ejecutarlo **no** es una respuesta en
 * blanco — el alumno respondió, simplemente no lo probó. Solo cuenta como
 * blanco si no hay SQL. Tratar "sin ejecutar" como blanco dispararía la
 * confirmación de "entregar con respuestas vacías" a alguien que sí contestó.
 *
 * **Lo que el alumno NO escribió no cuenta como respuesta.** La ayuda "¿qué
 * tablas hay?" tiene un botón que AGREGA su consulta al editor: sin descontarla,
 * pulsar un botón de ayuda y no contestar nada dejaba la hoja no vacía y la
 * pregunta pasaba a contar como respondida — así el aviso de "entregás con N en
 * blanco" no la listaba y el monitor del docente la sumaba. Es el mismo criterio
 * que ya rige para `codigo`, donde una plantilla intacta es NO respondida
 * (`starters.ts`); ver la tabla de invariantes cross-file de CLAUDE.md.
 */
export function isSqlAnswerBlank(raw: unknown): boolean {
  const parsed = parseSqlAnswer(raw);
  if (!parsed) return sinContenidoPropio(typeof raw === "string" ? raw : "");
  return sinContenidoPropio(parsed.sql);
}

/** Normaliza espacios y mayúsculas para comparar SQL "a ojo". */
function normalizarSql(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** ¿Queda algo que haya escrito el alumno, descontando lo que insertó un botón? */
function sinContenidoPropio(sql: string): boolean {
  const n = normalizarSql(sql);
  if (!n) return true;
  return n === normalizarSql(LIST_TABLES_SQL);
}

/** El SQL del alumno, para el editor y para el prompt de la IA. `null` si no es
 *  una respuesta `bd_sql` (así el caller usa el `raw` tal cual). */
export function sqlSourceForDisplay(raw: unknown): string | null {
  const parsed = parseSqlAnswer(raw);
  if (!parsed) return null;
  return parsed.sql.trim() || null;
}

/**
 * Rinde los resultados como TABLAS de texto plano, legibles por un humano en un
 * `<pre>` y por el modelo que califica.
 *
 * Se usa texto alineado y no JSON porque es lo que un docente lee de un vistazo
 * y lo que un modelo interpreta mejor como "salida de una consulta". Es el mismo
 * papel que cumple el transcript de la consola en `so_consola`, y viaja al
 * prompt por el MISMO campo (`executionOutput`), así que la IA ya sabe leerlo.
 */
export function sqlResultsForDisplay(raw: unknown): string | null {
  const parsed = parseSqlAnswer(raw);
  if (!parsed || parsed.results.length === 0) return null;
  const blocks = parsed.results.map((r, i) => renderStatementBlock(r, i + 1));
  return blocks.join("\n\n").trim() || null;
}

function renderStatementBlock(r: SqlStatementResult, n: number): string {
  const head = `── Sentencia ${n} ──\n${r.sql.trim()}`;
  if (r.error) return `${head}\nERROR: ${r.error}`;
  if (r.columns.length === 0) {
    const n2 = r.affectedRows ?? 0;
    return `${head}\nOK — ${n2} fila(s) afectada(s)`;
  }
  return `${head}\n${renderTable(r.columns, r.rows)}${
    r.rows.length >= MAX_PERSISTED_ROWS ? `\n… (recortado a ${MAX_PERSISTED_ROWS} filas)` : ""
  }`;
}

/**
 * Tabla de texto con columnas alineadas.
 *
 * El ancho se calcula por columna sobre las celdas presentes; se capea a 40
 * caracteres para que una columna con un TEXT largo no empuje la tabla a 300
 * caracteres de ancho y la vuelva ilegible en el `<pre>`.
 */
export function renderTable(columns: string[], rows: string[][]): string {
  if (columns.length === 0) return "";
  const CAP = 40;
  const widths = columns.map((c, i) =>
    Math.min(
      CAP,
      Math.max(c.length, ...rows.map((r) => (r[i] ?? "").length), 0),
    ),
  );
  const pad = (s: string, w: number) => {
    const t = s.length > w ? s.slice(0, w - 1) + "…" : s;
    return t + " ".repeat(Math.max(0, w - t.length));
  };
  const header = columns.map((c, i) => pad(c, widths[i])).join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  if (rows.length === 0) return `${header}\n${sep}\n(0 filas)`;
  const body = rows.map((r) => columns.map((_, i) => pad(r[i] ?? "", widths[i])).join(" | "));
  return [header, sep, ...body].join("\n");
}
