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
  xlsxSharedStrings,
  xlsxSheetXmlToText,
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

describe("robustez de decodeXmlEntities (via docx/pptx)", () => {
  it("no lanza RangeError con code point fuera de rango; conserva el texto", () => {
    const xml =
      "<w:document><w:body>" +
      "<w:p><w:r><w:t>Antes &#x110000; y &#9999999; después</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>Texto válido</w:t></w:r></w:p>" +
      "</w:body></w:document>";
    let out = "";
    expect(() => {
      out = docxXmlToText(xml);
    }).not.toThrow();
    // El texto legítimo sobrevive (no se pierde todo el documento).
    expect(out).toContain("Texto válido");
    expect(out).toContain("Antes");
    expect(out).toContain("después");
  });

  it("decodifica code points válidos normalmente", () => {
    const xml = "<w:p><w:r><w:t>caf&#233; &#x1F600;</w:t></w:r></w:p>";
    expect(docxXmlToText(xml)).toBe("café 😀");
  });
});

describe("docx tablas", () => {
  it("preserva estructura fila/columna (tab entre celdas, salto entre filas)", () => {
    const xml =
      "<w:tbl>" +
      "<w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>" +
      "<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>" +
      "</w:tbl>";
    expect(docxXmlToText(xml)).toBe("A1\tB1\nA2\tB2");
  });

  it("párrafos normales (fuera de tabla) siguen separados por salto", () => {
    const xml = "<w:p><w:r><w:t>Uno</w:t></w:r></w:p><w:p><w:r><w:t>Dos</w:t></w:r></w:p>";
    expect(docxXmlToText(xml)).toBe("Uno\nDos");
  });
});

describe("xlsx", () => {
  it("isOfficeDoc incluye xlsx", () => {
    expect(isOfficeDoc("datos.xlsx")).toBe(true);
    expect(isOfficeDoc("doc.docx")).toBe(true);
    expect(isOfficeDoc("hoja.csv")).toBe(false);
  });

  it("xlsxSharedStrings extrae las cadenas indexadas", () => {
    const sst =
      '<?xml version="1.0"?><sst count="3" uniqueCount="3">' +
      "<si><t>Nombre</t></si><si><t>Nota</t></si><si><t>Juan Pérez</t></si>" +
      "</sst>";
    expect(xlsxSharedStrings(sst)).toEqual(["Nombre", "Nota", "Juan Pérez"]);
    expect(xlsxSharedStrings(null)).toEqual([]);
  });

  it("xlsxSheetXmlToText resuelve cadenas compartidas, inline y números", () => {
    const shared = ["Nombre", "Nota", "Juan Pérez"];
    const sheet =
      "<worksheet><sheetData>" +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>4.5</v></c></row>' +
      '<row r="3"><c r="A3" t="inlineStr"><is><t>Ana</t></is></c><c r="B3"><v>5</v></c></row>' +
      "</sheetData></worksheet>";
    const out = xlsxSheetXmlToText(sheet, shared);
    expect(out).toBe("Nombre\tNota\nJuan Pérez\t4.5\nAna\t5");
  });

  it("xlsxSheetXmlToText tolera hoja vacía / nula", () => {
    expect(xlsxSheetXmlToText("", [])).toBe("");
    expect(xlsxSheetXmlToText("<worksheet><sheetData></sheetData></worksheet>", [])).toBe("");
  });
});
