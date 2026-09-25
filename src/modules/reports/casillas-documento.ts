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

/**
 * Escribe el CUERPO de una sección cuyo título vive en la misma celda.
 *
 * El Acuerdo tiene secciones de ancho completo —«Acuerdo sobre los aspectos
 * metodológicos»— donde el título y su texto son dos párrafos dentro del MISMO
 * `<td>`. `fijarCasilla` no sirve ahí: busca la celda siguiente, y la siguiente
 * es la de la sección de abajo, así que escribiría el texto de metodología
 * dentro de la de evaluación. Se comprobó leyendo el HTML real antes de usarla.
 *
 * Reemplaza todo lo que sigue al párrafo del título, hasta cerrar la celda, por
 * un párrafo por cada bloque separado con línea en blanco. El HTML que viene
 * del `.docx` tiene etiquetas sin cerrar —hay `<span>` que terminan en `</p>`—
 * así que no se intenta editar los párrafos existentes: se reemplaza el tramo
 * entero, que es lo único predecible sobre un marcado así.
 *
 * Devuelve `null` si no encuentra el título o su celda, o si el valor viene
 * vacío: borrar el cuerpo de una sección de un documento firmado tiene que ser
 * una acción explícita.
 */
export function fijarCuerpoDeSeccion(
  html: string | null | undefined,
  titulo: string,
  valor: string | null | undefined,
): string | null {
  if (!html || !valor || !valor.trim()) return null;
  const iTitulo = html.indexOf(`>${titulo}<`);
  if (iTitulo < 0) return null;

  // La celda que contiene el título.
  const iCelda = html.lastIndexOf("<td", iTitulo);
  const iFinCelda = html.indexOf("</td>", iTitulo);
  if (iCelda < 0 || iFinCelda < 0) return null;

  // El párrafo del título termina en el primer `</p>` posterior.
  const iFinTitulo = html.indexOf("</p>", iTitulo);
  if (iFinTitulo < 0 || iFinTitulo > iFinCelda) return null;
  const desde = iFinTitulo + "</p>".length;

  const cuerpo = valor
    .trim()
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map(
      (b) =>
        `<p style="text-align:justify"><span style="font-size:9pt">${b
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br />")}</span></p>`,
    )
    .join("");

  return html.slice(0, desde) + cuerpo + html.slice(iFinCelda);
}

/** Lo que dice hoy el cuerpo de una sección, en texto plano. */
export function leerCuerpoDeSeccion(
  html: string | null | undefined,
  titulo: string,
): string | null {
  if (!html) return null;
  const iTitulo = html.indexOf(`>${titulo}<`);
  if (iTitulo < 0) return null;
  const iFinCelda = html.indexOf("</td>", iTitulo);
  const iFinTitulo = html.indexOf("</p>", iTitulo);
  if (iFinCelda < 0 || iFinTitulo < 0 || iFinTitulo > iFinCelda) return null;
  return html
    .slice(iFinTitulo + 4, iFinCelda)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
