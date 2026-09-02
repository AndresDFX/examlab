/**
 * Dimensiones INTRÍNSECAS de una imagen, leídas de sus propios bytes. PURO: sin
 * DOM, sin canvas, sin red — así sirve igual en el navegador y en un test.
 *
 * ── El bug que existe para arreglar ───────────────────────────────────────
 * El exportador a Word tiene que darle a cada imagen un tamaño explícito: en un
 * .docx no hay `height:auto` ni `max-width`. Cuando el HTML no declaraba la
 * altura, `html-to-docx` la inventaba como `0,4 × ancho`.
 *
 * Y el HTML de los encabezados dice justamente `height:auto`, que `parseFloat`
 * devuelve como `NaN` → cae al 0,4. Medido sobre los dos logos reales de
 * producción, que son casi cuadrados (FESNA 205×225, UNIAJ 240×240): con
 * `width:150px` y `width:173px`, el .docx los pintaba 150×60 y 173×69 en vez de
 * ~165 y ~173 de alto. Un achatamiento vertical de 2,5 a 2,75 veces.
 *
 * Lo peor del caso: el PDF sale del navegador, que SÍ respeta `height:auto`, así
 * que el mismo informe salía bien en PDF y deformado en Word. Nadie compara los
 * dos.
 *
 * ── Por qué se leen los bytes y no se usa el navegador ────────────────────
 * `createImageBitmap` o un `<img>` darían lo mismo, pero son asíncronos y viven
 * en el navegador, y el exportador a .docx es una función SINCRÓNICA y pura que
 * corre también bajo los tests. Leer la cabecera es determinista, no necesita
 * mocks y cuesta unos pocos bytes.
 *
 * Solo se leen los formatos que el exportador puede embeber (PNG, JPEG, GIF) más
 * WebP, que aparece porque el logo de una institución real está en WebP.
 */

export interface Dimensiones {
  ancho: number;
  alto: number;
}

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

const ascii = (b: Uint8Array, i: number, n: number) =>
  String.fromCharCode(...Array.from(b.subarray(i, i + n)));

/** PNG: firma de 8 bytes y después el IHDR, con ancho y alto en big-endian. */
function png(b: Uint8Array): Dimensiones | null {
  if (b.length < 24) return null;
  if (b[0] !== 0x89 || ascii(b, 1, 3) !== "PNG") return null;
  return { ancho: u32be(b, 16), alto: u32be(b, 20) };
}

/** GIF: cabecera de 6 bytes y el tamaño lógico en little-endian. */
function gif(b: Uint8Array): Dimensiones | null {
  if (b.length < 10) return null;
  const sig = ascii(b, 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  return { ancho: u16le(b, 6), alto: u16le(b, 8) };
}

/**
 * JPEG: hay que RECORRER los segmentos hasta el SOF, que es el único que trae el
 * tamaño. No está a un offset fijo: antes vienen EXIF, perfiles de color y
 * miniaturas, y su cantidad depende de con qué se guardó el archivo.
 */
function jpeg(b: Uint8Array): Dimensiones | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++; // relleno entre segmentos
      continue;
    }
    const marca = b[i + 1];
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 traen el tamaño.
    // Se excluyen DHT (c4), DAC (cc) y los RSTn (d0..d7), que caen en el rango.
    const esSof =
      marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc;
    if (esSof) return { alto: u16be(b, i + 5), ancho: u16be(b, i + 7) };
    if (marca === 0xd8 || (marca >= 0xd0 && marca <= 0xd9)) {
      i += 2; // marcas sin longitud
      continue;
    }
    const largo = u16be(b, i + 2);
    if (largo < 2) return null;
    i += 2 + largo;
  }
  return null;
}

/**
 * WebP: tres variantes con el tamaño en lugares distintos. Aparece porque el logo
 * de una institución real está en WebP.
 */
function webp(b: Uint8Array): Dimensiones | null {
  if (b.length < 30 || ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8X") {
    // Extendido: el lienzo va como (valor - 1) en 3 bytes little-endian.
    return { ancho: u24le(b, 24) + 1, alto: u24le(b, 27) + 1 };
  }
  if (chunk === "VP8 ") {
    // Con pérdida: tras el código de arranque de 3 bytes, 14 bits por lado.
    return { ancho: u16le(b, 26) & 0x3fff, alto: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // Sin pérdida: 14 bits de ancho y 14 de alto, empaquetados tras la firma.
    const bits = u32be(b, 21);
    const le = ((bits >>> 24) | ((bits >>> 8) & 0xff00) | ((bits << 8) & 0xff0000) | (bits << 24)) >>> 0;
    return { ancho: (le & 0x3fff) + 1, alto: ((le >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

/**
 * Ancho y alto reales, o `null` si el formato no se reconoce o el archivo está
 * truncado. Nunca lanza: quien llama tiene un camino de respaldo y un error acá
 * dejaría el documento entero sin generar.
 */
export function intrinsicSize(bytes: Uint8Array | null | undefined): Dimensiones | null {
  if (!bytes || bytes.length < 10) return null;
  try {
    const d = png(bytes) ?? gif(bytes) ?? webp(bytes) ?? jpeg(bytes);
    if (!d) return null;
    if (!Number.isFinite(d.ancho) || !Number.isFinite(d.alto)) return null;
    if (d.ancho <= 0 || d.alto <= 0) return null;
    return d;
  } catch {
    return null;
  }
}

/**
 * El alto que le corresponde a una imagen cuando el HTML declara el ancho y deja
 * el alto en `auto`.
 *
 * Devuelve `null` si no se puede saber, para que quien llama decida su respaldo en
 * vez de recibir un número inventado que parece medido.
 */
export function altoProporcional(anchoDeseado: number, real: Dimensiones | null): number | null {
  if (!real || real.ancho <= 0) return null;
  if (!Number.isFinite(anchoDeseado) || anchoDeseado <= 0) return null;
  return Math.max(1, Math.round((anchoDeseado * real.alto) / real.ancho));
}
