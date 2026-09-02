import { afterEach, describe, expect, it, vi } from "vitest";

import { inlineRemoteImages } from "./inline-images";

/**
 * El navegador se simula al mínimo: `fetch`, `URL.createObjectURL`, un `Image`
 * que resuelve solo, y un canvas que devuelve un data URI fijo. No se prueba el
 * decodificador del navegador —eso no es nuestro código—, se prueba QUÉ se hace
 * con el HTML, que es donde estaba el riesgo.
 */
function simularNavegador(opciones: { falla?: boolean; ancho?: number; alto?: number } = {}) {
  const { falla = false, ancho = 240, alto = 240 } = opciones;
  const llamadas: string[] = [];

  vi.stubGlobal("fetch", async (u: string) => {
    llamadas.push(String(u));
    if (falla) return { ok: false } as Response;
    return {
      ok: true,
      blob: async () => ({ arrayBuffer: async () => new Uint8Array(32).buffer }),
    } as unknown as Response;
  });
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:x",
    revokeObjectURL: () => {},
  });
  class ImgFalsa {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = ancho;
    naturalHeight = alto;
    set src(_v: string) {
      setTimeout(() => this.onload?.(), 0);
    }
  }
  vi.stubGlobal("window", { Image: ImgFalsa });
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => {} }),
      toDataURL: () => "data:image/png;base64,UE5H",
    }),
  });
  return llamadas;
}

afterEach(() => vi.unstubAllGlobals());

const doc = (cuerpo: string, orientacion = "portrait") =>
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<style>@page { size: A4 ${orientacion}; margin: 18mm; }</style></head><body>` +
  cuerpo +
  `</body></html>`;

describe("inlineRemoteImages", () => {
  it("reemplaza el src remoto por un data URI", async () => {
    simularNavegador();
    const r = await inlineRemoteImages(
      doc('<header><img src="https://x/logo.webp" style="width:173px;height:auto;"/></header>'),
    );
    expect(r.fallidas).toBe(0);
    expect(r.html).toContain('src="data:image/png;base64,UE5H"');
    expect(r.html).not.toContain("https://x/logo.webp");
  });

  it("NO toca el <head> ni el @page — la trampa que rompería el horizontal", async () => {
    // `htmlToDocxFiles` saca la orientación con una expresión regular sobre el
    // `@page`, que vive en el `<style>` del `<head>`. Un round-trip por DOMParser
    // serializando solo el body tiraría ese `<head>` y toda plantilla en
    // horizontal saldría vertical en el Word, sin un solo error a la vista.
    simularNavegador();
    const entrada = doc('<img src="https://x/l.png" style="width:100px;"/>', "landscape");
    const r = await inlineRemoteImages(entrada);
    expect(r.html).toContain("@page { size: A4 landscape; margin: 18mm; }");
    expect(r.html.startsWith("<!doctype html>")).toBe(true);
    expect(r.html).toContain('<meta charset="utf-8">');
  });

  it("deja escrito el alto proporcional cuando el estilo decía auto", async () => {
    // 240×240 (el logo real de UNIAJ) a 173px de ancho → 173 de alto.
    simularNavegador({ ancho: 240, alto: 240 });
    const r = await inlineRemoteImages(
      doc('<img src="https://x/l.webp" style="width:173px;max-width:100%;height:auto;"/>'),
    );
    expect(r.html).toContain("height:173px");
    expect(r.html).not.toContain("height:auto");
    // Lo que ya estaba se conserva.
    expect(r.html).toContain("width:173px");
    expect(r.html).toContain("max-width:100%");
  });

  it("un logo no cuadrado conserva su proporción", async () => {
    // 205×225 (FESNA) a 150px → 165.
    simularNavegador({ ancho: 205, alto: 225 });
    const r = await inlineRemoteImages(doc('<img src="https://x/f.png" style="width:150px;height:auto;"/>'));
    expect(r.html).toContain("height:165px");
  });

  it("una sola descarga por URL aunque la imagen aparezca varias veces", async () => {
    // El mismo logo suele estar en el encabezado y en el pie, y el bucket responde
    // `no-cache`, así que el navegador no lo deduplica por su cuenta.
    const llamadas = simularNavegador();
    const r = await inlineRemoteImages(
      doc(
        '<header><img src="https://x/l.png" style="width:100px;"/></header>' +
          '<footer><img src="https://x/l.png" style="width:60px;"/></footer>',
      ),
    );
    expect(llamadas).toHaveLength(1);
    expect(r.html.match(/data:image\/png/g)).toHaveLength(2);
  });

  it("si la descarga falla, cuenta el fallo y deja el documento generable", async () => {
    // Que el logo no se pueda traer no puede impedir que el informe se descargue.
    simularNavegador({ falla: true });
    const entrada = doc('<img src="https://x/l.png" style="width:100px;"/>');
    const r = await inlineRemoteImages(entrada);
    expect(r.fallidas).toBe(1);
    expect(r.html).toBe(entrada);
  });

  it("las imágenes que ya son data URI no se tocan ni se descargan", async () => {
    const llamadas = simularNavegador();
    const entrada = doc('<img src="data:image/png;base64,AAAA" style="width:50px;"/>');
    const r = await inlineRemoteImages(entrada);
    expect(llamadas).toHaveLength(0);
    expect(r.html).toBe(entrada);
    expect(r.fallidas).toBe(0);
  });

  it("un documento sin imágenes se devuelve tal cual, sin tocar la red", async () => {
    const llamadas = simularNavegador();
    const entrada = doc("<p>solo texto</p>");
    const r = await inlineRemoteImages(entrada);
    expect(r.html).toBe(entrada);
    expect(llamadas).toHaveLength(0);
  });

  it("un html vacío no rompe", async () => {
    expect(await inlineRemoteImages("")).toEqual({ html: "", fallidas: 0 });
  });

  it("acepta el src con comillas simples", async () => {
    simularNavegador();
    const r = await inlineRemoteImages(doc("<img src='https://x/l.png' style='width:80px;'/>"));
    expect(r.html).toContain("data:image/png");
    expect(r.fallidas).toBe(0);
  });

  it("no se lleva por delante otros atributos de la etiqueta", async () => {
    simularNavegador();
    const r = await inlineRemoteImages(
      doc('<img alt="Logo" src="https://x/l.png" class="marca" style="width:90px;"/>'),
    );
    expect(r.html).toContain('alt="Logo"');
    expect(r.html).toContain('class="marca"');
  });
});
