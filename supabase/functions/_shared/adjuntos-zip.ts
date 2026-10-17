/**
 * Adjuntos VISUALES de una entrega ZIP con regla abierta (`contenido-zip.ts`): las imágenes —sueltas
 * o pegadas dentro de un Word o un PowerPoint— y los PDF, para que el modelo que califica los VEA en
 * vez de solo nombrarlos como «no legibles».
 *
 * ── Por qué ───────────────────────────────────────────────────────────────
 * Los proyectos integradores de 2026-2 se entregan con diagramas en PNG, capturas de la ejecución,
 * un mockup exportado a PDF y prototipos dibujados. Sin esto la IA calificaba la rúbrica de UML
 * (25 puntos) o la de «el contenedor corriendo en el lab» (20) sin ver ni un diagrama ni una captura,
 * y el prompt le pedía no bajar la nota por lo que no podía leer: la nota salía de una parte de la
 * entrega.
 *
 * ── Qué ve cada modelo (`capacidadDeAdjuntos`) ─────────────────────────────
 *   - Claude en Bedrock: imágenes y PDF. Una llamada con adjuntos NO va por Converse sino por
 *     `InvokeModel` con el formato nativo de Anthropic (`bedrock-anthropic.ts`): por Converse un PDF
 *     llega como texto extraído, y verlo como página exige activar citas.
 *   - Gemini: imágenes (por el endpoint compatible con OpenAI). Los PDF se siguen leyendo como texto:
 *     ese endpoint no documenta PDF, y un 400 tumbaría la llamada entera.
 *   - OpenAI con visión: imágenes.
 *   - El resto (gpt-oss de Bedrock): nada, como antes.
 *
 * Es TypeScript puro: lo importan el edge y sus tests desde `src/`. Por eso la descompresión llega
 * inyectada (`descomprimir`) en vez de importar fflate con un especificador de Deno.
 */
import { modeloAceptaImagen } from "./ai-vision.ts";
import { esModeloAnthropicEnBedrock } from "./bedrock-converse.ts";

export type MimeImagen = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface CapacidadDeAdjuntos {
  imagenes: readonly MimeImagen[];
  pdf: boolean;
}

const NINGUNA: CapacidadDeAdjuntos = { imagenes: [], pdf: false };
const TODAS_LAS_IMAGENES: readonly MimeImagen[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Topes. Los de imagen son los de Claude en Bedrock, el más estricto de los tres proveedores. */
export const MAX_IMAGENES = 20;
export const MAX_BYTES_IMAGEN = 3_750_000;
export const MAX_LADO_IMAGEN = 8000;
/** Por debajo de esto en los dos lados es un ícono o un adorno del documento, no evidencia. */
export const MIN_LADO_IMAGEN = 48;
export const MAX_PDFS = 3;
export const MAX_BYTES_PDF = 4_500_000;
/**
 * Páginas de PDF por llamada. Cada página vista cuesta ~2.300 tokens (texto + imagen) y Claude Haiku
 * tiene 200.000 de contexto, que también ocupan el texto de la entrega (hasta 200.000 caracteres) y
 * las imágenes. Un PDF cuyas páginas no se pueden contar se presupuesta con `PAGINAS_SUPUESTAS`.
 */
export const MAX_PAGINAS_PDF = 30;
export const PAGINAS_SUPUESTAS = 10;
/** Bytes crudos entre todos los adjuntos: en base64 son un tercio más, y el cuerpo entero viaja en un POST. */
export const MAX_BYTES_ADJUNTOS = 12_000_000;

export function capacidadDeAdjuntos(provider: string, model: string): CapacidadDeAdjuntos {
  if (provider === "bedrock") {
    return esModeloAnthropicEnBedrock(model) ? { imagenes: TODAS_LAS_IMAGENES, pdf: true } : NINGUNA;
  }
  if (!modeloAceptaImagen(provider, model)) return NINGUNA;
  // Gemini documenta PNG, JPEG y WEBP (además de HEIC/HEIF); GIF no.
  if (provider === "gemini") return { imagenes: ["image/png", "image/jpeg", "image/webp"], pdf: false };
  return { imagenes: TODAS_LAS_IMAGENES, pdf: false };
}

export interface InfoImagen {
  mime: MimeImagen;
  ancho: number;
  alto: number;
}

/**
 * Formato y tamaño de una imagen leídos de sus BYTES, no de la extensión: un `.png` que en realidad
 * es un JPEG se manda con el tipo correcto, y uno corrupto no llega al modelo (un 400 del proveedor
 * tumbaría la llamada con todos los demás adjuntos).
 */
export function infoDeImagen(b: Uint8Array): InfoImagen | null {
  if (b.length < 24) return null;
  // PNG: firma de 8 bytes y el IHDR con ancho y alto en big-endian.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return conLados("image/png", u32be(b, 16), u32be(b, 20));
  }
  // GIF: «GIF87a» / «GIF89a», lados en little-endian.
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return conLados("image/gif", b[6] | (b[7] << 8), b[8] | (b[9] << 8));
  }
  // WEBP: RIFF....WEBP y un chunk VP8, VP8L o VP8X.
  if (texto(b, 0, 4) === "RIFF" && texto(b, 8, 4) === "WEBP" && b.length >= 30) {
    const chunk = texto(b, 12, 4);
    if (chunk === "VP8 ") {
      return conLados("image/webp", (b[26] | (b[27] << 8)) & 0x3fff, (b[28] | (b[29] << 8)) & 0x3fff);
    }
    if (chunk === "VP8L") {
      const ancho = 1 + (((b[22] & 0x3f) << 8) | b[21]);
      const alto = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
      return conLados("image/webp", ancho, alto);
    }
    if (chunk === "VP8X") {
      return conLados(
        "image/webp",
        1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      );
    }
    return null;
  }
  // JPEG: los lados están en el primer marcador SOF; hay que recorrer los segmentos hasta él.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const tipo = b[i + 1];
      if (tipo === 0xff) {
        i++;
        continue;
      }
      // Marcadores sin longitud (RST, SOI, EOI, TEM).
      if ((tipo >= 0xd0 && tipo <= 0xd9) || tipo === 0x01) {
        i += 2;
        continue;
      }
      const largo = (b[i + 2] << 8) | b[i + 3];
      const esSof = tipo >= 0xc0 && tipo <= 0xcf && tipo !== 0xc4 && tipo !== 0xc8 && tipo !== 0xcc;
      if (esSof) return conLados("image/jpeg", (b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]);
      if (largo < 2) return null;
      i += 2 + largo;
    }
    return null;
  }
  return null;
}

export function esPdf(b: Uint8Array): boolean {
  return b.length > 5 && texto(b, 0, 5) === "%PDF-";
}

/**
 * Páginas de un PDF sin parsearlo: el `/Count` más alto de un nodo `/Type /Pages` (la raíz del árbol
 * de páginas lleva el total). `null` cuando no se ve —un PDF con el árbol dentro de un flujo de objetos
 * comprimido—: quien llama lo presupuesta con `PAGINAS_SUPUESTAS`. Parsearlo de verdad cuesta ~100 ms
 * de CPU por página, y el servidor corta la función que pasa de ~2 s.
 */
export function contarPaginasPdf(b: Uint8Array): number | null {
  const s = new TextDecoder("latin1").decode(b);
  let max = 0;
  const re = /\/Type\s*\/Pages\b([^>]*?)\/Count\s+(\d+)|\/Count\s+(\d+)([^>]*?)\/Type\s*\/Pages\b/g;
  for (const m of s.matchAll(re)) {
    const n = Number(m[2] ?? m[3]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : null;
}

export interface Adjunto {
  /** Ruta del archivo dentro del ZIP (para una imagen pegada, la del documento que la contiene). */
  ruta: string;
  /** Lo que lee el modelo antes del adjunto: la ruta, o «documento · imagen N». */
  etiqueta: string;
  tipo: "imagen" | "pdf";
  mime: string;
  bytes: Uint8Array;
}

export interface ResultadoAdjuntos {
  adjuntos: Adjunto[];
  /**
   * Archivos del ZIP que van como adjunto. No se leen como texto ni se nombran como «no legibles»:
   * los que NO entraron (formato, peso, tope) siguen el camino de siempre y se nombran.
   */
  rutasAdjuntas: Set<string>;
  /** Imágenes pegadas en documentos que no entraron (por el tope o por su formato, p. ej. EMF). */
  imagenesDeDocumentosSinMostrar: number;
  /** Algo quedó afuera solo por los topes: la entrega no se vio completa. */
  porTope: boolean;
}

/** fflate.unzipSync con filtro, inyectado. */
export type Descomprimir = (zip: Uint8Array, quiere: (nombre: string) => boolean) => Record<string, Uint8Array>;

const EXT_IMAGEN = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const MEDIA_DE_OFFICE = /^(word|ppt)\/media\/[^/]+$/;

/**
 * Reúne lo que el modelo va a ver, en este orden: las imágenes sueltas (son la evidencia que el
 * enunciado pide por carpeta: diagramas, capturas, prototipo), los PDF y por último las imágenes
 * pegadas en documentos, que suelen repetir las sueltas. Una imagen idéntica a otra ya incluida no se
 * repite. Con el tope alcanzado lo que sigue se descarta en ese mismo orden.
 */
export function reunirAdjuntos(entrada: {
  archivos: Record<string, Uint8Array>;
  /** Archivos aceptados del ZIP, ya sin ruido ni ocultos. */
  rutas: readonly string[];
  capacidad: CapacidadDeAdjuntos;
  descomprimir: Descomprimir;
}): ResultadoAdjuntos {
  const { archivos, capacidad, descomprimir } = entrada;
  const out: ResultadoAdjuntos = {
    adjuntos: [],
    rutasAdjuntas: new Set(),
    imagenesDeDocumentosSinMostrar: 0,
    porTope: false,
  };
  if (capacidad.imagenes.length === 0 && !capacidad.pdf) return out;

  const rutas = [...entrada.rutas].sort(ordenNatural);
  const vistas = new Set<string>();
  let imagenes = 0;
  let pdfs = 0;
  let paginas = 0;
  let bytes = 0;

  type Veredicto = "ok" | "formato" | "tope" | "repetida";
  const intentarImagen = (b: Uint8Array, ruta: string, etiqueta: string): Veredicto => {
    const info = infoDeImagen(b);
    if (!info || !capacidad.imagenes.includes(info.mime)) return "formato";
    if (info.ancho < MIN_LADO_IMAGEN && info.alto < MIN_LADO_IMAGEN) return "formato";
    if (b.length > MAX_BYTES_IMAGEN || info.ancho > MAX_LADO_IMAGEN || info.alto > MAX_LADO_IMAGEN) {
      return "formato";
    }
    const huella = huellaDe(b);
    if (vistas.has(huella)) return "repetida";
    if (imagenes >= MAX_IMAGENES || bytes + b.length > MAX_BYTES_ADJUNTOS) return "tope";
    vistas.add(huella);
    imagenes++;
    bytes += b.length;
    out.adjuntos.push({ ruta, etiqueta, tipo: "imagen", mime: info.mime, bytes: b });
    return "ok";
  };

  // 1) Imágenes sueltas.
  for (const ruta of rutas) {
    if (!EXT_IMAGEN.has(extension(ruta))) continue;
    const b = archivos[ruta];
    if (!b) continue;
    const v = intentarImagen(b, ruta, ruta);
    if (v === "ok" || v === "repetida") out.rutasAdjuntas.add(ruta);
    if (v === "tope") out.porTope = true;
  }

  // 2) PDF.
  if (capacidad.pdf) {
    for (const ruta of rutas) {
      if (extension(ruta) !== "pdf") continue;
      const b = archivos[ruta];
      if (!b || !esPdf(b) || b.length > MAX_BYTES_PDF) continue;
      const suyas = contarPaginasPdf(b) ?? PAGINAS_SUPUESTAS;
      // Un PDF que no entra se lee como texto, como siempre: no se pierde, se ve menos.
      if (pdfs >= MAX_PDFS || paginas + suyas > MAX_PAGINAS_PDF || bytes + b.length > MAX_BYTES_ADJUNTOS) {
        out.porTope = true;
        continue;
      }
      pdfs++;
      paginas += suyas;
      bytes += b.length;
      out.adjuntos.push({ ruta, etiqueta: ruta, tipo: "pdf", mime: "application/pdf", bytes: b });
      out.rutasAdjuntas.add(ruta);
    }
  }

  // 3) Imágenes pegadas dentro de un Word o un PowerPoint.
  if (capacidad.imagenes.length > 0) {
    for (const ruta of rutas) {
      const ext = extension(ruta);
      if (ext !== "docx" && ext !== "pptx") continue;
      const b = archivos[ruta];
      if (!b) continue;
      let media: Record<string, Uint8Array>;
      try {
        media = descomprimir(b, (nombre) => MEDIA_DE_OFFICE.test(nombre));
      } catch {
        continue; // un documento dañado ya lo reporta la lectura de texto
      }
      const nombres = Object.keys(media).sort(ordenNatural);
      nombres.forEach((nombre, i) => {
        const v = intentarImagen(media[nombre], ruta, `${ruta} · imagen ${i + 1}`);
        if (v === "tope") {
          out.porTope = true;
          out.imagenesDeDocumentosSinMostrar++;
        } else if (v === "formato") {
          // Los íconos diminutos no cuentan: no son evidencia y nadie los extraña.
          const info = infoDeImagen(media[nombre]);
          if (!info || info.ancho >= MIN_LADO_IMAGEN || info.alto >= MIN_LADO_IMAGEN) {
            out.imagenesDeDocumentosSinMostrar++;
          }
        }
      });
    }
  }
  return out;
}

/**
 * Las partes del mensaje en el formato de chat-completions (el que hablan los tres proveedores; el
 * traductor de Bedrock convierte `image_url` y `file` a los bloques de Anthropic). Cada adjunto va
 * precedido por su etiqueta, para que la retroalimentación pueda decir de qué archivo habla.
 */
export function partesDeAdjuntos(
  adjuntos: readonly Adjunto[],
  aBase64: (b: Uint8Array) => string,
): Array<Record<string, unknown>> {
  const partes: Array<Record<string, unknown>> = [];
  adjuntos.forEach((a, i) => {
    partes.push({ type: "text", text: `Adjunto ${i + 1} de ${adjuntos.length}: ${a.etiqueta}` });
    const datos = `data:${a.mime};base64,${aBase64(a.bytes)}`;
    if (a.tipo === "imagen") partes.push({ type: "image_url", image_url: { url: datos } });
    else partes.push({ type: "file", file: { filename: nombreDeArchivo(a.ruta), file_data: datos } });
  });
  return partes;
}

/** Lo que se le dice al modelo sobre los adjuntos, al final del texto de la entrega. */
export function avisoDeAdjuntos(r: Pick<ResultadoAdjuntos, "adjuntos" | "imagenesDeDocumentosSinMostrar">): string {
  const imagenes = r.adjuntos.filter((a) => a.tipo === "imagen").length;
  const pdfs = r.adjuntos.length - imagenes;
  const partes: string[] = [];
  if (r.adjuntos.length > 0) {
    const cuales = [
      imagenes > 0 ? `${imagenes} imagen${imagenes === 1 ? "" : "es"}` : "",
      pdfs > 0 ? `${pdfs} PDF` : "",
    ]
      .filter(Boolean)
      .join(" y ");
    partes.push(
      `Además del texto, VES ${cuales} de la entrega como adjuntos, después de este mensaje y cada uno precedido por su ruta. Las imágenes que venían pegadas dentro de un documento se nombran «documento · imagen N». Son parte de la entrega: los diagramas, las capturas de una ejecución, las pantallas de un mockup y los prototipos cuentan como evidencia de la rúbrica. Revisa que correspondan a lo pedido y que sean coherentes con el resto; si algo de una imagen no se distingue, dilo en vez de suponerlo.`,
    );
  }
  if (r.imagenesDeDocumentosSinMostrar > 0) {
    const n = r.imagenesDeDocumentosSinMostrar;
    partes.push(
      `Hay ${n} imagen${n === 1 ? "" : "es"} más dentro de los documentos que no se te ${n === 1 ? "muestra" : "muestran"} (por el tope de adjuntos o por su formato): existe${n === 1 ? "" : "n"} y el docente la${n === 1 ? "" : "s"} revisa; no bajes la nota por no verla${n === 1 ? "" : "s"}.`,
    );
  }
  return partes.length > 0 ? `\n\n${partes.join("\n\n")}` : "";
}

/** base64 sin dependencias: el `btoa` nativo sobre trozos, para no armar un argumento gigante. */
export function bytesABase64(b: Uint8Array): string {
  let binario = "";
  const PASO = 0x8000;
  for (let i = 0; i < b.length; i += PASO) {
    binario += String.fromCharCode(...b.subarray(i, i + PASO));
  }
  return btoa(binario);
}

function conLados(mime: MimeImagen, ancho: number, alto: number): InfoImagen | null {
  return ancho > 0 && alto > 0 ? { mime, ancho, alto } : null;
}

function u32be(b: Uint8Array, i: number): number {
  return ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
}

function texto(b: Uint8Array, desde: number, largo: number): string {
  return String.fromCharCode(...b.subarray(desde, desde + largo));
}

function extension(ruta: string): string {
  const base = ruta.toLowerCase().split("/").pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1) : "";
}

function nombreDeArchivo(ruta: string): string {
  return ruta.split("/").pop() || ruta;
}

/** «imagen10» después de «imagen9», no entre «imagen1» e «imagen2». */
function ordenNatural(a: string, b: string): number {
  return a.localeCompare(b, "es", { numeric: true, sensitivity: "base" });
}

/** FNV-1a de 32 bits + largo: alcanza para reconocer el MISMO archivo dos veces, no es criptografía. */
function huellaDe(b: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${b.length}:${(h >>> 0).toString(16)}`;
}
