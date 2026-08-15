/**
 * Resumen del esquema de partida de una hoja/pregunta SQL.
 *
 * Para qué: el `setupSql` corre en silencio antes de la consulta, así que quien
 * escribe la consulta no tiene forma de saber CONTRA QUÉ la escribe. Con 30
 * líneas de CREATE TABLE + INSERT hay que leerlas todas para recordar si la
 * tabla se llama `cliente` o `clientes`. Mostrar los nombres detectados convierte
 * eso en un vistazo, y además confirma que el esquema se entendió antes de
 * ejecutar nada.
 *
 * ── Es una AYUDA, no un parser de SQL ────────────────────────────────
 * Se detecta con expresiones regulares a propósito: un parser de verdad (o
 * ejecutar el DDL para introspeccionar) costaría muchísimo más que el valor de
 * un chip informativo, y el resultado REAL siempre lo da Postgres al ejecutar.
 * Consecuencia aceptada: puede omitir declaraciones exóticas (`CREATE TABLE` con
 * comentarios raros en medio, DDL generado dinámicamente). Nunca debe INVENTAR
 * una tabla que no está escrita, y por eso el patrón exige la palabra clave
 * literal. Si no detecta nada, el caller no muestra el resumen — no muestra
 * "0 tablas", que se leería como "el esquema está mal".
 */

/**
 * Deja fuera todo lo que NO es DDL ejecutable, para no leer nombres de tabla
 * donde no hay una tabla:
 *
 *  - **Comentarios** (`-- …`, `/* … *\/`): una tabla comentada no existe.
 *  - **Literales de texto** (`'…'`, con `''` como escape): un
 *    `INSERT INTO log VALUES ('create table falso')` NO declara `falso`. Sin
 *    esto el resumen mostraba una tabla fantasma — lo detectó su propio test.
 *  - **Bloques dollar-quoted** (`$$ … $$`, `$tag$ … $tag$`): son cuerpos de
 *    función PL/pgSQL. Un `CREATE TABLE` ahí adentro no se ejecuta al cargar el
 *    esquema, solo si alguien invoca la función.
 *
 * El orden importa: los dollar-quoted van primero porque su contenido puede
 * incluir comillas y guiones que confundirían a los otros patrones.
 */
function stripNonDdl(sql: string): string {
  return sql
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/'(?:''|[^'])*'/g, " '' ");
}

/**
 * Quita comillas y el prefijo de esquema de un identificador Postgres.
 * `public."Cliente"` → `Cliente`. Se preserva la capitalización: en Postgres un
 * identificador entre comillas ES sensible a mayúsculas, así que normalizarlo
 * mostraría un nombre con el que la consulta podría no funcionar.
 */
function cleanIdentifier(raw: string): string {
  const last = raw.trim().split(".").pop() ?? "";
  return last.replace(/^"(.*)"$/, "$1").trim();
}

const CREATE_TABLE_RE =
  /\bcreate\s+(?:global\s+|local\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?("[^"]+"|[a-z_][\w$]*)(?:\s*\.\s*("[^"]+"|[a-z_][\w$]*))?/gi;

const CREATE_VIEW_RE =
  /\bcreate\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+|materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?("[^"]+"|[a-z_][\w$]*)(?:\s*\.\s*("[^"]+"|[a-z_][\w$]*))?/gi;

function namesFrom(sql: string, re: RegExp): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // `matchAll` sobre una regex con /g: cada match trae el identificador y,
  // cuando venía calificado (`public.cliente`), el nombre real en el grupo 2.
  for (const m of sql.matchAll(re)) {
    const name = cleanIdentifier(m[2] ?? m[1] ?? "");
    if (!name) continue;
    // Dedup case-insensitive: `cliente` y `Cliente` en el mismo script son la
    // misma tabla para quien lee el resumen (Postgres las plegaría a minúscula
    // salvo que estén entre comillas).
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export interface SqlSchemaSummary {
  tables: string[];
  views: string[];
}

/** Tablas y vistas que DECLARA el `setupSql`, en orden de aparición. */
export function summarizeSetupSql(setupSql: string | null | undefined): SqlSchemaSummary {
  if (typeof setupSql !== "string" || !setupSql.trim()) return { tables: [], views: [] };
  const sql = stripNonDdl(setupSql);
  return { tables: namesFrom(sql, CREATE_TABLE_RE), views: namesFrom(sql, CREATE_VIEW_RE) };
}

/** ¿Hay algo que valga la pena mostrar como resumen? */
export function hasSchemaSummary(s: SqlSchemaSummary): boolean {
  return s.tables.length > 0 || s.views.length > 0;
}
