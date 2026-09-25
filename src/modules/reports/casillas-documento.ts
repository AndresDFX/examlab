/**
 * Escribir el valor de una casilla rotulada dentro de un informe ya generado.
 *
 * El informe es una instantánea: lo que no estaba resuelto al generarlo queda
 * en blanco para siempre. En los Acuerdos de septiembre eso dejó sin nombre y
 * sin correo al vocero de tres cursos —se lo designó después— y sin ciudad a
 * cuatro, porque la institución todavía no la tenía cargada.
 *
 * La tabla del Acuerdo es de pares: una celda con el rótulo y la siguiente con
 * el valor. Este módulo escribe **la celda que sigue al rótulo**, y ese detalle
 * es toda la diferencia. La primera versión de este arreglo buscaba «el primer
 * span vacío después del rótulo», y al correrla dos veces sobre el mismo
 * documento el teléfono ya estaba puesto, así que el vacío que encontró fue el
 * de la fila de abajo: escribió el teléfono en la casilla de Ciudad. Anclando a
 * la celda siguiente la función es idempotente por construcción — escribir dos
 * veces el mismo valor deja el mismo documento.
 *
 * Sin DOM: opera sobre el string, como el resto de `signature-slots`, porque el
 * HTML del informe también se manipula fuera del navegador.
 */

/** Escapa lo que va a quedar dentro de una celda. */
function esc(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Lo que dice hoy la casilla que sigue a `etiqueta`, o `null` si no está. */
export function leerCasilla(
  html: string | null | undefined,
  etiqueta: string,
): string | null {
  if (!html) return null;
  const i = html.indexOf(`>${etiqueta}<`);
  if (i < 0) return null;
  const finRotulo = html.indexOf("</td>", i);
  if (finRotulo < 0) return null;
  const m = html.slice(finRotulo).match(/<span[^>]*>([\s\S]*?)<\/span>/);
  return m ? m[1].replace(/&nbsp;/g, " ").trim() : null;
}

/**
 * Escribe `valor` en la casilla que sigue a `etiqueta`.
 *
 * Devuelve el HTML nuevo, o `null` si no encontró el rótulo o la casilla —
 * nunca escribe «en el lugar más parecido». Un valor vacío se ignora: borrar
 * un dato de un documento firmado tiene que ser una acción explícita, no el
 * efecto de pasar un `undefined`.
 */
export function fijarCasilla(
  html: string | null | undefined,
  etiqueta: string,
  valor: string | null | undefined,
): string | null {
  if (!html || !valor || !valor.trim()) return null;
  const i = html.indexOf(`>${etiqueta}<`);
  if (i < 0) return null;
  const finRotulo = html.indexOf("</td>", i);
  if (finRotulo < 0) return null;
  // El span de la celda SIGUIENTE, no «el próximo span vacío»: ver la cabecera.
  const resto = html.slice(finRotulo);
  const m = resto.match(/<span[^>]*>([\s\S]*?)<\/span>/);
  if (!m || m.index === undefined) return null;
  const abs = finRotulo + m.index;
  const apertura = m[0].slice(0, m[0].indexOf(">") + 1);
  return html.slice(0, abs) + apertura + esc(valor.trim()) + "</span>" + html.slice(abs + m[0].length);
}

/**
 * El nombre del vocero no tiene rótulo propio en la misma fila: su celda sigue
 * a «Nombre del vocero», que ocupa la fila entera. Se resuelve con el mismo
 * mecanismo, así que es solo un alias con el rótulo correcto — existe para que
 * el caller no tenga que conocer ese literal.
 */
export const ROTULO_NOMBRE_VOCERO = "Nombre del vocero";
