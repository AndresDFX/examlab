import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import {
  extractPlaceholders,
  extractTextFromDocumentXml,
  extractHtmlFromDocumentXml,
  MAX_DOCX_BYTES,
  parseDocxToText,
} from "./docx-import";
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
    // El párrafo de la celda NO debe aparecer como <p> suelto.
    expect(html).not.toContain("<p>A1</p>");
  });
});
