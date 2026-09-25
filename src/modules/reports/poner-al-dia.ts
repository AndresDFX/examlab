/**
 * Poner al día la ESTRUCTURA de un informe ya generado.
 *
 * `refrescar-datos.ts` corrige lo que DICE cada celda. Esto corrige dos cosas
 * que no son el texto de una celda y que también quedaron congeladas al
 * generar el documento:
 *
 * ── 1. La casilla de firma del vocero ─────────────────────────────────
 *
 * El bloque de firmas del Acuerdo tiene tres recuadros: Docente, Vocero y
 * Director. El del vocero se arma con `ranuraHtml(uidDelVocero)`, y cuando al
 * generar el documento el curso todavía no tenía vocero designado, ese uid es
 * nulo y en su lugar queda un RENGLÓN para firmar a mano. Designarlo después no
 * cambia el documento, así que el recuadro se queda en blanco para siempre y la
 * firma del vocero no tiene dónde dibujarse — que es exactamente lo reportado.
 *
 * Ser vocero no reemplaza ser estudiante: la persona sigue teniendo su fila en
 * el listado, con su propia casilla. Las dos casillas comparten el mismo uid, y
 * eso es lo buscado — `renderizarRanuras` dibuja la firma en TODAS las ranuras
 * de ese uid, así que una sola firma aparece en los dos lugares.
 *
 * ── 2. El orden y la numeración del listado ───────────────────────────
 *
 * El contexto ordena a los estudiantes por nombre, así que el documento se
 * generó con el orden de los nombres de ESE día. Al corregir después un nombre
 * incompleto («Josuan» → «Beltran Castaño Josuhan David») la fila se queda
 * donde estaba, y el listado deja de estar ordenado. Lo mismo con una fila
 * agregada más tarde: entra al final con el número que traía su propio render.
 *
 * Reordenar es mover filas ENTERAS, con su casilla adentro: no se toca ninguna
 * ranura, así que ninguna firma se pierde. Lo único que se reescribe es el
 * número de orden, que por definición depende de la posición.
 *
 * Sin DOM: opera sobre el string, como el resto del módulo.
 */
import { ATTR_UID, ranuraHtml } from "./signature-slots";
import { tablaDelListado } from "./insertar-filas";

/** Las celdas de primer nivel de una fila, con sus límites. */
function celdasDe(fila: string): Array<{ inicio: number; fin: number }> {
  const salida: Array<{ inicio: number; fin: number }> = [];
  const re = /<\/?td\b[^>]*>/gi;
  let prof = 0;
  let ini = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fila)) !== null) {
    if (!m[0].startsWith("</")) {
      if (prof === 0) ini = m.index;
      prof++;
      continue;
    }
    prof--;
    if (prof === 0 && ini >= 0) {
      salida.push({ inicio: ini, fin: m.index + m[0].length });
      ini = -1;
    }
    if (prof < 0) prof = 0;
  }
  return salida;
}

/**
 * Pone la casilla de firma del vocero en su recuadro.
 *
 * Ubica el recuadro por su ROTULO («El Vocero») y por la COLUMNA que ese rótulo
 * ocupa, no por una posición fija: el bloque tiene tres columnas y el orden
 * podría cambiar en otra plantilla. La fila de las firmas es la anterior a la
 * de los rótulos, que es como está armado el bloque.
 *
 * Devuelve `null` si no encuentra el recuadro, si esa celda ya tiene una
 * casilla, o si el uid está vacío — nunca escribe «en el lugar más parecido».
 */
export function fijarRanuraDeVocero(
  html: string | null | undefined,
  uidVocero: string | null | undefined,
  rotulo = "El Vocero",
): string | null {
  if (!html || !uidVocero || !uidVocero.trim()) return null;
  const iRot = html.indexOf(`>${rotulo}<`);
  if (iRot < 0) return null;

  const iniRotulos = html.lastIndexOf("<tr", iRot);
  if (iniRotulos < 0) return null;
  const finRotulos = html.indexOf("</tr>", iRot);
  if (finRotulos < 0) return null;
  const filaRotulos = html.slice(iniRotulos, finRotulos + 5);

  // ¿Qué columna ocupa el rótulo?
  const cs = celdasDe(filaRotulos);
  const col = cs.findIndex((c) => filaRotulos.slice(c.inicio, c.fin).includes(`>${rotulo}<`));
  if (col < 0) return null;

  // La fila de las firmas es la ANTERIOR a la de los rótulos.
  const iniFirmas = html.lastIndexOf("<tr", iniRotulos - 1);
  if (iniFirmas < 0) return null;
  const filaFirmas = html.slice(iniFirmas, iniRotulos);
  const cf = celdasDe(filaFirmas);
  if (col >= cf.length) return null;

  const celda = filaFirmas.slice(cf[col].inicio, cf[col].fin);
  if (celda.includes(ATTR_UID)) return null; // ya tiene casilla: nada que hacer

  // Reemplaza el renglón manual por la casilla. Si no hay renglón, se agrega
  // la casilla al final de la celda.
  const reRenglon = /<span class="examlab-renglon"[^>]*>[\s\S]*?<\/span>/;
  const nueva = reRenglon.test(celda)
    ? celda.replace(reRenglon, ranuraHtml(uidVocero))
    : celda.replace(/<\/td>\s*$/, `${ranuraHtml(uidVocero)}</td>`);
  if (nueva === celda) return null;

  const filaNueva =
    filaFirmas.slice(0, cf[col].inicio) + nueva + filaFirmas.slice(cf[col].fin);
  return html.slice(0, iniFirmas) + filaNueva + html.slice(iniRotulos);
}

/**
 * Reordena y renumera el listado de estudiantes.
 *
 * `ordenPorUid` da la posición de cada persona (la misma que usaría una
 * generación nueva). Un uid ausente del mapa va al final, conservando su orden
 * relativo: es preferible una fila fuera de lugar a una fila perdida.
 */
export function ordenarListado(
  html: string | null | undefined,
  ordenPorUid: ReadonlyMap<string, number>,
): { html: string; reordenado: boolean } {
  if (!html) return { html: "", reordenado: false };
  const t = tablaDelListado(html);
  if (!t) return { html, reordenado: false };

  const cuerpo = html.slice(t.inicio, t.fin);
  const filas = [...cuerpo.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map((m) => ({
    texto: m[0],
    inicio: m.index!,
    fin: m.index! + m[0].length,
  }));
  const conRanura = filas.filter((f) => f.texto.includes(ATTR_UID));
  if (conRanura.length < 2) return { html, reordenado: false };

  // Las filas de firmantes tienen que ser CONTIGUAS para poder reordenarlas sin
  // mover nada más. Si hay algo en el medio (un subtotal, un encabezado), se
  // deja el documento como está en vez de reacomodarlo a ciegas.
  const primera = filas.indexOf(conRanura[0]);
  const ultima = filas.indexOf(conRanura[conRanura.length - 1]);
  if (ultima - primera + 1 !== conRanura.length) return { html, reordenado: false };

  const clave = (f: { texto: string }) => {
    const m = f.texto.match(new RegExp(`${ATTR_UID}="([^"]*)"`));
    const pos = m ? ordenPorUid.get(m[1]) : undefined;
    return pos === undefined ? Number.MAX_SAFE_INTEGER : pos;
  };
  const ordenadas = conRanura
    .map((f, i) => ({ f, i }))
    // Estable: con la misma clave manda el orden en que ya estaban.
    .sort((a, b) => clave(a.f) - clave(b.f) || a.i - b.i)
    .map((x) => x.f);

  // Renumerar la primera celda de cada fila: el número de orden depende de la
  // posición, así que arrastrar el viejo dejaría un listado numerado al azar.
  const renumeradas = ordenadas.map((f, i) => {
    const cs = celdasDe(f.texto);
    const iFirma = cs.findIndex((c) => f.texto.slice(c.inicio, c.fin).includes(ATTR_UID));
    if (iFirma < 1) return f.texto; // sin celdas de datos antes de la firma
    const c = cs[0];
    const celda = f.texto.slice(c.inicio, c.fin);
    const m = celda.match(/<span[^>]*>([\s\S]*?)<\/span>/);
    if (!m || m.index === undefined) return f.texto;
    const apertura = m[0].slice(0, m[0].indexOf(">") + 1);
    const nueva =
      celda.slice(0, m.index) + apertura + String(i + 1) + "</span>" + celda.slice(m.index + m[0].length);
    return f.texto.slice(0, c.inicio) + nueva + f.texto.slice(c.fin);
  });

  const desde = filas[primera].inicio;
  const hasta = filas[ultima].fin;
  const cuerpoNuevo = cuerpo.slice(0, desde) + renumeradas.join("") + cuerpo.slice(hasta);
  const htmlNuevo = html.slice(0, t.inicio) + cuerpoNuevo + html.slice(t.fin);
  return { html: htmlNuevo, reordenado: htmlNuevo !== html };
}
