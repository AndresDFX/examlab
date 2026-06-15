import { describe, expect, it } from "vitest";
import { composePreviewHtml } from "./TemplateEditor";

const base = {
  header_html: "",
  footer_html: "",
  css: "",
  page_orientation: "portrait" as const,
  page_size: "A4" as const,
};

describe("composePreviewHtml", () => {
  it("resalta los {{placeholders}} que están en contenido de texto", () => {
    const html = composePreviewHtml({ ...base, body_html: "<p>Hola {{estudiante.nombre}}</p>" });
    expect(html).toContain('<span class="examlab-ph">{{estudiante.nombre}}</span>');
  });

  it("NO envuelve placeholders dentro de atributos (no rompe el HTML)", () => {
    const html = composePreviewHtml({
      ...base,
      body_html: '<img src="{{institucion.logo}}" alt="logo">',
    });
    // El token del atributo src queda intacto…
    expect(html).toContain('src="{{institucion.logo}}"');
    // …y NO se inyecta un <span> dentro del atributo.
    expect(html).not.toContain('src="<span');
  });

  it("renderiza el body formateado de un Word importado (sin placeholders)", () => {
    const docxHtml = "<h1>Acta</h1><p><strong>Negrita</strong> y normal</p>";
    const html = composePreviewHtml({ ...base, body_html: docxHtml });
    expect(html).toContain("<h1>Acta</h1>");
    expect(html).toContain("<strong>Negrita</strong>");
    // Documento HTML completo listo para iframe srcDoc.
    expect(html).toContain("<!doctype html>");
    // El preview se renderiza como HOJAS de página (no flujo continuo): cada
    // segmento es una .examlab-page con su etiqueta "Página N".
    expect(html).toContain('class="examlab-page"');
    expect(html).toContain("Página 1");
  });

  it("incluye el estilo del resaltado y la hoja respeta orientación/tamaño", () => {
    const html = composePreviewHtml({
      ...base,
      body_html: "<p>{{curso.nombre}}</p>",
      page_orientation: "landscape",
      page_size: "letter",
    });
    expect(html).toContain(".examlab-ph");
    // letter landscape → ancho de hoja = 279mm (lado largo).
    expect(html).toContain("width: 279mm");
  });

  it("separa el cuerpo en varias hojas por los saltos de página", () => {
    const html = composePreviewHtml({
      ...base,
      body_html: '<p>Uno</p><div class="examlab-page-break"></div><p>Dos</p>',
    });
    expect(html).toContain("Página 1");
    expect(html).toContain("Página 2");
    // El marcador de salto NO aparece dentro de una hoja (se usó para partir).
    expect(html).not.toContain('class="examlab-page-break"');
  });
});
