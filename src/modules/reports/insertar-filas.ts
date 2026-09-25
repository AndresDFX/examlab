/**
 * Agregar estudiantes a un Acuerdo ya generado, DENTRO de su listado.
 *
 * Antes, «agregar matriculados faltantes» envolvía las filas nuevas en una
 * tabla aparte con el título «Estudiantes matriculados con posterioridad» y la
 * concatenaba al final del documento. El resultado era un acta partida en dos:
 * 33 estudiantes en una tabla y uno solo en otra, debajo del bloque de firmas.
 * Para quien lee el acta —una coordinación, una auditoría— eso no es una
 * aclaración útil, es un documento que parece incompleto. La numeración además
 * volvía a arrancar en 1.
 *
 * Acá las filas van a la MISMA tabla, al final del listado.
 *
 * Dos cosas que hacen esto menos frágil de lo que parece:
 *
 *  - No se busca «la tabla de estudiantes» por su título ni por su posición,
 *    que cambian con cada plantilla. Se busca la tabla que contiene MÁS filas
 *    con ranura de firma. En un Acuerdo esa es siempre el listado: el bloque de
 *    firmas del docente y el vocero tiene dos o tres, y el listado tiene una por
 *    estudiante. Con un empate se toma la primera, que es la que aparece antes
 *    en el documento.
 *  - Si no hay ninguna tabla con ranuras, se devuelve `null` en vez de insertar
 *    a ciegas. El caller decide qué hacer; escribir en el lugar equivocado de un
 *    documento firmado es peor que no escribir.
 *
 * Sin React ni DOM: opera sobre el string, igual que `signature-slots`, porque
 * el HTML del informe también se manipula desde el servidor.
 */
import { ATTR_UID } from "./signature-slots";

/** Un `<table>…</table>` de nivel superior, con sus límites en el string. */
interface Tabla {
  inicio: number;
  fin: number;
  filasConRanura: number;
}

/**
 * Recorre las tablas de nivel superior. Lleva la cuenta de anidamiento para que
 * una tabla adentro de otra no corte el cierre de la de afuera — el HTML de
 * estas plantillas viene de un `.docx` y anida tablas con frecuencia.
 */
function tablas(html: string): Tabla[] {
  const salida: Tabla[] = [];
  const re = /<\/?table\b[^>]*>/gi;
  let profundidad = 0;
  let inicio = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const esCierre = m[0].startsWith("</");
    if (!esCierre) {
      if (profundidad === 0) inicio = m.index;
      profundidad++;
      continue;
    }
    profundidad--;
    if (profundidad === 0 && inicio >= 0) {
      const fin = m.index + m[0].length;
      const cuerpo = html.slice(inicio, fin);
      salida.push({
        inicio,
        fin,
        filasConRanura: (cuerpo.match(new RegExp(ATTR_UID, "g")) ?? []).length,
      });
      inicio = -1;
    }
    if (profundidad < 0) profundidad = 0; // cierre huérfano: no arrastra el resto
  }
  return salida;
}

/** La tabla que hace de listado de estudiantes, o `null` si no hay ninguna. */
export function tablaDelListado(html: string | null | undefined): Tabla | null {
  if (!html) return null;
  let mejor: Tabla | null = null;
  for (const t of tablas(html)) {
    if (t.filasConRanura === 0) continue;
    if (!mejor || t.filasConRanura > mejor.filasConRanura) mejor = t;
  }
  return mejor;
}

/**
 * Inserta `filasHtml` al final del listado de estudiantes.
 *
 * Devuelve el HTML nuevo, o `null` si no se encontró dónde ponerlas.
 */
export function insertarEnListado(
  html: string | null | undefined,
  filasHtml: string,
): string | null {
  if (!html || !filasHtml.trim()) return null;
  const t = tablaDelListado(html);
  if (!t) return null;
  const cuerpo = html.slice(t.inicio, t.fin);
  // Antes del `</tbody>` si existe, y si no antes del `</table>`. Meterlas
  // después del `</tbody>` las deja fuera del cuerpo: los navegadores lo
  // toleran, Word no.
  const iTbody = cuerpo.toLowerCase().lastIndexOf("</tbody>");
  const punto = iTbody >= 0 ? iTbody : cuerpo.toLowerCase().lastIndexOf("</table>");
  if (punto < 0) return null;
  const nuevo = cuerpo.slice(0, punto) + filasHtml + cuerpo.slice(punto);
  return html.slice(0, t.inicio) + nuevo + html.slice(t.fin);
}
