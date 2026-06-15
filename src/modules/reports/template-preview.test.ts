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
  it("RENDERIZA las variables con datos de muestra (ya no muestra {{...}})", () => {
    const html = composePreviewHtml({ ...base, body_html: "<p>Hola {{estudiante.nombre}}</p>" });
    // Se ve el valor resuelto, no el token crudo.
    expect(html).toContain("Juan Pérez Gómez");
    expect(html).not.toContain("{{estudiante.nombre}}");
  });

  it("usa el contexto provisto (p. ej. marca real del tenant) cuando se pasa", () => {
    const html = composePreviewHtml(
      { ...base, body_html: "<p>[{{institucion.nombre}}]</p>" },
      { institucion: { nombre: "Universidad de Prueba" } },
    );
    expect(html).toContain("Universidad de Prueba");
  });

  it("renderiza el logo institucional dentro del src de la imagen", () => {
    const html = composePreviewHtml(
      { ...base, body_html: '<img src="{{institucion.logo}}" alt="logo">' },
      { institucion: { logo: "https://ejemplo.test/logo.png" } },
    );
    expect(html).toContain('src="https://ejemplo.test/logo.png"');
    expect(html).not.toContain("{{institucion.logo}}");
  });

  it("renderiza el body formateado y lo envuelve en hojas de página numeradas", () => {
    const docxHtml = "<h1>Acta</h1><p><strong>Negrita</strong> y normal</p>";
    const html = composePreviewHtml({ ...base, body_html: docxHtml });
    expect(html).toContain("<h1>Acta</h1>");
    expect(html).toContain("<strong>Negrita</strong>");
    // Documento HTML completo listo para iframe srcDoc.
    expect(html).toContain("<!doctype html>");
    // El preview se renderiza como HOJAS de página con su número.
    expect(html).toContain('class="examlab-page"');
    expect(html).toContain("Página 1 de 1");
  });

  it("la hoja respeta orientación/tamaño (letter landscape → 279mm de ancho)", () => {
    const html = composePreviewHtml({
      ...base,
      body_html: "<p>{{curso.nombre}}</p>",
      page_orientation: "landscape",
      page_size: "letter",
    });
    expect(html).toContain("width: 279mm");
  });

  it("separa el cuerpo en varias hojas por los saltos de página", () => {
    const html = composePreviewHtml({
      ...base,
      body_html: '<p>Uno</p><div class="examlab-page-break"></div><p>Dos</p>',
    });
    expect(html).toContain("Página 1 de 2");
    expect(html).toContain("Página 2 de 2");
    // El marcador de salto NO aparece dentro de una hoja (se usó para partir).
    expect(html).not.toContain('class="examlab-page-break"');
  });

  it("es resiliente a una plantilla con un bloque sin cerrar (no rompe el preview)", () => {
    const html = composePreviewHtml({ ...base, body_html: "<p>{{#each cortes}} sin cerrar</p>" });
    // No lanza; cae al HTML crudo del fragmento.
    expect(html).toContain("<!doctype html>");
  });
});
