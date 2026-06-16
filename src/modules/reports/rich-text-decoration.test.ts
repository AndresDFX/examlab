import { describe, expect, it } from "vitest";
import { decorateVars, stripVarDecoration } from "./RichTextEditor";

describe("decorateVars — resaltado de {{variables}} en el editor visual", () => {
  it("envuelve un token escalar en span.examlab-added[data-ev]", () => {
    const out = decorateVars("<p>Hola {{curso.nombre}}</p>");
    expect(out).toBe(
      '<p>Hola <span class="examlab-added" data-ev="1">{{curso.nombre}}</span></p>',
    );
  });

  it("colorea variables que YA venían en el HTML importado (no sólo lo insertado)", () => {
    // Caso del .docx Camacho: la celda traía el token horneado en el template.
    const out = decorateVars(
      '<td><span style="color:#000000">Programación II {{curso.nombre}}</span></td>',
    );
    expect(out).toContain('<span class="examlab-added" data-ev="1">{{curso.nombre}}</span>');
    // El estilo de la celda importada se conserva.
    expect(out).toContain('style="color:#000000"');
  });

  it("colorea bloques de control {{#each}} y {{/each}}", () => {
    const out = decorateVars("<div>{{#each estudiantes}}</div><div>{{/each}}</div>");
    expect(out).toContain('<span class="examlab-added" data-ev="1">{{#each estudiantes}}</span>');
    expect(out).toContain('<span class="examlab-added" data-ev="1">{{/each}}</span>');
  });

  it("NO matchea llaves dentro de atributos de etiquetas", () => {
    // Un atributo improbable con llaves no debe romperse.
    const out = decorateVars('<img src="x" data-x="{{a}}"/>plain {{b}}');
    // El token dentro del atributo queda intacto…
    expect(out).toContain('data-x="{{a}}"');
    // …y sólo el del texto se resalta.
    expect(out).toContain('<span class="examlab-added" data-ev="1">{{b}}</span>');
  });

  it("varios tokens en el mismo texto", () => {
    const out = decorateVars("<p>{{a}} y {{b}}</p>");
    expect((out.match(/data-ev="1"/g) ?? []).length).toBe(2);
  });
});

describe("stripVarDecoration — el body_html guardado/exportado va LIMPIO", () => {
  it("quita el wrapper de variable conservando el token", () => {
    const decorated = '<p>Hola <span class="examlab-added" data-ev="1">{{curso.nombre}}</span></p>';
    expect(stripVarDecoration(decorated)).toBe("<p>Hola {{curso.nombre}}</p>");
  });

  it("round-trip: strip(decorate(x)) === x para HTML limpio", () => {
    for (const x of [
      "<p>Hola {{curso.nombre}}</p>",
      "<div>{{#each estudiantes}}</div><div><br></div><div>{{/each}}</div>",
      "<p>Sin variables</p>",
      "<p>{{a}} y {{b}} y {{c}}</p>",
    ]) {
      expect(stripVarDecoration(decorateVars(x))).toBe(x);
    }
  });

  it("NO toca bloques de IA (.examlab-added SIN data-ev) — esos sí persisten", () => {
    const html = '<div class="examlab-added">Texto generado por IA</div>';
    expect(stripVarDecoration(html)).toBe(html);
  });

  it("strip es idempotente sobre HTML ya limpio", () => {
    const clean = "<p>Programación II {{curso.nombre}}</p>";
    expect(stripVarDecoration(clean)).toBe(clean);
  });

  it("limpia también los span.examlab-added VIEJOS (sin data-ev) de plantillas previas", () => {
    const legacy = '<p>Hola <span class="examlab-added">{{curso.nombre}}</span></p>';
    expect(stripVarDecoration(legacy)).toBe("<p>Hola {{curso.nombre}}</p>");
  });
});
