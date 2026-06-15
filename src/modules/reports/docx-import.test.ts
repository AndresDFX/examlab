import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  extractPlaceholders,
  extractTextFromDocumentXml,
  extractHtmlFromDocumentXml,
  MAX_DOCX_BYTES,
  parseDocxToText,
  parseDocxBundle,
  PAGE_BREAK_HTML,
} from "./docx-import";
import { composeTemplateHtml } from "./TemplateEditor";
import {
  buildAiReportPrompt,
  flattenCatalogPaths,
  summarizeContextForAi,
} from "./template-engine";

// ─────────────────────────────────────────────────────────────────────
// Helpers de test — construir un .docx mínimo con fflate
// ─────────────────────────────────────────────────────────────────────

/** Envuelve párrafos en el esqueleto OOXML de word/document.xml. */
function documentXml(paragraphsInnerXml: string[]): string {
  const body = paragraphsInnerXml.map((p) => `<w:p>${p}</w:p>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr/></w:body>
</w:document>`;
}

/** Un run de texto simple. */
function run(text: string): string {
  return `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
}

/** Construye los bytes de un .docx con los párrafos dados. */
function buildDocx(paragraphsInnerXml: string[]): Uint8Array {
  const xml = documentXml(paragraphsInnerXml);
  const zipped = zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    ),
    "word/document.xml": strToU8(xml),
  });
  // fflate.zipSync devuelve Uint8Array — pero su .buffer puede ser un
  // ArrayBuffer compartido. Normalizamos a una copia exacta.
  return new Uint8Array(zipped);
}

// ─────────────────────────────────────────────────────────────────────
// extractTextFromDocumentXml
// ─────────────────────────────────────────────────────────────────────

describe("extractTextFromDocumentXml", () => {
  it("extrae un párrafo con un solo run", () => {
    const xml = documentXml([run("Hola mundo")]);
    expect(extractTextFromDocumentXml(xml)).toBe("Hola mundo");
  });

  it("concatena varios runs dentro de un mismo párrafo", () => {
    const xml = documentXml([run("Parte uno ") + run("parte dos")]);
    expect(extractTextFromDocumentXml(xml)).toBe("Parte uno parte dos");
  });

  it("separa párrafos con salto de línea", () => {
    const xml = documentXml([run("Primero"), run("Segundo"), run("Tercero")]);
    expect(extractTextFromDocumentXml(xml)).toBe("Primero\nSegundo\nTercero");
  });

  it("preserva un párrafo vacío como línea en blanco entre contenido", () => {
    const xml = documentXml([run("Antes"), "", run("Después")]);
    expect(extractTextFromDocumentXml(xml)).toBe("Antes\n\nDespués");
  });

  it("traduce <w:tab/> a tabulación y <w:br/> a salto de línea", () => {
    const xml = documentXml([
      `<w:r><w:t>A</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>B</w:t></w:r>`,
      `<w:r><w:t>C</w:t><w:br/><w:t>D</w:t></w:r>`,
    ]);
    expect(extractTextFromDocumentXml(xml)).toBe("A\tB\nC\nD");
  });

  it("desescapa entidades XML", () => {
    const xml = documentXml([run("Notas &lt; 3 &amp; &gt; 0 &quot;ok&quot;")]);
    expect(extractTextFromDocumentXml(xml)).toBe('Notas < 3 & > 0 "ok"');
  });

  it("preserva los placeholders {{var}} tal cual (no son entidades)", () => {
    const xml = documentXml([run("Estimado {{estudiante.nombre}},")]);
    expect(extractTextFromDocumentXml(xml)).toBe("Estimado {{estudiante.nombre}},");
  });

  it("colapsa 3+ saltos consecutivos a doble salto", () => {
    const xml = documentXml([run("A"), "", "", "", run("B")]);
    expect(extractTextFromDocumentXml(xml)).toBe("A\n\nB");
  });

  it("devuelve cadena vacía cuando no hay párrafos", () => {
    expect(extractTextFromDocumentXml("<w:body></w:body>")).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────
// parseDocxToText — round-trip con fflate.zipSync
// ─────────────────────────────────────────────────────────────────────

describe("parseDocxToText", () => {
  it("extrae párrafos de un .docx mínimo construido con zipSync", () => {
    const docx = buildDocx([run("Boletín del curso"), run("Estimado estudiante:")]);
    expect(parseDocxToText(docx)).toBe("Boletín del curso\nEstimado estudiante:");
  });

  it("preserva placeholders embebidos en el .docx", () => {
    const docx = buildDocx([
      run("Estimado {{estudiante.nombre}},"),
      run("Tu nota final fue {{nota_final}}."),
    ]);
    const text = parseDocxToText(docx);
    expect(text).toContain("{{estudiante.nombre}}");
    expect(text).toContain("{{nota_final}}");
  });

  it("lanza error si el archivo está vacío", () => {
    expect(() => parseDocxToText(new Uint8Array(0))).toThrow(/vacío/i);
  });

  it("lanza error si no es un ZIP válido", () => {
    const notZip = strToU8("esto no es un docx, es texto plano cualquiera");
    expect(() => parseDocxToText(notZip)).toThrow(/válido/i);
  });

  it("lanza error si el ZIP no contiene word/document.xml", () => {
    const zipped = zipSync({ "otro.txt": strToU8("contenido irrelevante") });
    expect(() => parseDocxToText(new Uint8Array(zipped))).toThrow(/document\.xml/i);
  });

  it("lanza error si supera el tamaño máximo", () => {
    // No construimos 8MB reales — basta con un Uint8Array que reporte
    // byteLength por encima del tope.
    const big = new Uint8Array(MAX_DOCX_BYTES + 1);
    expect(() => parseDocxToText(big)).toThrow(/tamaño máximo/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// extractPlaceholders
// ─────────────────────────────────────────────────────────────────────

describe("extractPlaceholders", () => {
  it("extrae variables de interpolación en orden de aparición", () => {
    const text = "Hola {{estudiante.nombre}}, tu nota es {{nota_final}}.";
    expect(extractPlaceholders(text)).toEqual(["estudiante.nombre", "nota_final"]);
  });

  it("deduplica variables repetidas", () => {
    const text = "{{curso.nombre}} — {{curso.nombre}} de nuevo — {{nota_final}}";
    expect(extractPlaceholders(text)).toEqual(["curso.nombre", "nota_final"]);
  });

  it("soporta {{{raw}}} (sin escape) devolviendo el path interno", () => {
    const text = "{{{institucion.logo}}} y {{curso.nombre}}";
    expect(extractPlaceholders(text)).toEqual(["institucion.logo", "curso.nombre"]);
  });

  it("ignora tags de bloque y control (#each, /each, #if, @index)", () => {
    const text = "{{#each cortes}}{{nombre}}: {{nota}} ({{@index}}){{/each}} {{#if aprobado}}OK{{/if}}";
    expect(extractPlaceholders(text)).toEqual(["nombre", "nota"]);
  });

  it("recorta espacios alrededor del nombre", () => {
    expect(extractPlaceholders("{{  estudiante.nombre  }}")).toEqual(["estudiante.nombre"]);
  });

  it("devuelve [] cuando no hay placeholders", () => {
    expect(extractPlaceholders("Texto sin variables.")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// flattenCatalogPaths
// ─────────────────────────────────────────────────────────────────────

describe("flattenCatalogPaths", () => {
  it("incluye scalars y eaches del catálogo, no los grupos", () => {
    const paths = flattenCatalogPaths();
    expect(paths).toContain("estudiante.nombre");
    expect(paths).toContain("curso.nombre");
    expect(paths).toContain("nota_final");
    // 'cortes' es un nodo 'each' → se incluye.
    expect(paths).toContain("cortes");
  });

  it("no incluye los paths de grupos puros (sin scalar/each homónimo)", () => {
    const flat = flattenCatalogPaths();
    // Estos grupos NO tienen un hijo scalar/each con su mismo path, así
    // que su path nunca debe aparecer en la lista aplanada.
    for (const groupOnly of ["estudiante", "curso", "docente", "institucion", "notas", "asistencia"]) {
      expect(flat).not.toContain(groupOnly);
    }
  });

  it("incluye 'estudiantes' (el grupo consolidado tiene un each homónimo)", () => {
    // El grupo 'estudiantes' contiene un nodo 'each' también llamado
    // 'estudiantes' → su path SÍ aparece, vía el each, no vía el grupo.
    expect(flattenCatalogPaths()).toContain("estudiantes");
  });
});

// ─────────────────────────────────────────────────────────────────────
// summarizeContextForAi
// ─────────────────────────────────────────────────────────────────────

describe("summarizeContextForAi", () => {
  it("aplana primitivos y objetos anidados a clave: valor", () => {
    const ctx = {
      periodo: "2026-1",
      escala_max: 5,
      curso: { nombre: "Paradigmas", codigo: "PP-01" },
    };
    const out = summarizeContextForAi(ctx);
    expect(out).toContain("periodo: 2026-1");
    expect(out).toContain("escala_max: 5");
    expect(out).toContain("curso:");
    expect(out).toContain("nombre: Paradigmas");
    expect(out).toContain("codigo: PP-01");
  });

  it("trunca arrays largos e informa cuántos quedaron fuera", () => {
    const estudiantes = Array.from({ length: 9 }, (_, i) => ({
      nombre: `Alumno ${i + 1}`,
      nota_final: i,
    }));
    const out = summarizeContextForAi({ estudiantes }, 3);
    expect(out).toContain("estudiantes (9 elementos):");
    expect(out).toContain("Alumno 1");
    expect(out).toContain("Alumno 3");
    expect(out).not.toContain("Alumno 4");
    expect(out).toContain("y 6 más");
  });

  it("muestra '—' para valores nulos/vacíos", () => {
    const out = summarizeContextForAi({ periodo: "", grupo: null });
    expect(out).toContain("periodo: —");
    expect(out).toContain("grupo: —");
  });
});

// ─────────────────────────────────────────────────────────────────────
// buildAiReportPrompt
// ─────────────────────────────────────────────────────────────────────

describe("buildAiReportPrompt", () => {
  const ctx = {
    curso: { nombre: "Paradigmas de Programación" },
    nota_final: 4.2,
    estudiante: { nombre: "Ana" },
  };

  it("compone un system y user no vacíos", () => {
    const { system, user } = buildAiReportPrompt({
      draftText: "",
      instruction: "Redacta una observación de desempeño",
      ctx,
    });
    expect(system.length).toBeGreaterThan(0);
    expect(user).toContain("Redacta una observación de desempeño");
  });

  it("incluye las variables disponibles y los datos del curso en el user", () => {
    const { user } = buildAiReportPrompt({ draftText: "", instruction: "x", ctx });
    expect(user).toContain("VARIABLES DISPONIBLES");
    expect(user).toContain("estudiante.nombre");
    expect(user).toContain("DATOS DEL CURSO");
    expect(user).toContain("Paradigmas de Programación");
  });

  it("indica que genera desde cero cuando el draft está vacío", () => {
    const { user } = buildAiReportPrompt({ draftText: "   ", instruction: "x", ctx });
    expect(user).toContain("vacío");
  });

  it("incluye el texto actual cuando hay draft", () => {
    const { user } = buildAiReportPrompt({
      draftText: "<h1>Boletín de {{estudiante.nombre}}</h1>",
      instruction: "completa el cuerpo",
      ctx,
    });
    expect(user).toContain("TEXTO ACTUAL DEL INFORME");
    expect(user).toContain("{{estudiante.nombre}}");
  });

  it("usa una instrucción por defecto cuando no se pasa ninguna", () => {
    const { user } = buildAiReportPrompt({ draftText: "", instruction: "", ctx });
    expect(user).toContain("Genera el contenido del informe");
  });
});

// ─────────────────────────────────────────────────────────────────────
// extractHtmlFromDocumentXml — variante con formato preservado
// ─────────────────────────────────────────────────────────────────────

/** Run con propiedades (negrita/itálica). */
function runFmt(text: string, opts: { b?: boolean; i?: boolean } = {}): string {
  const rPr = `<w:rPr>${opts.b ? "<w:b/>" : ""}${opts.i ? "<w:i/>" : ""}</w:rPr>`;
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

describe("extractHtmlFromDocumentXml", () => {
  it("envuelve cada párrafo en <p>", () => {
    const xml = documentXml([run("Hola"), run("Mundo")]);
    expect(extractHtmlFromDocumentXml(xml)).toBe("<p>Hola</p>\n<p>Mundo</p>");
  });

  it("preserva negrita e itálica como <strong>/<em>", () => {
    const xml = documentXml([runFmt("Negro", { b: true }) + runFmt(" cursiva", { i: true })]);
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toContain("<strong>Negro</strong>");
    expect(html).toContain("<em> cursiva</em>");
  });

  it("ignora w:b con val='false' (negrita desactivada por estilo)", () => {
    const xml = `<w:document><w:body><w:p><w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t>normal</w:t></w:r></w:p></w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toBe("<p>normal</p>");
  });

  it("convierte encabezados (w:pStyle Heading2) a <h2>", () => {
    const xml = `<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Sección</w:t></w:r></w:p></w:body></w:document>`;
    expect(extractHtmlFromDocumentXml(xml)).toBe("<h2>Sección</h2>");
  });

  it("escapa HTML del texto pero preserva los {{placeholders}}", () => {
    const xml = documentXml([run("a < b {{estudiante.nombre}}")]);
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toContain("a &lt; b {{estudiante.nombre}}");
  });

  it("omite párrafos vacíos", () => {
    const xml = documentXml([run("Uno"), "", run("Dos")]);
    expect(extractHtmlFromDocumentXml(xml)).toBe("<p>Uno</p>\n<p>Dos</p>");
  });

  it("convierte una tabla a <table> sin re-emitir sus párrafos internos", () => {
    const xml = `<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Después</w:t></w:r></w:p></w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toContain("<table");
    expect(html).toContain("A1");
    expect(html).toContain("B1");
    expect(html).toContain("<p>Después</p>");
    // La celda renderiza su párrafo DENTRO del <td> (no como <p> suelto a
    // nivel de documento) — y preserva formato/imágenes, no sólo texto plano.
    expect(html).toMatch(/<td[^>]*><p>A1<\/p><\/td>/);
  });

  // ── Saltos de página (claridad de páginas al editar) ──
  it("traduce <w:br w:type=\"page\"/> a un marcador de salto de página", () => {
    const xml = `<w:document><w:body><w:p><w:r><w:t>Pág 1</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>Pág 2</w:t></w:r></w:p></w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toContain(PAGE_BREAK_HTML);
    // El salto parte el párrafo en fragmentos top-level (no queda dentro del <p>).
    expect(html).toContain("<p>Pág 1</p>");
    expect(html).toContain("<p>Pág 2</p>");
    expect(html).not.toMatch(/<p>[^<]*examlab-page-break/);
  });

  it("traduce <w:lastRenderedPageBreak/> (hint de Word) a salto de página", () => {
    const xml = `<w:document><w:body><w:p><w:r><w:lastRenderedPageBreak/><w:t>Nueva página</w:t></w:r></w:p></w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toContain(PAGE_BREAK_HTML);
    expect(html).toContain("<p>Nueva página</p>");
  });

  it("un <w:br/> suave (sin type=page) sigue siendo <br/>, no salto de página", () => {
    const xml = `<w:document><w:body><w:p><w:r><w:t>línea 1</w:t><w:br/><w:t>línea 2</w:t></w:r></w:p></w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toContain("<br/>");
    expect(html).not.toContain(PAGE_BREAK_HTML);
  });

  it("emite <img> con data URI para <a:blip r:embed> usando el resolver", () => {
    const xml = `<w:document><w:body><w:p><w:r><w:drawing><a:blip r:embed="rIdX"/></w:drawing></w:r></w:p></w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml, (rid) =>
      rid === "rIdX" ? "data:image/png;base64,AAA" : null,
    );
    expect(html).toContain('<img src="data:image/png;base64,AAA"');
  });

  it("respeta la alineación del párrafo (<w:jc w:val=center>)", () => {
    const xml = `<w:document><w:body><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>Centrado</w:t></w:r></w:p></w:body></w:document>`;
    expect(extractHtmlFromDocumentXml(xml)).toContain('style="text-align:center"');
  });

  it("preserva tamaño (w:sz) y color (w:color) del run como estilo inline", () => {
    const xml = `<w:document><w:body><w:p><w:r><w:rPr><w:sz w:val="32"/><w:color w:val="FF0000"/></w:rPr><w:t>Grande rojo</w:t></w:r></w:p></w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toContain("font-size:16pt"); // 32 medios-puntos / 2
    expect(html).toContain("color:#FF0000");
  });

  it("preserva alineación vertical y sombreado de la celda", () => {
    const xml = `<w:document><w:body><w:tbl><w:tr><w:tc><w:tcPr><w:vAlign w:val="top"/><w:shd w:fill="EEEEEE"/></w:tcPr><w:p><w:r><w:t>X</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toContain("vertical-align:top");
    expect(html).toContain("background-color:#EEEEEE");
  });
});

// ─────────────────────────────────────────────────────────────────────
// parseDocxBundle — cuerpo + cabecera/pie + imágenes embebidas
// ─────────────────────────────────────────────────────────────────────

/** .docx con una CABECERA tipo "logo | título" (imagen + texto centrado). */
function buildDocxWithHeader(): Uint8Array {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const documentXmlStr = `<?xml version="1.0"?>
<w:document ${W} ${R}><w:body>
  <w:p><w:r><w:t>Cuerpo del informe</w:t></w:r></w:p>
  <w:sectPr><w:headerReference w:type="default" r:id="rId1"/></w:sectPr>
</w:body></w:document>`;
  const documentRels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="header" Target="header1.xml"/>
</Relationships>`;
  const headerXml = `<?xml version="1.0"?>
<w:hdr ${W} ${R} ${A} ${WP}>
  <w:tbl><w:tblPr></w:tblPr><w:tr>
    <w:tc><w:p><w:r><w:drawing><wp:inline><wp:extent cx="952500" cy="476250"/><a:blip r:embed="rId2"/></wp:inline></w:drawing></w:r></w:p></w:tc>
    <w:tc><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>DIAGNÓSTICO Y SEGUIMIENTO ACADÉMICO</w:t></w:r></w:p></w:tc>
  </w:tr></w:tbl>
</w:hdr>`;
  const headerRels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="image" Target="media/image1.png"/>
</Relationships>`;
  const zipped = zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    "word/document.xml": strToU8(documentXmlStr),
    "word/_rels/document.xml.rels": strToU8(documentRels),
    "word/header1.xml": strToU8(headerXml),
    "word/_rels/header1.xml.rels": strToU8(headerRels),
    // El contenido real no importa para el test: parseDocxBundle sólo lo
    // base64-codifica en un data URI.
    "word/media/image1.png": strToU8("FAKE-PNG-BYTES"),
  });
  return new Uint8Array(zipped);
}

describe("parseDocxBundle", () => {
  it("extrae cuerpo + cabecera con imagen embebida como data URI", () => {
    const bundle = parseDocxBundle(buildDocxWithHeader());
    expect(bundle.bodyHtml).toContain("Cuerpo del informe");
    // La cabecera trae el logo embebido (no un enlace a archivo externo).
    expect(bundle.headerHtml).toContain("data:image/png;base64,");
    expect(bundle.headerHtml).toContain("<img ");
    // Y el título centrado.
    expect(bundle.headerHtml).toContain("DIAGNÓSTICO Y SEGUIMIENTO ACADÉMICO");
    expect(bundle.headerHtml).toContain("text-align:center");
    expect(bundle.headerHtml).toContain("<table");
    // Sin pie en este documento.
    expect(bundle.footerHtml).toBe("");
  });

  it("dimensiona la imagen por <wp:extent> (EMU → px)", () => {
    const bundle = parseDocxBundle(buildDocxWithHeader());
    // cx=952500 EMU / 9525 = 100px.
    expect(bundle.headerHtml).toContain("width:100px");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Cabecera con CUADROS DE TEXTO flotantes (caso Camacho: logo | título |
// versión posicionados con <wp:anchor>) → reconstruida como fila de tabla
// ordenada por posición. Sin esto se aplanaba a párrafos apilados.
// ─────────────────────────────────────────────────────────────────────

function buildDocxWithTextboxHeader(): Uint8Array {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const WP = 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const documentXmlStr = `<?xml version="1.0"?>
<w:document ${W} ${R}><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p>
<w:sectPr><w:headerReference w:type="default" r:id="rId1"/></w:sectPr></w:body></w:document>`;
  const documentRels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="header" Target="header1.xml"/></Relationships>`;
  // Logo inline (rId2) + caja "VERSION" a la derecha (posOffset grande) + caja
  // "TITULO" al centro (posOffset medio). Insertadas en orden NO posicional a
  // propósito, para verificar el ordenamiento por posición.
  const headerXml = `<?xml version="1.0"?>
<w:hdr ${W} ${R} ${WP} ${A}>
  <w:p><w:r><w:drawing><wp:inline><wp:extent cx="1362075" cy="590550"/><a:blip r:embed="rId2"/></wp:inline></w:drawing></w:r></w:p>
  <w:p><w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="column"><wp:posOffset>6000000</wp:posOffset></wp:positionH><wp:extent cx="977900" cy="470535"/><a:graphic><a:graphicData><wps:txbx><w:txbxContent><w:p><w:r><w:t>VERSION</w:t></w:r></w:p></w:txbxContent></wps:txbx></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>
  <w:p><w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="column"><wp:posOffset>3000000</wp:posOffset></wp:positionH><wp:extent cx="2905125" cy="688340"/><a:graphic><a:graphicData><wps:txbx><w:txbxContent><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b w:val="1"/></w:rPr><w:t>TITULO</w:t></w:r></w:p></w:txbxContent></wps:txbx></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r></w:p>
</w:hdr>`;
  const headerRels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="image" Target="media/image1.png"/></Relationships>`;
  const zipped = zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    "word/document.xml": strToU8(documentXmlStr),
    "word/_rels/document.xml.rels": strToU8(documentRels),
    "word/header1.xml": strToU8(headerXml),
    "word/_rels/header1.xml.rels": strToU8(headerRels),
    "word/media/image1.png": strToU8("PNG"),
  });
  return new Uint8Array(zipped);
}

describe("parseDocxBundle — cabecera de cuadros de texto → tabla por posición", () => {
  const bundle = parseDocxBundle(buildDocxWithTextboxHeader());
  const h = bundle.headerHtml;

  it("reconstruye una FILA de tabla con una columna por cuadro/logo", () => {
    expect(h.startsWith("<table")).toBe(true);
    expect((h.match(/<td/g) ?? []).length).toBe(3);
    expect(h).toContain("data:image/png;base64,"); // logo embebido
    expect(h).toContain("TITULO");
    expect(h).toContain("VERSION");
  });

  it("ordena las columnas por posición horizontal: logo → título → versión", () => {
    const iLogo = h.indexOf("<img");
    const iTitle = h.indexOf("TITULO");
    const iVer = h.indexOf("VERSION");
    expect(iLogo).toBeGreaterThanOrEqual(0);
    expect(iLogo).toBeLessThan(iTitle); // logo (inline) primero
    expect(iTitle).toBeLessThan(iVer); // título (posOffset 3M) antes que versión (6M)
  });

  it("preserva el título centrado y en negrita dentro de su celda", () => {
    expect(h).toContain("text-align:center");
    expect(h).toContain("<strong>TITULO</strong>");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Fidelidad de estructura de TABLA: anchos de columna (tblGrid) preservados.
// Sin esto, una cabecera "logo | título | versión" se DESFASA al exportar
// porque las columnas reflowean a ancho automático.
// ─────────────────────────────────────────────────────────────────────

/** Tabla con <w:tblGrid> de 3 columnas (20% / 60% / 20%) + celdas logo|título|versión. */
function gridHeaderTableXml(opts?: { titleSpan?: boolean }): string {
  const span = opts?.titleSpan;
  const titleCell = span
    ? `<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>TITULO</w:t></w:r></w:p></w:tc>`
    : `<w:tc><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>TITULO</w:t></w:r></w:p></w:tc>`;
  const rowCells = span
    ? `<w:tc><w:p><w:r><w:t>LOGO</w:t></w:r></w:p></w:tc>${titleCell}`
    : `<w:tc><w:p><w:r><w:t>LOGO</w:t></w:r></w:p></w:tc>${titleCell}<w:tc><w:p><w:r><w:t>V1.0</w:t></w:r></w:p></w:tc>`;
  return `<w:tbl><w:tblPr></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="6000"/><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${rowCells}</w:tr></w:tbl>`;
}

describe("tableToHtml — anchos de columna (fidelidad de estructura)", () => {
  it("aplica el ancho % de cada columna desde <w:tblGrid> + table-layout:fixed", () => {
    const xml = `<w:document><w:body>${gridHeaderTableXml()}</w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toContain("table-layout:fixed");
    // 2000/10000=20%, 6000/10000=60%, 2000/10000=20%.
    expect(html).toContain("width:20%");
    expect(html).toContain("width:60%");
    expect(html).toContain("LOGO");
    expect(html).toContain("TITULO");
    expect(html).toContain("V1.0");
  });

  it("gridSpan: la celda combinada lleva colspan + suma de anchos", () => {
    const xml = `<w:document><w:body>${gridHeaderTableXml({ titleSpan: true })}</w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).toContain('colspan="2"');
    // El título abarca cols 2+3 = 60%+20% = 80%.
    expect(html).toContain("width:80%");
  });

  it("sin <w:tblGrid> NO fuerza table-layout:fixed (comportamiento previo)", () => {
    const xml = `<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`;
    const html = extractHtmlFromDocumentXml(xml);
    expect(html).not.toContain("table-layout:fixed");
  });
});

// ─────────────────────────────────────────────────────────────────────
// "E2E" del flujo importar→exportar: el .docx con cabecera (logo + título +
// versión, con anchos de columna) sobrevive intacto al componer el documento
// de exportación (composeTemplateHtml). Es la fidelidad estructural que el
// usuario pidió: que el informe quede "tal cual como el original".
// ─────────────────────────────────────────────────────────────────────

/** .docx con cabecera de 3 columnas con grid + logo embebido. */
function buildDocxWithGridHeader(): Uint8Array {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const documentXmlStr = `<?xml version="1.0"?>
<w:document ${W} ${R}><w:body>
  <w:p><w:r><w:t>Cuerpo</w:t></w:r></w:p>
  <w:sectPr><w:headerReference w:type="default" r:id="rId1"/></w:sectPr>
</w:body></w:document>`;
  const documentRels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="header" Target="header1.xml"/>
</Relationships>`;
  const headerXml = `<?xml version="1.0"?>
<w:hdr ${W} ${R} ${A}>
  <w:tbl><w:tblPr></w:tblPr>
    <w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="6000"/><w:gridCol w:w="2000"/></w:tblGrid>
    <w:tr>
      <w:tc><w:p><w:r><w:drawing><a:blip r:embed="rId2"/></w:drawing></w:r></w:p></w:tc>
      <w:tc><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:t>DIAGNÓSTICO Y SEGUIMIENTO ACADÉMICO</w:t></w:r></w:p></w:tc>
      <w:tc><w:p><w:r><w:t>V – 1.0 – 2019</w:t></w:r></w:p></w:tc>
    </w:tr>
  </w:tbl>
</w:hdr>`;
  const headerRels = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="image" Target="media/image1.png"/>
</Relationships>`;
  const zipped = zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    "word/document.xml": strToU8(documentXmlStr),
    "word/_rels/document.xml.rels": strToU8(documentRels),
    "word/header1.xml": strToU8(headerXml),
    "word/_rels/header1.xml.rels": strToU8(headerRels),
    "word/media/image1.png": strToU8("FAKE-PNG"),
  });
  return new Uint8Array(zipped);
}

describe("importar .docx → exportar: la cabecera mantiene su estructura", () => {
  it("composeTemplateHtml conserva tabla, anchos de columna, logo y título centrado", () => {
    const bundle = parseDocxBundle(buildDocxWithGridHeader());
    const composed = composeTemplateHtml({
      body_html: bundle.bodyHtml,
      header_html: bundle.headerHtml,
      footer_html: bundle.footerHtml,
      css: "",
      page_orientation: "portrait",
      page_size: "A4",
    });
    // La cabecera va dentro de <header> y conserva la estructura del .docx:
    expect(composed).toContain("<header>");
    expect(composed).toContain("table-layout:fixed");
    expect(composed).toContain("width:20%");
    expect(composed).toContain("width:60%");
    expect(composed).toContain("data:image/png;base64,");
    expect(composed).toContain("text-align:center");
    expect(composed).toContain("DIAGNÓSTICO Y SEGUIMIENTO ACADÉMICO");
    expect(composed).toContain("V – 1.0 – 2019");
  });
});
