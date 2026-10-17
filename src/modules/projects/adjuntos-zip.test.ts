// @vitest-environment node
// En jsdom, fflate arma ZIPs con carpetas basura y los tests pasan sin validar nada.
import { describe, expect, it } from "vitest";
import { unzipSync, zipSync } from "fflate";

// Se importa del EDGE por ruta relativa: el test valida el módulo que corre en producción.
import {
  MAX_BYTES_IMAGEN,
  MAX_IMAGENES,
  avisoDeAdjuntos,
  bytesABase64,
  capacidadDeAdjuntos,
  contarPaginasPdf,
  esPdf,
  infoDeImagen,
  partesDeAdjuntos,
  planDeRescate,
  reunirAdjuntos,
  type Descomprimir,
} from "../../../supabase/functions/_shared/adjuntos-zip.ts";
import { traducirAMensajesAnthropic } from "../../../supabase/functions/_shared/bedrock-anthropic.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** PNG mínimo: firma + IHDR con los lados pedidos + `relleno` bytes (para variar la huella). */
function png(ancho: number, alto: number, relleno = 0, semilla = 0): Uint8Array {
  const b = new Uint8Array(33 + relleno);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, ancho);
  new DataView(b.buffer).setUint32(20, alto);
  for (let i = 33; i < b.length; i++) b[i] = (i * 31 + semilla) & 0xff;
  b[32] = semilla & 0xff;
  return b;
}

function jpeg(ancho: number, alto: number): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    // APP0 (JFIF), 16 bytes de largo
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // SOF0: largo, precisión, alto, ancho, componentes
    0xff, 0xc0, 0x00, 0x11, 0x08, alto >> 8, alto & 0xff, ancho >> 8, ancho & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

function gif(ancho: number, alto: number): Uint8Array {
  return new Uint8Array([...enc("GIF89a"), ancho & 0xff, ancho >> 8, alto & 0xff, alto >> 8, ...new Array(20).fill(0)]);
}

function webpVp8x(ancho: number, alto: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set(enc("RIFF"), 0);
  b.set(enc("WEBP"), 8);
  b.set(enc("VP8X"), 12);
  const w = ancho - 1;
  const h = alto - 1;
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
  return b;
}

function webpVp8l(ancho: number, alto: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set(enc("RIFF"), 0);
  b.set(enc("WEBP"), 8);
  b.set(enc("VP8L"), 12);
  b[20] = 0x2f;
  const bits = (ancho - 1) | ((alto - 1) << 14);
  b.set([bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff], 21);
  return b;
}

function webpVp8(ancho: number, alto: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set(enc("RIFF"), 0);
  b.set(enc("WEBP"), 8);
  b.set(enc("VP8 "), 12);
  b.set([0x9d, 0x01, 0x2a], 23);
  b.set([ancho & 0xff, (ancho >> 8) & 0x3f, alto & 0xff, (alto >> 8) & 0x3f], 26);
  return b;
}

function pdf(paginas: number | null, relleno = ""): Uint8Array {
  const arbol = paginas === null ? "/Filter /FlateDecode" : `<< /Type /Pages /Kids [3 0 R] /Count ${paginas} >>`;
  return enc(`%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj ${arbol} endobj\n${relleno}%%EOF`);
}

function docx(media: Record<string, Uint8Array>): Uint8Array {
  const archivos: Record<string, Uint8Array> = { "word/document.xml": enc("<w:document/>") };
  for (const [nombre, bytes] of Object.entries(media)) archivos[`word/media/${nombre}`] = bytes;
  return zipSync(archivos);
}

const descomprimir: Descomprimir = (zip, quiere) =>
  unzipSync(zip, { filter: (f) => quiere(f.name, f.originalSize) });
const CLAUDE = capacidadDeAdjuntos("bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0");
const GEMINI = capacidadDeAdjuntos("gemini", "gemini-2.5-flash");

function reunir(archivos: Record<string, Uint8Array>, capacidad = CLAUDE) {
  return reunirAdjuntos({ archivos, rutas: Object.keys(archivos), capacidad, descomprimir });
}

describe("capacidadDeAdjuntos — qué puede ver el modelo que califica", () => {
  it("Claude en Bedrock ve imágenes y PDF (la llamada con adjuntos va por InvokeModel)", () => {
    expect(CLAUDE.pdf).toBe(true);
    expect(CLAUDE.imagenes).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    expect(capacidadDeAdjuntos("bedrock", "anthropic.claude-3-5-haiku-20241022-v1:0").pdf).toBe(true);
  });

  it("el gpt-oss de Bedrock es solo texto: no ve nada, como antes", () => {
    expect(capacidadDeAdjuntos("bedrock", "openai.gpt-oss-120b-1:0")).toEqual({ imagenes: [], pdf: false });
  });

  it("Gemini ve PNG, JPEG y WEBP pero no PDF (su endpoint compatible con OpenAI no lo documenta)", () => {
    expect(GEMINI).toEqual({ imagenes: ["image/png", "image/jpeg", "image/webp"], pdf: false });
  });

  it("OpenAI solo con un modelo con visión", () => {
    expect(capacidadDeAdjuntos("openai", "gpt-4o-mini").imagenes.length).toBe(4);
    expect(capacidadDeAdjuntos("openai", "gpt-4o-mini").pdf).toBe(false);
    expect(capacidadDeAdjuntos("openai", "gpt-3.5-turbo").imagenes).toEqual([]);
    expect(capacidadDeAdjuntos("otro", "x").imagenes).toEqual([]);
  });
});

describe("infoDeImagen — el formato y los lados salen de los bytes, no de la extensión", () => {
  it("lee PNG, JPEG, GIF y las tres variantes de WEBP", () => {
    expect(infoDeImagen(png(1920, 1080))).toEqual({ mime: "image/png", ancho: 1920, alto: 1080 });
    expect(infoDeImagen(jpeg(800, 600))).toEqual({ mime: "image/jpeg", ancho: 800, alto: 600 });
    expect(infoDeImagen(gif(320, 240))).toEqual({ mime: "image/gif", ancho: 320, alto: 240 });
    expect(infoDeImagen(webpVp8x(1280, 720))).toEqual({ mime: "image/webp", ancho: 1280, alto: 720 });
    expect(infoDeImagen(webpVp8l(300, 200))).toEqual({ mime: "image/webp", ancho: 300, alto: 200 });
    expect(infoDeImagen(webpVp8(640, 480))).toEqual({ mime: "image/webp", ancho: 640, alto: 480 });
  });

  it("lo que no es una imagen conocida (EMF de Word, texto, bytes cortados) no pasa", () => {
    expect(infoDeImagen(new Uint8Array([1, 0, 0, 0, ...new Array(40).fill(0)]))).toBeNull();
    expect(infoDeImagen(enc("no soy una imagen, soy un texto bastante largo"))).toBeNull();
    expect(infoDeImagen(png(10, 10).subarray(0, 12))).toBeNull();
  });
});

describe("PDF", () => {
  it("se reconoce por su firma y se cuentan sus páginas cuando el árbol está a la vista", () => {
    expect(esPdf(pdf(3))).toBe(true);
    expect(esPdf(png(10, 10))).toBe(false);
    expect(contarPaginasPdf(pdf(12))).toBe(12);
    expect(contarPaginasPdf(enc("%PDF-1.4 2 0 obj << /Count 5 /Kids [3 0 R] /Type /Pages >> endobj"))).toBe(5);
  });

  it("con el árbol comprimido no se adivina: null", () => {
    expect(contarPaginasPdf(pdf(null))).toBeNull();
  });
});

describe("reunirAdjuntos", () => {
  it("primero las imágenes sueltas, después los PDF y al final las pegadas en documentos, sin repetidas", () => {
    const diagrama1 = png(1200, 800, 50, 1);
    const diagrama10 = png(1200, 800, 50, 2);
    const diagrama2 = png(1200, 800, 50, 3);
    const captura = png(900, 700, 50, 4);
    const r = reunir({
      "Equipo/diagramas/diagrama 10.png": diagrama10,
      "Equipo/diagramas/diagrama 2.png": diagrama2,
      "Equipo/diagramas/diagrama 1.png": diagrama1,
      "Equipo/mockup/Mockup.pdf": pdf(4),
      "Equipo/Documento de diseno.docx": docx({
        "image1.png": captura,
        "image2.png": diagrama1, // la misma que la suelta: no se repite
        "image3.emf": new Uint8Array([1, 0, 0, 0, ...new Array(60).fill(7)]),
      }),
    });
    expect(r.adjuntos.map((a) => a.etiqueta)).toEqual([
      "Equipo/diagramas/diagrama 1.png",
      "Equipo/diagramas/diagrama 2.png",
      "Equipo/diagramas/diagrama 10.png",
      "Equipo/mockup/Mockup.pdf",
      "Equipo/Documento de diseno.docx · imagen 1",
    ]);
    expect(r.adjuntos.map((a) => a.tipo)).toEqual(["imagen", "imagen", "imagen", "pdf", "imagen"]);
    // El EMF no se puede mostrar: se le avisa a la IA que existe.
    expect(r.imagenesDeDocumentosSinMostrar).toBe(1);
    expect(r.porTope).toBe(false);
    // El documento NO es un adjunto: su texto se sigue leyendo aparte.
    expect([...r.rutasAdjuntas].sort()).toEqual([
      "Equipo/diagramas/diagrama 1.png",
      "Equipo/diagramas/diagrama 10.png",
      "Equipo/diagramas/diagrama 2.png",
      "Equipo/mockup/Mockup.pdf",
    ]);
  });

  it("con Gemini el PDF no va como adjunto (se lee su texto, como siempre) ni el GIF", () => {
    const r = reunir({ "a.pdf": pdf(2), "b.gif": gif(400, 300), "c.png": png(400, 300) }, GEMINI);
    expect(r.adjuntos.map((a) => a.ruta)).toEqual(["c.png"]);
    expect(r.rutasAdjuntas.has("a.pdf")).toBe(false);
    expect(r.rutasAdjuntas.has("b.gif")).toBe(false);
  });

  it("el formato lo deciden los bytes: un .png que es un JPEG viaja como JPEG", () => {
    const r = reunir({ "captura.png": jpeg(800, 600) });
    expect(r.adjuntos[0].mime).toBe("image/jpeg");
  });

  it("un modelo que no ve nada no recibe nada (y no se descomprime ningún documento)", () => {
    let llamadas = 0;
    const r = reunirAdjuntos({
      archivos: { "a.png": png(400, 300), "b.docx": docx({ "image1.png": png(500, 400) }) },
      rutas: ["a.png", "b.docx"],
      capacidad: capacidadDeAdjuntos("bedrock", "openai.gpt-oss-120b-1:0"),
      descomprimir: (z, q) => {
        llamadas++;
        return descomprimir(z, q);
      },
    });
    expect(r.adjuntos).toEqual([]);
    expect(r.rutasAdjuntas.size).toBe(0);
    expect(llamadas).toBe(0);
  });

  it("pasado el tope de imágenes lo que sigue queda afuera y se marca", () => {
    const archivos: Record<string, Uint8Array> = {};
    for (let i = 1; i <= MAX_IMAGENES + 5; i++) archivos[`capturas/${i}.png`] = png(800, 600, 20, i);
    const r = reunir(archivos);
    expect(r.adjuntos.length).toBe(MAX_IMAGENES);
    expect(r.porTope).toBe(true);
    // Los que no entraron siguen el camino de siempre: se nombran como no leídos.
    expect(r.rutasAdjuntas.has(`capturas/${MAX_IMAGENES + 1}.png`)).toBe(false);
    expect(r.rutasAdjuntas.has("capturas/1.png")).toBe(true);
  });

  it("una imagen demasiado pesada o demasiado grande no se manda (la rechazaría el proveedor)", () => {
    const r = reunir({
      "pesada.png": png(1000, 800, MAX_BYTES_IMAGEN + 10),
      "enorme.png": png(9000, 600),
      "bien.png": png(1000, 800, 10),
    });
    expect(r.adjuntos.map((a) => a.ruta)).toEqual(["bien.png"]);
    expect(r.porTope).toBe(false);
  });

  it("los íconos diminutos de un documento no se mandan ni se reportan como faltantes", () => {
    const r = reunir({ "Informe.docx": docx({ "image1.png": png(32, 32), "image2.png": png(640, 480) }) });
    expect(r.adjuntos.map((a) => a.etiqueta)).toEqual(["Informe.docx · imagen 2"]);
    expect(r.imagenesDeDocumentosSinMostrar).toBe(0);
  });

  it("los PDF tienen presupuesto de páginas: el que no entra se lee como texto", () => {
    const r = reunir({ "a.pdf": pdf(20), "b.pdf": pdf(20), "c.pdf": pdf(null) });
    expect(r.adjuntos.map((a) => a.ruta)).toEqual(["a.pdf", "c.pdf"]);
    expect(r.rutasAdjuntas.has("b.pdf")).toBe(false);
    expect(r.porTope).toBe(true);
  });
});

describe("partesDeAdjuntos y avisoDeAdjuntos", () => {
  const r = reunir({
    "diagramas/er.png": png(800, 600, 4),
    "mockup/Mockup.pdf": pdf(2),
  });

  it("cada adjunto va precedido por su ruta; imágenes como image_url y PDF como file", () => {
    const partes = partesDeAdjuntos(r.adjuntos, bytesABase64);
    expect(partes).toHaveLength(4);
    expect(partes[0]).toEqual({ type: "text", text: "Adjunto 1 de 2: diagramas/er.png" });
    expect((partes[1] as { image_url: { url: string } }).image_url.url).toMatch(/^data:image\/png;base64,iVBORw0KGgo/);
    expect(partes[2]).toEqual({ type: "text", text: "Adjunto 2 de 2: mockup/Mockup.pdf" });
    const archivo = (partes[3] as { file: { filename: string; file_data: string } }).file;
    expect(archivo.filename).toBe("Mockup.pdf");
    expect(archivo.file_data).toMatch(/^data:application\/pdf;base64,JVBERi0/);
  });

  it("el aviso dice cuántos ve y cuántos no, en singular o plural", () => {
    const aviso = avisoDeAdjuntos(r);
    expect(aviso).toContain("VES 1 imagen y 1 PDF");
    expect(aviso).not.toContain("no se te muestra");
    const conFaltante = avisoDeAdjuntos({ adjuntos: [], imagenesDeDocumentosSinMostrar: 1 });
    expect(conFaltante).toContain("Hay 1 imagen dentro de los documentos que no se te muestra");
    expect(avisoDeAdjuntos({ adjuntos: [], imagenesDeDocumentosSinMostrar: 0 })).toBe("");
  });
});

describe("bytesABase64", () => {
  it("coincide con la codificación de Node, también pasado el tamaño de un trozo", () => {
    const b = new Uint8Array(0x8000 * 2 + 123);
    for (let i = 0; i < b.length; i++) b[i] = (i * 7919) & 0xff;
    expect(bytesABase64(b)).toBe(Buffer.from(b).toString("base64"));
    expect(bytesABase64(new Uint8Array())).toBe("");
  });
});

describe("lo que se infla de un documento", () => {
  function pptx(media: Record<string, Uint8Array>): Uint8Array {
    const archivos: Record<string, Uint8Array> = { "ppt/slides/slide1.xml": enc("<p:sld/>") };
    for (const [nombre, bytes] of Object.entries(media)) archivos[`ppt/media/${nombre}`] = bytes;
    return zipSync(archivos);
  }

  it("un video de una presentación no se descomprime ni se cuenta como imagen", () => {
    const pedidas: string[] = [];
    const r = reunirAdjuntos({
      archivos: { "Expo.pptx": pptx({ "media1.mp4": new Uint8Array(5000).fill(9), "image1.png": png(800, 600) }) },
      rutas: ["Expo.pptx"],
      capacidad: CLAUDE,
      descomprimir: (z, quiere) => {
        const r = descomprimir(z, quiere);
        pedidas.push(...Object.keys(r));
        return r;
      },
    });
    expect(pedidas).toEqual(["ppt/media/image1.png"]);
    expect(r.adjuntos.map((a) => a.etiqueta)).toEqual(["Expo.pptx · imagen 1"]);
    expect(r.imagenesDeDocumentosSinMostrar).toBe(0);
  });

  it("una imagen pegada que pesa más del tope no se infla y se avisa", () => {
    const r = reunir({ "Informe.docx": docx({ "image1.png": png(1000, 800, MAX_BYTES_IMAGEN + 10) }) });
    expect(r.adjuntos).toEqual([]);
    expect(r.imagenesDeDocumentosSinMostrar).toBe(1);
  });

  it("Claude anterior a la versión 3 es solo texto", () => {
    expect(capacidadDeAdjuntos("bedrock", "anthropic.claude-v2:1")).toEqual({ imagenes: [], pdf: false });
    expect(capacidadDeAdjuntos("bedrock", "anthropic.claude-instant-v1")).toEqual({ imagenes: [], pdf: false });
  });
});

describe("contarPaginasPdf ante un PDF fabricado para trabarlo", () => {
  it("es lineal: un mega de /Count y /Type /Pages se cuenta en milisegundos", () => {
    const relleno = "/Count 1 ".repeat(60_000) + "<< /Type /Pages /Count 7 >> ".repeat(2_000);
    const t0 = performance.now();
    expect(contarPaginasPdf(enc(`%PDF-1.7 ${relleno}`))).toBe(7);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe("planDeRescate — la llamada con adjuntos falló y se califica sin ellos", () => {
  const r = reunir({
    "diagramas/er.png": png(800, 600, 6),
    "mockup/Mockup.pdf": pdf(2),
    "Informe.docx": docx({ "image1.png": png(640, 480, 8, 9), "image2.emf": new Uint8Array(80).fill(1) }),
  });

  it("una entrega de solo imágenes no se califica: no hay nada que leer", () => {
    const plan = planDeRescate({ adjuntos: r.adjuntos, imagenesDeDocumentosSinMostrar: 0, pdfsLeidos: new Set(), hayTexto: false });
    expect(plan).toEqual({ sinContenido: true, aviso: "" });
  });

  it("con texto, nombra lo que no se pudo mostrar; el PDF que sí se leyó como texto no se nombra", () => {
    const plan = planDeRescate({
      adjuntos: r.adjuntos,
      imagenesDeDocumentosSinMostrar: r.imagenesDeDocumentosSinMostrar,
      pdfsLeidos: new Set(["mockup/Mockup.pdf"]),
      hayTexto: true,
    });
    expect(plan.sinContenido).toBe(false);
    expect(plan.aviso).toContain("no se te pudieron mostrar: diagramas/er.png, Informe.docx · imagen 1.");
    expect(plan.aviso).not.toContain("Mockup.pdf");
    // El EMF del documento también se le avisa.
    expect(plan.aviso).toContain("Hay 1 imagen dentro de los documentos");
  });
});

describe("las partes que arma partesDeAdjuntos sobreviven al traductor de Claude", () => {
  it("ningún adjunto se pierde en el camino: el aviso promete los que el modelo efectivamente recibe", () => {
    const r = reunir({
      "a.png": png(400, 300, 1, 1),
      "b.jpg": jpeg(400, 300),
      "c.gif": gif(400, 300),
      "d.webp": webpVp8x(400, 300),
      "e.pdf": pdf(1),
    });
    expect(r.adjuntos).toHaveLength(5);
    const cuerpo = traducirAMensajesAnthropic({
      messages: [{ role: "user", content: [{ type: "text", text: "x" }, ...partesDeAdjuntos(r.adjuntos, bytesABase64)] }],
    }) as { messages: Array<{ content: Array<{ type: string }> }> };
    const tipos = cuerpo.messages[0].content.map((b) => b.type);
    expect(tipos.filter((t) => t === "image")).toHaveLength(4);
    expect(tipos.filter((t) => t === "document")).toHaveLength(1);
  });
});
