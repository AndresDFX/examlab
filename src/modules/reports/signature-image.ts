/**
 * Una FOTO de una firma en papel → una firma con fondo transparente.
 *
 * Quien firma desde el teléfono casi siempre ya tiene su firma: la hizo en un
 * papel y le tomó una foto. Adjuntarla tal cual no sirve, y no por estética: el
 * documento pone la firma en una celda sobre fondo blanco, así que una foto con
 * su rectángulo de papel encima tapa el renglón, arrastra la sombra de la mano y
 * el color del escritorio, y pesa varios cientos de kilobytes cuando la columna
 * `report_signatures.signed_drawing` acepta 120 000 caracteres.
 *
 * Lo que hace este módulo es lo único delicado de ese camino: separar la TINTA
 * del PAPEL. El recorte a la caja del trazo y el escalado ya existen en
 * `signature-pad.ts` y se reusan tal cual — una vez que el papel es transparente,
 * `cajaDelTrazo` funciona igual que con un trazo dibujado, porque mira el alfa.
 *
 * ── Por qué el nivel del papel es LOCAL y no global ────────────────────
 * Lo obvio sería «todo lo más claro que 200 es papel». Falla con la primera foto
 * real: la luz nunca es pareja, así que una esquina del papel queda en 240 y la
 * otra, bajo la sombra de la propia mano, en 150 — el mismo papel cae a los dos
 * lados del umbral y la firma sale con medio rectángulo gris pegado.
 *
 * Estimar el papel con un percentil GLOBAL tampoco alcanza, y vale escribirlo
 * porque es el error que este módulo cometió primero: con el degradado de arriba,
 * el percentil global da ~231 y la zona en sombra, que vale 153, queda a un tercio
 * del camino hacia la tinta — o sea que sale con alfa 94, un velo gris sobre media
 * firma. Lo destapó el test, no la lectura.
 *
 * Por eso el papel se estima POR ZONAS: se divide la imagen en una grilla, se toma
 * el percentil alto de cada celda y se interpola entre ellas, así cada píxel se
 * compara contra el papel que tiene AL LADO. La tinta sí se estima globalmente:
 * es oscura en toda la foto, y un percentil por celda la perdería en las celdas
 * que son puro papel.
 *
 * ── Por qué una rampa y no blanco/negro ────────────────────────────────
 * Un corte binario deja el borde del trazo en escalera. La rampa entre los dos
 * niveles convierte la penumbra del borde en alfa parcial, que es exactamente el
 * antialiasing que tendría un trazo dibujado.
 *
 * ── Por qué se aplana el color ─────────────────────────────────────────
 * Los píxeles del borde son grises claros: si se conserva su color, sobre el
 * fondo blanco del documento la firma se ve lavada y con halo. Se les pone el
 * color de la TINTA —estimado de los píxeles más oscuros, así que una lapicera
 * azul sigue saliendo azul— y el alfa hace de cobertura. El trazo queda parejo.
 */

/** Tope de `chk_report_signatures_drawing`. Ver la mig 20261940000000. */
export const MAX_CARACTERES_FIRMA = 120_000;

/**
 * Lados máximos a probar, de mayor a menor, hasta que el PNG entre en la columna.
 *
 * Una foto produce muchos más píxeles con alfa parcial que un trazo dibujado
 * —todo el antialiasing del borde— y el PNG comprime peor, así que el mismo 600
 * que le alcanza a un trazo puede no alcanzarle a una foto. Bajar es gratis: la
 * firma se muestra a lo sumo a 34 px de alto en el documento.
 */
export const LADOS_DE_REINTENTO = [600, 460, 340, 240] as const;

export interface AnalisisDeFoto {
  /** Luminancia estimada del papel (0-255). */
  nivelPapel: number;
  /** Luminancia estimada de la tinta (0-255). */
  nivelTinta: number;
  /** `nivelPapel - nivelTinta`. Cuánto se despega la tinta del papel. */
  contraste: number;
  /** Color medio de la tinta, para aplanar el trazo. */
  tinta: { r: number; g: number; b: number };
}

export type ResultadoFondo =
  | { ok: true; analisis: AnalisisDeFoto }
  /** La imagen no tiene dos niveles separables: un papel en blanco, una foto
   *  toda oscura, o algo que no es una firma sobre papel. */
  | { ok: false; motivo: "sin_contraste" }
  /** No hay píxeles que mirar (imagen vacía o totalmente transparente). */
  | { ok: false; motivo: "vacia" };

/** Luminancia percibida. Los coeficientes son los de Rec. 601, que es lo que se
 *  usa para decidir «claro u oscuro» sobre color de 8 bits. */
function luminancia(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Valor de luminancia en un percentil, leído de un histograma de 256 casillas. */
function percentil(histograma: number[], total: number, p: number): number {
  const objetivo = total * p;
  let acumulado = 0;
  for (let v = 0; v < 256; v++) {
    acumulado += histograma[v];
    if (acumulado >= objetivo) return v;
  }
  return 255;
}

/**
 * Nivel de papel POR CELDA: el percentil alto de luminancia de cada zona.
 *
 * La grilla se elige por tamaño y no fija, entre dos presiones opuestas: con
 * celdas muy CHICAS, una celda que cae entera dentro de un trazo grueso tendría
 * «papel» oscuro y ese pedazo de tinta se volvería transparente; con celdas muy
 * GRANDES, el degradado DENTRO de una celda deja un velo — el percentil de la
 * celda queda cerca de su lado más iluminado, así que el lado en sombra sale con
 * alfa bajo pero no cero. Medido: ese velo es residual mientras el degradado por
 * celda quede por debajo del piso de alfa, o sea con unas seis celdas o más a lo
 * ancho de la zona iluminada de forma despareja.
 *
 * Por eso el proceso analiza a 1400 px (`LADO_DE_ANALISIS`) y no a una miniatura:
 * con `/40` eso da 24 celdas, y el degradado por celda de una foto de teléfono
 * queda en unas pocas unidades de luminancia.
 */
export function mapaDePapel(
  datos: Uint8ClampedArray | number[],
  ancho: number,
  alto: number,
  percentil_: number,
): { celdas: Float32Array; cols: number; filas: number } {
  const n = Math.max(3, Math.min(24, Math.round(Math.max(ancho, alto) / 40)));
  const cols = Math.max(1, Math.min(n, ancho));
  const filas = Math.max(1, Math.min(n, alto));
  const celdas = new Float32Array(cols * filas);
  const hist = new Array<number>(256);

  for (let cy = 0; cy < filas; cy++) {
    const y0 = Math.floor((cy * alto) / filas);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * alto) / filas));
    for (let cx = 0; cx < cols; cx++) {
      const x0 = Math.floor((cx * ancho) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * ancho) / cols));
      hist.fill(0);
      let total = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * ancho + x) * 4;
          if (datos[i + 3] < 16) continue;
          hist[Math.round(luminancia(datos[i], datos[i + 1], datos[i + 2]))]++;
          total++;
        }
      }
      celdas[cy * cols + cx] = total === 0 ? 255 : percentil(hist, total, percentil_);
    }
  }
  return { celdas, cols, filas };
}

/**
 * Nivel de papel en un píxel, interpolando entre los centros de las celdas.
 *
 * Sin interpolar, el borde entre dos celdas produce un escalón visible en el
 * alfa: se ve una cuadrícula sobre la firma.
 */
export function papelEn(
  mapa: { celdas: Float32Array; cols: number; filas: number },
  ancho: number,
  alto: number,
  x: number,
  y: number,
): number {
  const { celdas, cols, filas } = mapa;
  const fx = (x + 0.5) * (cols / ancho) - 0.5;
  const fy = (y + 0.5) * (filas / alto) - 0.5;
  const x0 = Math.max(0, Math.min(cols - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(filas - 1, Math.floor(fy)));
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(filas - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const a = celdas[y0 * cols + x0] * (1 - tx) + celdas[y0 * cols + x1] * tx;
  const b = celdas[y1 * cols + x0] * (1 - tx) + celdas[y1 * cols + x1] * tx;
  return a * (1 - ty) + b * ty;
}

export interface OpcionesFondo {
  /** Dónde está el papel. Alto a propósito: el papel es la mayoría de la foto. */
  percentilPapel?: number;
  /**
   * Dónde está la tinta. MUY bajo, y ese número es el que casi arruina todo
   * esto: una firma fina sobre una hoja ocupa bastante menos del 5 % de los
   * píxeles, así que un percentil «bajo» del 5 % cae sobre el PAPEL, el
   * contraste estimado da casi cero y la foto se rechaza por «sin contraste»
   * aunque la firma se vea perfecta. Con 0,1 % el percentil cae dentro del
   * trazo incluso cuando el trazo es el 1 % de la imagen.
   */
  percentilTinta?: number;
  /** Separación mínima entre papel y tinta para considerar que hay una firma. */
  contrasteMinimo?: number;
  /** Cobertura por debajo de la cual el píxel es papel. Mata el grano del papel
   *  y la textura del escaneo, que si no quedan como una bruma gris. */
  pisoAlfa?: number;
  /** Cobertura por encima de la cual el píxel es tinta plena, para que el cuerpo
   *  del trazo quede sólido y no translúcido. */
  techoAlfa?: number;
}

/**
 * Deja transparente el papel y opaca la tinta, MUTANDO `datos` en el lugar.
 *
 * `datos` es el array de `getImageData(...).data` (4 bytes por píxel). Se muta y
 * no se copia porque son varios millones de bytes y copiarlos no aporta nada:
 * quien llama acaba de crear ese buffer para esto.
 *
 * Los píxeles que YA vienen transparentes se respetan y se excluyen del análisis.
 * Importa: si alguien adjunta un PNG que ya tiene el fondo recortado, sus píxeles
 * transparentes suelen traer RGB en cero, o sea luminancia 0, y contarlos como
 * tinta invertiría la estimación y arruinaría una imagen que ya estaba bien.
 */
export function quitarFondoDeFirma(
  datos: Uint8ClampedArray | number[],
  ancho: number,
  alto: number,
  opciones: OpcionesFondo = {},
): ResultadoFondo {
  const {
    percentilPapel = 0.9,
    percentilTinta = 0.001,
    contrasteMinimo = 40,
    pisoAlfa = 0.12,
    techoAlfa = 0.82,
  } = opciones;

  if (ancho <= 0 || alto <= 0) return { ok: false, motivo: "vacia" };

  const histograma = new Array<number>(256).fill(0);
  let opacos = 0;
  for (let i = 0; i < datos.length; i += 4) {
    if (datos[i + 3] < 16) continue; // ya transparente: no es papel ni tinta
    const l = Math.round(luminancia(datos[i], datos[i + 1], datos[i + 2]));
    histograma[l]++;
    opacos++;
  }
  if (opacos === 0) return { ok: false, motivo: "vacia" };

  const nivelPapel = percentil(histograma, opacos, percentilPapel);
  const nivelTinta = percentil(histograma, opacos, percentilTinta);
  const contraste = nivelPapel - nivelTinta;
  if (contraste < contrasteMinimo) return { ok: false, motivo: "sin_contraste" };

  // Color de la tinta: promedio de lo más oscuro. Se toma una franja y no el
  // mínimo absoluto porque el píxel más oscuro de una foto es ruido.
  const corteTinta = nivelTinta + contraste * 0.2;
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < datos.length; i += 4) {
    if (datos[i + 3] < 16) continue;
    if (luminancia(datos[i], datos[i + 1], datos[i + 2]) > corteTinta) continue;
    sr += datos[i];
    sg += datos[i + 1];
    sb += datos[i + 2];
    n++;
  }
  const tinta =
    n > 0
      ? { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n) }
      : { r: 17, g: 24, b: 39 }; // el gris del lápiz del lienzo, como respaldo

  // El papel, zona por zona. La tinta NO: es oscura en toda la foto, y estimarla
  // por celda la perdería en las celdas que son puro papel.
  const mapa = mapaDePapel(datos, ancho, alto, percentilPapel);
  // Piso del papel local: si una celda cayera entera dentro de un trazo, su
  // «papel» sería casi tinta y ese pedazo se volvería transparente. Con el piso,
  // el peor caso es que esa zona quede algo más tenue, no que desaparezca.
  const pisoPapel = nivelTinta + contrasteMinimo / 2;
  const span = Math.max(0.01, techoAlfa - pisoAlfa);
  for (let i = 0; i < datos.length; i += 4) {
    if (datos[i + 3] < 16) {
      datos[i + 3] = 0;
      continue;
    }
    const px = (i >> 2) % ancho;
    const py = Math.floor((i >> 2) / ancho);
    const l = luminancia(datos[i], datos[i + 1], datos[i + 2]);
    const papelLocal = Math.max(pisoPapel, papelEn(mapa, ancho, alto, px, py));
    // 0 en el papel, 1 en la tinta, rampa en el medio.
    let cobertura = (papelLocal - l) / Math.max(1, papelLocal - nivelTinta);
    if (cobertura <= pisoAlfa) cobertura = 0;
    else if (cobertura >= techoAlfa) cobertura = 1;
    else cobertura = (cobertura - pisoAlfa) / span;
    datos[i] = tinta.r;
    datos[i + 1] = tinta.g;
    datos[i + 2] = tinta.b;
    datos[i + 3] = Math.round(Math.max(0, Math.min(1, cobertura)) * 255);
  }

  return { ok: true, analisis: { nivelPapel, nivelTinta, contraste, tinta } };
}

/** ¿El PNG entra en la columna? Ver `MAX_CARACTERES_FIRMA`. */
export function firmaCabeEnColumna(dataUrl: string): boolean {
  return dataUrl.length <= MAX_CARACTERES_FIRMA;
}

/**
 * Lado máximo al que conviene bajar la foto ANTES de analizarla.
 *
 * Una foto de teléfono son doce megapíxeles: recorrerla cuatro veces en
 * JavaScript se siente, y no aporta nada porque la firma termina midiendo 600 px
 * de lado. Bajarla primero hace que todo el proceso sea inmediato y, de paso,
 * promedia el grano del papel, que es ruido que la rampa tendría que descartar.
 */
export const LADO_DE_ANALISIS = 1400;

export function dimensionesDeAnalisis(
  ancho: number,
  alto: number,
  maxLado = LADO_DE_ANALISIS,
): { w: number; h: number } {
  const lado = Math.max(ancho, alto);
  if (lado <= 0) return { w: 0, h: 0 };
  const factor = lado > maxLado ? maxLado / lado : 1;
  return { w: Math.max(1, Math.round(ancho * factor)), h: Math.max(1, Math.round(alto * factor)) };
}
