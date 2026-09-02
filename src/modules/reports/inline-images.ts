/**
 * Convierte las imágenes REMOTAS de un informe en imágenes embebidas, para que la
 * descarga de Word las lleve adentro.
 *
 * ── Por qué hace falta ────────────────────────────────────────────────────
 * El exportador a .docx solo puede embeber una imagen si su `src` ya es un data
 * URI: un `<img src="https://…">` no viaja dentro del archivo y desaparece del
 * documento sin ningún error. El logo institucional vive en el bucket de marcas,
 * así que llega como URL: sin este paso, el logo se ve en la vista previa y en el
 * PDF, y se pierde justamente en el Word que la gente entrega.
 *
 * ── Se re-codifica SIEMPRE a PNG, a propósito ─────────────────────────────
 * El exportador acepta png, jpg y gif, y rechaza WebP y SVG. El logo de una
 * institución real está en WebP y el bucket también admite SVG, así que pasarlos
 * tal cual los haría desaparecer igual. Al decodificarlos y volver a escribirlos
 * como PNG entran los cuatro formatos por el mismo camino.
 *
 * ── Y se escribe el ALTO real ─────────────────────────────────────────────
 * El HTML de los encabezados declara `height:auto`, que en un .docx no existe: hay
 * que dar una medida. Como acá ya tenemos la imagen decodificada y sus dimensiones
 * en la mano, se deja el alto calculado en el `style`. El exportador tiene su
 * propio respaldo leyendo los bytes, pero dejarlo escrito acá es gratis y hace que
 * el HTML sea correcto por sí mismo.
 *
 * ── Se opera sobre el TEXTO, sin volver a parsear el documento ────────────
 * La tentación es `DOMParser` + `doc.body.innerHTML`, y sería un error silencioso:
 * `htmlToDocxFiles` saca la orientación de la página con una expresión regular
 * sobre el `@page` que vive en el `<style>` del `<head>`. Serializar solo el body
 * tira ese `<head>` y TODA plantilla en horizontal saldría vertical en el Word,
 * sin un solo error a la vista. Y un segundo ciclo de parseo sobre HTML que salió
 * de importar un `.docx` es justo donde el parser reparenta tablas.
 *
 * Por eso se reemplaza únicamente el atributo `src` dentro de cada etiqueta
 * `<img …>`: el resto del documento —incluido el `<head>`— queda byte por byte
 * igual.
 */

import { altoProporcional, intrinsicSize } from "./image-size";

export interface ResultadoIncrustado {
  html: string;
  /** Cuántas imágenes no se pudieron traer. El caller avisa; no se lanza. */
  fallidas: number;
}

/** Etiquetas `<img …>` completas. No se tocan otras partes del documento. */
const RE_IMG = /<img\b[^>]*>/gi;
const RE_SRC = /(\ssrc\s*=\s*)("([^"]*)"|'([^']*)')/i;

const esRemota = (src: string) => /^https?:\/\//i.test(src.trim());

/** Descarga y re-codifica a PNG. `null` si no se puede (red, CORS, formato). */
async function aPngDataUri(
  url: string,
): Promise<{ dataUri: string; ancho: number; alto: number } | null> {
  try {
    const res = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!res.ok) return null;
    const blob = await res.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());

    // Se dibuja vía `<img>` y no `createImageBitmap`: ese último no decodifica SVG
    // en Chrome (lanza), y un logo en SVG caería siempre al contador de fallidas
    // sin que el docente tenga nada que hacer al respecto.
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new window.Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("no se pudo decodificar"));
        el.src = objectUrl;
      });
      // El SVG no tiene dimensiones intrínsecas garantizadas; si el navegador no
      // las da, se cae a las de la cabecera binaria y por último a un cuadrado.
      const nat = intrinsicSize(bytes);
      const w = img.naturalWidth || nat?.ancho || 300;
      const h = img.naturalHeight || nat?.alto || 300;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);
      return { dataUri: canvas.toDataURL("image/png"), ancho: w, alto: h };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return null;
  }
}

/** Deja escrito el alto proporcional cuando el `style` dice `auto` o no lo dice. */
function conAltoResuelto(tag: string, ancho: number, alto: number): string {
  const m = /(\sstyle\s*=\s*)("([^"]*)"|'([^']*)')/i.exec(tag);
  if (!m) return tag;
  const estilo = m[3] ?? m[4] ?? "";
  const decls = estilo
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  const anchoDecl = decls.find((d) => /^width\s*:/i.test(d));
  const anchoPx = anchoDecl ? parseFloat(anchoDecl.split(":")[1]) : NaN;
  const altoPx = altoProporcional(
    Number.isFinite(anchoPx) && anchoPx > 0 ? anchoPx : 120,
    { ancho, alto },
  );
  if (altoPx == null) return tag;
  const sinAlto = decls.filter((d) => !/^height\s*:/i.test(d));
  sinAlto.push(`height:${altoPx}px`);
  const nuevo = sinAlto.join(";") + ";";
  return tag.slice(0, m.index) + m[1] + '"' + nuevo + '"' + tag.slice(m.index + m[0].length);
}

/**
 * Reemplaza cada `<img src="http…">` por su versión embebida.
 *
 * Nunca lanza y nunca deja el HTML a medias: una imagen que no se pueda traer se
 * cuenta en `fallidas` y su etiqueta queda como estaba, así que el documento se
 * genera igual (con el hueco de esa imagen) en vez de no generarse.
 */
export async function inlineRemoteImages(html: string): Promise<ResultadoIncrustado> {
  if (!html) return { html, fallidas: 0 };
  const tags = html.match(RE_IMG) ?? [];
  const urls = new Set<string>();
  for (const tag of tags) {
    const m = RE_SRC.exec(tag);
    const src = m ? (m[3] ?? m[4] ?? "") : "";
    if (esRemota(src)) urls.add(src.trim());
  }
  if (urls.size === 0) return { html, fallidas: 0 };

  // Una descarga por URL, no por etiqueta: el mismo logo puede estar en el
  // encabezado y en el pie, y el bucket responde `no-cache`, así que el navegador
  // no lo deduplica por su cuenta.
  const cache = new Map<string, { dataUri: string; ancho: number; alto: number } | null>();
  await Promise.all(
    [...urls].map(async (u) => {
      cache.set(u, await aPngDataUri(u));
    }),
  );

  let fallidas = 0;
  const salida = html.replace(RE_IMG, (tag) => {
    const m = RE_SRC.exec(tag);
    if (!m) return tag;
    const src = (m[3] ?? m[4] ?? "").trim();
    if (!esRemota(src)) return tag;
    const listo = cache.get(src);
    if (!listo) {
      fallidas++;
      return tag;
    }
    const conSrc =
      tag.slice(0, m.index) + m[1] + '"' + listo.dataUri + '"' + tag.slice(m.index + m[0].length);
    return conAltoResuelto(conSrc, listo.ancho, listo.alto);
  });

  return { html: salida, fallidas };
}
