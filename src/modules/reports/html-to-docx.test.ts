import { describe, expect, it } from "vitest";
import { strFromU8 } from "fflate";
import { htmlToDocxFiles } from "./html-to-docx";

/** HTML compuesto de prueba: cabecera tipo "logo | título", cuerpo con salto
 *  de página y tabla, y pie. Imita la salida de composeTemplateHtml. */
function composedSample(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>@page { size: A4 portrait; margin: 18mm; }</style></head><body>
<header>
  <table style="border-collapse:collapse;width:100%;table-layout:fixed;">
    <tr>
      <td style="width:20%;"><img src="data:image/png;base64,iVBORw0KGgo=" style="width:100px;height:40px;" alt=""/></td>
      <td style="width:80%;"><p style="text-align:center"><strong>DIAGNÓSTICO ACADÉMICO</strong></p></td>
    </tr>
  </table>
</header>
<main>
  <p>Hola <strong>mundo</strong></p>
  <div class="examlab-page-break"></div>
  <p>Contenido de la página dos</p>
</main>
<footer><p>Pie de página</p></footer>
</body></html>`;
}

function part(files: Record<string, Uint8Array>, path: string): string {
  const b = files[path];
  if (!b) throw new Error(`falta la parte ${path}`);
  return strFromU8(b);
}

function rootLocalName(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  // Si el XML está mal formado, jsdom/navegador devuelve <parsererror> como raíz.
  return doc.documentElement.localName;
}

describe("htmlToDocxFiles — estructura OOXML del .docx", () => {
  const files = htmlToDocxFiles(composedSample());

  it("incluye las partes OOXML requeridas", () => {
    for (const p of [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/styles.xml",
      "word/_rels/document.xml.rels",
      "word/header1.xml",
      "word/footer1.xml",
    ]) {
      expect(files[p], `parte ${p}`).toBeTruthy();
    }
  });

  it("todas las partes XML están bien formadas (raíz esperada)", () => {
    expect(rootLocalName(part(files, "word/document.xml"))).toBe("document");
    expect(rootLocalName(part(files, "word/header1.xml"))).toBe("hdr");
    expect(rootLocalName(part(files, "word/footer1.xml"))).toBe("ftr");
    expect(rootLocalName(part(files, "word/styles.xml"))).toBe("styles");
    expect(rootLocalName(part(files, "[Content_Types].xml"))).toBe("Types");
    expect(rootLocalName(part(files, "_rels/.rels"))).toBe("Relationships");
  });

  it("la CABECERA va en word/header1.xml (área de encabezado), NO en el cuerpo", () => {
    const header = part(files, "word/header1.xml");
    const document = part(files, "word/document.xml");
    // El título de la cabecera está en header1.xml…
    expect(header).toContain("DIAGNÓSTICO ACADÉMICO");
    // …y NO en el cuerpo del documento (esa era la queja: cabecera al inicio
    // del documento en vez de en el área de encabezado).
    expect(document).not.toContain("DIAGNÓSTICO ACADÉMICO");
    // El cuerpo referencia la cabecera/pie en el sectPr.
    expect(document).toContain("<w:headerReference");
    expect(document).toContain("<w:footerReference");
  });

  it("embebe la imagen de la cabecera (media + relación r:embed)", () => {
    const header = part(files, "word/header1.xml");
    expect(header).toContain("<w:drawing>");
    expect(header).toMatch(/r:embed="rId/);
    // El binario de la imagen quedó en word/media/*
    const mediaKeys = Object.keys(files).filter((k) => k.startsWith("word/media/"));
    expect(mediaKeys.length).toBeGreaterThan(0);
    // …y su relación en el rels de la cabecera.
    expect(files["word/_rels/header1.xml.rels"]).toBeTruthy();
    expect(part(files, "word/_rels/header1.xml.rels")).toContain("media/");
  });

  it("preserva anchos de columna (tblGrid) + título en negrita centrado", () => {
    const header = part(files, "word/header1.xml");
    expect(header).toContain("<w:tblGrid>");
    expect(header).toContain("<w:gridCol");
    expect(header).toContain('<w:jc w:val="center"/>');
    expect(header).toContain("<w:b/>");
  });

  it("el cuerpo conserva el salto de página y el texto", () => {
    const document = part(files, "word/document.xml");
    expect(document).toContain('<w:br w:type="page"/>');
    expect(document).toContain("Hola ");
    expect(document).toContain("Contenido de la página dos");
    // El pie va en footer1.xml, NO en el cuerpo.
    expect(document).not.toContain("Pie de página");
    expect(part(files, "word/footer1.xml")).toContain("Pie de página");
  });

  it("declara la orientación/tamaño de página (A4 portrait → pgSz)", () => {
    const document = part(files, "word/document.xml");
    expect(document).toContain("<w:pgSz");
    expect(document).toContain('w:w="11906"'); // A4 ancho en twips
  });
});
