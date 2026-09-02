import { describe, expect, it } from "vitest";

import { TOPE_ALTO_LOGO } from "./document-css";
import { institutionalHeaderHtml } from "./header-block";

describe("institutionalHeaderHtml", () => {
  it("el logo va SIEMPRE dentro del condicional, y el {{#if}} va ANTES del <img>", () => {
    // Cuatro de las seis instituciones no tienen logo cargado. Un `<img src="">`
    // pinta el recuadro roto del navegador, en un acta que se imprime y se firma.
    const h = institutionalHeaderHtml({ titulo: "ACUERDO" });
    expect(h).toContain("{{#if institucion.logo}}");
    expect(h).toContain("{{/if}}");
    expect(h.indexOf("{{#if institucion.logo}}")).toBeLessThan(h.indexOf("<img"));
    expect(h.indexOf("<img")).toBeLessThan(h.indexOf("{{/if}}"));
  });

  it("son tres celdas: logo, título, código", () => {
    const h = institutionalHeaderHtml({ titulo: "X", codigoFormato: "DO-F-021" });
    expect((h.match(/<td/g) ?? []).length).toBe(3);
    expect(h).toContain("width:26%");
    expect(h).toContain("width:48%");
  });

  it("el ancho del logo es configurable y el alto queda en auto", () => {
    // `auto` es lo correcto para pantalla y PDF, y el exportador a Word ya lee las
    // dimensiones reales de la imagen en vez de inventar la altura.
    const h = institutionalHeaderHtml({ anchoLogo: 173 });
    expect(h).toContain("width:173px");
    expect(h).toContain("height:auto");
  });

  it("un ancho inválido cae al valor por defecto en vez de emitir NaN", () => {
    expect(institutionalHeaderHtml({ anchoLogo: 0 })).toContain("width:68px");
    expect(institutionalHeaderHtml({ anchoLogo: NaN })).toContain("width:68px");
    expect(institutionalHeaderHtml({ anchoLogo: -5 })).not.toContain("width:-5px");
  });

  it("SIEMPRE acota el alto del logo", () => {
    // Sin el tope, en impresión el encabezado va fijo, el cuerpo le reserva un alto
    // constante y el logo lo hace crecer hasta tapar las primeras líneas. Medido con
    // el logo real de FESNA: 3,07 cm de solape y tres cláusulas debajo del logo.
    for (const op of [{}, { anchoLogo: 90 }, { titulo: "X" }]) {
      expect(institutionalHeaderHtml(op)).toContain(`max-height:${TOPE_ALTO_LOGO}`);
    }
  });

  it("escapa el texto que escribe el docente", () => {
    // El título entra a un documento que después se abre en Word y en el navegador.
    const h = institutionalHeaderHtml({ titulo: '<script>alert("x")</script>' });
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });

  it("NO escapa las variables de la plantilla (tienen que resolverse)", () => {
    const h = institutionalHeaderHtml({ mostrarNombre: true, mostrarFecha: true });
    expect(h).toContain("{{institucion.nombre}}");
    expect(h).toContain("{{fecha_emision}}");
    expect(h).not.toContain("&#123;");
  });

  it("sin ninguna opción sigue siendo una tabla válida de 3 celdas", () => {
    const h = institutionalHeaderHtml();
    expect(h.startsWith("<table")).toBe(true);
    expect(h.endsWith("</table>")).toBe(true);
    expect((h.match(/<td/g) ?? []).length).toBe(3);
  });

  it("las celdas vacías llevan &nbsp; para no colapsar", () => {
    // Una celda literalmente vacía la colapsa el navegador y se pierde el borde.
    const h = institutionalHeaderHtml();
    expect((h.match(/&nbsp;/g) ?? []).length).toBe(2); // centro y derecha
  });

  it("el subtítulo y la versión aparecen solo si se piden", () => {
    const sin = institutionalHeaderHtml({ titulo: "T" });
    expect(sin).not.toContain("font-size:9pt");
    const con = institutionalHeaderHtml({ titulo: "T", subtitulo: "Programa", version: "V – 1.0" });
    expect(con).toContain("Programa");
    expect(con).toContain("V – 1.0");
  });

  it("no emite `undefined` ni `null` en ningún caso", () => {
    for (const op of [
      {},
      { titulo: "" },
      { codigoFormato: "" },
      { mostrarNombre: true },
      { mostrarFecha: true, anchoLogo: 90 },
    ]) {
      const h = institutionalHeaderHtml(op);
      expect(h).not.toContain("undefined");
      expect(h).not.toContain("null");
    }
  });
});
