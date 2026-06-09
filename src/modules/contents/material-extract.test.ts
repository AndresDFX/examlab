import { describe, it, expect } from "vitest";
import {
  extensionOf,
  isNotebook,
  isOfficeDoc,
  isImageFile,
  isReferenceableFile,
  notebookToReadableText,
  docxXmlToText,
  pptxSlideXmlToText,
} from "./material-extract";

describe("extensionOf / clasificadores", () => {
  it("extensionOf en minúsculas sin punto", () => {
    expect(extensionOf("Foo.DOCX")).toBe("docx");
    expect(extensionOf("a.b.ipynb")).toBe("ipynb");
    expect(extensionOf("sinext")).toBe("");
    expect(extensionOf(null)).toBe("");
  });

  it("isNotebook / isOfficeDoc / isImageFile", () => {
    expect(isNotebook("Sesion1.ipynb")).toBe(true);
    expect(isNotebook("x.py")).toBe(false);
    expect(isOfficeDoc("Guion.docx")).toBe(true);
    expect(isOfficeDoc("Pres.pptx")).toBe(true);
    expect(isOfficeDoc("x.txt")).toBe(false);
    expect(isImageFile("Ejemplo UML.png")).toBe(true);
    expect(isImageFile("x.docx")).toBe(false);
  });

  it("isReferenceableFile excluye imágenes y binarios opacos", () => {
    expect(isReferenceableFile("Guion.docx")).toBe(true);
    expect(isReferenceableFile("Sesion1.ipynb")).toBe(true);
    expect(isReferenceableFile("main.py")).toBe(true);
    expect(isReferenceableFile("Pres.pptx")).toBe(true);
    expect(isReferenceableFile("UML.png")).toBe(false);
    expect(isReferenceableFile("codigo.zip")).toBe(false);
    expect(isReferenceableFile("video.mp4")).toBe(false);
    expect(isReferenceableFile(null)).toBe(false);
  });
});

describe("notebookToReadableText", () => {
  it("convierte markdown + código a texto legible con fences", () => {
    const nb = JSON.stringify({
      metadata: { language_info: { name: "python" } },
      cells: [
        { cell_type: "markdown", source: ["# Clase 1\n", "Intro a POO"] },
        { cell_type: "code", source: "class A:\n    pass" },
        { cell_type: "code", source: "   " }, // vacía → omitida
      ],
    });
    const out = notebookToReadableText(nb);
    expect(out).toContain("# Clase 1");
    expect(out).toContain("Intro a POO");
    expect(out).toContain("```python");
    expect(out).toContain("class A:");
    // la celda vacía no agrega un bloque extra
    expect(out.match(/```python/g)?.length).toBe(1);
  });

  it("JSON inválido → vacío (no throw)", () => {
    expect(notebookToReadableText("{not json")).toBe("");
    expect(notebookToReadableText("")).toBe("");
    expect(notebookToReadableText(null)).toBe("");
    expect(notebookToReadableText('{"foo":1}')).toBe(""); // sin cells
  });
});

describe("docxXmlToText", () => {
  it("extrae texto de párrafos y runs, ignorando tags", () => {
    const xml =
      '<w:document><w:body>' +
      '<w:p><w:r><w:t>Hola</w:t></w:r><w:r><w:t xml:space="preserve"> mundo</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Segundo párrafo</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const out = docxXmlToText(xml);
    expect(out).toBe("Hola mundo\nSegundo párrafo");
  });

  it("decodifica entidades XML", () => {
    const xml = "<w:p><w:r><w:t>a &amp; b &lt;c&gt; &#233;</w:t></w:r></w:p>";
    expect(docxXmlToText(xml)).toBe("a & b <c> é");
  });

  it("maneja <w:br/> y <w:tab/>", () => {
    const xml = "<w:p><w:r><w:t>L1</w:t><w:br/><w:t>L2</w:t></w:r></w:p>";
    expect(docxXmlToText(xml)).toBe("L1\nL2");
  });

  it("vacío/null → ''", () => {
    expect(docxXmlToText("")).toBe("");
    expect(docxXmlToText(null)).toBe("");
  });
});

describe("pptxSlideXmlToText", () => {
  it("extrae texto de <a:t> separando párrafos", () => {
    const xml =
      "<p:sld><p:cSld><p:spTree>" +
      "<a:p><a:r><a:t>Título de slide</a:t></a:r></a:p>" +
      "<a:p><a:r><a:t>Bullet 1</a:t></a:r></a:p>" +
      "</p:spTree></p:cSld></p:sld>";
    const out = pptxSlideXmlToText(xml);
    expect(out).toBe("Título de slide\nBullet 1");
  });
});
