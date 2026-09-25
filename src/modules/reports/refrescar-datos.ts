/**
 * Refrescar los DATOS de un informe ya generado contra la base actual.
 *
 * El informe es una instantánea: el HTML que se guarda es exactamente lo que se
 * firma. Eso es correcto para las firmas, pero convierte cualquier corrección
 * posterior en algo que el documento nunca se entera. En los Acuerdos de
 * septiembre eso dejó, a la vez: estudiantes con el nombre incompleto con el
 * que se habían registrado («Josuan», «Js Cadavid», «Julio Cesar»), filas sin
 * número de documento porque el dato se cargó después, y al vocero sin nombre
 * ni correo porque se lo designó más tarde.
 *
 * Hasta ahora cada una de esas correcciones se hizo a mano, una por una, con un
 * script distinto. Esto es la alternativa: una función que toma el documento y
 * los datos de hoy, y devuelve el documento con sus celdas al día.
 *
 * ── Lo que NO toca, y es lo que hace que esto sea seguro ──────────────
 *
 * Las celdas de firma. Se reconocen por llevar la ranura (`data-firma-uid`) y
 * se saltan enteras: ni su contenido ni su posición cambian. Una firma ya
 * puesta se dibuja dentro de esa ranura, así que tocarla sería borrar la firma
 * de alguien. Por lo mismo tampoco se agregan ni se quitan filas: refrescar es
 * actualizar lo que dice una celda, nunca cambiar quién está en el documento.
 *
 * ── Cómo se identifica qué celda es cuál ──────────────────────────────
 *
 * Por POSICIÓN dentro de la fila, contando solo las celdas anteriores a la de
 * la firma: la primera es el número de orden, la segunda el nombre y la tercera
 * el documento. Es el orden de las dos plantillas de Acuerdo que existen. Se
 * descartó identificarlas por su contenido (¿es un número? ¿es un nombre?)
 * porque un documento vacío y un nombre vacío son indistinguibles, y porque un
 * apellido con dígitos —o un documento con letras, que existe— lo mandaría a la
 * celda equivocada. Y se descartó buscar el encabezado de la columna porque el
 * listado del Acuerdo no tiene fila de encabezado.
 *
 * Si una fila no tiene esa forma, se devuelve sin tocar en vez de adivinar.
 */
import { ATTR_UID } from "./signature-slots";

/** Los datos de una persona, tal como están HOY en la base. */
export interface DatosDeFirmante {
  nombre?: string | null;
  documento?: string | null;
}

/** Escapa lo que va a quedar dentro de una celda. */
function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Los `<td>` de primer nivel de una fila, con sus límites. */
function celdas(fila: string): Array<{ inicio: number; fin: number }> {
  const salida: Array<{ inicio: number; fin: number }> = [];
  const re = /<\/?td\b[^>]*>/gi;
  let profundidad = 0;
  let inicio = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fila)) !== null) {
    if (!m[0].startsWith("</")) {
      if (profundidad === 0) inicio = m.index;
      profundidad++;
      continue;
    }
    profundidad--;
    if (profundidad === 0 && inicio >= 0) {
      salida.push({ inicio, fin: m.index + m[0].length });
      inicio = -1;
    }
    if (profundidad < 0) profundidad = 0;
  }
  return salida;
}

/** Reemplaza el texto del primer `<span>` de una celda. */
function escribirEnCelda(fila: string, c: { inicio: number; fin: number }, valor: string): string {
  const cuerpo = fila.slice(c.inicio, c.fin);
  const m = cuerpo.match(/<span[^>]*>([\s\S]*?)<\/span>/);
  if (!m || m.index === undefined) return fila;
  const apertura = m[0].slice(0, m[0].indexOf(">") + 1);
  const nuevo =
    cuerpo.slice(0, m.index) + apertura + esc(valor) + "</span>" + cuerpo.slice(m.index + m[0].length);
  return fila.slice(0, c.inicio) + nuevo + fila.slice(c.fin);
}

/**
 * Actualiza el nombre y el documento de UNA fila. Devuelve la fila tal cual si
 * no tiene la forma esperada o si no hay nada que cambiar.
 */
export function refrescarFila(fila: string, datos: DatosDeFirmante): string {
  const cs = celdas(fila);
  const iFirma = cs.findIndex((c) => fila.slice(c.inicio, c.fin).includes(ATTR_UID));
  if (iFirma < 0) return fila; // fila sin firma: no es de un firmante
  // Antes de la firma: [orden] [nombre] [documento?]
  const datosCells = cs.slice(0, iFirma);
  if (datosCells.length < 2) return fila;

  let out = fila;
  // De atrás hacia adelante: escribir corre los índices de lo que sigue.
  if (datosCells.length >= 3 && datos.documento && datos.documento.trim()) {
    out = escribirEnCelda(out, datosCells[2], datos.documento.trim());
  }
  if (datos.nombre && datos.nombre.trim()) {
    out = escribirEnCelda(out, datosCells[1], datos.nombre.trim());
  }
  return out;
}

/**
 * Refresca todas las filas de firmantes del documento.
 *
 * `porUid` trae los datos de hoy, indexados por el uid de la ranura. Un uid que
 * no esté en el mapa deja su fila intacta: es preferible un dato viejo a uno
 * borrado.
 */
export function refrescarDatos(
  html: string | null | undefined,
  porUid: ReadonlyMap<string, DatosDeFirmante>,
): { html: string; filasTocadas: number } {
  if (!html) return { html: "", filasTocadas: 0 };
  let tocadas = 0;
  const salida = html.replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, (fila) => {
    const m = fila.match(new RegExp(`${ATTR_UID}="([^"]*)"`));
    if (!m) return fila;
    const datos = porUid.get(m[1]);
    if (!datos) return fila;
    const nueva = refrescarFila(fila, datos);
    if (nueva !== fila) tocadas++;
    return nueva;
  });
  return { html: salida, filasTocadas: tocadas };
}
