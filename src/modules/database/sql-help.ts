/**
 * Las dos piezas que necesita la ayuda de "¿qué tablas hay en la base?":
 * la consulta y la regla con la que se inserta en un editor.
 *
 * Viven en un módulo PURO (sin React) porque las comparten el runner de
 * `bd_sql`, la hoja de SQL de la pizarra y —lo que obliga a que sean puras— el
 * predicado de "respuesta en blanco" de `sql-answer.ts`, que corre en el monitor
 * del docente sin montar nada. Además es lo único del área testeable sin Monaco.
 */

/**
 * Consulta que responde qué hay REALMENTE en la base. Verificada contra
 * PGlite 0.5.4.
 *
 * Devuelve tablas **y vistas** (`table_type` = `BASE TABLE` | `VIEW`), que es
 * el motivo de usar `information_schema.tables` y no `pg_tables`: ese último
 * omite las vistas, y una vista que el docente creó en el esquema de partida
 * es exactamente el objeto que el alumno va a consultar.
 *
 * **En una sola línea a propósito**: el mismo string se MUESTRA en pantalla y
 * se INSERTA en el editor. Con dos formas (una bonita para mostrar, otra para
 * insertar) la que se ve y la que se ejecuta se desincronizan; Monaco va con
 * `wordWrap` encendido, así que una línea larga se lee igual.
 *
 * No es traducible: es código, y un `en.json` "traducido" produciría una
 * consulta que no corre. Mismo criterio que `sql-generation-prompt.ts`.
 */
export const LIST_TABLES_SQL =
  "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;";

/**
 * Agrega `addition` al final de `base` dejando una línea en blanco entre
 * bloques. **Nunca pisa lo que ya estaba.**
 *
 * La regla es del repo y no es cosmética: estas superficies se usan en vivo
 * frente al curso (y en un examen cronometrado), así que reemplazar en
 * silencio lo que la persona escribió es el peor resultado posible, y un
 * diálogo de confirmación en medio de la clase es fricción. Agregar es
 * reversible a ojo —el bloque nuevo se ve al final—; reemplazar no.
 */
export function appendSqlBlock(base: string, addition: string): string {
  const head = (base ?? "").trimEnd();
  const tail = (addition ?? "").trim();
  if (!tail) return head;
  return head ? `${head}\n\n${tail}\n` : `${tail}\n`;
}
