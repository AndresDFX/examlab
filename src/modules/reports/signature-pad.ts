/**
 * Helpers PUROS del lienzo de firma.
 *
 * Lo que vive acá es el recorte del trazo a su propia caja. Suena cosmético y no
 * lo es: el lienzo mide 600×200 y una firma real ocupa una fracción, así que sin
 * recortar el PNG llega a la celda del documento con un mar de transparencia
 * alrededor y el trazo se ve diminuto — el navegador escala la imagen completa,
 * no la tinta. Recortando, la firma llena la celda como una firma en papel.
 *
 * Está separado del componente porque es aritmética de índices con casos borde
 * (lienzo vacío, trazo pegado al margen, un solo punto) y esa clase de código se
 * verifica con tests, no mirándolo.
 */

export interface Caja {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Caja que encierra la tinta de un lienzo RGBA.
 *
 * `datos` es el array de `getImageData(...).data`: 4 bytes por píxel (R,G,B,A). Se
 * mira SOLO el alfa, porque el lienzo es transparente y el trazo es lo único
 * opaco; mirar el color obligaría a saber de qué color se dibujó.
 *
 * `umbral` deja fuera el antialiasing casi invisible del borde del trazo. Con 0 la
 * caja crece uno o dos píxeles por cada lado sin que se vea nada ahí.
 *
 * Devuelve `null` si no hay tinta: es el caso de "no dibujó nada", y quien llama
 * necesita distinguirlo de una caja de tamaño cero.
 */
export function cajaDelTrazo(
  datos: ArrayLike<number>,
  ancho: number,
  alto: number,
  umbral = 8,
): Caja | null {
  if (ancho <= 0 || alto <= 0) return null;
  let minX = ancho;
  let minY = alto;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const alfa = datos[(y * ancho + x) * 4 + 3];
      if (alfa === undefined || alfa <= umbral) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  // +1 porque los índices son inclusivos: de la columna 3 a la 5 hay TRES
  // columnas, no dos.
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/**
 * Agranda la caja `margen` píxeles por lado, sin salirse del lienzo.
 *
 * El margen existe para que el trazo no quede tocando el borde de la imagen, que
 * al escalar se ve recortado.
 */
export function conMargen(caja: Caja, margen: number, ancho: number, alto: number): Caja {
  // Se calcula por ESQUINAS y no sumando anchos: sumar obliga a corregir el ancho
  // cuando el recorte del margen izquierdo fue parcial, y ahí es donde se cuela el
  // off-by-one. Con las dos esquinas recortadas al lienzo, el tamaño sale solo.
  const x1 = Math.max(0, caja.x - margen);
  const y1 = Math.max(0, caja.y - margen);
  const x2 = Math.min(ancho, caja.x + caja.w + margen);
  const y2 = Math.min(alto, caja.y + caja.h + margen);
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * ¿El trazo es demasiado chico para ser una firma?
 *
 * Un toque accidental deja un punto de 2×2 y no debería contar como firma: el
 * documento quedaría "firmado" con una mancha. El umbral es deliberadamente bajo
 * —una firma corta, de solo iniciales, tiene que pasar— y lo que descarta es el
 * clic suelto.
 */
export function trazoDemasiadoChico(caja: Caja | null, minLado = 12): boolean {
  if (!caja) return true;
  return caja.w < minLado && caja.h < minLado;
}
