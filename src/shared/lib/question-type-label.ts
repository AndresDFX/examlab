/**
 * Etiqueta legible de un tipo de pregunta. Fuente única.
 *
 * ── Por qué existe ────────────────────────────────────────────────────
 * El tipo interno (`cerrada`, `bd_sql`, `cerrada_multi`, `codigo_zip`…) no es
 * para el usuario. Se pintaba crudo con `className="capitalize"` en 6 lugares
 * —el editor y el taker de talleres, los de proyectos, el grid del docente y la
 * revisión del alumno— y `capitalize` **no arregla el guion bajo**: por UAX#29
 * el `_` une palabras, así que en pantalla salía «Bd_sql», «Cerrada_multi» y
 * «Codigo_zip», con el guion a la vista.
 *
 * El mapa ya existía en `app.student.take.$examId.tsx` con un comentario que
 * declaraba la intención («el alumno NO debe ver el código interno crudo»),
 * pero vivía dentro de esa pantalla, así que ninguna otra lo usaba. Esto lo
 * saca a un módulo para que la próxima pantalla no tenga que redescubrirlo.
 *
 * ── Nota sobre `cerrada` vs `cerrada_multi` ───────────────────────────
 * El selector de tipo del taller usaba `workshopQuestions.typeClosedSingle`
 * («Opción múltiple») para LOS DOS, así que la lista mostraba la misma etiqueta
 * repetida y el docente no podía distinguirlas. Las claves del banco de
 * preguntas sí las separan bien —«Selección única» vs «Opción múltiple»— y son
 * las que se usan acá.
 */

/** Tipo → clave i18n. Las de `questionBank.type.*` ya existen en es y en. */
const CLAVE_POR_TIPO: Record<string, string> = {
  abierta: "questionBank.type.abierta",
  cerrada: "questionBank.type.cerrada",
  cerrada_multi: "questionBank.type.cerradaMulti",
  codigo: "questionBank.type.codigo",
  codigo_zip: "questionBank.type.codigoZip",
  diagrama: "questionBank.type.diagrama",
  java_gui: "questionBank.type.javaGui",
  python_gui: "questionBank.type.pythonGui",
  red_consola: "questionBank.type.redConsola",
  red_gui: "questionBank.type.redGui",
  so_consola: "questionBank.type.soConsola",
  bd_sql: "bdSql.typeLabel",
};

/**
 * Clave i18n del tipo, o `null` si es un tipo que el mapa no conoce.
 *
 * Devolver `null` en vez de inventar una clave es deliberado: el caller decide
 * el fallback, y si aparece un tipo nuevo se ve en pantalla que falta agregarlo
 * en vez de mostrar una clave sin traducir.
 */
export function questionTypeLabelKey(type: string | null | undefined): string | null {
  if (!type) return null;
  return CLAVE_POR_TIPO[type] ?? null;
}

/**
 * Etiqueta lista para pintar. `t` es la función de i18next.
 *
 * El fallback para un tipo desconocido reemplaza el guion bajo por un espacio,
 * que es lo que `capitalize` NO hace: así lo peor que puede pasar es
 * «bd sql» en vez de «Bd_sql».
 */
export function questionTypeLabel(
  type: string | null | undefined,
  t: (clave: string) => string,
): string {
  if (!type) return "—";
  const clave = questionTypeLabelKey(type);
  return clave ? t(clave) : type.replace(/_/g, " ");
}

/** Los tipos con etiqueta conocida. Para tests y para armar selectores. */
export const TIPOS_CON_ETIQUETA = Object.keys(CLAVE_POR_TIPO);
